import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdmEntityType } from '../../types/b1-types.js';

const auditRecord = vi.hoisted(() => vi.fn());
const requireWriteConfirmation = vi.hoisted(() => vi.fn(async () => undefined));
const requireSensitiveReadConfirmation = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../loggers/audit-logger.js', () => ({
    AuditLogger: class {
        static describeRetentionPolicy(): string {
            return 'mock-policy';
        }

        record(entry: unknown): void {
            auditRecord(entry);
        }
    }
}));

vi.mock('../../tools/b1-elicitation.js', () => ({
    requireWriteConfirmation,
    requireSensitiveReadConfirmation,
}));

type ToolResult = {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
};

function getText(result: unknown): string {
    const typedResult = result as ToolResult;
    return typedResult.content?.[0]?.text ?? '';
}

function createLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    };
}

function createSapClient(overrides: Partial<{
    createEntity: (
        servicePath: string,
        entitySet: string,
        data: unknown,
        options?: { preferReturnNoContent?: boolean }
    ) => Promise<{ status: number; headers: Record<string, string>; data: unknown }>;
    updateEntity: (servicePath: string, entitySet: string, key: string | number, data: unknown) => Promise<{ data: unknown }>;
    deleteEntity: (servicePath: string, entitySet: string, key: string | number) => Promise<{ data: unknown }>;
    readEntitySet: (servicePath: string, entitySet: string, queryOptions?: Record<string, unknown>, isDiscovery?: boolean) => Promise<{ data: unknown }>;
    readEntity: (servicePath: string, entitySet: string, key: string | number, isDiscovery?: boolean, queryOptions?: Record<string, unknown>) => Promise<{ data: unknown }>;
}> = {}) {
    return {
        getCompanyId: vi.fn(() => 'SBODEMOUS'),
        getB1Client: vi.fn(() => undefined),
        setUserToken: vi.fn(),
        createEntity: overrides.createEntity ?? vi.fn(async (_servicePath: string, _entitySet: string, data: unknown) => ({
            status: 201,
            headers: {},
            data: { created: true, payload: data }
        })),
        updateEntity: overrides.updateEntity ?? vi.fn(async (_servicePath: string, _entitySet: string, key: string | number, data: unknown) => ({
            data: { updated: true, key, payload: data }
        })),
        deleteEntity: overrides.deleteEntity ?? vi.fn(async (_servicePath: string, _entitySet: string, key: string | number) => ({
            data: { deleted: true, key }
        })),
        readEntitySet: overrides.readEntitySet ?? vi.fn(async () => ({
            data: { items: [] }
        })),
        readEntity: overrides.readEntity ?? vi.fn(async (_servicePath: string, _entitySet: string, key: string | number) => ({
            data: { key }
        }))
    };
}

