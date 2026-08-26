/**
 * Helpers for parsing B1 MCP tool responses.
 *
 * All B1 tool responses follow a consistent shape:
 *
 *   content[0].text =
 *     <human-readable header / guidance lines>
 *
 *     {JSON payload}          ← always the last block in the text
 *
 * The utilities here let callers work with the structured payload
 * without fragile regex gymnastics.
 */

// The MCP SDK's callTool() return type is a discriminated union: one branch carries
// `content: ContentBlock[]`, the other carries `toolResult: unknown`. Both have an
// index signature `[x: string]: unknown`, so Record<string, unknown> covers both.
export type B1ToolResult = Record<string, unknown>;

// ─── Text extraction ───────────────────────────────────────────────────────────

/** Returns the raw text from the first content item, or '' when absent. */
export function getToolText(result: B1ToolResult): string {
    const content = result['content'] as Array<{ type?: string; text?: string }> | undefined;
    const first = content?.[0];
    return first?.type === 'text' && typeof first.text === 'string' ? first.text : '';
}

// ─── Error detection ──────────────────────────────────────────────────────────

/**
 * Returns true when the tool result represents an error.
 * Checks the `isError` flag first, then falls back to the "ERROR:" prefix
 * that all B1 error responses use.
 */
export function isToolError(result: B1ToolResult): boolean {
    if (result['isError'] === true) return true;
    return getToolText(result).startsWith('ERROR:');
}

// ─── JSON extraction ──────────────────────────────────────────────────────────

/**
 * Extract and JSON-parse the payload embedded at the end of a B1 tool response text.
 *
 * Every B1 tool appends the JSON payload as the last block after the guidance lines:
 *   "…\n\nFull Metadata:\n\n{…}"   (b1_get_entity_schema)
 *   "…\n== RESULT ==\n{…}"         (b1_read)
 *   "…\n\n{…}"                     (b1_find_entities)
 *
 * Strategy: find the last '\n{' or '\n[' in the text and parse from there.
 * This is safe because all header lines end before the first bare newline+brace.
 */
export function parseToolTextJson<T = unknown>(text: string): T {
    const lastObj = text.lastIndexOf('\n{');
    const lastArr = text.lastIndexOf('\n[');
    const nlIdx = Math.max(lastObj, lastArr);
    if (nlIdx >= 0) return JSON.parse(text.slice(nlIdx + 1)) as T;
    if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text) as T;
    throw new Error(`No JSON payload found in tool response text`);
}

/** Convenience wrapper: extracts text then parses the JSON payload.
 *
 * Preference order:
 *   1. structuredContent — present when the server is new enough to include it;
 *      already a plain object, no text parsing needed.
 *   2. parseToolTextJson(content[0].text) — legacy fallback for older responses
 *      or any handler that has not yet been updated to emit structuredContent.
 */
export function parseToolJson<T = unknown>(result: B1ToolResult): T {
    // Fast path: server already provided a clean machine-readable payload.
    if (result['structuredContent'] !== undefined) {
        return result['structuredContent'] as T;
    }
    return parseToolTextJson<T>(getToolText(result));
}
