import { describe, expect, test } from "bun:test";
import type { ObjectVariantDef } from "@hera/db";
import { sameDef } from "../listSpec.ts";
import {
  canDeleteVariant,
  canRenameVariant,
  canSetDefault,
  canSetShared,
  confirmFieldPicker,
  findDuplicateVariantName,
  normalizeObjectDef,
  pickDefaultVariantId,
  variantStatusLabel,
  type FieldPickerItem,
  type VariantRow,
} from "./objectVariantLogic.ts";

const row = (over: Partial<VariantRow> & Pick<VariantRow, "id" | "name">): VariantRow => ({
  shared: false,
  isDefault: false,
  isStandard: false,
  canManage: true,
  definition: { header: [], sections: [] },
  author: "Ada",
  ...over,
});

describe("normalizeObjectDef", () => {
  test("passes through current shape", () => {
    const def: ObjectVariantDef = {
      header: [{ name: "DocNum", visible: true }],
      sections: [{ id: "general", visible: true, fields: [{ name: "Comments", visible: true }] }],
    };
    expect(normalizeObjectDef(def)).toEqual(def);
  });

  test("maps legacy { fields, sections } to header + sections once", () => {
    expect(
      normalizeObjectDef({
        fields: [{ name: "CardCode", visible: true }],
        sections: [{ id: "general", visible: true, fields: [{ name: "Comments", visible: false }] }],
      }),
    ).toEqual({
      header: [{ name: "CardCode", visible: true }],
      sections: [{ id: "general", visible: true, fields: [{ name: "Comments", visible: false }] }],
    });
  });

  test("empty / unknown becomes empty object def", () => {
    expect(normalizeObjectDef(null)).toEqual({ header: [], sections: [] });
    expect(normalizeObjectDef({ fields: [], sections: [] })).toEqual({ header: [], sections: [] });
  });
});

describe("duplicate personal/shared names", () => {
  const variants = [
    row({ id: "p1", name: "Mine", shared: false }),
    row({ id: "s1", name: "Mine", shared: true }),
    row({ id: "p2", name: "Other", shared: false }),
  ];

  test("personal names collide only within personal scope", () => {
    expect(findDuplicateVariantName(variants, "Mine", false)?.id).toBe("p1");
    expect(findDuplicateVariantName(variants, "Mine", true)?.id).toBe("s1");
    expect(findDuplicateVariantName(variants, "Other", true)).toBeUndefined();
  });

  test("excludeId allows renaming a row to its own name", () => {
    expect(findDuplicateVariantName(variants, "Mine", false, "p1")).toBeUndefined();
  });

  test("comparison is case-insensitive and trims", () => {
    expect(findDuplicateVariantName(variants, "  mine  ", false)?.id).toBe("p1");
  });
});

describe("selected / default / shared labels", () => {
  test("composes status labels for list items", () => {
    expect(variantStatusLabel({ isDefault: true, shared: true }, true)).toBe("Selected · Default · Shared");
    expect(variantStatusLabel({ isDefault: true, shared: false }, false)).toBe("Default");
    expect(variantStatusLabel({ isDefault: false, shared: true }, false)).toBe("Shared");
    expect(variantStatusLabel({ isDefault: false, shared: false }, true)).toBe("Selected");
    expect(variantStatusLabel({ isDefault: false, shared: false }, false)).toBe("");
  });
});

describe("dirty comparison", () => {
  test("sameDef detects draft edits vs selected definition", () => {
    const saved: ObjectVariantDef = {
      header: [{ name: "DocNum", visible: true }],
      sections: [{ id: "general", visible: true, fields: [{ name: "Comments", visible: true }] }],
    };
    const draft: ObjectVariantDef = {
      header: [{ name: "DocNum", visible: true }],
      sections: [{ id: "general", visible: true, fields: [{ name: "Comments", visible: false }] }],
    };
    expect(sameDef(saved, saved)).toBe(true);
    expect(sameDef(draft, saved)).toBe(false);
  });
});

describe("Standard protection and permissions", () => {
  const standard = row({
    id: "std",
    name: "Standard",
    shared: true,
    isStandard: true,
    canManage: true,
  });
  const personal = row({ id: "p1", name: "Mine", canManage: true });
  const sharedOther = row({ id: "s1", name: "Team", shared: true, canManage: false });

  test("Standard cannot be renamed or deleted even when canManage", () => {
    expect(canRenameVariant(standard)).toBe(false);
    expect(canDeleteVariant(standard)).toBe(false);
  });

  test("owner can rename/delete personal variants", () => {
    expect(canRenameVariant(personal)).toBe(true);
    expect(canDeleteVariant(personal)).toBe(true);
  });

  test("non-admin cannot manage shared they do not own", () => {
    expect(canRenameVariant(sharedOther)).toBe(false);
    expect(canDeleteVariant(sharedOther)).toBe(false);
  });

  test("sharing is admin-only and blocked for Standard", () => {
    expect(canSetShared(personal, true)).toBe(true);
    expect(canSetShared(personal, false)).toBe(false);
    expect(canSetShared(standard, true)).toBe(false);
  });

  test("Default toggle requires canManage and is blocked for Standard", () => {
    expect(canSetDefault(personal)).toBe(true);
    expect(canSetDefault(sharedOther)).toBe(false);
    expect(canSetDefault(standard)).toBe(false);
  });
});

describe("pickDefaultVariantId", () => {
  test("personal default wins over shared default", () => {
    const variants = [
      row({ id: "shared-def", name: "Standard", shared: true, isDefault: true, isStandard: true }),
      row({ id: "mine", name: "Mine", isDefault: true }),
    ];
    expect(pickDefaultVariantId(variants)).toBe("mine");
  });

  test("falls back to first row", () => {
    expect(pickDefaultVariantId([row({ id: "a", name: "A" }), row({ id: "b", name: "B" })])).toBe("a");
    expect(pickDefaultVariantId([])).toBeNull();
  });
});

describe("FieldPicker confirm", () => {
  test("preserves ordered field arrays and applies visibility, label, width", () => {
    const draft: FieldPickerItem[] = [
      { name: "ItemCode", visible: true, label: "Item", defaultLabel: "ItemCode", width: 120 },
      { name: "Quantity", visible: false, label: "Quantity", defaultLabel: "Quantity" },
      { name: "UnitPrice", visible: true, label: "UnitPrice", defaultLabel: "UnitPrice" },
    ];
    expect(confirmFieldPicker(draft)).toEqual([
      { name: "ItemCode", visible: true, label: "Item", width: 120 },
      { name: "Quantity", visible: false },
      { name: "UnitPrice", visible: true },
    ]);
  });

  test("Reset to Auto clears width; empty label override is omitted", () => {
    const draft: FieldPickerItem[] = [
      { name: "Comments", visible: true, label: "  ", defaultLabel: "Comments", width: undefined },
    ];
    expect(confirmFieldPicker(draft)).toEqual([{ name: "Comments", visible: true }]);
  });
});
