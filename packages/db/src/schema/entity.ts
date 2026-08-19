import { z } from "zod";

export type EnumOption = { value: string; text: string; numericValue?: number };
export type EntityProperty = {
  name: string;
  type: string;
  nullable: boolean;
  options?: EnumOption[];
  lookup?: { entitySet: string; valueField: string; labelField?: string };
};
export type CollectionSchema = {
  name: string;
  typeName: string;
  many: boolean;
  properties: EntityProperty[];
};
export type EntitySchema = {
  name: string;
  typeName: string;
  keys: string[];
  properties: EntityProperty[];
  collections: CollectionSchema[];
};
export type EnabledEntity = EntitySchema & { editable: boolean };

const EnumOptionZ = z.object({
  value: z.string(),
  text: z.string(),
  numericValue: z.number().optional(),
});
const LookupZ = z.object({
  entitySet: z.string(),
  valueField: z.string(),
  labelField: z.string().optional(),
});
const EntityPropertyZ: z.ZodType<EntityProperty> = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  options: z.array(EnumOptionZ).optional(),
  lookup: LookupZ.optional(),
});
const CollectionSchemaZ: z.ZodType<CollectionSchema> = z.object({
  name: z.string(),
  typeName: z.string(),
  many: z.boolean(),
  properties: z.array(EntityPropertyZ),
});
export const EntitySchemaZ: z.ZodType<EntitySchema> = z.object({
  name: z.string(),
  typeName: z.string(),
  keys: z.array(z.string()),
  properties: z.array(EntityPropertyZ),
  collections: z.array(CollectionSchemaZ),
});
export const EnabledEntityZ: z.ZodType<EnabledEntity> = EntitySchemaZ.and(
  z.object({ editable: z.boolean() }),
);

/** Shared serializable profile shape. Registry + authz stay server-owned. */
export type EntityProfile = {
  entity: string;
  family: "sales-document" | "purchase-document" | "master-data";
  titleField?: string;
  subtitleFields: string[];
  fields: {
    editableHeader: string[];
    requiredOnCreate: string[];
    readOnly: string[];
    collectionEditable: Record<string, string[]>;
    editWhen: Array<{ field: string; allowed: Array<string | number | boolean> }>;
  };
  create?: { dedupField: string; resultKey: string };
  collections: Record<
    string,
    {
      parentKey: string;
      childParentKey: string;
      rowKey: string;
      editable: boolean;
    }
  >;
};

export type EntityCapabilities = {
  canEdit: boolean;
  canCreate: boolean;
  reason?: string;
};
