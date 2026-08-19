import { ORPCError } from "@orpc/server";
import type { EntityCapabilities, EntityProfile } from "@hera/db";

export type WriteCapability = { entity: string; dedupField: string };

/** Same window as agent offline detection (3 missed ~25s pull cycles). */
export const WRITE_CAPABILITY_STALE_MS = 90_000;

function lockAllows(
  record: Record<string, unknown>,
  rule: { field: string; allowed: Array<string | number | boolean> },
): boolean {
  if (!(rule.field in record)) return false;
  const v = record[rule.field];
  return rule.allowed.some((a) => a === v);
}

/**
 * Profile `editWhen` against a record (submitted write data or fetched row).
 * Missing lock fields fail closed. Empty editWhen → editable.
 */
export function assertEditableRecord(
  profile: EntityProfile,
  record: Record<string, unknown>,
): void {
  const locks = profile.fields.editWhen;
  if (!locks.length) return;
  if (!locks.every((r) => lockAllows(record, r))) {
    throw new ORPCError("FORBIDDEN", {
      message: "Record is not editable (status lock)",
    });
  }
}

/** True when profile editWhen allows editing this record (missing locks → false). */
export function recordPassesEditWhen(
  profile: EntityProfile,
  record: Record<string, unknown>,
): boolean {
  const locks = profile.fields.editWhen;
  if (!locks.length) return true;
  return locks.every((r) => lockAllows(record, r));
}

export function resolveWriteCapabilities(input: {
  entity: string;
  profile: EntityProfile | null;
  writeCapabilities: WriteCapability[] | null | undefined;
  checkedAt: Date | null | undefined;
  lastSeenAt: Date | null | undefined;
  now?: Date;
}): EntityCapabilities {
  const now = input.now ?? new Date();
  if (!input.profile) {
    return { canEdit: false, canCreate: false, reason: "No profile" };
  }

  // Agent-capability gate only: status locks are enforced at write time via assertEditableRecord
  // (capabilities RPC has no record). Updates stay allowed without a fresh create report.
  const canEdit = true;

  if (!input.profile.create) {
    return { canEdit, canCreate: false };
  }

  const checkedAge = input.checkedAt ? now.getTime() - input.checkedAt.getTime() : Infinity;
  const seenAge = input.lastSeenAt ? now.getTime() - input.lastSeenAt.getTime() : Infinity;
  if (checkedAge > WRITE_CAPABILITY_STALE_MS || seenAge > WRITE_CAPABILITY_STALE_MS) {
    return { canEdit, canCreate: false, reason: "Agent offline/stale report" };
  }

  const cap = (input.writeCapabilities ?? []).find((c) => c.entity === input.entity);
  if (!cap) {
    return { canEdit, canCreate: false, reason: "Entity not reported" };
  }
  if (cap.dedupField !== input.profile.create.dedupField) {
    return { canEdit, canCreate: false, reason: "UDF mismatch" };
  }
  return { canEdit, canCreate: true };
}
