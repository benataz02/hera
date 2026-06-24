import type { Model, FormSection, FormGroup, FormItem } from "@hera/config-engine";

// Short ids for builder nodes (client-only; the engine keys on item `name`, not `id`).
export const uid = (): string => Math.random().toString(36).slice(2, 10);

export const blankModel = (): Model => ({ name: "New model", family: "", sections: [], rules: [] });

export const blankSection = (): FormSection => ({ id: uid(), label: "New section", groups: [] });

export const blankGroup = (): FormGroup => ({ id: uid(), label: "New group", items: [] });

export const blankItem = (): FormItem => ({
  id: uid(),
  name: "field_" + uid().slice(0, 4),
  label: "New field",
  input: { mandatory: false, dataSource: { kind: "normal" }, inputType: "input", value: { kind: "manual" } },
});

// Walk every item once (used for the live preview's enumerate + the runtime render).
export const allItems = (m: Model): FormItem[] => m.sections.flatMap((s) => s.groups.flatMap((g) => g.items));
