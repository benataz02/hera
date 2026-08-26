/**
 * Workflow handlers — b1_copy_document and b1_create_payment.
 */

import { B1Client } from '../services/b1-client.js';
import { B1DiscoveryService } from '../services/b1-discovery.js';
import { Logger } from '../loggers/app-logger.js';
import { AuditLogger } from '../loggers/audit-logger.js';
import { B1DocumentService } from '../services/b1-document-service.js';
import { B1PaymentService } from '../services/b1-payment-service.js';
import { McpToolRequestContext, requireWriteConfirmation } from './b1-elicitation.js';
import { getRequestContext } from '../utils/request-context.js';

export interface WorkflowContext {
    sapClient: B1Client;
    logger: Logger;
    discoveryService: B1DiscoveryService;
    /** Company DB for OAuth mode; undefined in direct mode */
    companyId?: string;
    mcpRequestContext?: McpToolRequestContext;
}

const auditLogger = new AuditLogger('b1-workflow');

async function getPersonalFieldNamesForEntity(
    ctx: WorkflowContext,
    entityName: string,
    fieldNames: readonly string[]
): Promise<string[] | undefined> {
    const metadataManager = ctx.discoveryService.getB1MetadataManager(ctx.companyId);
    if (!metadataManager) {
        return undefined;
    }

    const includedFieldNameSet = new Set(fieldNames.map((fieldName) => fieldName.toLowerCase()));

    try {
        const entitySchema = await metadataManager.getEntitySchema(entityName);
        const personalFieldNames = Array.from(entitySchema.properties.values())
            .filter((property) => property.isPersonalField && includedFieldNameSet.has(property.name.toLowerCase()))
            .map((property) => property.name)
            .sort();

        return personalFieldNames.length > 0 ? personalFieldNames : undefined;
    } catch {
        return undefined;
    }
}

function recordWorkflowWriteConfirmationAudit(options: {
    operation: 'create' | 'update' | 'delete';
    entityName: string;
    details: Record<string, unknown>;
}): void {
    const requestContext = getRequestContext();

    auditLogger.record({
        event: 'WriteConfirmationApproved',
        category: 'DataModification',
        subCategory: options.operation === 'create' ? 'Create' : options.operation === 'update' ? 'Update' : 'Delete',
        outcome: 'info',
        userName: requestContext?.userName,
        companyId: requestContext?.companyId,
        sourceIp: requestContext?.sourceIp,
        message: `${options.operation} ${options.entityName} confirmation approved`,
        details: {
            entityName: options.entityName,
            ...options.details,
            confirmationType: 'mcp-elicitation'
        }
    });
}

