import { describe, expect, test } from "bun:test";
import type { EntityProfile, EntityProperty } from "@hera/db";
import {
  addCollectionRow,
  fieldDisplayText,
  cloneForEdit,
  isCollectionFieldEditable,
  isHeaderFieldEditable,
  mergeFetchedIntoDraft,
  missingRequiredFields,
  patchDraftField,
  removeCollectionRow,
  resolveEntityCapabilities,
} from "../objectSpec.ts";

const DOC_PROFILE: EntityProfile = {
  entity: "Quotations",
  family: "sales-document",
  titleField: "DocNum",
  subtitleFields: ["CardCode"],
  fields: {
    editableHeader: ["CardCode", "CardName", "Comments"],
    requiredOnCreate: ["CardCode"],
    readOnly: ["DocEntry", "DocNum", "DocTotal", "DocumentStatus", "Cancelled"],
    collectionEditable: { DocumentLines: ["ItemCode", "Quantity", "UnitPrice"] },
    editWhen: [
      { field: "DocumentStatus", allowed: ["bost_Open"] },
      { field: "Cancelled", allowed: ["tNO", "N", false] },
    ],
  },
  collections: {
    DocumentLines: {
      parentKey: "DocEntry",
      childParentKey: "DocEntry",
      rowKey: "LineNum",
      editable: true,
    },
  },
};

const OPEN_RECORD: Record<string, unknown> = {
  DocEntry: 10,
  DocNum: 100,
  CardCode: "C001",
  CardName: "Acme",
  Comments: "hello",
  DocumentStatus: "bost_Open",
  Cancelled: "tNO",
  SecretNote: "hidden-value",
  DocumentLines: [
    { LineNum: 0, ItemCode: "A1", Quantity: 2 },
    { LineNum: 1, ItemCode: "B2", Quantity: 1 },
  ],
};

describe("Edit clone", () => {
  test("deep-clones record into an independent draft", () => {
    const draft = cloneForEdit(OPEN_RECORD);
    expect(draft).toEqual(OPEN_RECORD);
    expect(draft).not.toBe(OPEN_RECORD);
    expect(draft.DocumentLines).not.toBe(OPEN_RECORD.DocumentLines);
    expect((draft.DocumentLines as unknown[])[0]).not.toBe(
      (OPEN_RECORD.DocumentLines as unknown[])[0],
    );
  });
});

describe("no mutation of query data", () => {
  test("mutating draft leaves the source record untouched", () => {
    const record = structuredClone(OPEN_RECORD);
    const draft = cloneForEdit(record);
    draft.CardCode = "CHANGED";
    (draft.DocumentLines as Record<string, unknown>[])[0]!.ItemCode = "ZZ";
    expect(record.CardCode).toBe("C001");
    expect((record.DocumentLines as Record<string, unknown>[])[0]!.ItemCode).toBe("A1");
  });
});

describe("Cancel restoration", () => {
  test("discarding draft restores display to the original record values", () => {
    const record = structuredClone(OPEN_RECORD);
    let draft: Record<string, unknown> | null = cloneForEdit(record);
    let dirtyPaths = new Set<string>(["CardCode"]);
    draft = patchDraftField(draft, dirtyPaths, "CardCode", "X").draft;
    // Cancel: drop draft + dirties; display source is still `record`.
    draft = null;
    dirtyPaths = new Set();
    expect(draft).toBeNull();
    expect(dirtyPaths.size).toBe(0);
    expect(record.CardCode).toBe("C001");
  });
});

describe("Save validation", () => {
  test("reports missing requiredOnCreate fields", () => {
    expect(missingRequiredFields(DOC_PROFILE, { CardCode: "" })).toEqual(["CardCode"]);
    expect(missingRequiredFields(DOC_PROFILE, { CardCode: "   " })).toEqual(["CardCode"]);
    expect(missingRequiredFields(DOC_PROFILE, { CardCode: "C001" })).toEqual([]);
    expect(missingRequiredFields(null, {})).toEqual([]);
  });
});

describe("status-lock disablement", () => {
  test("open + not cancelled → canEdit", () => {
    const caps = resolveEntityCapabilities(DOC_PROFILE, OPEN_RECORD);
    expect(caps.canEdit).toBe(true);
    expect(isHeaderFieldEditable(DOC_PROFILE, "CardCode", caps)).toBe(true);
    expect(isHeaderFieldEditable(DOC_PROFILE, "DocTotal", caps)).toBe(false);
    expect(isCollectionFieldEditable(DOC_PROFILE, "DocumentLines", "ItemCode", caps)).toBe(true);
    expect(isCollectionFieldEditable(DOC_PROFILE, "DocumentLines", "LineTotal", caps)).toBe(false);
  });

  test("closed or cancelled → display-only", () => {
    expect(
      resolveEntityCapabilities(DOC_PROFILE, { ...OPEN_RECORD, DocumentStatus: "bost_Close" })
        .canEdit,
    ).toBe(false);
    expect(
      resolveEntityCapabilities(DOC_PROFILE, { ...OPEN_RECORD, Cancelled: "tYES" }).canEdit,
    ).toBe(false);
  });

  test("missing lock fields → display-only, not a guess", () => {
    expect(resolveEntityCapabilities(DOC_PROFILE, { CardCode: "C1" }).canEdit).toBe(false);
    expect(resolveEntityCapabilities(null, OPEN_RECORD).canEdit).toBe(false);
  });

  test("locked document disables header and line edits", () => {
    const caps = resolveEntityCapabilities(DOC_PROFILE, {
      ...OPEN_RECORD,
      DocumentStatus: "bost_Close",
    });
    expect(isHeaderFieldEditable(DOC_PROFILE, "CardCode", caps)).toBe(false);
    expect(isCollectionFieldEditable(DOC_PROFILE, "DocumentLines", "Quantity", caps)).toBe(false);
  });
});

