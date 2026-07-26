import { z } from "zod";
import { chat, toolDefinition, EventType, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import type { Provider, ToolName } from "@hera/assistant";
import { resolveProvider, toProviderApiError } from "./provider.ts";
import type { ModelPart, Msg } from "./loop.ts";

export type ToolDecl = {
  name: ToolName; kind: "read" | "write"; label: string; description: string;
  input: z.ZodType; output: z.ZodType;
};

/** What the loop needs from a provider: one streamed model call. */
export type ChatAdapter = (req: {
  system: string; messages: unknown[]; tools: ToolDecl[] | null; // null = wrap-up (no tools)
  maxOutputTokens: number; signal: AbortSignal;
}) => AsyncIterable<
  | { kind: "text"; text: string }
  | { kind: "toolCall"; id: string; name: string; args: unknown; metadata?: unknown }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
>;

// TanStack AI findings for THIS file (streaming chunk shapes + tool declarations), verified
// against the installed .d.ts under packages/assistant/node_modules/@tanstack/ai@0.42.0 (the
// same package/version provider.ts's own comment block already verified the adapter-factory
// half against, plus @ag-ui/core@0.0.52 and @tanstack/ai-event-client@0.6.8 for the event/usage
// shapes that live one level down). provider.ts's comment covers `chat()`'s OPTIONS half; this
// one covers the RETURN half (its default `AsyncIterable<StreamChunk>`) plus `toolDefinition()`.
//
// - `StreamChunk` (dist/esm/types.d.ts:1410) = `AGUIEvent`, a discriminated union keyed by
//   `type: EventType` (re-exported from `@ag-ui/core`; values are literal strings like
//   `"TEXT_MESSAGE_CONTENT"`, `"TOOL_CALL_END"`, `"RUN_FINISHED"`, `"RUN_ERROR"`), plus many
//   lifecycle-only events this file ignores (RUN_STARTED, TEXT_MESSAGE_START/END,
//   TOOL_CALL_START/ARGS, STEP_STARTED/FINISHED, *_SNAPSHOT, reasoning/thinking events).
//   - `TextMessageContentEvent.delta: string` — one streamed text fragment.
//   - `ToolCallEndEvent.toolCallId: string`, `.toolCallName?: string`, `.input?: unknown` — the
//     FINAL PARSED (already an object, not a JSON string) tool-call arguments. Confirmed by
//     reading `activities/chat/tools/tool-calls.js`: a tool passed to `chat({tools})` WITHOUT
//     `.server()`/`.client()` (a bare `toolDefinition()` instance) has no `execute`, so the
//     engine routes it into `needsClientExecution` and ends the run right there — it never
//     tries to invoke the tool itself. That is exactly the behavior this adapter relies on:
//     `runTurn` (loop.ts) is the one and only tool executor; TanStack AI is used purely to get
//     the model to decide to call a tool, never to run it.
//   - `RunFinishedEvent.usage?: TokenUsage` (`@tanstack/ai-event-client`) — fields are
//     `.promptTokens` / `.completionTokens` (NOT `inputTokens`/`outputTokens`; those names live
//     only on `loop.ts`'s own `ChatAdapter` chunk shape, which is what this file translates to).
//   - `RunErrorEvent.message: string` — thrown here as a plain `Error`; `runTurn`'s own
//     try/catch (loop.ts) already turns any thrown error into a turn-ending "partial" status
//     plus a generic retryable error event, so no special handling is needed on this side.
// - `toolDefinition(config)` (`activities/chat/tools/tool-definition.d.ts`) takes
//   `{name, description, inputSchema, outputSchema, needsApproval?, lazy?, metadata?}` and
//   returns a `ToolDefinitionInstance` usable DIRECTLY in `chat({tools: [...]})` with no
//   `.server()`/`.client()` call, per the function's own doc example ("Used directly in chat()
//   on the server (as a tool definition without execute)"). Zod v4 schemas satisfy `SchemaInput`
//   (`StandardSchemaV1`) natively, so `ToolDecl.input`/`.output` pass straight through.
// - `chat()`'s `messages` accepts a plain `ModelMessage` (`{role, content, toolCalls?,
//   toolCallId?}`) alongside its richer `UIMessage`/`ConstrainedModelMessage` shapes — the
//   simplest one that round-trips loop.ts's own provider-neutral `Msg`/`ModelPart` shape without
//   needing the full parts-based UI format.
// - `chat()`'s cancellation knob is `abortController?: AbortController` (an instance, not a
//   plain `AbortSignal`) — this file bridges `req.signal` into a fresh `AbortController` whose
//   `.abort()` fires when the source signal aborts.
// - Per-provider max-output-tokens is NOT a top-level `chat()` option and the field name differs
//   per provider — it lives under provider-specific `modelOptions`: gemini `maxOutputTokens`,
//   anthropic `max_tokens`, openai `max_output_tokens` (verified against each package's own
//   `text-provider-options.d.ts`).

/** loop.ts's provider-neutral `Msg[]` -> TanStack AI's `ModelMessage[]`. An assistant "turn" with
 *  a tool call expands to two ModelMessages (assistant call, then the tool's result) since
 *  ModelMessage carries only one role per object. loop.ts enforces one tool call per iteration,
 *  so at most one call/result pair ever needs splitting out of a single `parts` array. */
export function toModelMessages(messages: unknown[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages as Msg[]) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
      continue;
    }
    const text = m.parts.find((p): p is Extract<ModelPart, { type: "text" }> => p.type === "text");
    const call = m.parts.find((p): p is Extract<ModelPart, { type: "toolCall" }> => p.type === "toolCall");
    const result = m.parts.find((p): p is Extract<ModelPart, { type: "toolResult" }> => p.type === "toolResult");
    out.push({
      role: "assistant",
      content: text?.text ?? null,
      ...(call ? { toolCalls: [{
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
        ...(call.metadata !== undefined ? { metadata: call.metadata } : {}),
      }] } : {}),
    });
    if (result) out.push({ role: "tool", content: JSON.stringify(result.result), toolCallId: result.id });
  }
  return out;
}

