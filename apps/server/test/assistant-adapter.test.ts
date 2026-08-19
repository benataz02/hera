import { describe, expect, test } from "bun:test";

describe("assistant provider adapter", () => {
  test("round-trips Gemini tool-call metadata into the next model request", async () => {
    const adapterModule = await import("../src/assistant/adapter.ts") as Record<string, unknown>;
    const translateStream = adapterModule.translateStream as
      | ((stream: AsyncIterable<unknown>) => AsyncIterable<unknown>)
      | undefined;
    const toModelMessages = adapterModule.toModelMessages as
      | ((messages: unknown[]) => unknown[])
      | undefined;

    async function* providerEvents() {
      yield {
        type: "TOOL_CALL_START",
        toolCallId: "call-1",
        toolCallName: "suggestFollowUps",
        metadata: { thoughtSignature: "signed-thought" },
      };
      yield {
        type: "TOOL_CALL_END",
        toolCallId: "call-1",
        toolCallName: "suggestFollowUps",
        input: { suggestions: ["Calculate candidates"] },
      };
    }

    const translated: unknown[] = [];
    if (translateStream) {
      for await (const chunk of translateStream(providerEvents())) translated.push(chunk);
    }

    expect(translated).toEqual([{
      kind: "toolCall",
      id: "call-1",
      name: "suggestFollowUps",
      args: { suggestions: ["Calculate candidates"] },
      metadata: { thoughtSignature: "signed-thought" },
    }]);

    expect(toModelMessages?.([{
      role: "assistant",
      parts: [{
        type: "toolCall",
        id: "call-1",
        name: "suggestFollowUps",
        args: { suggestions: ["Calculate candidates"] },
        metadata: { thoughtSignature: "signed-thought" },
      }],
    }])).toEqual([{
      role: "assistant",
      content: null,
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: {
          name: "suggestFollowUps",
          arguments: JSON.stringify({ suggestions: ["Calculate candidates"] }),
        },
        metadata: { thoughtSignature: "signed-thought" },
      }],
    }]);
  });
});
