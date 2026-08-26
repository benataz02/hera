/**
 * SAP Business One Constants and Reference Data
 * Provides reference data for object types, document codes, and common field patterns
 */

interface B1ObjectType {
    code: number;
    name: string;
    entityName: string;
    description: string;
}

interface B1DocumentFlow {
    name: string;
    sourceType: number;
    sourceEntity: string;
    targetType: number;
    targetEntity: string;
    description: string;
}

interface B1FieldPattern {
    fieldName: string;
    description: string;
    type: string;
    examples: string[];
}

/**
 * SAP Business One Object Type Codes
 * Used for BaseType in document references
 */
export const B1_OBJECT_TYPES: Record<string, B1ObjectType> = {
    // Sales Documents
    QUOTATIONS: {
        code: 23,
        name: 'Quotations',
        entityName: 'Quotations',
        description: 'Sales Quotations'
    },
    ORDERS: {
        code: 17,
        name: 'Orders',
        entityName: 'Orders',
        description: 'Sales Orders'
    },
    DELIVERY_NOTES: {
        code: 15,
        name: 'DeliveryNotes',
        entityName: 'DeliveryNotes',
        description: 'Delivery Notes'
    },
    RETURNS: {
        code: 16,
        name: 'Returns',
        entityName: 'Returns',
        description: 'Returns (Goods Return)'
    },
    INVOICES: {
        code: 13,
        name: 'Invoices',
        entityName: 'Invoices',
        description: 'A/R Invoices'
    },
    CREDIT_NOTES: {
        code: 14,
        name: 'CreditNotes',
        entityName: 'CreditNotes',
        description: 'A/R Credit Notes'
    },
    DOWN_PAYMENTS: {
        code: 203,
        name: 'DownPayments',
        entityName: 'DownPayments',
        description: 'Down Payments'
    },

    // Purchase Documents
    PURCHASE_QUOTATIONS: {
        code: 540000006,
        name: 'PurchaseQuotations',
        entityName: 'PurchaseQuotations',
        description: 'Purchase Quotations'
    },
    PURCHASE_ORDERS: {
        code: 22,
        name: 'PurchaseOrders',
        entityName: 'PurchaseOrders',
        description: 'Purchase Orders'
    },
    GOODS_RECEIPT_PO: {
        code: 20,
        name: 'PurchaseDeliveryNotes',
        entityName: 'PurchaseDeliveryNotes',
        description: 'Goods Receipt PO'
    },
    GOODS_RETURN: {
        code: 21,
        name: 'PurchaseReturns',
        entityName: 'PurchaseReturns',
        description: 'Goods Return'
    },
    PURCHASE_INVOICES: {
        code: 18,
        name: 'PurchaseInvoices',
        entityName: 'PurchaseInvoices',
        description: 'A/P Invoices'
    },
    PURCHASE_CREDIT_NOTES: {
        code: 19,
        name: 'PurchaseCreditNotes',
        entityName: 'PurchaseCreditNotes',
        description: 'A/P Credit Notes'
    },

    // Payment Documents
    INCOMING_PAYMENTS: {
        code: 24,
        name: 'IncomingPayments',
        entityName: 'IncomingPayments',
        description: 'Incoming Payments (Customer Payments)'
    },
    VENDOR_PAYMENTS: {
        code: 46,
        name: 'VendorPayments',
        entityName: 'VendorPayments',
        description: 'Outgoing Payments (Vendor Payments)'
    },

    // Inventory Documents
    INVENTORY_GEN_ENTRY: {
        code: 59,
        name: 'InventoryGenEntries',
        entityName: 'InventoryGenEntries',
        description: 'Goods Receipt'
    },
    INVENTORY_GEN_EXIT: {
        code: 60,
        name: 'InventoryGenExits',
        entityName: 'InventoryGenExits',
        description: 'Goods Issue'
    },
    INVENTORY_TRANSFER: {
        code: 67,
        name: 'StockTransfers',
        entityName: 'StockTransfers',
        description: 'Inventory Transfer'
    },

    // Master Data
    BUSINESS_PARTNERS: {
        code: 2,
        name: 'BusinessPartners',
        entityName: 'BusinessPartners',
        description: 'Business Partners (Customers/Vendors)'
    },
    ITEMS: {
        code: 4,
        name: 'Items',
        entityName: 'Items',
        description: 'Items (Products)'
    }
};

/**
 * Common document flows in SAP Business One
 */
