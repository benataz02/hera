/**
 * SAP Business One Payment Service
 * Handles payment validation and creation operations
 */

import { B1Client } from './b1-client.js';
import { Logger } from '../loggers/app-logger.js';
import { B1_PAYMENT_TYPES } from '../tools/b1-constants.js';
import {
    InvoicePaymentDetails,
    PaymentValidationResult,
    PaymentCreationResult,
    PaymentPreparationResult,
    PaymentAllocationType,
    ManualPaymentAllocation
} from '../types/b1-workflow-types.js';

export class B1PaymentService {
    constructor(
        private readonly sapClient: B1Client,
        private readonly logger: Logger,
        private readonly serviceUrl: string
    ) { }

    /**
     * Fetch invoice details including open balance
     */
    private async getInvoiceDetails(docEntry: number): Promise<InvoicePaymentDetails | null> {
        try {
            const response = await this.sapClient.readEntity(
                this.serviceUrl,
                'Invoices',
                docEntry,
                false
            );

            if (!response.data) {
                return null;
            }

            const invoice = response.data as Record<string, unknown>;

            return {
                docEntry: invoice.DocEntry as number,
                docNum: invoice.DocNum as string,
                docDate: invoice.DocDate as string,
                docTotal: invoice.DocTotal as number,
                paidToDate: invoice.PaidToDate as number || 0,
                openBalance: (invoice.DocTotal as number) - ((invoice.PaidToDate as number) || 0),
                amountToApply: 0, // Will be set during allocation
                remainingAfterPayment: 0, // Will be calculated during allocation
                status: 'OK'
            };
        } catch (error) {
            this.logger.error(`Error fetching invoice ${docEntry}:`, error);
            return null;
        }
    }

    /**
     * Validate payment allocation against invoices
     */
    async validatePayment(
        cardCode: string,
        invoiceDocEntries: number[],
        paymentAmount: number,
        allocationType: PaymentAllocationType = 'auto',
        manualAllocations?: ManualPaymentAllocation[]
    ): Promise<PaymentValidationResult & { invoices: InvoicePaymentDetails[] }> {
        const validation: PaymentValidationResult = {
            valid: true,
            totalOpenAmount: 0,
            totalToApply: 0,
            warnings: [],
            errors: []
        };

        const invoices: InvoicePaymentDetails[] = [];

        // Fetch all invoice details
        for (const docEntry of invoiceDocEntries) {
            const invoice = await this.getInvoiceDetails(docEntry);

            if (!invoice) {
                validation.errors.push(`Invoice ${docEntry} not found`);
                validation.valid = false;
                continue;
            }

            // Check if invoice belongs to the specified business partner
            const invoiceData = await this.sapClient.readEntity(
                this.serviceUrl,
                'Invoices',
                docEntry,
                false
            );
            const invoiceCardCode = (invoiceData.data as Record<string, unknown>).CardCode as string;

            if (invoiceCardCode !== cardCode) {
                validation.errors.push(
                    `Invoice ${invoice.docNum} belongs to ${invoiceCardCode}, not ${cardCode}`
                );
                validation.valid = false;
                continue;
            }

            // Check if invoice is open
            if (invoice.openBalance <= 0) {
                validation.errors.push(
                    `Invoice ${invoice.docNum} is already fully paid (DocEntry: ${docEntry})`
                );
                validation.valid = false;
                continue;
            }

            validation.totalOpenAmount += invoice.openBalance;
            invoices.push(invoice);
        }

        // Apply allocation logic
        if (allocationType === 'auto') {
            // Auto-allocation: Allocate to invoices in order (oldest first)
            let remainingPayment = paymentAmount;

            for (const invoice of invoices) {
                if (remainingPayment <= 0) {
                    invoice.amountToApply = 0;
                    invoice.remainingAfterPayment = invoice.openBalance;
                    invoice.status = 'OK';
                    invoice.message = 'Not included in this payment';
                } else {
                    const amountToApply = Math.min(remainingPayment, invoice.openBalance);
                    invoice.amountToApply = amountToApply;
                    invoice.remainingAfterPayment = invoice.openBalance - amountToApply;
                    remainingPayment -= amountToApply;
                    validation.totalToApply += amountToApply;

                    if (invoice.remainingAfterPayment > 0) {
                        invoice.status = 'WARNING';
                        invoice.message = `Partial payment - ${invoice.remainingAfterPayment.toFixed(2)} will remain open`;
                    } else {
                        invoice.status = 'OK';
                        invoice.message = 'Will be fully paid';
                    }
                }
            }

            if (remainingPayment > 0) {
                validation.warnings.push(
                    `Payment amount ${paymentAmount} exceeds total open amount ${validation.totalOpenAmount}. ` +
                    `Excess: ${remainingPayment.toFixed(2)}`
                );
            }
        } else {
            // Manual allocation
            if (!manualAllocations || manualAllocations.length === 0) {
                validation.errors.push('Manual allocation requires manualAllocations parameter');
                validation.valid = false;
                return { ...validation, invoices };
            }

            const allocMap = new Map(manualAllocations.map(a => [a.docEntry, a.amountToApply]));

            for (const invoice of invoices) {
                const amountToApply = allocMap.get(invoice.docEntry) || 0;
                invoice.amountToApply = amountToApply;
                invoice.remainingAfterPayment = invoice.openBalance - amountToApply;
                validation.totalToApply += amountToApply;

                if (amountToApply > invoice.openBalance) {
                    invoice.status = 'ERROR';
                    invoice.message = `Amount ${amountToApply} exceeds open balance ${invoice.openBalance}`;
                    validation.errors.push(
                        `Invoice ${invoice.docNum}: Allocated amount ${amountToApply} exceeds open balance ${invoice.openBalance}`
                    );
                    validation.valid = false;
                } else if (invoice.remainingAfterPayment > 0) {
                    invoice.status = 'WARNING';
                    invoice.message = `Partial payment - ${invoice.remainingAfterPayment.toFixed(2)} will remain open`;
                } else {
                    invoice.status = 'OK';
                    invoice.message = 'Will be fully paid';
                }
            }

            if (Math.abs(validation.totalToApply - paymentAmount) > 0.01) {
                validation.warnings.push(
                    `Total allocated ${validation.totalToApply.toFixed(2)} does not match payment amount ${paymentAmount.toFixed(2)}`
                );
            }
        }

        return { ...validation, invoices };
    }

