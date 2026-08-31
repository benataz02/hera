import type { Entries } from "@hera/config-engine";
import type { AssistantEvent, ChangeRow } from "@hera/assistant";

// Pure client reducer for the Chati streaming protocol. No components, no side effects beyond
// the `opts` callbacks handed in by the (Task 16) component — see events.ts for the wire shapes
// this translates from.

export type ChatChange = {
  key: string;
  from: unknown;
  to: unknown;
  evidence: string;
  valid: boolean;
  reason?: string;
  reverted?: boolean;
  superseded?: boolean;
};

export type ChatMsg = {
  role: "user" | "assistant";
  turnId: string;
  text: string;
  changes?: ChatChange[];
  results?: { tool: string; resultId: string; data: unknown }[];
  candidates?: { projectVersion: string; candidateCount: number; top: unknown[] };
  suggestions?: string[];
  fileName?: string;
  streaming?: boolean;
  error?: { code: string; message: string; retryable: boolean };
  // Deliberate small addition beyond the brief's literal type: the brief's ChatMsg has no slot
  // for "tool X is running" activity lines, but Task 16's UI renders activity "in event order"
  // alongside text/changes/results — this reducer is the only place that ever sees raw `tool`
  // events, so it's the only place that can capture them for later render. Kept minimal.
  activity?: { seq: number; name: string; label: string }[];
};

export type ChatState = {
  messages: ChatMsg[];
  appliedSeq: Record<string, number>; // per turnId — de-dup boundary
  touched: { entryKeys: Set<string>; batches: boolean }; // edits after a partial/error terminal event
  busy: boolean;
};

export const initialChatState: ChatState = {
  messages: [],
  appliedSeq: {},
  touched: { entryKeys: new Set(), batches: false },
  busy: false,
};

function valEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toChatChange(row: ChangeRow): ChatChange {
  return { key: row.key, from: row.from, to: row.to, evidence: row.evidence, valid: row.valid, reason: row.reason };
}

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  const next = arr.slice();
  next[idx] = value;
  return next;
}

function findAssistantIdx(messages: ChatMsg[], turnId: string): number {
  return messages.findIndex((m) => m.role === "assistant" && m.turnId === turnId);
}

function blankAssistant(turnId: string): ChatMsg {
  return { role: "assistant", turnId, text: "" };
}

/** Find the turn's assistant message, creating it lazily (on the turn's first event) if absent. */
function upsertAssistant(messages: ChatMsg[], turnId: string, update: (msg: ChatMsg) => ChatMsg): ChatMsg[] {
  const idx = findAssistantIdx(messages, turnId);
  if (idx === -1) return [...messages, update(blankAssistant(turnId))];
  const existing = messages[idx];
  if (!existing) return messages;
  return replaceAt(messages, idx, update(existing));
}

/** Upsert-by-key: a later `changes` event within the same turn revises rows sharing a key,
 * while leaving other previously-proposed rows (and their position) intact. */
function mergeChanges(existing: ChatChange[] | undefined, incoming: ChatChange[]): ChatChange[] {
  const merged = new Map((existing ?? []).map((c): [string, ChatChange] => [c.key, c]));
  for (const row of incoming) merged.set(row.key, row);
  return [...merged.values()];
}

export function startTurn(s: ChatState, turnId: string, text: string, fileName?: string): ChatState {
  const userMsg: ChatMsg = { role: "user", turnId, text, fileName };
  return { ...s, messages: [...s.messages, userMsg], busy: true };
}

