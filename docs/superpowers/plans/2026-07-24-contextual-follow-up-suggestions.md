# Contextual Follow-up Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the assistant from invoking `suggestFollowUps` for greetings and other non-configurator turns.

**Architecture:** Keep the existing tool and event flow. Change only the system-prompt eligibility rule and protect it with a prompt-builder test.

**Tech Stack:** TypeScript, Bun test

## Global Constraints

- Suggestions require a substantive configuration request or completed configurator action.
- Suggestions require at least one concrete, relevant next step.
- Greetings, thanks, casual conversation, capability questions, clarification requests, failed actions, and no-op turns must not invoke `suggestFollowUps`.

---

### Task 1: Gate follow-up suggestions in the system prompt

**Files:**
- Create: `packages/assistant/test/prompt.test.ts`
- Modify: `packages/assistant/src/prompt.ts:73-76`

**Interfaces:**
- Consumes: `buildAssistPrompt(model, propagated, working, ctx): string`
- Produces: A system prompt that explicitly defines when `suggestFollowUps` is and is not eligible.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";
import { buildAssistPrompt } from "../src/prompt.ts";

const model: ModelDef = {
  name: "Test product",
  parameters: [],
  structure: { sections: [] },
  computed: [],
  constraints: [],
  bom: [],
  routing: [],
  queryTables: [],
  pricing: { priceExpr: "0", quoteItemCode: "TEST" },
  batchDefaults: [],
};

test("limits follow-up suggestions to substantive configurator turns", () => {
  const prompt = buildAssistPrompt(
    model,
    { domains: {}, defaulted: new Set(), conflicts: [] },
    { entries: {}, batches: [], projectVersion: "1", workingRevision: 0 },
    { status: "draft" },
  );

  expect(prompt).toContain(
    "Call suggestFollowUps only after handling a substantive configuration request",
  );
  expect(prompt).toContain(
    "Do not call it for greetings, thanks, casual conversation, capability questions, clarification requests, failed actions, or no-op turns",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/assistant/test/prompt.test.ts`

Expected: FAIL because the current prompt unconditionally says to call `suggestFollowUps` before every final reply.

- [ ] **Step 3: Write the minimal prompt change**

Replace the existing follow-up instruction with:

```ts
"- Call suggestFollowUps only after handling a substantive configuration request",
"  or completing a configurator action, and only when one or more concrete,",
"  relevant next steps exist. Do not call it for greetings, thanks, casual",
"  conversation, capability questions, clarification requests, failed actions,",
"  or no-op turns. When it does not apply, answer directly without calling it.",
"  Phrase suggestions as short prompts in the user's voice and return at most 3.",
```

- [ ] **Step 4: Run focused and package tests**

Run: `bun test packages/assistant/test/prompt.test.ts packages/assistant/test/tools.test.ts packages/assistant/test/provider.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Check TypeScript and lint diagnostics**

Run the repository's assistant-package TypeScript check if available, then inspect diagnostics for the two changed files.

Expected: no new errors.

- [ ] **Step 6: Commit only when explicitly requested**

Do not create a commit unless the user asks for one.
