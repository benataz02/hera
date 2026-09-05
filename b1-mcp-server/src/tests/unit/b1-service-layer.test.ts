import { afterEach, describe, expect, it, vi } from 'vitest';
import { B1ServiceLayer } from '../../services/b1-service-layer.js';
import { runWithRequestContext } from '../../utils/request-context.js';

function makeConfig() {
    return {
        get: vi.fn((key: string, fallback?: unknown) => {
            switch (key) {
                case 'b1.serviceLayerUrl':
                    return 'https://example.sap.local';
                case 'b1.companyDb':
                    return 'SBODEMOUS';
                case 'b1.userName':
                    return 'manager';
                case 'b1.password':
                    return 'secret';
                case 'auth.allowSelfSigned':
                    return false;
                default:
                    return fallback;
            }
        })
    };
}

function makeLogger() {
    return {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    };
}

describe('B1ServiceLayer.fetchPersonalFieldsSetups', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('follows @odata.nextLink and returns flattened personal fields', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        fetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                text: async () => JSON.stringify({
                    value: [
                        { TableName: 'ORDR', FieldName: 'NumAtCard', DataClassification: 'pfsdc_Personal' },
                        { TableName: 'ORDR' }
                    ],
                    '@odata.nextLink': 'PersonalFieldsSetups?$skip=2'
                })
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                text: async () => JSON.stringify({
                    value: [
                        { TableName: 'OCRD', FieldName: 'LicTradNum', DataClassification: 'pfsdc_Personal' }
                    ]
                })
            } as Response);

        const service = new B1ServiceLayer(makeConfig() as never, makeLogger() as never);
        const rows = await runWithRequestContext({ requestId: 'req-pfs-1', token: 'oauth-token' }, async () =>
            service.fetchPersonalFieldsSetups(20)
        );

        expect(rows).toEqual([
            { tableName: 'ORDR', fieldName: 'NumAtCard', dataClassification: 'pfsdc_Personal' },
            { tableName: 'OCRD', fieldName: 'LicTradNum', dataClassification: 'pfsdc_Personal' }
        ]);

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[0][0]).toBe('https://example.sap.local/b1s/v2/PersonalFieldsSetups');
        expect(fetchSpy.mock.calls[1][0]).toBe('https://example.sap.local/b1s/v2/PersonalFieldsSetups?$skip=2');
    });

    it('sends odata.maxpagesize preference header', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () => JSON.stringify({ value: [] })
        } as Response);

        const service = new B1ServiceLayer(makeConfig() as never, makeLogger() as never);
        await runWithRequestContext({ requestId: 'req-pfs-2', token: 'oauth-token' }, async () =>
            service.fetchPersonalFieldsSetups(50)
        );

        const requestInit = fetchSpy.mock.calls[0][1] as RequestInit;
        const headers = requestInit.headers as Record<string, string>;
        expect(headers['Prefer']).toBe('odata.maxpagesize=50');
    });

    it('includes requestId in service-layer error logs', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () => JSON.stringify({ error: { message: 'boom' } })
        } as Response);

        const logger = makeLogger();
        const service = new B1ServiceLayer(makeConfig() as never, logger as never);

        await expect(runWithRequestContext({ requestId: 'req-123', token: 'oauth-token' }, () => service.request({
            url: 'BusinessPartners',
            method: 'GET'
        }))).rejects.toThrow('B1 API Error 500');

        expect(logger.error).toHaveBeenCalledWith(
            'SAP B1 Service Layer request failed',
            expect.objectContaining({
                requestId: 'req-123',
                method: 'GET',
                status: 500
            })
        );
    });
});

describe('B1ServiceLayer.fetchPersonalFieldsByTable', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('posts to PersonalFieldsSetupsService_GetPersonalFieldsByTable with expected payload', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () => JSON.stringify({ value: [] })
        } as Response);

        const service = new B1ServiceLayer(makeConfig() as never, makeLogger() as never);
        await runWithRequestContext({ requestId: 'req-pft-1', token: 'oauth-token' }, async () =>
            service.fetchPersonalFieldsByTable('OCRD')
        );

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('https://example.sap.local/b1s/v2/PersonalFieldsSetupsService_GetPersonalFieldsByTable');

        const requestInit = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(requestInit.method).toBe('POST');

        const headers = requestInit.headers as Record<string, string>;
        expect(headers['Accept']).toBe('application/json');

        expect(requestInit.body).toBe(JSON.stringify({
            PersonalFieldsSetupTableParams: {
                TableName: 'OCRD'
            }
        }));
    });

    it('maps valid rows and filters incomplete rows', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () => JSON.stringify({
                value: [
                    { TableName: 'OCRD', FieldName: 'LicTradNum', DataClassification: 'pfsdc_Personal', Category: 'pfsc_None' },
                    { TableName: 'OCRD', DataClassification: 'pfsdc_Personal' },
                    { FieldName: 'CardName', DataClassification: 'pfsdc_Personal' }
                ]
            })
        } as Response);

        const service = new B1ServiceLayer(makeConfig() as never, makeLogger() as never);
        const rows = await runWithRequestContext({ requestId: 'req-pft-2', token: 'oauth-token' }, async () =>
            service.fetchPersonalFieldsByTable('OCRD')
        );

        expect(rows).toEqual([
            {
                tableName: 'OCRD',
                fieldName: 'LicTradNum',
                dataClassification: 'pfsdc_Personal',
                category: 'pfsc_None'
            }
        ]);
    });
});