describe("hidden-field retention", () => {
  test("edits remain on draft after the field leaves the visible variant", () => {
    let draft = cloneForEdit(OPEN_RECORD);
    let dirty = new Set<string>();
    ({ draft, dirtyPaths: dirty } = patchDraftField(draft, dirty, "SecretNote", "edited-hidden"));
    // Variant no longer shows SecretNote — draft still holds it.
    expect(draft.SecretNote).toBe("edited-hidden");
    expect(dirty.has("SecretNote")).toBe(true);
    expect(OPEN_RECORD.SecretNote).toBe("hidden-value");
  });
});

describe("projection merge without dirty overwrite", () => {
  test("fills missing fetched paths and skips dirty / already-present", () => {
    const draft = {
      CardCode: "local-dirty",
      Comments: "keep-me",
      DocumentLines: [{ LineNum: 0, ItemCode: "A1", Quantity: 9 }],
    };
    const dirty = new Set(["CardCode", "DocumentLines.0.Quantity"]);
    const fetched = {
      CardCode: "from-server",
      Comments: "server-comments",
      NumAtCard: "PO-9",
      DocumentLines: [
        { LineNum: 0, ItemCode: "A1", Quantity: 1, TaxCode: "V1" },
      ],
    };
    const merged = mergeFetchedIntoDraft(draft, fetched, dirty);
    expect(merged.CardCode).toBe("local-dirty");
    expect(merged.Comments).toBe("keep-me");
    expect(merged.NumAtCard).toBe("PO-9");
    const line = (merged.DocumentLines as Record<string, unknown>[])[0]!;
    expect(line.Quantity).toBe(9);
    expect(line.TaxCode).toBe("V1");
    expect(line.ItemCode).toBe("A1");
  });
});

describe("line add/remove", () => {
  test("adds and removes collection rows without mutating the prior draft", () => {
    const base = cloneForEdit(OPEN_RECORD);
    const dirty = new Set<string>();
    const added = addCollectionRow(base, dirty, "DocumentLines", { ItemCode: "NEW" });
    expect((base.DocumentLines as unknown[]).length).toBe(2);
    expect((added.draft.DocumentLines as unknown[]).length).toBe(3);
    expect((added.draft.DocumentLines as Record<string, unknown>[])[2]!.ItemCode).toBe("NEW");
    expect(added.dirtyPaths.has("DocumentLines")).toBe(true);

    const removed = removeCollectionRow(added.draft, added.dirtyPaths, "DocumentLines", 0);
    expect((added.draft.DocumentLines as unknown[]).length).toBe(3);
    expect((removed.draft.DocumentLines as unknown[]).length).toBe(2);
    expect((removed.draft.DocumentLines as Record<string, unknown>[])[0]!.ItemCode).toBe("B2");
    expect(removed.dirtyPaths.has("DocumentLines")).toBe(true);
  });

  test("removed lines stay gone after projection merge", () => {
    const base = cloneForEdit(OPEN_RECORD);
    const removed = removeCollectionRow(base, new Set(), "DocumentLines", 0);
    expect((removed.draft.DocumentLines as unknown[]).length).toBe(1);
    expect(removed.dirtyPaths.has("DocumentLines")).toBe(true);

    const fetched = {
      ...OPEN_RECORD,
      DocumentLines: [
        { LineNum: 0, ItemCode: "A1", Quantity: 2 },
        { LineNum: 1, ItemCode: "B2", Quantity: 1 },
      ],
    };
    const merged = mergeFetchedIntoDraft(removed.draft, fetched, removed.dirtyPaths);
    expect((merged.DocumentLines as unknown[]).length).toBe(1);
    expect((merged.DocumentLines as Record<string, unknown>[])[0]!.ItemCode).toBe("B2");
  });

  test("draft collection length wins even without collection dirty path", () => {
    const draft = {
      DocumentLines: [{ LineNum: 1, ItemCode: "B2", Quantity: 1 }],
    };
    const fetched = {
      DocumentLines: [
        { LineNum: 0, ItemCode: "A1", Quantity: 2 },
        { LineNum: 1, ItemCode: "B2", Quantity: 1 },
      ],
    };
    const merged = mergeFetchedIntoDraft(draft, fetched, new Set());
    expect((merged.DocumentLines as unknown[]).length).toBe(1);
    expect((merged.DocumentLines as Record<string, unknown>[])[0]!.ItemCode).toBe("B2");
  });
});

describe("fieldDisplayText", () => {
  const status: EntityProperty = {
    name: "DocumentStatus",
    type: "SAPB1.BoStatus",
    nullable: true,
    options: [{ value: "bost_Open", text: "Open", numericValue: 0 }],
  };

  test("humanizes enum members and falls back to the raw value", () => {
    expect(fieldDisplayText(status, "bost_Open")).toBe("Open");
    expect(fieldDisplayText(status, "bost_Unknown")).toBe("bost_Unknown");
  });

  test("non-enum properties format normally", () => {
    expect(fieldDisplayText({ name: "CardCode", type: "Edm.String", nullable: true }, "C001")).toBe(
      "C001",
    );
    expect(fieldDisplayText(status, null)).toBe("");
  });
});