/** Declarations only (schemas + descriptions) — never `.server()`'d. Execution stays with
 *  `runTurn`'s own `executors[name](...)` call so the durable counters (`bumpCounters`) and
 *  idempotency fencing (`runToolOperation`'s `operationKey`) remain authoritative. */
function toolDefinitionsFor(tools: ToolDecl[]) {
  return tools.map((t) => toolDefinition({ name: t.name, description: t.description, inputSchema: t.input, outputSchema: t.output }));
}

function modelOptionsFor(provider: Provider, model: string, maxOutputTokens: number): Record<string, unknown> {
  // ponytail: minimal thinking. Measured on gemini-3.5-flash against an ~800-token prompt —
  // median TTFT 2300ms default vs 1034ms with MINIMAL (n=4/n=4, warm process). The thinking is
  // invisible to the user anyway: translateStream drops reasoning events, so it reads as a dead
  // window. This loop dispatches tools, it doesn't reason. Raise if answer quality degrades.
  if (provider === "gemini")
    return {
      maxOutputTokens,
      thinkingConfig: model.startsWith("gemini-3") ? { thinkingLevel: "MINIMAL" } : { thinkingBudget: 0 },
    };
  if (provider === "anthropic") return { max_tokens: maxOutputTokens };
  return { max_output_tokens: maxOutputTokens };
}

/** Convert TanStack's provider stream to the package-neutral chunks used by the durable loop.
 * Tool-call metadata arrives on TOOL_CALL_START, so retain it until the matching END event. */
export async function* translateStream(stream: AsyncIterable<StreamChunk>) {
  const toolCallMetadata = new Map<string, unknown>();

  for await (const chunk of stream) {
    if (chunk.type === EventType.TOOL_CALL_START) {
      if (chunk.metadata !== undefined) toolCallMetadata.set(chunk.toolCallId, chunk.metadata);
    } else if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
      if (chunk.delta) yield { kind: "text" as const, text: chunk.delta };
    } else if (chunk.type === EventType.TOOL_CALL_END) {
      const metadata = toolCallMetadata.get(chunk.toolCallId);
      toolCallMetadata.delete(chunk.toolCallId);
      yield {
        kind: "toolCall" as const,
        id: chunk.toolCallId,
        name: chunk.toolCallName ?? "",
        args: chunk.input,
        ...(metadata !== undefined ? { metadata } : {}),
      };
    } else if (chunk.type === EventType.RUN_FINISHED) {
      if (chunk.usage) yield {
        kind: "usage" as const,
        inputTokens: chunk.usage.promptTokens,
        outputTokens: chunk.usage.completionTokens,
      };
    } else if (chunk.type === EventType.RUN_ERROR) {
      throw new Error(chunk.message);
    }
  }
}

/** Builds one turn's `ChatAdapter` (loop.ts). `resolveProvider` + `makeAdapter()` run once here,
 *  reused across every provider call the turn makes (mirrors provider.ts's own "adapters are
 *  built per turn" comment) — never at module scope, so no API key is ever cached across turns. */
export function makeChatAdapter(provider: Provider, model: string): ChatAdapter {
  const resolved = resolveProvider(provider, process.env, model);
  const providerAdapter = resolved.makeAdapter();

  return async function* (req) {
    try {
      const abortController = new AbortController();
      if (req.signal.aborted) abortController.abort();
      else req.signal.addEventListener("abort", () => abortController.abort(), { once: true });

      const stream = chat({
        adapter: providerAdapter,
        systemPrompts: [req.system],
        messages: toModelMessages(req.messages),
        tools: req.tools ? toolDefinitionsFor(req.tools) : undefined,
        // Cast: `buildAdapter`'s return type (provider.ts) is a union across the three provider
        // adapters chosen at runtime, so `modelOptions`'s inferred type at this call site is the
        // union of all three providers' option shapes — TS can't statically narrow which one
        // applies here. `modelOptionsFor` above has already chosen the right field name for the
        // actual `provider`; this cast is a type-level formality, not a runtime trust decision
        // (same rationale as provider.ts's own `buildAdapter` cast).
        modelOptions: modelOptionsFor(provider, model, req.maxOutputTokens) as never,
        abortController,
        stream: true,
      });

      yield* translateStream(stream);
    } catch (error) {
      throw toProviderApiError(error);
    }
  };
}