function createDiscoveryService() {
    const metadataManager = {
        getEntityList: vi.fn(() => [{ name: 'Items' }]),
        getEntitySchema: vi.fn(async (): Promise<EdmEntityType> => ({
            name: 'Items',
            namespace: 'SAPB1',
            category: 2,
            isArray: false,
            keys: ['ItemCode'],
            entityClass: 'standard',
            properties: new Map([
                ['ItemCode', { name: 'ItemCode', type: { name: 'Edm.String', category: 0, isArray: false }, maxLength: 50 }],
                ['ItemName', { name: 'ItemName', type: { name: 'Edm.String', category: 0, isArray: false }, maxLength: 100 }]
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

function createDiscoveryServiceWithProperties(properties: Array<Record<string, unknown>>) {
    const metadataManager = {
        getEntityList: vi.fn(() => [{ name: 'Items' }]),
        getEntitySchema: vi.fn(async (): Promise<EdmEntityType> => ({
            name: 'Items',
            namespace: 'SAPB1',
            category: 2,
            isArray: false,
            keys: ['ItemCode'],
            entityClass: 'standard',
            properties: new Map(properties.map((prop: Record<string, unknown>) => [
                String(prop.name),
                {
                    name: String(prop.name),
                    type: {
                        name: String(prop.type ?? 'Edm.String'),
                        category: typeof prop.type === 'string' && String(prop.type).startsWith('Collection(') ? 2 : 0,
                        isArray: typeof prop.type === 'string' && String(prop.type).startsWith('Collection(')
                    },
                    isPersonalField: prop.isPersonalField as boolean | undefined,
                    isArray: prop.isArray as boolean | undefined
                }
            ]))
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

function createDiscoveryServiceWithEntitySchema(entitySchema: EdmEntityType) {
    const metadataManager = {
        getEntityList: vi.fn(() => [{ name: entitySchema.name }]),
        getEntitySchema: vi.fn(async () => entitySchema),
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

describe('entity read/write handlers audit logging', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        auditRecord.mockReset();
        requireWriteConfirmation.mockReset();
        requireWriteConfirmation.mockImplementation(async () => undefined);
        requireSensitiveReadConfirmation.mockReset();
        requireSensitiveReadConfirmation.mockImplementation(async () => undefined);
        vi.resetModules();
        process.env.AUTHENTICATION_MODE = 'direct';
        delete process.env.NODE_ENV;
    });

    afterEach(() => {
        for (const key of Object.keys(process.env)) {
            if (!(key in originalEnv)) {
                delete process.env[key];
            }
        }

        for (const [key, value] of Object.entries(originalEnv)) {
            process.env[key] = value;
        }
    });

    it('records successful create operations', async () => {
        const { executeEntityWriteOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const { runWithRequestContext } = await import('../../utils/request-context.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryService();

        const result = await runWithRequestContext({
            requestId: 'req-entity-write-1',
            token: 'jwt-token',
            companyId: 'SBODEMOUS',
            sourceIp: '203.0.113.10'
        }, () => executeEntityWriteOperation({
            entityName: 'Items',
            operation: 'create',
            parameters: {
                ItemCode: 'A0001',
                ItemName: 'Test item'
            }
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS',
            sourceIp: '203.0.113.10'
        }));

        expect(getText(result)).toContain('SUCCESS: Creating new Items');
        expect(sapClient.createEntity).toHaveBeenCalledWith(
            'https://example.com/b1s/v2/',
            'Items',
            {
                ItemCode: 'A0001',
                ItemName: 'Test item'
            },
            { preferReturnNoContent: true }
        );
        expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
            event: 'WriteConfirmationApproved',
            category: 'DataModification',
            subCategory: 'Create',
            outcome: 'info',
            companyId: 'SBODEMOUS',
            sourceIp: '203.0.113.10',
            details: expect.objectContaining({
                entitySet: 'Items',
                fieldNames: ['ItemCode', 'ItemName'],
                confirmationType: 'mcp-elicitation',
                usedAuthenticatedContext: true
            })
        }));
        expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
            event: 'EntityCreated',
            category: 'DataModification',
            subCategory: 'Create',
            outcome: 'success',
            companyId: 'SBODEMOUS',
            sourceIp: '203.0.113.10',
            details: expect.objectContaining({
                entitySet: 'Items',
                fieldNames: ['ItemCode', 'ItemName'],
                usedAuthenticatedContext: true
            })
        }));
    });

    it('records successful updates with sanitized field names', async () => {
        const { executeEntityWriteOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryService();

        const result = await executeEntityWriteOperation({
            entityName: 'Items',
            operation: 'update',
            parameters: {
                ItemCode: 'A0001',
                ItemName: 'Updated item'
            }
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect(getText(result)).toContain('SUCCESS: Updating Items with key: A0001');
        expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
            event: 'EntityUpdated',
            subCategory: 'Update',
            details: expect.objectContaining({
                keyValue: 'A0001',
                fieldNames: ['ItemName']
            })
        }));
    });

    it('records failed delete operations', async () => {
        const { executeEntityWriteOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient({
            deleteEntity: vi.fn(async () => {
                throw new Error('Delete rejected by SAP');
            })
        });
        const discoveryService = createDiscoveryService();

        const result = await executeEntityWriteOperation({
            entityName: 'Items',
            operation: 'delete',
            parameters: {
                ItemCode: 'A0001'
            }
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as ToolResult).isError).toBe(true);
        expect(getText(result)).toContain('ERROR: Failed to execute delete operation on Items');
        expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
            event: 'EntityDeleteFailed',
            category: 'DataModification',
            subCategory: 'Delete',
            outcome: 'failure',
            details: expect.objectContaining({
                entitySet: 'Items',
                keyValue: 'A0001',
                reason: 'Delete rejected by SAP'
            })
        }));
    });

    it('does not audit read operations', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryService();

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect(getText(result)).toContain('SUCCESS: Reading Items entities');
        expect(auditRecord).not.toHaveBeenCalled();
    });

    it('supports read operations inside request context without write audit side effects', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const { runWithRequestContext } = await import('../../utils/request-context.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryService();

        const result = await runWithRequestContext({
            requestId: 'req-entity-read-1',
            token: 'jwt-token',
            companyId: 'SBODEMOUS',
            sourceIp: '198.51.100.10'
        }, () => executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS',
            sourceIp: '198.51.100.10'
        }));

        expect(getText(result)).toContain('SUCCESS: Reading Items entities');
        expect(sapClient.readEntitySet).toHaveBeenCalledTimes(1);
        expect(auditRecord).not.toHaveBeenCalled();
    });

    it('applies select query options for read-single operations', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryService();

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read-single',
            selectString: 'ItemCode,ItemName',
            parameters: {
                ItemCode: 'A0001'
            }
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect(getText(result)).toContain('SUCCESS: Reading single Items with key: A0001');
        expect(sapClient.readEntity).toHaveBeenCalledWith(
            'https://example.com/b1s/v2/',
            'Items',
            'A0001',
            false,
            {
                $select: 'ItemCode,ItemName'
            }
        );
    });

    it('fails read when selectString contains unknown properties', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryService();

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read',
            selectString: 'ItemCode,NotARealProperty'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as ToolResult).isError).toBe(true);
        expect(getText(result)).toContain('Invalid selectString');
        expect(getText(result)).toContain('NotARealProperty');
        expect(sapClient.readEntitySet).not.toHaveBeenCalled();
    });

    it('fails read when orderbyString contains unknown properties', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryService();

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read',
            orderbyString: 'NotARealProperty desc'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as ToolResult).isError).toBe(true);
        expect(getText(result)).toContain('Invalid orderbyString');
        expect(getText(result)).toContain('NotARealProperty');
        expect(sapClient.readEntitySet).not.toHaveBeenCalled();
    });

    it('supports nested property paths in selectString', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();

        const addressExtensionType = {
            name: 'AddressExtension',
            category: 2,
            isArray: false,
            properties: new Map([
                ['ShipToStreet', { name: 'ShipToStreet', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['BillToBuilding', { name: 'BillToBuilding', type: { name: 'Edm.String', category: 0, isArray: false } }]
            ])
        };

        const discoveryService = createDiscoveryServiceWithEntitySchema({
            name: 'BusinessPartners',
            namespace: 'SAPB1',
            category: 2,
            isArray: false,
            keys: ['CardCode'],
            entityClass: 'standard',
            properties: new Map([
                ['CardCode', { name: 'CardCode', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['AddressExtension', {
                    name: 'AddressExtension',
                    type: addressExtensionType,
                    isArray: false
                }]
            ])
        });

        const result = await executeEntityReadOperation({
            entityName: 'BusinessPartners',
            operation: 'read',
            selectString: 'CardCode,AddressExtension/ShipToStreet'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as ToolResult).isError).not.toBe(true);
        expect(getText(result)).toContain('SUCCESS: Reading BusinessPartners entities');
        expect(sapClient.readEntitySet).toHaveBeenCalledWith(
            'https://example.com/b1s/v2/',
            'BusinessPartners',
            expect.objectContaining({
                $select: 'CardCode,AddressExtension/ShipToStreet'
            }),
            false
        );
    });

    it('fails read when nested selectString path does not exist in metadata', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();

        const addressExtensionType = {
            name: 'AddressExtension',
            category: 2,
            isArray: false,
            properties: new Map([
                ['ShipToStreet', { name: 'ShipToStreet', type: { name: 'Edm.String', category: 0, isArray: false } }]
            ])
        };

        const discoveryService = createDiscoveryServiceWithEntitySchema({
            name: 'BusinessPartners',
            namespace: 'SAPB1',
            category: 2,
            isArray: false,
            keys: ['CardCode'],
            entityClass: 'standard',
            properties: new Map([
                ['CardCode', { name: 'CardCode', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['AddressExtension', {
                    name: 'AddressExtension',
                    type: addressExtensionType,
                    isArray: false
                }]
            ])
        });

        const result = await executeEntityReadOperation({
            entityName: 'BusinessPartners',
            operation: 'read',
            selectString: 'CardCode,AddressExtension/DoesNotExist'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as ToolResult).isError).toBe(true);
        expect(getText(result)).toContain('Invalid selectString');
        expect(getText(result)).toContain('AddressExtension/DoesNotExist');
        expect(sapClient.readEntitySet).not.toHaveBeenCalled();
    });

    it('supports nested scalar paths in orderbyString', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();

        const addressExtensionType = {
            name: 'AddressExtension',
            category: 2,
            isArray: false,
            properties: new Map([
                ['ShipToStreet', { name: 'ShipToStreet', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['BillToBuilding', { name: 'BillToBuilding', type: { name: 'Edm.String', category: 0, isArray: false } }]
            ])
        };

        const discoveryService = createDiscoveryServiceWithEntitySchema({
            name: 'BusinessPartners',
            namespace: 'SAPB1',
            category: 2,
            isArray: false,
            keys: ['CardCode'],
            entityClass: 'standard',
            properties: new Map([
                ['CardCode', { name: 'CardCode', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['AddressExtension', {
                    name: 'AddressExtension',
                    type: addressExtensionType,
                    isArray: false
                }]
            ])
        });

        const result = await executeEntityReadOperation({
            entityName: 'BusinessPartners',
            operation: 'read',
            orderbyString: 'AddressExtension/ShipToStreet desc'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as ToolResult).isError).not.toBe(true);
        expect(getText(result)).toContain('SUCCESS: Reading BusinessPartners entities');
        expect(sapClient.readEntitySet).toHaveBeenCalledWith(
            'https://example.com/b1s/v2/',
            'BusinessPartners',
            expect.objectContaining({
                $orderby: 'AddressExtension/ShipToStreet desc'
            }),
            false
        );
    });

    it('rewrites selectString to canonical metadata casing', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryService();

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read-single',
            selectString: 'itemcode,itemname',
            parameters: {
                ItemCode: 'A0001'
            }
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as ToolResult).isError).not.toBe(true);
        expect(sapClient.readEntity).toHaveBeenCalledWith(
            'https://example.com/b1s/v2/',
            'Items',
            'A0001',
            false,
            {
                $select: 'ItemCode,ItemName'
            }
        );
    });

    it('rewrites orderbyString to canonical metadata casing', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryService();

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read',
            orderbyString: 'itemname DESC,itemcode'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect((result as ToolResult).isError).not.toBe(true);
        expect(sapClient.readEntitySet).toHaveBeenCalledWith(
            'https://example.com/b1s/v2/',
            'Items',
            expect.objectContaining({
                $orderby: 'ItemName desc,ItemCode'
            }),
            false
        );
    });

    it('formats composite keys with numeric values unquoted and escapes apostrophes', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryServiceWithEntitySchema({
            name: 'OrderLines',
            namespace: 'SAPB1',
            category: 2,
            isArray: false,
            keys: ['DocEntry', 'ItemCode'],
            entityClass: 'standard',
            properties: new Map([
                ['DocEntry', { name: 'DocEntry', type: { name: 'Edm.Int32', category: 0, isArray: false } }],
                ['ItemCode', { name: 'ItemCode', type: { name: 'Edm.String', category: 0, isArray: false } }]
            ])
        });

        await executeEntityReadOperation({
            entityName: 'OrderLines',
            operation: 'read-single',
            parameters: {
                DocEntry: '10',
                ItemCode: "O'Brien"
            }
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        expect(sapClient.readEntity).toHaveBeenCalledWith(
            'https://example.com/b1s/v2/',
            'OrderLines',
            "DocEntry=10,ItemCode='O''Brien'",
            false,
            {
                $select: undefined
            }
        );
    });

    it('requires elicitation when read selectString includes personal fields', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryServiceWithProperties([
            { name: 'ItemCode', type: 'Edm.String' },
            { name: 'LicTradNum', type: 'Edm.String', isPersonalField: true }
        ]);

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read',
            selectString: 'ItemCode,LicTradNum'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS',
            mcpRequestContext: { sendRequest: vi.fn() as never }
        });

        expect(getText(result)).toContain('SUCCESS: Reading Items entities');
        expect(requireSensitiveReadConfirmation).toHaveBeenCalledWith(expect.objectContaining({
            entityName: 'Items',
            selectString: 'ItemCode,LicTradNum',
            selectedPersonalFields: ['LicTradNum']
        }));
        expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
            event: 'SensitiveReadConfirmationApproved',
            category: 'Authorization',
            subCategory: 'Context',
            outcome: 'info',
            details: expect.objectContaining({
                entitySet: 'Items',
                selectString: 'ItemCode,LicTradNum',
                selectedPersonalFields: ['LicTradNum'],
                confirmationType: 'mcp-elicitation'
            })
        }));
    });

    it('skips elicitation when read selectString excludes personal fields', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryServiceWithProperties([
            { name: 'ItemCode', type: 'Edm.String' },
            { name: 'ItemName', type: 'Edm.String', isPersonalField: false }
        ]);

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read',
            selectString: 'ItemCode,ItemName'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS',
            mcpRequestContext: { sendRequest: vi.fn() as never }
        });

        expect(getText(result)).toContain('SUCCESS: Reading Items entities');
        expect(requireSensitiveReadConfirmation).not.toHaveBeenCalled();
    });

    it('treats empty selectString as absent for sensitive-read elicitation', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient();
        const discoveryService = createDiscoveryServiceWithProperties([
            { name: 'ItemCode', type: 'Edm.String' },
            { name: 'LicTradNum', type: 'Edm.String', isPersonalField: true }
        ]);

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read',
            selectString: ''
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS',
            mcpRequestContext: { sendRequest: vi.fn() as never }
        });

        expect(getText(result)).toContain('SUCCESS: Reading Items entities');
        expect(requireSensitiveReadConfirmation).not.toHaveBeenCalled();
    });

    it('formats create success with 204 no-content and location headers', async () => {
        const { executeEntityWriteOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient({
            createEntity: vi.fn(async () => ({
                status: 204,
                headers: {
                    location: "https://example.com/b1s/v2/Items('i011')",
                    'preference-applied': 'return-no-content'
                },
                data: null
            }))
        });
        const discoveryService = createDiscoveryService();

        const result = await executeEntityWriteOperation({
            entityName: 'Items',
            operation: 'create',
            parameters: {
                ItemCode: 'i011'
            }
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS',
            mcpRequestContext: { sendRequest: vi.fn() as never }
        });

        const text = getText(result);
        expect(text).toContain('status: 204 No Content');
        expect(text).toContain('preferenceApplied: return-no-content');
        expect(text).toContain("location: Items('i011')");
    });

    it('recursively redacts personal fields from nested complex collections for read-single without $select', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient({
            readEntity: vi.fn(async () => ({
                data: {
                    ItemCode: 'A0001',
                    LicTradNum: 'TOP-SECRET',
                    DocumentLines: [
                        { LineNum: 0, SensitiveLineField: 'SECRET-L1', ItemCode: 'A0001' },
                        { LineNum: 1, SensitiveLineField: 'SECRET-L2', ItemCode: 'B0002' }
                    ]
                }
            }))
        });

        const documentLineType = {
            name: 'DocumentLine',
            category: 2,
            isArray: false,
            properties: new Map([
                ['LineNum', { name: 'LineNum', type: { name: 'Edm.Int32', category: 0, isArray: false } }],
                ['ItemCode', { name: 'ItemCode', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['SensitiveLineField', {
                    name: 'SensitiveLineField',
                    type: { name: 'Edm.String', category: 0, isArray: false },
                    isPersonalField: true
                }]
            ])
        };

        const nestedSchema = {
            name: 'Items',
            namespace: 'SAPB1',
            entitySet: 'Items',
            keys: ['ItemCode'],
            category: 2,
            isArray: false,
            properties: new Map([
                ['ItemCode', { name: 'ItemCode', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['LicTradNum', {
                    name: 'LicTradNum',
                    type: { name: 'Edm.String', category: 0, isArray: false },
                    isPersonalField: true
                }],
                ['DocumentLines', {
                    name: 'DocumentLines',
                    type: documentLineType,
                    isArray: true
                }]
            ])
        };

        const discoveryService = {
            getDiscoveredServices: vi.fn(async () => [{
                id: 'B1_SERVICE_LAYER',
                url: 'https://example.com/b1s/v2/',
                metadata: null
            }]),
            getB1MetadataManager: vi.fn(() => ({
                getEntityList: vi.fn(() => [{ name: 'Items' }]),
                getEntitySchema: vi.fn(async () => nestedSchema),
                getComplexTypeProperties: vi.fn(() => null)
            }))
        };

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read-single',
            parameters: {
                ItemCode: 'A0001'
            }
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        const text = getText(result);
        expect(text).toContain('SUCCESS: Reading single Items with key: A0001');
        expect(text).not.toContain('TOP-SECRET');
        expect(text).not.toContain('SECRET-L1');
        expect(text).not.toContain('SECRET-L2');
        expect(text).toContain('SensitiveLineField');
        expect(text).toContain('[redacted]');
        expect(text).not.toContain('[REDACTED:');
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Redacted 3 personal field(s) from read-single Items:')
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('LicTradNum')
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('DocumentLines[0].SensitiveLineField')
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('DocumentLines[1].SensitiveLineField')
        );
    });

    it('redacts personal fields from read collection results when no select is provided', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const documentLineType = {
            name: 'DocumentLine',
            category: 2,
            isArray: false,
            properties: new Map([
                ['LineNum', { name: 'LineNum', type: { name: 'Edm.Int32', category: 0, isArray: false } }],
                ['SensitiveLineField', {
                    name: 'SensitiveLineField',
                    type: { name: 'Edm.String', category: 0, isArray: false },
                    isPersonalField: true
                }]
            ])
        };
        const sapClient = createSapClient({
            readEntitySet: vi.fn(async () => ({
                data: {
                    value: [{
                        ItemCode: 'A0001',
                        LicTradNum: 'TOP-SECRET',
                        DocumentLines: [
                            { LineNum: 0, SensitiveLineField: 'SECRET-L1' },
                            { LineNum: 1, SensitiveLineField: 'SECRET-L2' }
                        ]
                    }]
                }
            }))
        });

        const nestedSchema = {
            name: 'Items',
            namespace: 'SAPB1',
            entitySet: 'Items',
            keys: ['ItemCode'],
            category: 2,
            isArray: false,
            properties: new Map([
                ['ItemCode', { name: 'ItemCode', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['LicTradNum', {
                    name: 'LicTradNum',
                    type: { name: 'Edm.String', category: 0, isArray: false },
                    isPersonalField: true
                }],
                ['DocumentLines', {
                    name: 'DocumentLines',
                    type: documentLineType,
                    isArray: true
                }]
            ])
        };

        const discoveryService = {
            getDiscoveredServices: vi.fn(async () => [{
                id: 'B1_SERVICE_LAYER',
                url: 'https://example.com/b1s/v2/',
                metadata: null
            }]),
            getB1MetadataManager: vi.fn(() => ({
                getEntityList: vi.fn(() => [{ name: 'Items' }]),
                getEntitySchema: vi.fn(async () => nestedSchema),
                getComplexTypeProperties: vi.fn(() => null)
            }))
        };

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        const text = getText(result);
        expect(text).toContain('SUCCESS: Reading Items entities');
        expect(text).not.toContain('TOP-SECRET');
        expect(text).not.toContain('SECRET-L1');
        expect(text).not.toContain('SECRET-L2');
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Redacted 3 personal field(s) from read Items:')
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('value[0].LicTradNum')
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('value[0].DocumentLines[0].SensitiveLineField')
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('value[0].DocumentLines[1].SensitiveLineField')
        );
    });

    it('redacts personal fields when selectString is blank or whitespace-only', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();
        const sapClient = createSapClient({
            readEntitySet: vi.fn(async () => ({
                data: {
                    value: [{
                        ItemCode: 'A0001',
                        LicTradNum: 'TOP-SECRET'
                    }]
                }
            }))
        });

        const nestedSchema = {
            name: 'Items',
            namespace: 'SAPB1',
            entitySet: 'Items',
            keys: ['ItemCode'],
            category: 2,
            isArray: false,
            properties: new Map([
                ['ItemCode', { name: 'ItemCode', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['LicTradNum', {
                    name: 'LicTradNum',
                    type: { name: 'Edm.String', category: 0, isArray: false },
                    isPersonalField: true
                }]
            ])
        };

        const discoveryService = {
            getDiscoveredServices: vi.fn(async () => [{
                id: 'B1_SERVICE_LAYER',
                url: 'https://example.com/b1s/v2/',
                metadata: null
            }]),
            getB1MetadataManager: vi.fn(() => ({
                getEntityList: vi.fn(() => [{ name: 'Items' }]),
                getEntitySchema: vi.fn(async () => nestedSchema),
                getComplexTypeProperties: vi.fn(() => null)
            }))
        };

        const result = await executeEntityReadOperation({
            entityName: 'Items',
            operation: 'read',
            selectString: '   '
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        const text = getText(result);
        expect(text).toContain('SUCCESS: Reading Items entities');
        expect(text).not.toContain('TOP-SECRET');
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Redacted 1 personal field(s) from read Items:')
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('value[0].LicTradNum')
        );
    });

    it('redacts only inside selected complex properties when selectString includes them', async () => {
        const { executeEntityReadOperation } = await import('../../tools/b1-schema-execute-handlers.js');
        const logger = createLogger();

        const documentLineType = {
            name: 'DocumentLine',
            category: 2,
            isArray: false,
            properties: new Map([
                ['LineNum', { name: 'LineNum', type: { name: 'Edm.Int32', category: 0, isArray: false } }],
                ['SensitiveLineField', {
                    name: 'SensitiveLineField',
                    type: { name: 'Edm.String', category: 0, isArray: false },
                    isPersonalField: true
                }]
            ])
        };

        const addressExtensionType = {
            name: 'AddressExtension',
            category: 2,
            isArray: false,
            properties: new Map([
                ['ShipToStreet', {
                    name: 'ShipToStreet',
                    type: { name: 'Edm.String', category: 0, isArray: false },
                    isPersonalField: true
                }],
                ['BillToBuilding', { name: 'BillToBuilding', type: { name: 'Edm.String', category: 0, isArray: false } }]
            ])
        };

        const sapClient = createSapClient({
            readEntitySet: vi.fn(async () => ({
                data: {
                    value: [{
                        CardCode: 'C20000',
                        DocEntry: 123,
                        ContactPerson: 'VISIBLE-SCALAR',
                        DocumentLines: [
                            { LineNum: 0, SensitiveLineField: 'SECRET-L1' }
                        ],
                        AddressExtension: {
                            ShipToStreet: 'SECRET-STREET',
                            BillToBuilding: 'HQ'
                        }
                    }]
                }
            }))
        });

        const entitySchema = {
            name: 'BusinessPartners',
            namespace: 'SAPB1',
            keys: ['CardCode'],
            category: 2,
            isArray: false,
            properties: new Map([
                ['CardCode', { name: 'CardCode', type: { name: 'Edm.String', category: 0, isArray: false } }],
                ['DocEntry', { name: 'DocEntry', type: { name: 'Edm.Int32', category: 0, isArray: false } }],
                ['ContactPerson', {
                    name: 'ContactPerson',
                    type: { name: 'Edm.String', category: 0, isArray: false },
                    isPersonalField: true
                }],
                ['DocumentLines', {
                    name: 'DocumentLines',
                    type: documentLineType,
                    isArray: true
                }],
                ['AddressExtension', {
                    name: 'AddressExtension',
                    type: addressExtensionType,
                    isArray: false
                }]
            ])
        };

        const discoveryService = {
            getDiscoveredServices: vi.fn(async () => [{
                id: 'B1_SERVICE_LAYER',
                url: 'https://example.com/b1s/v2/',
                metadata: null
            }]),
            getB1MetadataManager: vi.fn(() => ({
                getEntityList: vi.fn(() => [{ name: 'BusinessPartners' }]),
                getEntitySchema: vi.fn(async () => entitySchema),
                getComplexTypeProperties: vi.fn(() => null)
            }))
        };

        const result = await executeEntityReadOperation({
            entityName: 'BusinessPartners',
            operation: 'read',
            selectString: 'CardCode,DocEntry,DocumentLines,AddressExtension'
        }, {
            sapClient: sapClient as never,
            logger: logger as never,
            discoveryService: discoveryService as never,
            companyId: 'SBODEMOUS'
        });

        const text = getText(result);
        expect(text).toContain('SUCCESS: Reading BusinessPartners entities');
        expect(text).toContain('C20000');
        expect(text).toContain('123');
        expect(text).toContain('VISIBLE-SCALAR');
        expect(text).not.toContain('SECRET-L1');
        expect(text).not.toContain('SECRET-STREET');
        expect(text).toContain('HQ');
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('DocumentLines[0].SensitiveLineField')
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('AddressExtension.ShipToStreet')
        );
    });
});