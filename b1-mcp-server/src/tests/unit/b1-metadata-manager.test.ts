import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { B1MetadataManager } from '../../services/b1-metadata-manager.js';
import { B1DiscoveryService } from '../../services/b1-discovery.js';
import type { B1ServiceLayer } from '../../services/b1-service-layer.js';
import type { B1Client } from '../../services/b1-client.js';
import type { Logger } from '../../loggers/app-logger.js';
import type { Config } from '../../utils/config.js';
import { config } from '../../utils/config.js';

function edmx(schemaBody: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0"
    xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"
    xmlns:sap="http://www.sap.com/Protocols/SAPData">
  <edmx:DataServices>
    <Schema Namespace="SAPB1" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:sap="http://www.sap.com/Protocols/SAPData">
      ${schemaBody}
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
}

function entityContainer(entitySets: string): string {
    return `<EntityContainer Name="ServiceLayer">${entitySets}</EntityContainer>`;
}

// ---------------------------------------------------------------------------
// Phase 1 fixture: lightweight entity list (scope=entityset)
// Contains one standard entity, one UDT, one UDO
// ---------------------------------------------------------------------------

const PHASE1_XML = edmx(entityContainer(`
    <EntitySet EntityType="SAPB1.Document" Name="Orders">
        <Annotation Term="Common.Label" String="Sales Order"/>
        <Annotation Term="SAPB1.TableName" String="ORDR"/>
    </EntitySet>
    <EntitySet EntityType="SAPB1.U_ProjectData" Name="U_ProjectData">
        <Annotation Term="Common.Label" String="Project Data"/>
        <Annotation Term="SAPB1.TableName" String="@ProjectData"/>
    </EntitySet>
    <EntitySet EntityType="SAPB1.MyUDO" Name="MyUDO">
        <Annotation Term="Common.Label" String="My User Defined Object"/>
        <Annotation Term="SAPB1.TableName" String="@MyUDO"/>
    </EntitySet>
`));

// Phase 2 fixture: full schema for U_ProjectData (UDT)
const PHASE2_UDT_XML = edmx(`
    <EntityType Name="U_ProjectData">
        <Key><PropertyRef Name="Code"/></Key>
        <Property Name="Code" Type="Edm.String" MaxLength="20"/>
        <Property Name="Name" Type="Edm.String"/>
        <Property Name="U_MyField" Type="Edm.String">
            <Annotation Term="Common.Label" String="My UDF"/>
            <Annotation Term="SAPB1.ColumnName" String="U_MyField"/>
        </Property>
    </EntityType>
    ${entityContainer(`
        <EntitySet EntityType="SAPB1.U_ProjectData" Name="U_ProjectData">
            <Annotation Term="Common.Label" String="Project Data"/>
            <Annotation Term="SAPB1.TableName" String="@ProjectData"/>
        </EntitySet>
    `)}
`);

// Phase 2 fixture: full schema for MyUDO (UDO)
const PHASE2_UDO_XML = edmx(`
    <EntityType Name="MyUDO">
        <Key><PropertyRef Name="DocEntry"/></Key>
        <Property Name="DocEntry" Type="Edm.Int32"/>
        <Property Name="Remarks" Type="Edm.String"/>
    </EntityType>
    ${entityContainer(`
        <EntitySet EntityType="SAPB1.MyUDO" Name="MyUDO">
            <Annotation Term="Common.Label" String="My User Defined Object"/>
            <Annotation Term="SAPB1.TableName" String="@MyUDO"/>
        </EntitySet>
    `)}
`);

const PHASE2_ORDERS_XML = edmx(`
    <EntityType Name="Document">
        <Key><PropertyRef Name="DocEntry"/></Key>
        <Property Name="DocEntry" Type="Edm.Int32"/>
        <Property Name="LicTradNum" Type="Edm.String"/>
    </EntityType>
    ${entityContainer(`
        <EntitySet EntityType="SAPB1.Document" Name="Orders">
            <Annotation Term="Common.Label" String="Sales Order"/>
            <Annotation Term="SAPB1.TableName" String="ORDR"/>
        </EntitySet>
    `)}
`);