export async function createDocumentFromBase(
    args: Record<string, unknown>,
    ctx: WorkflowContext
) {
    try {
        const sourceEntityName = args.sourceEntityName as string;
        const sourceDocEntry = args.sourceDocEntry as number;
        const targetEntityName = args.targetEntityName as string;
        const lineSelections = args.lineSelections as number[] | undefined;
        const additionalFields = args.additionalFields as Record<string, unknown> | undefined;

        const discoveredServices = await ctx.discoveryService.getDiscoveredServices(
            ctx.companyId,
            ctx.sapClient.getB1Client()
        );
        const service = discoveredServices.find(s => s.id === 'B1_SERVICE_LAYER');
        if (!service) {
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: SAP B1 Service Layer not initialized.`
                }],
                isError: true
            };
        }

        await requireWriteConfirmation({
            requestContext: ctx.mcpRequestContext,
            operation: 'create',
            entityName: targetEntityName,
            summaryLines: [
                `Source: ${sourceEntityName} DocEntry ${sourceDocEntry}`,
                `Flow: ${sourceEntityName} -> ${targetEntityName}`,
                `Selected lines: ${lineSelections?.join(', ') ?? 'all'}`
            ],
            parameters: additionalFields,
            personalFieldNames: additionalFields
                ? await getPersonalFieldNamesForEntity(ctx, targetEntityName, Object.keys(additionalFields))
                : undefined
        });

        recordWorkflowWriteConfirmationAudit({
            operation: 'create',
            entityName: targetEntityName,
            details: {
                sourceEntityName,
                sourceDocEntry,
                targetEntityName,
                lineSelections: lineSelections ?? 'all',
                hasAdditionalFields: !!additionalFields
            }
        });

        const documentService = new B1DocumentService(ctx.sapClient, ctx.logger, service.url);
        const result = await documentService.createDocumentFromBase(
            sourceEntityName, sourceDocEntry, targetEntityName, lineSelections, additionalFields
        );

        if (!result.success) {
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: ${result.error}\n\nSource: ${result.sourceDocument.entityName} DocEntry ${result.sourceDocument.docEntry}`
                }],
                isError: true
            };
        }

        let responseText = `SUCCESS: Created ${result.targetDocument?.entityName} from ${result.sourceDocument.entityName}\n\n`;
        responseText += `Source Document:\n`;
        responseText += `  - Entity: ${result.sourceDocument.entityName}\n`;
        responseText += `  - DocEntry: ${result.sourceDocument.docEntry}\n`;
        responseText += `  - DocNum: ${result.sourceDocument.docNum}\n\n`;
        responseText += `Target Document Created:\n`;
        responseText += `  - Entity: ${result.targetDocument?.entityName}\n`;
        responseText += `  - DocEntry: ${result.targetDocument?.docEntry}\n`;
        responseText += `  - DocNum: ${result.targetDocument?.docNum}\n`;

        // structuredContent exposes the key document identifiers for code;
        // the text above with labels is kept for LLM agents.
        return {
            content: [{ type: "text" as const, text: responseText }],
            structuredContent: {
                source: result.sourceDocument,
                target: result.targetDocument
            }
        };

    } catch (error) {
        ctx.logger.error('Error creating document from base:', error);
        return {
            content: [{
                type: "text" as const,
                text: `ERROR: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
        };
    }
}

export async function preparePaymentForInvoices(
    args: Record<string, unknown>,
    ctx: WorkflowContext
) {
    try {
        const cardCode = args.cardCode as string;
        const invoiceDocEntries = args.invoiceDocEntries as number[];
        const paymentAmount = args.paymentAmount as number;
        const validateOnly = args.validateOnly === true;

        const discoveredServices = await ctx.discoveryService.getDiscoveredServices(
            ctx.companyId,
            ctx.sapClient.getB1Client()
        );
        const service = discoveredServices.find(s => s.id === 'B1_SERVICE_LAYER');
        if (!service) {
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: SAP B1 Service Layer not initialized.`
                }],
                isError: true
            };
        }

        const paymentService = new B1PaymentService(ctx.sapClient, ctx.logger, service.url);
        const result = await paymentService.preparePaymentForInvoices(
            cardCode,
            invoiceDocEntries,
            paymentAmount,
            {
                allocationType: (args.allocationType as 'auto' | 'manual') || 'auto',
                manualAllocations: args.manualAllocations as Array<{ docEntry: number; amountToApply: number }> | undefined,
                transferAccount: args.transferAccount as string,
                transferDate: args.transferDate as string,
                transferReference: args.transferReference as string,
                remarks: args.remarks as string,
                validateOnly: true
            }
        );

        if (!validateOnly && result.validation.valid) {
            await requireWriteConfirmation({
                requestContext: ctx.mcpRequestContext,
                operation: 'create',
                entityName: 'IncomingPayments',
                summaryLines: [
                    `Business Partner: ${cardCode}`,
                    `Invoices: ${invoiceDocEntries.join(', ')}`,
                    `Invoice count: ${result.invoices.length}`,
                    `Total to apply: ${result.validation.totalToApply.toFixed(2)}`
                ],
                
                // These parameters do not have any personal data.
                parameters: {
                    paymentAmount,
                    transferAccount: args.transferAccount,
                    transferDate: args.transferDate,
                    transferReference: args.transferReference,
                    remarks: args.remarks
                }
            });

            recordWorkflowWriteConfirmationAudit({
                operation: 'create',
                entityName: 'IncomingPayments',
                details: {
                    businessPartnerCode: cardCode,
                    invoiceDocEntries,
                    invoiceCount: result.invoices.length,
                    totalToApply: result.validation.totalToApply
                }
            });

            result.payment = await paymentService.createPayment(
                cardCode,
                result.invoices,
                paymentAmount,
                args.transferAccount as string,
                args.transferDate as string,
                args.transferReference as string,
                args.remarks as string
            );
        }

        let responseText = '';

        responseText += `[PAYMENT VALIDATION]\n\n`;
        responseText += `Status: ${result.validation.valid ? 'VALID' : 'INVALID'}\n`;
        responseText += `Total Open Amount: ${result.validation.totalOpenAmount.toFixed(2)}\n`;
        responseText += `Total to Apply: ${result.validation.totalToApply.toFixed(2)}\n`;

        if (result.validation.errors.length > 0) {
            responseText += `\nErrors:\n`;
            result.validation.errors.forEach(err => { responseText += `  ${err}\n`; });
        }

        if (result.validation.warnings.length > 0) {
            responseText += `\nWarnings:\n`;
            result.validation.warnings.forEach(warn => { responseText += `  ${warn}\n`; });
        }

        responseText += `\n[INVOICE DETAILS]\n\n`;
        for (const invoice of result.invoices) {
            responseText += `Invoice ${invoice.docNum} (DocEntry: ${invoice.docEntry}):\n`;
            responseText += `  - DocTotal: ${invoice.docTotal.toFixed(2)}\n`;
            responseText += `  - Paid to Date: ${invoice.paidToDate.toFixed(2)}\n`;
            responseText += `  - Open Balance: ${invoice.openBalance.toFixed(2)}\n`;
            responseText += `  - Amount to Apply: ${invoice.amountToApply.toFixed(2)}\n`;
            responseText += `  - Remaining After: ${invoice.remainingAfterPayment.toFixed(2)}\n`;
            responseText += `  - Status: ${invoice.status === 'OK' ? '✅' : invoice.status === 'WARNING' ? '⚠️' : '❌'} ${invoice.status}\n`;
            if (invoice.message) responseText += `  - Message: ${invoice.message}\n`;
            responseText += `\n`;
        }

        if (result.payment) {
            responseText += `[PAYMENT CREATED]\n\n`;
            responseText += `  Success!\n`;
            responseText += `  - DocEntry: ${result.payment.docEntry}\n`;
            responseText += `  - DocNum: ${result.payment.docNum}\n`;
            responseText += `  - Message: ${result.payment.message}\n`;
        } else if (validateOnly) {
            responseText += `[VALIDATION ONLY]\n\nNo payment was created (validateOnly=true)\n`;
        }

        // structuredContent exposes validation, invoice breakdown, and the created payment
        // (when applicable) for code; the formatted text above is kept for LLM agents.
        return {
            content: [{ type: "text" as const, text: responseText }],
            structuredContent: {
                validation: result.validation,
                invoices: result.invoices,
                ...(result.payment ? { payment: result.payment } : {})
            }
        };

    } catch (error) {
        ctx.logger.error('Error preparing payment:', error);
        return {
            content: [{
                type: "text" as const,
                text: `ERROR: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
        };
    }
}
