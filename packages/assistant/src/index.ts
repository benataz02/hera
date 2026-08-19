// Pure half of Chati: drizzle tables, the wire event protocol, tool declarations and the chat
// input contract. Consumed by apps/server (the turn engine), apps/web (event + input types) and
// packages/db's drizzle.config (schema.ts, for migrations). Nothing here touches a db handle,
// a provider SDK or an executor — that all lives in apps/server/src/assistant/.
export * from "./canonical.ts";
export * from "./schema.ts";
export * from "./events.ts";
export * from "./input.ts";
export * from "./tools.ts";