const PHASE2_ORDERS_WITH_LINES_XML = edmx(`
    <ComplexType Name="DocumentLine">
        <Property Name="LineNum" Type="Edm.Int32"/>
        <Property Name="ItemCode" Type="Edm.String">
            <Annotation Term="SAPB1.ColumnName" String="ItemCode"/>
        </Property>
    </ComplexType>
    <EntityType Name="Document">
        <Key><PropertyRef Name="DocEntry"/></Key>
        <Property Name="DocEntry" Type="Edm.Int32"/>
        <Property Name="DocumentLines" Type="Collection(SAPB1.DocumentLine)">
            <Annotation Term="SAPB1.ChildTableName" String="RDR1"/>
        </Property>
    </EntityType>
    ${entityContainer(`
        <EntitySet EntityType="SAPB1.Document" Name="Orders">
            <Annotation Term="Common.Label" String="Sales Order"/>
            <Annotation Term="SAPB1.TableName" String="ORDR"/>
        </EntitySet>
    `)}
`);

const PHASE2_ORDERS_WITH_DEEP_NESTING_XML = edmx(`
    <ComplexType Name="SerialRow">
        <Property Name="DistNumber" Type="Edm.String">
            <Annotation Term="SAPB1.ColumnName" String="DistNumber"/>
        </Property>
        <Property Name="ManufacturerSerialNumber" Type="Edm.String"/>
    </ComplexType>
    <ComplexType Name="DocumentLine">
        <Property Name="ItemCode" Type="Edm.String">
            <Annotation Term="SAPB1.ColumnName" String="ItemCode"/>
        </Property>
        <Property Name="SerialNumbers" Type="Collection(SAPB1.SerialRow)">
            <Annotation Term="SAPB1.ChildTableName" String="OSRN"/>
        </Property>
    </ComplexType>
    <EntityType Name="Document">
        <Key><PropertyRef Name="DocEntry"/></Key>
        <Property Name="DocEntry" Type="Edm.Int32"/>
        <Property Name="DocumentLines" Type="Collection(SAPB1.DocumentLine)">
            <Annotation Term="SAPB1.ChildTableName" String="RDR1"/>
        </Property>
    </EntityType>
    ${entityContainer(`
        <EntitySet EntityType="SAPB1.Document" Name="Orders">
            <Annotation Term="Common.Label" String="Sales Order"/>
            <Annotation Term="SAPB1.TableName" String="ORDR"/>
        </EntitySet>
    `)}
`);

