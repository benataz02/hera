import type { EntityProfile } from "@hera/db";

const DOCUMENT_LINES = {
  DocumentLines: {
    parentKey: "DocEntry",
    childParentKey: "DocEntry",
    rowKey: "LineNum",
    editable: true,
  },
} as const;

const DOCUMENT_READ_ONLY = [
  "DocEntry",
  "DocNum",
  "DocTotal",
  "VatSum",
  "DocTotalFc",
  "VatSumFc",
  "DocumentStatus",
  "Cancelled",
  "CreateDate",
  "UpdateDate",
  "DataVersion",
  "Series",
];

const DOCUMENT_EDITABLE_HEADER = [
  "CardCode",
  "CardName",
  "DocDate",
  "DocDueDate",
  "TaxDate",
  "DocCurrency",
  "SalesPersonCode",
  "DocumentsOwner",
  "Comments",
  "NumAtCard",
  "PaymentGroupCode",
  "TransportationCode",
  "ShipToCode",
  "PayToCode",
];

const DOCUMENT_LINE_EDITABLE = [
  "ItemCode",
  "ItemDescription",
  "Quantity",
  "UnitPrice",
  "DiscountPercent",
  "TaxCode",
  "WarehouseCode",
  "UoMCode",
  "UoMEntry",
];

const DOCUMENT_EDIT_WHEN = [
  { field: "DocumentStatus", allowed: ["bost_Open"] as Array<string | number | boolean> },
  { field: "Cancelled", allowed: ["tNO", "N", false] },
];

function documentProfile(
  entity: string,
  family: "sales-document" | "purchase-document",
): EntityProfile {
  return {
    entity,
    family,
    titleField: "DocNum",
    subtitleFields: ["CardCode", "CardName"],
    fields: {
      editableHeader: [...DOCUMENT_EDITABLE_HEADER],
      requiredOnCreate: ["CardCode"],
      readOnly: [...DOCUMENT_READ_ONLY],
      collectionEditable: { DocumentLines: [...DOCUMENT_LINE_EDITABLE] },
      editWhen: DOCUMENT_EDIT_WHEN.map((x) => ({ ...x, allowed: [...x.allowed] })),
    },
    create: { dedupField: "U_HERA_DedupKey", resultKey: "DocEntry" },
    collections: { ...DOCUMENT_LINES },
  };
}

const SALES_ENTITIES = [
  "Quotations",
  "Orders",
  "Invoices",
  "DeliveryNotes",
  "CreditNotes",
  "DownPayments",
  "Returns",
] as const;

const PURCHASE_ENTITIES = [
  "PurchaseOrders",
  "PurchaseInvoices",
  "PurchaseDeliveryNotes",
  "PurchaseCreditNotes",
  "PurchaseDownPayments",
  "PurchaseReturns",
] as const;

const ITEMS: EntityProfile = {
  entity: "Items",
  family: "master-data",
  titleField: "ItemCode",
  subtitleFields: ["ItemName"],
  fields: {
    editableHeader: ["ItemName", "ForeignName", "ItemsGroupCode", "ItemType", "BarCode"],
    requiredOnCreate: ["ItemCode", "ItemName"],
    readOnly: ["ItemCode", "CreateDate", "UpdateDate", "DataVersion"],
    collectionEditable: {},
    editWhen: [],
  },
  collections: {},
};

const BUSINESS_PARTNERS: EntityProfile = {
  entity: "BusinessPartners",
  family: "master-data",
  titleField: "CardCode",
  subtitleFields: ["CardName"],
  fields: {
    editableHeader: [
      "CardName",
      "CardType",
      "GroupCode",
      "Phone1",
      "EmailAddress",
      "Currency",
      "FederalTaxID",
    ],
    requiredOnCreate: ["CardCode", "CardName", "CardType"],
    readOnly: ["CardCode", "CreateDate", "UpdateDate", "DataVersion"],
    collectionEditable: {},
    editWhen: [],
  },
  collections: {},
};

const BY_NAME = new Map<string, EntityProfile>([
  ...SALES_ENTITIES.map((e) => [e, documentProfile(e, "sales-document")] as const),
  ...PURCHASE_ENTITIES.map((e) => [e, documentProfile(e, "purchase-document")] as const),
  ["Items", ITEMS],
  ["BusinessPartners", BUSINESS_PARTNERS],
]);

export function getEntityProfile(entity: string): EntityProfile | null {
  return BY_NAME.get(entity) ?? null;
}