export function applyEvent(
  s: ChatState,
  e: AssistantEvent,
  opts: {
    onApplyValues(changes: ChatChange[]): void; // page callback: entries + aiMarks
    onCandidates(e: Extract<AssistantEvent, { type: "candidates" }>): void;
    onSelection(e: Extract<AssistantEvent, { type: "selection" }>): void;
    onConversation(id: string): void;
  },
): ChatState {
  // Duplicate/lower seq per turn: ignored entirely (state unchanged).
  const lastSeq = s.appliedSeq[e.turnId] ?? -1;
  if (e.seq <= lastSeq) return s;
  const appliedSeq = { ...s.appliedSeq, [e.turnId]: e.seq };

  switch (e.type) {
    case "delta": {
      const messages = upsertAssistant(s.messages, e.turnId, (msg) => ({
        ...msg,
        text: msg.text + e.text,
        streaming: true,
      }));
      return { ...s, appliedSeq, messages };
    }

    case "tool": {
      const messages = upsertAssistant(s.messages, e.turnId, (msg) => ({
        ...msg,
        streaming: true,
        activity: [...(msg.activity ?? []), { seq: e.seq, name: e.name, label: e.label }],
      }));
      return { ...s, appliedSeq, messages };
    }

    case "result": {
      const messages = upsertAssistant(s.messages, e.turnId, (msg) => ({
        ...msg,
        streaming: true,
        results: [...(msg.results ?? []), { tool: e.tool, resultId: e.resultId, data: e.data }],
      }));
      return { ...s, appliedSeq, messages };
    }

    case "changes": {
      const rows = e.changes.map(toChatChange);
      const validRows = rows.filter((r) => r.valid);
      if (validRows.length > 0) opts.onApplyValues(validRows);
      const messages = upsertAssistant(s.messages, e.turnId, (msg) => ({
        ...msg,
        streaming: true,
        changes: mergeChanges(msg.changes, rows),
      }));
      return { ...s, appliedSeq, messages };
    }

    case "snapshot": {
      const rows = e.changes.map(toChatChange);
      const toApply: ChatChange[] = [];
      const stored: ChatChange[] = rows.map((row) => {
        if (s.touched.entryKeys.has(row.key)) return { ...row, superseded: true };
        if (row.valid) toApply.push(row);
        return row;
      });
      if (toApply.length > 0) opts.onApplyValues(toApply);

      const next: ChatMsg = {
        role: "assistant",
        turnId: e.turnId,
        text: e.text,
        changes: stored,
        results: e.results.map((r) => ({ tool: r.tool, resultId: r.resultId, data: r.data })),
        candidates: e.candidates,
        suggestions: e.suggestions,
        streaming: e.status === "running",
      };
      const idx = findAssistantIdx(s.messages, e.turnId);
      const messages = idx === -1 ? [...s.messages, next] : replaceAt(s.messages, idx, next);

      return {
        ...s,
        appliedSeq,
        messages,
        touched: { entryKeys: new Set(), batches: false }, // only `snapshot` clears touched
      };
    }

    case "candidates": {
      const messages = upsertAssistant(s.messages, e.turnId, (msg) => ({
        ...msg,
        streaming: true,
        candidates: {
          projectVersion: e.projectVersion,
          candidateCount: e.candidateCount,
          top: e.top,
        },
      }));
      opts.onCandidates(e);
      return { ...s, appliedSeq, messages };
    }

    case "selection": {
      // No dedicated storage slot on ChatMsg for selection rows — forward only.
      opts.onSelection(e);
      return { ...s, appliedSeq };
    }

    case "conversation": {
      // No dedicated storage slot on ChatMsg for conversation metadata — forward only.
      opts.onConversation(e.id);
      return { ...s, appliedSeq };
    }

    case "error": {
      const messages = upsertAssistant(s.messages, e.turnId, (msg) => ({
        ...msg,
        streaming: false,
        error: { code: e.code, message: e.message, retryable: e.retryable },
      }));
      return { ...s, appliedSeq, messages, busy: false };
    }

    case "done": {
      const messages = upsertAssistant(s.messages, e.turnId, (msg) => ({
        ...msg,
        streaming: false,
        suggestions: e.suggestions,
      }));
      return { ...s, appliedSeq, messages, busy: false };
    }
  }
}

/** Dumb setter — caller (Task 16) is expected to only invoke this while a turn is in the
 * partial/error/pending-retry state; this function itself doesn't check that. */
export function recordUserEdit(s: ChatState, keys: string[], batches: boolean): ChatState {
  const entryKeys = new Set(s.touched.entryKeys);
  for (const key of keys) entryKeys.add(key);
  return { ...s, touched: { entryKeys, batches: s.touched.batches || batches } };
}

export function revertChange(
  msg: ChatMsg,
  key: string,
  currentEntries: Entries,
): { next: Entries; marked: ChatMsg } | { superseded: ChatMsg } {
  const changes = msg.changes ?? [];
  const idx = changes.findIndex((c) => c.key === key);
  const change = idx === -1 ? undefined : changes[idx];
  if (idx === -1 || !change) return { superseded: msg };

  if (!valEqual(currentEntries[key], change.to)) {
    const marked = replaceAt(changes, idx, { ...change, superseded: true });
    return { superseded: { ...msg, changes: marked } };
  }

  const next: Entries = { ...currentEntries };
  if (change.from === undefined) delete next[key];
  else next[key] = change.from as Entries[string];

  const marked = replaceAt(changes, idx, { ...change, reverted: true });
  return { next, marked: { ...msg, changes: marked } };
}

// ponytail: compare-and-restore, no op-log; fine for visible session state
export function revertAll(msg: ChatMsg, currentEntries: Entries): { next: Entries; marked: ChatMsg } {
  const next: Entries = { ...currentEntries };
  const changes = (msg.changes ?? []).map((change) => {
    if (!change.valid || change.reverted || change.superseded) return change;
    if (!valEqual(next[change.key], change.to)) return { ...change, superseded: true };
    if (change.from === undefined) delete next[change.key];
    else next[change.key] = change.from as Entries[string];
    return { ...change, reverted: true };
  });
  return { next, marked: { ...msg, changes } };
}