function makeLogger(): Logger {
    return {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as Logger;
}

function makeB1ServiceLayer(xmlByCall: string[]): B1ServiceLayer {
    let callIndex = 0;
    return {
        fetchMetadata: vi.fn(async () => {
            const xml = xmlByCall[callIndex] ?? xmlByCall[xmlByCall.length - 1];
            callIndex++;
            return xml;
        }),
        fetchPersonalFieldsByTable: vi.fn(async () => []),
    } as unknown as B1ServiceLayer;
}

function makeFetchMetadataMock(xmlByCall: string[]): ReturnType<typeof vi.fn> {
    let callIndex = 0;
    return vi.fn(async () => {
        const xml = xmlByCall[callIndex] ?? xmlByCall[xmlByCall.length - 1];
        callIndex++;
        return xml;
    });
}

function makeMetadataManager(options: {
    xmlByCall: string[];
    fetchPersonalFieldsByTable?: ReturnType<typeof vi.fn>;
}): {
    manager: B1MetadataManager;
    fetchMetadata: ReturnType<typeof vi.fn>;
    fetchPersonalFieldsByTable: ReturnType<typeof vi.fn>;
} {
    const fetchMetadata = makeFetchMetadataMock(options.xmlByCall);
    const fetchPersonalFieldsByTable = options.fetchPersonalFieldsByTable ?? vi.fn(async () => []);
    const client = {
        fetchMetadata,
        fetchPersonalFieldsByTable
    } as unknown as B1ServiceLayer;

    return {
        manager: new B1MetadataManager(client, makeLogger()),
        fetchMetadata,
        fetchPersonalFieldsByTable
    };
}

async function makeInitializedMetadataManager(options: {
    xmlByCall: string[];
    fetchPersonalFieldsByTable?: ReturnType<typeof vi.fn>;
}): Promise<{
    manager: B1MetadataManager;
    fetchMetadata: ReturnType<typeof vi.fn>;
    fetchPersonalFieldsByTable: ReturnType<typeof vi.fn>;
}> {
    const setup = makeMetadataManager(options);
    await setup.manager.initialize();
    return setup;
}

describe('B1MetadataManager — phase 1 entity list classification', () => {
    let manager: B1MetadataManager;

    beforeEach(async () => {
        const setup = await makeInitializedMetadataManager({
            xmlByCall: [PHASE1_XML]
        });
        manager = setup.manager;
    });

    it('populates entity list with correct count', () => {
        expect(manager.getEntityList()).toHaveLength(3);
    });

    it('classifies standard entity correctly', () => {
        const entity = manager.getEntityList().find(e => e.name === 'Orders');
        expect(entity?.entityClass).toBe('standard');
    });

    it('classifies UDT: U_* name with @-prefixed table annotation', () => {
        const entity = manager.getEntityList().find(e => e.name === 'U_ProjectData');
        expect(entity?.entityClass).toBe('udt');
    });

    it('classifies UDO: non-U_* name with @-prefixed table annotation', () => {
        const entity = manager.getEntityList().find(e => e.name === 'MyUDO');
        expect(entity?.entityClass).toBe('udo');
    });

    it('getCacheStats reports correct entity list count', () => {
        expect(manager.getCacheStats().entityListCount).toBe(3);
        expect(manager.getCacheStats().entitySchemaCacheSize).toBe(0);
    });
});

describe('B1MetadataManager — phase 2 lazy loading + UDF properties', () => {
    let manager: B1MetadataManager;
    let fetchMetadataMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        const setup = await makeInitializedMetadataManager({
            xmlByCall: [PHASE1_XML, PHASE2_UDT_XML, PHASE2_UDO_XML],
            fetchPersonalFieldsByTable: vi.fn(async (tableName: string) => tableName === '@PROJECTDATA'
                ? [{ tableName: '@ProjectData', fieldName: 'U_MyField', dataClassification: 'pfsdc_Personal' }]
                : [])
        });
        fetchMetadataMock = setup.fetchMetadata;
        manager = setup.manager;
    });

    it('loads entity schema on first call (cache miss)', async () => {
        await manager.getEntitySchema('U_ProjectData');
        // phase 1 + phase 2 = 2 calls total
        expect(fetchMetadataMock).toHaveBeenCalledTimes(2);
    });

    it('cache hit on second call — fetchMetadata not called again', async () => {
        await manager.getEntitySchema('U_ProjectData');
        await manager.getEntitySchema('U_ProjectData');
        expect(fetchMetadataMock).toHaveBeenCalledTimes(2); // still only phase1 + 1 phase2
        expect(manager.getCacheStats().cacheHits).toBe(1);
    });

    it('schema cache size increments per unique entity', async () => {
        await manager.getEntitySchema('U_ProjectData');
        expect(manager.getCacheStats().entitySchemaCacheSize).toBe(1);
        await manager.getEntitySchema('MyUDO');
        expect(manager.getCacheStats().entitySchemaCacheSize).toBe(2);
    });

    it('marks U_* property as isUDF', async () => {
        const schema = await manager.getEntitySchema('U_ProjectData');
        expect(schema.properties.get('U_MyField')?.isUDF).toBe(true);
    });

    it('non-U_ property is NOT isUDF', async () => {
        const schema = await manager.getEntitySchema('U_ProjectData');
        expect(schema.properties.get('Code')?.isUDF).toBeFalsy();
    });

    it('marks property as isPersonalField when table/field pair exists in PersonalFieldsSetups', async () => {
        const schema = await manager.getEntitySchema('U_ProjectData');
        expect(schema.properties.get('U_MyField')?.isPersonalField).toBe(true);
    });

    it('keeps property without personal fields match as not personal', async () => {
        const schema = await manager.getEntitySchema('U_ProjectData');
        expect(schema.properties.get('Code')?.isPersonalField).toBeFalsy();
    });

    it('propagates entityClass=udt to full schema', async () => {
        const schema = await manager.getEntitySchema('U_ProjectData');
        expect(schema.entityClass).toBe('udt');
    });

    it('propagates entityClass=udo to full schema', async () => {
        await manager.getEntitySchema('U_ProjectData'); // consume first phase2 mock
        const schema = await manager.getEntitySchema('MyUDO');
        expect(schema.entityClass).toBe('udo');
    });

    it('loads and caches personal field rows per table', async () => {
        const byTablePersonalFields = vi.fn(async (tableName: string) => tableName === '@MYUDO'
            ? [{ tableName: '@MyUDO', fieldName: 'Remarks', dataClassification: 'pfsdc_Personal' }]
            : []);

        const { manager: pagedManager } = await makeInitializedMetadataManager({
            xmlByCall: [PHASE1_XML, PHASE2_UDO_XML],
            fetchPersonalFieldsByTable: byTablePersonalFields
        });
        const schema = await pagedManager.getEntitySchema('MyUDO');
        await pagedManager.getEntitySchema('MyUDO');

        expect(schema.properties.get('Remarks')?.isPersonalField).toBe(true);
        expect(byTablePersonalFields).toHaveBeenCalledTimes(1);
        expect(byTablePersonalFields).toHaveBeenCalledWith('@MYUDO');
    });

    it('loads personal fields using the entity table name', async () => {
        const { manager: mappedManager } = await makeInitializedMetadataManager({
            xmlByCall: [PHASE1_XML, PHASE2_ORDERS_XML],
            fetchPersonalFieldsByTable: vi.fn(async (tableName: string) => tableName === 'ORDR'
                ? [{ tableName: 'ORDR', fieldName: 'LicTradNum', dataClassification: 'pfsdc_Personal' }]
                : [])
        });
        const schema = await mappedManager.getEntitySchema('Orders');
        const entity = mappedManager.getEntityList().find((e) => e.name === 'Orders');

        expect(entity?.table).toBe('ORDR');
        expect(schema.properties.get('LicTradNum')?.isPersonalField).toBe(true);
    });

    it('marks nested complex-type properties using childTableName + fieldName', async () => {
        const { manager: mappedManager } = await makeInitializedMetadataManager({
            xmlByCall: [PHASE1_XML, PHASE2_ORDERS_WITH_LINES_XML],
            fetchPersonalFieldsByTable: vi.fn(async (tableName: string) => tableName === 'RDR1'
                ? [{ tableName: 'RDR1', fieldName: 'ItemCode', dataClassification: 'pfsdc_Personal' }]
                : [])
        });
        await mappedManager.getEntitySchema('Orders');

        const lineProps = mappedManager.getComplexTypeProperties('Orders', 'DocumentLine');
        expect(lineProps?.find(p => p.name === 'ItemCode')?.isPersonalField).toBe(true);
        expect(lineProps?.find(p => p.name === 'LineNum')?.isPersonalField).toBeFalsy();
    });

    it('switches table context across deep nesting levels via childTableName', async () => {
        const { manager: mappedManager } = await makeInitializedMetadataManager({
            xmlByCall: [PHASE1_XML, PHASE2_ORDERS_WITH_DEEP_NESTING_XML],
            fetchPersonalFieldsByTable: vi.fn(async (tableName: string) => {
                if (tableName === 'RDR1') {
                    return [{ tableName: 'RDR1', fieldName: 'ItemCode', dataClassification: 'pfsdc_Personal' }];
                }
                if (tableName === 'OSRN') {
                    return [{ tableName: 'OSRN', fieldName: 'DistNumber', dataClassification: 'pfsdc_Personal' }];
                }
                return [];
            })
        });
        await mappedManager.getEntitySchema('Orders');

        const lineProps = mappedManager.getComplexTypeProperties('Orders', 'DocumentLine');
        expect(lineProps?.find(p => p.name === 'ItemCode')?.isPersonalField).toBe(true);

        const serialProps = mappedManager.getComplexTypeProperties('Orders', 'SerialRow');
        expect(serialProps?.find(p => p.name === 'DistNumber')?.isPersonalField).toBe(true);
        expect(serialProps?.find(p => p.name === 'ManufacturerSerialNumber')?.isPersonalField).toBeFalsy();
    });

    it('keeps same-named complex types exclusive per entity set', async () => {
        const phase1 = edmx(entityContainer(`
            <EntitySet EntityType="SAPB1.Document" Name="Orders">
                <Annotation Term="SAPB1.TableName" String="ORDR"/>
            </EntitySet>
            <EntitySet EntityType="SAPB1.Document" Name="Invoices">
                <Annotation Term="SAPB1.TableName" String="OINV"/>
            </EntitySet>
        `));

        const phase2Orders = edmx(`
            <ComplexType Name="DocumentLine">
                <Property Name="OrderOnlyField" Type="Edm.String"/>
            </ComplexType>
            <EntityType Name="Document">
                <Key><PropertyRef Name="DocEntry"/></Key>
                <Property Name="DocEntry" Type="Edm.Int32"/>
                <Property Name="DocumentLines" Type="Collection(SAPB1.DocumentLine)"/>
            </EntityType>
            ${entityContainer(`
                <EntitySet EntityType="SAPB1.Document" Name="Orders">
                    <Annotation Term="SAPB1.TableName" String="ORDR"/>
                </EntitySet>
            `)}
        `);

        const phase2Invoices = edmx(`
            <ComplexType Name="DocumentLine">
                <Property Name="InvoiceOnlyField" Type="Edm.String"/>
            </ComplexType>
            <EntityType Name="Document">
                <Key><PropertyRef Name="DocEntry"/></Key>
                <Property Name="DocEntry" Type="Edm.Int32"/>
                <Property Name="DocumentLines" Type="Collection(SAPB1.DocumentLine)"/>
            </EntityType>
            ${entityContainer(`
                <EntitySet EntityType="SAPB1.Document" Name="Invoices">
                    <Annotation Term="SAPB1.TableName" String="OINV"/>
                </EntitySet>
            `)}
        `);

        const { manager: scopedManager } = await makeInitializedMetadataManager({
            xmlByCall: [phase1, phase2Orders, phase2Invoices]
        });

        await scopedManager.getEntitySchema('Orders');
        await scopedManager.getEntitySchema('Invoices');

        const orderCtProps = scopedManager.getComplexTypeProperties('Orders', 'DocumentLine');
        const invoiceCtProps = scopedManager.getComplexTypeProperties('Invoices', 'DocumentLine');

        expect(orderCtProps?.some(p => p.name === 'OrderOnlyField')).toBe(true);
        expect(orderCtProps?.some(p => p.name === 'InvoiceOnlyField')).toBe(false);
        expect(invoiceCtProps?.some(p => p.name === 'InvoiceOnlyField')).toBe(true);
        expect(invoiceCtProps?.some(p => p.name === 'OrderOnlyField')).toBe(false);
    });
});

