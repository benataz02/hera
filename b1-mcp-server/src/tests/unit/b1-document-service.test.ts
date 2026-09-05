import { beforeEach, describe, expect, it, vi } from 'vitest';

import { B1DocumentService } from '../../services/b1-document-service.js';
import { B1Client } from '../../services/b1-client.js';
import { Logger } from '../../loggers/app-logger.js';

const SERVICE_URL = 'https://localhost:50000/b1s/v2/';

describe('B1DocumentService', () => {
    let service: B1DocumentService;
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

        service = new B1DocumentService(mockSAPClient, mockLogger, SERVICE_URL);
    });

    it('returns error for unsupported document flow', async () => {
        const result = await service.createDocumentFromBase(
            'Orders',
            123,
            'PurchaseOrders'
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid document flow');
        expect((mockSAPClient.readEntity as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
        expect((mockSAPClient.createEntity as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it('creates target document from source with base references', async () => {
        (mockSAPClient.readEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: {
                DocEntry: 123,
                DocNum: 'SO-1001',
                CardCode: 'C20000',
                CardName: 'ACME Corp',
                DocDate: '2026-03-20',
                DocDueDate: '2026-03-25',
                DocumentLines: [
                    {
                        ItemCode: 'A00001',
                        Quantity: 2,
                        Price: 50,
                        WarehouseCode: '01',
                        LineTotal: 100
                    },
                    {
                        ItemCode: 'A00002',
                        Quantity: 1,
                        Price: 70
                    }
                ]
            }
        });

        (mockSAPClient.createEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: {
                DocEntry: 456,
                DocNum: 'INV-2001'
            }
        });

        const result = await service.createDocumentFromBase(
            'Orders',
            123,
            'Invoices',
            [0],
            { Comments: 'Override header from test' }
        );

        expect(result.success).toBe(true);
        expect(result.targetDocument).toEqual({
            docEntry: 456,
            docNum: 'INV-2001',
            entityName: 'Invoices'
        });
        expect(result.sourceDocument).toEqual({
            docEntry: 123,
            docNum: 'SO-1001',
            entityName: 'Orders'
        });

        const createCalls = (mockSAPClient.createEntity as unknown as ReturnType<typeof vi.fn>).mock.calls;
        expect(createCalls.length).toBe(1);
        expect(createCalls[0][0]).toBe(SERVICE_URL);
        expect(createCalls[0][1]).toBe('Invoices');

        const createdPayload = createCalls[0][2] as Record<string, unknown>;
        expect(createdPayload.CardCode).toBe('C20000');
        expect(createdPayload.DocDate).toBe('2026-03-20');
        expect(createdPayload.DocDueDate).toBe('2026-03-25');
        expect(createdPayload.Comments).toBe('Override header from test');

        const lines = createdPayload.DocumentLines as Array<Record<string, unknown>>;
        expect(lines.length).toBe(1);
        expect(lines[0].BaseType).toBe(17);
        expect(lines[0].BaseEntry).toBe(123);
        expect(lines[0].BaseLine).toBe(0);
        expect(lines[0].ItemCode).toBe('A00001');
        expect(lines[0].Quantity).toBe(2);
        expect(lines[0].LineTotal).toBeUndefined();
    });

    it('returns error when selected lines are out of range', async () => {
        (mockSAPClient.readEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: {
                DocEntry: 123,
                DocNum: 'SO-1001',
                CardCode: 'C20000',
                CardName: 'ACME Corp',
                DocDate: '2026-03-20',
                DocDueDate: '2026-03-25',
                DocumentLines: [
                    {
                        ItemCode: 'A00001',
                        Quantity: 2
                    }
                ]
            }
        });

        const result = await service.createDocumentFromBase(
            'Orders',
            123,
            'Invoices',
            [99]
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('No valid lines to copy');
        expect((mockSAPClient.createEntity as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it('validateSourceDocument returns invalid when source has no lines', async () => {
        (mockSAPClient.readEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: {
                DocEntry: 321,
                DocNum: 'SO-4321',
                CardCode: 'C20000',
                CardName: 'ACME Corp',
                DocDate: '2026-03-20',
                DocDueDate: '2026-03-25',
                DocumentLines: []
            }
        });

        const validation = await service.validateSourceDocument('Orders', 321);

        expect(validation.valid).toBe(false);
        expect(validation.error).toContain('has no lines to copy');
    });

    it('getSourceDocument throws when CardCode is missing', async () => {
        (mockSAPClient.readEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: {
                DocEntry: 555,
                DocNum: 'SO-5555',
                CardName: 'No CardCode',
                DocDate: '2026-03-20',
                DocDueDate: '2026-03-25',
                DocumentLines: [{ ItemCode: 'A00001', Quantity: 1 }]
            }
        });

        await expect(service.getSourceDocument('Orders', 555)).rejects.toThrow(
            'missing CardCode'
        );
    });
});
