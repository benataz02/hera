import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditRecord = vi.hoisted(() => vi.fn());
const requireWriteConfirmation = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../loggers/audit-logger.js', () => ({
    AuditLogger: class {
        record(entry: unknown): void {
            auditRecord(entry);
        }
    }
}));

vi.mock('../../tools/b1-elicitation.js', () => ({
    requireWriteConfirmation,
}));

vi.mock('../../services/b1-document-service.js', () => ({
    B1DocumentService: class {
        createDocumentFromBase = vi.fn(async () => ({
            success: true,
            sourceDocument: { entityName: 'Orders', docEntry: 10, docNum: 1000 },
            targetDocument: { entityName: 'Invoices', docEntry: 20, docNum: 2000 }
        }));
    }
}));

vi.mock('../../services/b1-payment-service.js', () => ({
    B1PaymentService: class {
        preparePaymentForInvoices = vi.fn(async () => ({
            validation: {
                valid: true,
                totalOpenAmount: 100,
                totalToApply: 100,
                errors: [],
                warnings: []
            },
            invoices: [
                { docNum: 101, docEntry: 101, docTotal: 100, paidToDate: 0, openBalance: 100, amountToApply: 100, remainingAfterPayment: 0, status: 'OK' }
            ],
            payment: undefined
        }));

        createPayment = vi.fn(async () => ({
            docEntry: 300,
            docNum: 400,
            message: 'created'
        }));
    }
}));

function createLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    };
}

function createDiscoveryService() {
    const metadataManager = {
        getEntityList: vi.fn(() => [{ name: 'Orders' }, { name: 'IncomingPayments' }]),
        getEntitySchema: vi.fn(async (entityName: string) => ({
            name: entityName,
            entitySet: entityName,
            namespace: 'SAPB1',
            keys: ['DocEntry'],
            creatable: true,
            updatable: true,
            deletable: true,
            addressable: true,
            entityClass: 'standard',
            properties: new Map([
                ['DocEntry', { name: 'DocEntry', type: { name: 'Edm.Int32', category: 0, isArray: false } }],
                ['CardCode', { name: 'CardCode', type: { name: 'Edm.String', category: 0, isArray: false }, isPersonalField: false }]
            ])
        })),
        getComplexTypeProperties: vi.fn(() => null)
    };

    return {
        getDiscoveredServices: vi.fn(async () => [{
            id: 'B1_SERVICE_LAYER',
            url: 'https://example.com/b1s/v2/',
            metadata: null
        }]),
        getB1MetadataManager: vi.fn(() => metadataManager)
    };
}

describe('workflow handlers audit logging', () => {
    beforeEach(() => {
        auditRecord.mockReset();
        requireWriteConfirmation.mockReset();
        requireWriteConfirmation.mockImplementation(async () => undefined);
    });

    it('logs write confirmation approval for createDocumentFromBase', async () => {
        const { createDocumentFromBase } = await import('../../tools/b1-workflow-handlers.js');
        const logger = createLogger();
        const discoveryService = createDiscoveryService();

        const result = await createDocumentFromBase({
            sourceEntityName: 'Orders',
            sourceDocEntry: 10,
            targetEntityName: 'Invoices',
            lineSelections: [0, 1],
            additionalFields: { Comments: 'Copy' }
        }, {
            sapClient: {
                getB1Client: vi.fn(() => undefined),
                getCompanyId: vi.fn(() => 'SBODEMOUS')
            } as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as { isError?: boolean }).isError).not.toBe(true);
        expect(requireWriteConfirmation).toHaveBeenCalledTimes(1);
        expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
            event: 'WriteConfirmationApproved',
            category: 'DataModification',
            subCategory: 'Create',
            outcome: 'info',
            details: expect.objectContaining({
                entityName: 'Invoices',
                sourceEntityName: 'Orders',
                sourceDocEntry: 10,
                targetEntityName: 'Invoices',
                lineSelections: [0, 1],
                hasAdditionalFields: true,
                confirmationType: 'mcp-elicitation'
            })
        }));
    });

    it('logs write confirmation approval for preparePaymentForInvoices', async () => {
        const { preparePaymentForInvoices } = await import('../../tools/b1-workflow-handlers.js');
        const logger = createLogger();
        const discoveryService = createDiscoveryService();

        const result = await preparePaymentForInvoices({
            cardCode: 'C20000',
            invoiceDocEntries: [101],
            paymentAmount: 100,
            validateOnly: false,
            transferAccount: '110000',
            transferDate: '2026-06-08',
            transferReference: 'TRX-1',
            remarks: 'Payment'
        }, {
            sapClient: {
                getB1Client: vi.fn(() => undefined),
                getCompanyId: vi.fn(() => 'SBODEMOUS')
            } as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as { isError?: boolean }).isError).not.toBe(true);
        expect(requireWriteConfirmation).toHaveBeenCalledTimes(1);
        expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
            event: 'WriteConfirmationApproved',
            category: 'DataModification',
            subCategory: 'Create',
            outcome: 'info',
            details: expect.objectContaining({
                entityName: 'IncomingPayments',
                businessPartnerCode: 'C20000',
                invoiceDocEntries: [101],
                invoiceCount: 1,
                totalToApply: 100,
                confirmationType: 'mcp-elicitation'
            })
        }));
    });
});