describe('B1MetadataManager — PersonalFieldsSetups on-demand health and fail-closed mode', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    it('marks personal field cache unhealthy when table-scoped personal fields load fails (non-production)', async () => {
        process.env.NODE_ENV = 'test';

        const { manager } = await makeInitializedMetadataManager({
            xmlByCall: [PHASE1_XML, PHASE2_ORDERS_XML],
            fetchPersonalFieldsByTable: vi.fn(async () => {
                throw new Error('PersonalFieldsSetups unavailable');
            })
        });
        await manager.getEntitySchema('Orders');

        expect(manager.isPersonalFieldCacheHealthy()).toBe(false);
        expect(manager.getPersonalFieldCacheError()).toContain('PersonalFieldsSetups unavailable');
    });

    it('fails closed in production when table-scoped personal fields cannot be loaded', async () => {
        process.env.NODE_ENV = 'production';

        const { manager } = await makeInitializedMetadataManager({
            xmlByCall: [PHASE1_XML, PHASE2_ORDERS_XML],
            fetchPersonalFieldsByTable: vi.fn(async () => {
                throw new Error('PersonalFieldsSetups unavailable');
            })
        });
        await expect(manager.getEntitySchema('Orders')).rejects.toThrow('Failed to load PersonalFieldsSetups for table ORDR in fail-closed mode');
    });
});

