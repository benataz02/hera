import { beforeEach, describe, expect, it, vi } from 'vitest';

import { B1PaymentService } from '../../services/b1-payment-service.js';
import { B1Client } from '../../services/b1-client.js';
import { Logger } from '../../loggers/app-logger.js';

const SERVICE_URL = 'https://localhost:50000/b1s/v2/';

/** Minimal invoice API response (DocTotal=1000, PaidToDate=0 → openBalance=1000) */
function makeInvoiceResponse(docEntry: number, cardCode = 'C20000', paidToDate = 0, docTotal = 1000) {
    return {
        data: {
            DocEntry: docEntry,
            DocNum: `INV-${docEntry}`,
            DocDate: '2026-04-01',
            DocTotal: docTotal,
            PaidToDate: paidToDate,
            CardCode: cardCode
        }
    };
}

describe('B1PaymentService', () => {
    let service: B1PaymentService;
    let mockSAPClient: B1Client;
    let mockLogger: Logger;

    beforeEach(() => {
        mockSAPClient = {
            readEntity: vi.fn(),
            createEntity: vi.fn()
        } as unknown as B1Client;

        mockLogger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        } as unknown as Logger;

        service = new B1PaymentService(mockSAPClient, mockLogger, SERVICE_URL);
    });

    // -----------------------------------------------------------------------
    // validatePayment — auto allocation
    // -----------------------------------------------------------------------

    describe('validatePayment — auto allocation', () => {
        it('returns error when invoice is not found', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null });

            const result = await service.validatePayment('C20000', [999], 500);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Invoice 999 not found');
            expect(result.invoices).toHaveLength(0);
        });

        it('returns error when invoice belongs to a different business partner', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C99999'));

            const result = await service.validatePayment('C20000', [101], 500);

            expect(result.valid).toBe(false);
            expect(result.errors[0]).toMatch(/belongs to C99999, not C20000/);
        });

        it('returns error when invoice is already fully paid', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000', 1000, 1000));

            const result = await service.validatePayment('C20000', [101], 500);

            expect(result.valid).toBe(false);
            expect(result.errors[0]).toMatch(/already fully paid/);
        });

        it('fully allocates payment to a single invoice', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000', 0, 1000));

            const result = await service.validatePayment('C20000', [101], 1000);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.totalOpenAmount).toBe(1000);
            expect(result.totalToApply).toBe(1000);
            expect(result.invoices[0].amountToApply).toBe(1000);
            expect(result.invoices[0].remainingAfterPayment).toBe(0);
            expect(result.invoices[0].status).toBe('OK');
            expect(result.invoices[0].message).toBe('Will be fully paid');
        });

        it('partially allocates payment and sets WARNING status', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000', 0, 1000));

            const result = await service.validatePayment('C20000', [101], 600);

            expect(result.valid).toBe(true);
            expect(result.invoices[0].amountToApply).toBe(600);
            expect(result.invoices[0].remainingAfterPayment).toBe(400);
            expect(result.invoices[0].status).toBe('WARNING');
            expect(result.invoices[0].message).toMatch(/400\.00 will remain open/);
        });

        it('distributes payment across multiple invoices oldest-first', async () => {
            const readEntity = mockSAPClient.readEntity as ReturnType<typeof vi.fn>;
            readEntity
                .mockResolvedValueOnce(makeInvoiceResponse(101, 'C20000', 0, 600))
                .mockResolvedValueOnce(makeInvoiceResponse(101, 'C20000', 0, 600))  // CardCode check
                .mockResolvedValueOnce(makeInvoiceResponse(102, 'C20000', 0, 800))
                .mockResolvedValueOnce(makeInvoiceResponse(102, 'C20000', 0, 800)); // CardCode check

            const result = await service.validatePayment('C20000', [101, 102], 1000);

            expect(result.valid).toBe(true);
            expect(result.totalOpenAmount).toBe(1400);
            expect(result.totalToApply).toBe(1000);

            const [inv1, inv2] = result.invoices;
            expect(inv1.amountToApply).toBe(600);   // fully paid
            expect(inv1.status).toBe('OK');
            expect(inv2.amountToApply).toBe(400);   // partial
            expect(inv2.status).toBe('WARNING');
        });

        it('adds warning when payment exceeds total open amount', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000', 0, 500));

            const result = await service.validatePayment('C20000', [101], 800);

            expect(result.valid).toBe(true);
            expect(result.warnings[0]).toMatch(/exceeds total open amount/);
            expect(result.warnings[0]).toMatch(/Excess: 300\.00/);
        });

        it('leaves later invoices untouched when payment is exhausted', async () => {
            const readEntity = mockSAPClient.readEntity as ReturnType<typeof vi.fn>;
            readEntity
                .mockResolvedValueOnce(makeInvoiceResponse(101, 'C20000', 0, 1000))
                .mockResolvedValueOnce(makeInvoiceResponse(101, 'C20000', 0, 1000))
                .mockResolvedValueOnce(makeInvoiceResponse(102, 'C20000', 0, 500))
                .mockResolvedValueOnce(makeInvoiceResponse(102, 'C20000', 0, 500));

            const result = await service.validatePayment('C20000', [101, 102], 1000);

            const [inv1, inv2] = result.invoices;
            expect(inv1.amountToApply).toBe(1000);
            expect(inv2.amountToApply).toBe(0);
            expect(inv2.status).toBe('OK');
            expect(inv2.message).toBe('Not included in this payment');
        });
    });

    // -----------------------------------------------------------------------
    // validatePayment — manual allocation
    // -----------------------------------------------------------------------

    describe('validatePayment — manual allocation', () => {
        it('returns error when manualAllocations is missing', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000'));

            const result = await service.validatePayment('C20000', [101], 500, 'manual');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Manual allocation requires manualAllocations parameter');
        });

        it('applies exact manual allocation amounts', async () => {
            const readEntity = mockSAPClient.readEntity as ReturnType<typeof vi.fn>;
            readEntity
                .mockResolvedValueOnce(makeInvoiceResponse(101, 'C20000', 0, 1000))
                .mockResolvedValueOnce(makeInvoiceResponse(101, 'C20000', 0, 1000))
                .mockResolvedValueOnce(makeInvoiceResponse(102, 'C20000', 0, 800))
                .mockResolvedValueOnce(makeInvoiceResponse(102, 'C20000', 0, 800));

            const result = await service.validatePayment(
                'C20000', [101, 102], 900, 'manual',
                [{ docEntry: 101, amountToApply: 400 }, { docEntry: 102, amountToApply: 500 }]
            );

            expect(result.valid).toBe(true);
            expect(result.invoices[0].amountToApply).toBe(400);
            expect(result.invoices[1].amountToApply).toBe(500);
            expect(result.totalToApply).toBe(900);
        });

        it('returns error when manual amount exceeds invoice open balance', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000', 0, 300));

            const result = await service.validatePayment(
                'C20000', [101], 500, 'manual',
                [{ docEntry: 101, amountToApply: 500 }]
            );

            expect(result.valid).toBe(false);
            expect(result.invoices[0].status).toBe('ERROR');
            expect(result.errors[0]).toMatch(/exceeds open balance/);
        });

        it('adds warning when total manual allocation does not match payment amount', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000', 0, 1000));

            const result = await service.validatePayment(
                'C20000', [101], 500, 'manual',
                [{ docEntry: 101, amountToApply: 300 }]
            );

            expect(result.valid).toBe(true);
            expect(result.warnings[0]).toMatch(/does not match payment amount/);
        });
    });

    // -----------------------------------------------------------------------
    // createPayment
    // -----------------------------------------------------------------------

    describe('createPayment', () => {
        it('creates incoming payment and returns DocEntry + DocNum', async () => {
            (mockSAPClient.createEntity as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { DocEntry: 77, DocNum: 'PAY-77' }
            });

            const invoices = [
                {
                    docEntry: 101, docNum: 'INV-101', docDate: '2026-04-01',
                    docTotal: 1000, paidToDate: 0, openBalance: 1000,
                    amountToApply: 1000, remainingAfterPayment: 0, status: 'OK' as const
                }
            ];

            const result = await service.createPayment('C20000', invoices, 1000);

            expect(result.docEntry).toBe(77);
            expect(result.docNum).toBe('PAY-77');
            expect(result.message).toMatch(/successfully/);

            const createCall = (mockSAPClient.createEntity as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(createCall[1]).toBe('IncomingPayments');
            expect(createCall[2].CardCode).toBe('C20000');
            expect(createCall[2].PaymentInvoices).toHaveLength(1);
            expect(createCall[2].PaymentInvoices[0].DocEntry).toBe(101);
            expect(createCall[2].PaymentInvoices[0].SumApplied).toBe(1000);
        });

        it('throws when no invoices have amounts to apply', async () => {
            const invoices = [
                {
                    docEntry: 101, docNum: 'INV-101', docDate: '2026-04-01',
                    docTotal: 1000, paidToDate: 0, openBalance: 1000,
                    amountToApply: 0, remainingAfterPayment: 1000, status: 'OK' as const
                }
            ];

            await expect(service.createPayment('C20000', invoices, 0))
                .rejects.toThrow('No invoices with amounts to apply');
        });

        it('uses provided transferAccount and transferDate', async () => {
            (mockSAPClient.createEntity as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { DocEntry: 88, DocNum: 'PAY-88' }
            });

            const invoices = [
                {
                    docEntry: 101, docNum: 'INV-101', docDate: '2026-04-01',
                    docTotal: 500, paidToDate: 0, openBalance: 500,
                    amountToApply: 500, remainingAfterPayment: 0, status: 'OK' as const
                }
            ];

            await service.createPayment('C20000', invoices, 500, '10200001', '2026-04-15', 'CHK-001', 'April payment');

            const payload = (mockSAPClient.createEntity as ReturnType<typeof vi.fn>).mock.calls[0][2];
            expect(payload.TransferAccount).toBe('10200001');
            expect(payload.TransferDate).toBe('2026-04-15');
            expect(payload.TransferReference).toBe('CHK-001');
            expect(payload.Remarks).toBe('April payment');
        });

        it('throws when SAP returns no DocEntry', async () => {
            (mockSAPClient.createEntity as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });

            const invoices = [
                {
                    docEntry: 101, docNum: 'INV-101', docDate: '2026-04-01',
                    docTotal: 500, paidToDate: 0, openBalance: 500,
                    amountToApply: 500, remainingAfterPayment: 0, status: 'OK' as const
                }
            ];

            await expect(service.createPayment('C20000', invoices, 500))
                .rejects.toThrow('Payment created but DocEntry not returned');
        });
    });

    // -----------------------------------------------------------------------
    // preparePaymentForInvoices
    // -----------------------------------------------------------------------

    describe('preparePaymentForInvoices', () => {
        it('returns validation result only when validateOnly=true', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000', 0, 1000));

            const result = await service.preparePaymentForInvoices(
                'C20000', [101], 1000, { validateOnly: true }
            );

            expect(result.payment).toBeUndefined();
            expect(result.validation.valid).toBe(true);
            expect(mockSAPClient.createEntity).not.toHaveBeenCalled();
        });

        it('does not create payment when validation fails', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C99999', 0, 1000));

            const result = await service.preparePaymentForInvoices('C20000', [101], 1000);

            expect(result.payment).toBeUndefined();
            expect(result.validation.valid).toBe(false);
            expect(mockSAPClient.createEntity).not.toHaveBeenCalled();
        });

        it('validates and creates payment when validation passes', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000', 0, 1000));
            (mockSAPClient.createEntity as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { DocEntry: 55, DocNum: 'PAY-55' }
            });

            const result = await service.preparePaymentForInvoices('C20000', [101], 1000);

            expect(result.validation.valid).toBe(true);
            expect(result.payment).toBeDefined();
            expect(result.payment?.docEntry).toBe(55);
        });

        it('propagates createPayment errors as thrown exceptions', async () => {
            (mockSAPClient.readEntity as ReturnType<typeof vi.fn>)
                .mockResolvedValue(makeInvoiceResponse(101, 'C20000', 0, 1000));
            (mockSAPClient.createEntity as ReturnType<typeof vi.fn>)
                .mockRejectedValue(new Error('SAP connection refused'));

            await expect(
                service.preparePaymentForInvoices('C20000', [101], 1000)
            ).rejects.toThrow('SAP connection refused');
        });
    });
});
