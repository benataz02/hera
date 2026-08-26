/**
 * Type definitions for SAP Business One workflow operations
 */

/**
 * Payment allocation method
 */
export type PaymentAllocationType = 'auto' | 'manual';

/**
 * Manual payment allocation for a specific invoice
 */
export interface ManualPaymentAllocation {
    docEntry: number;
    amountToApply: number;
}

/**
 * Invoice details with payment information
 */
export interface InvoicePaymentDetails {
    docEntry: number;
    docNum: string;
    docDate: string;
    docTotal: number;
    paidToDate: number;
    openBalance: number;
    amountToApply: number;
    remainingAfterPayment: number;
    status: 'OK' | 'WARNING' | 'ERROR';
    message?: string;
}

/**
 * Payment validation result
 */
export interface PaymentValidationResult {
    valid: boolean;
    totalOpenAmount: number;
    totalToApply: number;
    warnings: string[];
    errors: string[];
}

/**
 * Payment creation result
 */
export interface PaymentCreationResult {
    docEntry: number;
    docNum: string;
    message: string;
}

/**
 * Complete payment preparation result
 */
export interface PaymentPreparationResult {
    validation: PaymentValidationResult;
    invoices: InvoicePaymentDetails[];
    payment?: PaymentCreationResult;
}

/**
 * Document line with optional base reference
 */
export interface DocumentLineWithBase {
    ItemCode?: string;
    ItemDescription?: string;
    Quantity?: number;
    Price?: number;
    WarehouseCode?: string;
    TaxCode?: string;
    BaseType?: number;
    BaseEntry?: number;
    BaseLine?: number;
    [key: string]: unknown;
}

/**
 * Source document information for copying
 */
export interface SourceDocumentInfo {
    docEntry: number;
    docNum: string;
    cardCode: string;
    cardName: string;
    docDate: string;
    docDueDate: string;
    documentLines: DocumentLineWithBase[];
    [key: string]: unknown;
}

/**
 * Document creation from base result
 */
export interface DocumentFromBaseResult {
    success: boolean;
    targetDocument?: {
        docEntry: number;
        docNum: string;
        entityName: string;
    };
    error?: string;
    sourceDocument: {
        docEntry: number;
        docNum: string;
        entityName: string;
    };
}