describe('B1MetadataManager — TTL cache refresh', () => {
    const originalMetadataTtlMinutes = config.get<number>('metadata.cacheTtlMinutes', 30);

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        config.set('metadata.cacheTtlMinutes', 0.001);
    });

    afterEach(() => {
        vi.useRealTimers();
        config.set('metadata.cacheTtlMinutes', originalMetadataTtlMinutes);
    });

    it('refreshes entity list and schema when metadata TTL expires', async () => {
        const { manager, fetchMetadata } = makeMetadataManager({
            xmlByCall: [PHASE1_XML, PHASE2_ORDERS_XML, PHASE1_XML, PHASE2_ORDERS_XML]
        });
        await manager.getEntitySchema('Orders');

        vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));
        await manager.getEntitySchema('Orders');

        expect(fetchMetadata).toHaveBeenCalledTimes(4);
    });

    it('refreshes personal fields for entity tables when schema is rebuilt after metadata TTL expiry', async () => {
        const fetchPersonalFieldsByTable = vi.fn()
            .mockResolvedValueOnce([
                { tableName: 'ORDR', fieldName: 'LicTradNum', dataClassification: 'pfsdc_Personal' }
            ])
            .mockResolvedValueOnce([]);

        const { manager } = makeMetadataManager({
            xmlByCall: [PHASE1_XML, PHASE2_ORDERS_XML, PHASE1_XML, PHASE2_ORDERS_XML],
            fetchPersonalFieldsByTable
        });
        const firstSchema = await manager.getEntitySchema('Orders');
        expect(firstSchema.properties.get('LicTradNum')?.isPersonalField).toBe(true);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));

        const refreshedSchema = await manager.getEntitySchema('Orders');
        expect(refreshedSchema.properties.get('LicTradNum')?.isPersonalField).toBeFalsy();
        expect(fetchPersonalFieldsByTable).toHaveBeenCalledTimes(2);
    });
});