    /**
     * Create incoming payment for invoices
     */
    async createPayment(
        cardCode: string,
        invoices: InvoicePaymentDetails[],
        paymentAmount: number,
        transferAccount?: string,
        transferDate?: string,
        transferReference?: string,
        remarks?: string
    ): Promise<PaymentCreationResult> {
        try {
            // Build PaymentInvoices array
            const paymentInvoices = invoices
                .filter(inv => inv.amountToApply > 0)
                .map(inv => ({
                    DocEntry: inv.docEntry,
                    InstallmentId: 1,
                    SumApplied: inv.amountToApply
                }));

            if (paymentInvoices.length === 0) {
                throw new Error('No invoices with amounts to apply');
            }

            // Build payment document
            const paymentDocument = {
                CardCode: cardCode,
                DocType: B1_PAYMENT_TYPES.CUSTOMER,
                DocDate: transferDate || new Date().toISOString().split('T')[0],
                TransferAccount: transferAccount || '_SYS00000000001',
                TransferSum: paymentAmount,
                TransferDate: transferDate || new Date().toISOString().split('T')[0],
                TransferReference: transferReference || '',
                Remarks: remarks || `Payment for ${paymentInvoices.length} invoice(s) via MCP`,
                PaymentInvoices: paymentInvoices
            };

            this.logger.debug(`Creating payment for ${cardCode} with ${paymentInvoices.length} invoices`);

            const response = await this.sapClient.createEntity(
                this.serviceUrl,
                'IncomingPayments',
                paymentDocument
            );

            const responseData = response.data as Record<string, unknown>;
            if (!responseData?.DocEntry) {
                throw new Error('Payment created but DocEntry not returned');
            }

            return {
                docEntry: responseData.DocEntry as number,
                docNum: (responseData.DocNum as string) || '',
                message: `Payment created successfully for ${paymentInvoices.length} invoice(s)`
            };
        } catch (error) {
            this.logger.error('Error creating payment:', error);
            throw error;
        }
    }

    /**
     * Prepare payment for invoices (validate and optionally create)
     */
    async preparePaymentForInvoices(
        cardCode: string,
        invoiceDocEntries: number[],
        paymentAmount: number,
        options: {
            allocationType?: PaymentAllocationType;
            manualAllocations?: ManualPaymentAllocation[];
            transferAccount?: string;
            transferDate?: string;
            transferReference?: string;
            remarks?: string;
            validateOnly?: boolean;
        } = {}
    ): Promise<PaymentPreparationResult> {
        try {
            // Validate payment
            const validationResult = await this.validatePayment(
                cardCode,
                invoiceDocEntries,
                paymentAmount,
                options.allocationType || 'auto',
                options.manualAllocations
            );

            const result: PaymentPreparationResult = {
                validation: {
                    valid: validationResult.valid,
                    totalOpenAmount: validationResult.totalOpenAmount,
                    totalToApply: validationResult.totalToApply,
                    warnings: validationResult.warnings,
                    errors: validationResult.errors
                },
                invoices: validationResult.invoices
            };

            // If validation failed or validateOnly is true, return without creating
            if (!validationResult.valid || options.validateOnly) {
                return result;
            }

            // Create payment when validation passes
            const payment = await this.createPayment(
                cardCode,
                validationResult.invoices,
                paymentAmount,
                options.transferAccount,
                options.transferDate,
                options.transferReference,
                options.remarks
            );

            result.payment = payment;

            return result;
        } catch (error) {
            this.logger.error('Error preparing payment:', error);
            throw error;
        }
    }
}
