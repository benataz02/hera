import { sql } from "drizzle-orm";
import {
  boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import type { Entries } from "@hera/config-engine";

// Chati persistence. Spec: docs/superpowers/specs/2026-07-21-configurator-assistant-design.md.
// Owned by @hera/assistant; migrations are generated from packages/db (drizzle.config schema array).
// No runtime dependency on @hera/db — configs.remove deletes conversations explicitly.

export type Provider = "gemini" | "anthropic" | "openai";
export type TurnStatus = "running" | "partial" | "complete" | "failed";
export type ToolExecStatus = "running" | "complete" | "error";

/** One applied/rejected value line as the window renders it (persisted UI projection). */
export type UiChange = {
  key: string; from: unknown; to: unknown; evidence: string;
  provenance: { source: "user" | "drawing" | "similar" | "document"; detail: string; sourceRef?: unknown };
  valid: boolean; reason?: string; reverted?: boolean; superseded?: boolean;
};

/** content jsonb: `ui` is what the window renders; `model` is the TanStack AI normalized
 *  message(s) including tool-call/tool-result parts. Storing both beats re-deriving. */
export type MessageContent = {
  ui: {
    text: string; changes?: UiChange[]; invalid?: UiChange[];
    results?: { tool: string; resultId: string; data: unknown }[];
    suggestions?: string[]; fileName?: string;
  };
  model: unknown[];
};

export const assistantConversation = pgTable(
  "assistant_conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(), // attribution, not an owner boundary
    provider: text("provider").$type<Provider>().notNull(),
    model: text("model").notNull(),
    title: text("title").notNull(), // first user message, truncated to 80 chars
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assistant_conv_tenant_project_idx").on(t.tenantId, t.projectId, t.updatedAt)],
);

export const assistantTurn = pgTable(
  "assistant_turn",
  {
    id: uuid("id").primaryKey(), // client-generated turnId; reused verbatim on Retry
    conversationId: uuid("conversation_id").notNull()
      .references(() => assistantConversation.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    provider: text("provider").$type<Provider>().notNull(), // pinned for the turn's lifetime
    model: text("model").notNull(),
    initialProjectVersion: timestamp("initial_project_version", { withTimezone: true }).notNull(),
    latestProjectVersion: timestamp("latest_project_version", { withTimezone: true }).notNull(),
    initialEntries: jsonb("initial_entries").$type<Entries>().notNull(),
    initialBatches: jsonb("initial_batches").$type<number[]>().notNull(),
    workingEntries: jsonb("working_entries").$type<Entries>().notNull(),
    workingBatches: jsonb("working_batches").$type<number[]>().notNull(),
    workingRevision: integer("working_revision").notNull().default(0),
    nextSeq: integer("next_seq").notNull().default(0),
    iterationCount: integer("iteration_count").notNull().default(0),
    executedToolCallCount: integer("executed_tool_call_count").notNull().default(0),
    providerCallCount: integer("provider_call_count").notNull().default(0),
    wrapUpAttempted: boolean("wrap_up_attempted").notNull().default(false),
    calculated: boolean("calculated").notNull().default(false), // set once calculate succeeds → WORKING_FROZEN
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    status: text("status").$type<TurnStatus>().notNull().default("running"),
    errorCode: text("error_code"),
    inputTokens: integer("input_tokens").notNull().default(0),  // accumulate across attempts
    outputTokens: integer("output_tokens").notNull().default(0),
    userMessage: text("user_message").notNull(), // immutable identity: retry must match
    attachmentName: text("attachment_name"),
    attachmentMime: text("attachment_mime"),
    attachmentSha256: text("attachment_sha256"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("assistant_turn_conv_idx").on(t.conversationId, t.startedAt),
    // one running turn per conversation and per user (partial unique indexes)
    uniqueIndex("assistant_turn_running_conv_uq").on(t.conversationId).where(sql`${t.status} = 'running'`),
    uniqueIndex("assistant_turn_running_user_uq").on(t.userId).where(sql`${t.status} = 'running'`),
  ],
);

export const assistantMessage = pgTable(
  "assistant_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull()
      .references(() => assistantConversation.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    createdByUserId: text("created_by_user_id"),
    content: jsonb("content").$type<MessageContent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("assistant_msg_conv_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("assistant_msg_turn_role_uq").on(t.turnId, t.role), // ≤1 user + 1 assistant row per turn
  ],
);

export const assistantToolExecution = pgTable(
  "assistant_tool_execution",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    turnId: uuid("turn_id").notNull().references(() => assistantTurn.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    replayToolCallIds: jsonb("replay_tool_call_ids").$type<string[]>().notNull().default([]),
    operationKey: text("operation_key").notNull(),
    eventSeq: integer("event_seq"),
    name: text("name").notNull(),
    status: text("status").$type<ToolExecStatus>().notNull().default("running"),
    leaseToken: uuid("lease_token").notNull(),
    input: jsonb("input").notNull(),
    inputHash: text("input_hash").notNull(),
    result: jsonb("result"),
    errorCode: text("error_code"),
    observedProjectVersion: timestamp("observed_project_version", { withTimezone: true }),
    affectedProjectVersion: timestamp("affected_project_version", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    replayCount: integer("replay_count").notNull().default(0),
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("assistant_tool_exec_op_uq").on(t.turnId, t.operationKey)],
);