describe('B1DiscoveryService — per-company cache isolation', () => {
    // Phase 1 XML fixtures that differ per company so we can distinguish them
    const PHASE1_COMPANY_A = edmx(entityContainer(`
        <EntitySet EntityType="SAPB1.U_TableA" Name="U_TableA">
            <Annotation Term="Common.Label" String="Company A UDT"/>
            <Annotation Term="SAPB1.TableName" String="@TableA"/>
        </EntitySet>
    `));

    const PHASE1_COMPANY_B = edmx(entityContainer(`
        <EntitySet EntityType="SAPB1.UDO_B" Name="UDO_B">
            <Annotation Term="Common.Label" String="Company B UDO"/>
            <Annotation Term="SAPB1.TableName" String="@UDO_B"/>
        </EntitySet>
    `));

    const PHASE1_DIRECT = edmx(entityContainer(`
        <EntitySet EntityType="SAPB1.Items" Name="Items">
            <Annotation Term="Common.Label" String="Items"/>
            <Annotation Term="SAPB1.TableName" String="OITM"/>
        </EntitySet>
    `));

    function makeDiscoveryService(sharedClientXml: string): {
        svc: B1DiscoveryService;
        sharedFetch: ReturnType<typeof vi.fn>;
    } {
        const sharedFetch = vi.fn().mockResolvedValue(sharedClientXml);
        const sharedB1Client = { fetchMetadata: sharedFetch } as unknown as B1ServiceLayer;

        const mockB1Client = {
            getB1Client: vi.fn().mockReturnValue(sharedB1Client),
            setCompanyId: vi.fn(),
            getCompanyId: vi.fn(),
            setUserToken: vi.fn(),
            getUserToken: vi.fn(),
        } as unknown as B1Client;

        const mockConfig = {
            get: vi.fn().mockReturnValue('https://localhost:50000'),
        } as unknown as Config;

        const svc = new B1DiscoveryService(mockB1Client, makeLogger(), mockConfig);
        return { svc, sharedFetch };
    }

    function makePerSessionClient(xml: string): B1ServiceLayer {
        return makeB1ServiceLayer([xml]);
    }

    it('creates separate metadata managers for different companies', async () => {
        const { svc } = makeDiscoveryService(PHASE1_DIRECT);
        const clientA = makePerSessionClient(PHASE1_COMPANY_A);
        const clientB = makePerSessionClient(PHASE1_COMPANY_B);

        await svc.getDiscoveredServices('COMPANY_A', clientA);
        await svc.getDiscoveredServices('COMPANY_B', clientB);

        const managerA = svc.getB1MetadataManager('COMPANY_A');
        const managerB = svc.getB1MetadataManager('COMPANY_B');

        expect(managerA).toBeDefined();
        expect(managerB).toBeDefined();
        expect(managerA).not.toBe(managerB);
    });

    it('direct mode (no companyDb) stores under empty-string key', async () => {
        const { svc } = makeDiscoveryService(PHASE1_DIRECT);
        const directClient = makePerSessionClient(PHASE1_DIRECT);

        await svc.getDiscoveredServices(undefined, directClient);

        // getB1MetadataManager() with no arg → key ''
        expect(svc.getB1MetadataManager()).toBeDefined();
        // Should be the same as passing '' explicitly
        expect(svc.getB1MetadataManager('')).toBe(svc.getB1MetadataManager());
    });

    it('returns cached services on second call without re-fetching metadata', async () => {
        const { svc } = makeDiscoveryService(PHASE1_DIRECT);
        const fetchMock = vi.fn().mockResolvedValue(PHASE1_COMPANY_A);
        const clientA = { fetchMetadata: fetchMock } as unknown as B1ServiceLayer;

        await svc.getDiscoveredServices('COMPANY_A', clientA);
        await svc.getDiscoveredServices('COMPANY_A', clientA);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('company A entity list is independent from company B', async () => {
        const { svc } = makeDiscoveryService(PHASE1_DIRECT);
        const clientA = makePerSessionClient(PHASE1_COMPANY_A);
        const clientB = makePerSessionClient(PHASE1_COMPANY_B);

        await svc.getDiscoveredServices('COMPANY_A', clientA);
        await svc.getDiscoveredServices('COMPANY_B', clientB);

        const listA = svc.getB1MetadataManager('COMPANY_A')!.getEntityList();
        const listB = svc.getB1MetadataManager('COMPANY_B')!.getEntityList();

        // Company A has only U_TableA (udt)
        expect(listA).toHaveLength(1);
        expect(listA[0].name).toBe('U_TableA');
        expect(listA[0].entityClass).toBe('udt');

        // Company B has only UDO_B (udo)
        expect(listB).toHaveLength(1);
        expect(listB[0].name).toBe('UDO_B');
        expect(listB[0].entityClass).toBe('udo');
    });

    it('concurrent requests for the same company deduplicate initialization', async () => {
        const { svc } = makeDiscoveryService(PHASE1_DIRECT);
        const fetchMock = vi.fn().mockResolvedValue(PHASE1_COMPANY_A);
        const clientA = { fetchMetadata: fetchMock } as unknown as B1ServiceLayer;

        // Fire two concurrent requests before the first resolves
        const [result1, result2] = await Promise.all([
            svc.getDiscoveredServices('COMPANY_A', clientA),
            svc.getDiscoveredServices('COMPANY_A', clientA),
        ]);

        // Metadata fetched exactly once despite two concurrent callers
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // Both callers receive the same service
        expect(result1[0].id).toBe(result2[0].id);
    });
});