export const B1_DOCUMENT_FLOWS: Record<string, B1DocumentFlow> = {
    QUOTATION_TO_ORDER: {
        name: 'Quotation to Sales Order',
        sourceType: 23,
        sourceEntity: 'Quotations',
        targetType: 17,
        targetEntity: 'Orders',
        description: 'Convert Sales Quotation to Sales Order'
    },
    ORDER_TO_DELIVERY: {
        name: 'Sales Order to Delivery',
        sourceType: 17,
        sourceEntity: 'Orders',
        targetType: 15,
        targetEntity: 'DeliveryNotes',
        description: 'Create Delivery Note from Sales Order'
    },
    DELIVERY_TO_INVOICE: {
        name: 'Delivery to Invoice',
        sourceType: 15,
        sourceEntity: 'DeliveryNotes',
        targetType: 13,
        targetEntity: 'Invoices',
        description: 'Create A/R Invoice from Delivery Note'
    },
    ORDER_TO_INVOICE: {
        name: 'Sales Order to Invoice',
        sourceType: 17,
        sourceEntity: 'Orders',
        targetType: 13,
        targetEntity: 'Invoices',
        description: 'Create A/R Invoice directly from Sales Order (skip delivery)'
    },
    INVOICE_TO_PAYMENT: {
        name: 'Invoice to Payment',
        sourceType: 13,
        sourceEntity: 'Invoices',
        targetType: 24,
        targetEntity: 'IncomingPayments',
        description: 'Create Incoming Payment for A/R Invoice'
    },
    PO_TO_GRPO: {
        name: 'Purchase Order to Goods Receipt',
        sourceType: 22,
        sourceEntity: 'PurchaseOrders',
        targetType: 20,
        targetEntity: 'PurchaseDeliveryNotes',
        description: 'Create Goods Receipt from Purchase Order'
    },
    GRPO_TO_AP_INVOICE: {
        name: 'Goods Receipt to A/P Invoice',
        sourceType: 20,
        sourceEntity: 'PurchaseDeliveryNotes',
        targetType: 18,
        targetEntity: 'PurchaseInvoices',
        description: 'Create A/P Invoice from Goods Receipt'
    },
    AP_INVOICE_TO_PAYMENT: {
        name: 'A/P Invoice to Payment',
        sourceType: 18,
        sourceEntity: 'PurchaseInvoices',
        targetType: 46,
        targetEntity: 'VendorPayments',
        description: 'Create Vendor Payment for A/P Invoice'
    }
};

/**
 * Common field patterns in SAP Business One
 */
export const B1_FIELD_PATTERNS: Record<string, B1FieldPattern> = {
    DOCUMENT_KEYS: {
        fieldName: 'DocEntry / DocNum',
        description: 'Document unique identifiers',
        type: 'number',
        examples: ['DocEntry: Internal key (e.g., 123)', 'DocNum: User-visible number (e.g., 1001)']
    },
    BUSINESS_PARTNER_KEYS: {
        fieldName: 'CardCode / CardName',
        description: 'Business Partner identifiers',
        type: 'string',
        examples: ['CardCode: "C20000"', 'CardName: "ABC Customer"']
    },
    ITEM_KEYS: {
        fieldName: 'ItemCode / ItemName',
        description: 'Item identifiers',
        type: 'string',
        examples: ['ItemCode: "A00001"', 'ItemName: "Product Name"']
    },
    DATES: {
        fieldName: 'DocDate / DocDueDate / TaxDate',
        description: 'Document dates',
        type: 'date (YYYY-MM-DD)',
        examples: ['DocDate: "2025-12-31"', 'DocDueDate: "2025-12-31"']
    },
    BASE_DOCUMENT: {
        fieldName: 'BaseType / BaseEntry / BaseLine',
        description: 'Reference to source document',
        type: 'number',
        examples: [
            'BaseType: Object type code (e.g., 17 for Orders)',
            'BaseEntry: Source DocEntry',
            'BaseLine: Line number in source document (0-based)'
        ]
    },
    DOCUMENT_LINES: {
        fieldName: 'DocumentLines',
        description: 'Collection of line items in document',
        type: 'array',
        examples: [
            'ItemCode: Item to order/deliver/invoice',
            'Quantity: Quantity',
            'Price: Unit price',
            'VatGroup: Tax code', //for EU
            'TaxCode: Tax code', //for US
            'WarehouseCode: Warehouse (if applicable)'
        ]
    }
};

/**
 * Document status codes
 */
export const B1_DOCUMENT_STATUS = {
    OPEN: 'bost_Open',
    CLOSED: 'bost_Close',
    CANCELLED: 'bost_Cancelled'
};

/**
 * Line status codes
 */
export const B1_LINE_STATUS = {
    OPEN: 'bost_Open',
    CLOSED: 'bost_Close'
};

/**
 * Payment types
 */
export const B1_PAYMENT_TYPES = {
    CUSTOMER: 'rCustomer',
    VENDOR: 'rSupplier',
    ACCOUNT: 'rAccount'
};

/**
 * Business Partner types
 */
export const B1_BP_TYPES = {
    CUSTOMER: 'cCustomer',
    VENDOR: 'cSupplier',
    LEAD: 'cLid'
};

/**
 * Helper function to get object type by entity name
 */
export function getObjectTypeByEntity(entityName: string): B1ObjectType | undefined {
    return Object.values(B1_OBJECT_TYPES).find(
        ot => ot.entityName.toLowerCase() === entityName.toLowerCase()
    );
}

/**
 * Helper function to get document flow
 */
export function getDocumentFlow(sourceEntity: string, targetEntity: string): B1DocumentFlow | undefined {
    return Object.values(B1_DOCUMENT_FLOWS).find(
        flow => flow.sourceEntity.toLowerCase() === sourceEntity.toLowerCase() &&
            flow.targetEntity.toLowerCase() === targetEntity.toLowerCase()
    );
}

/**
 * Helper function to validate if a document flow is supported
 */
export function isValidDocumentFlow(sourceEntity: string, targetEntity: string): boolean {
    return getDocumentFlow(sourceEntity, targetEntity) !== undefined;
}
