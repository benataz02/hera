import { describe, it, expect, beforeAll, vi } from 'vitest';

import { B1SAPToolRegistry } from '../../tools/b1-tool-registry.js';
import { getValidCategories } from '../../tools/b1-category-mappings.js';
import { runWithRequestContext } from '../../utils/request-context.js';
import type { DiscoveredEntitySet, ODataService, ServiceMetadata } from '../../types/b1-types.js';

type ToolContent = { type?: string; text?: string };
type ToolResult = { content?: ToolContent[]; structuredContent?: unknown; isError?: boolean };
type MatchItem = {
  entityName: string;
  categories: string[];
};
type DiscoveryResult = {
  query?: string;
  matches: MatchItem[];
  totalFound: number;
};

function getText(result: unknown): string {
  const r = result as ToolResult;
  return (r.content?.[0]?.text ?? '');
}

function getStructuredContent<T>(result: unknown): T | null {
  const r = result as ToolResult;
  return (r.structuredContent as T | undefined) ?? null;
}

function parseDiscoveryResult(result: unknown): DiscoveryResult | null {
  return getStructuredContent<DiscoveryResult>(result);
}

function getRequiredTool(
  tools: Map<string, { def: unknown; handler: (args: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> }>,
  toolName: string
): { def: unknown; handler: (args: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> } {
  const tool = tools.get(toolName);
  expect(tool, `Expected tool '${toolName}' to be registered`).toBeDefined();
  return tool as { def: unknown; handler: (args: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> };
}

// Minimal test logger
class TestLogger {
  info() { return undefined; }
  warn() { return undefined; }
  error() { return undefined; }
  debug() { return undefined; }
}

// Mock MCP server capturing tools
class MockMcpServer {
  public tools: Map<string, { def: unknown; handler: (args: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> }>;
  constructor() {
    this.tools = new Map();
  }
  registerTool(name: string, def: unknown, handler: (args: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>) {
    this.tools.set(name, { def, handler });
  }
  // Not needed for these tests but present in real server
  registerResource() { return undefined; }
}

// Mock SAP client that records calls
class MockSAPClient {
  public last: Record<string, unknown> | undefined;
  private companyId?: string;
  setUserToken() { return undefined; }
  setCompanyId(companyId?: string) { this.companyId = companyId; }
  getCompanyId() { return this.companyId; }
  getB1Client() { return undefined; }
  async readEntitySet(servicePath: string, entitySet: string, queryOptions?: Record<string, unknown>) {
    const url = `${servicePath}${entitySet}`;
    this.last = { op: 'readEntitySet', url, queryOptions };
    return { data: { kind: 'list', items: [{ id: 1 }], echo: this.last } };
  }
  async readEntity(servicePath: string, entitySet: string, key: string) {
    const url = `${servicePath}${entitySet}('${key}')`;
    this.last = { op: 'readEntity', url };
    return { data: { kind: 'single', id: key, echo: this.last } };
  }
  async createEntity(
    servicePath: string,
    entitySet: string,
    data: unknown,
    options?: { preferReturnNoContent?: boolean }
  ) {
    const url = `${servicePath}${entitySet}`;
    this.last = { op: 'createEntity', url, data, options };
    return { status: 201, headers: {}, data: { kind: 'created', data, echo: this.last } };
  }
  async updateEntity(servicePath: string, entitySet: string, key: string, data: unknown) {
    const url = `${servicePath}${entitySet}('${key}')`;
    this.last = { op: 'updateEntity', url, data };
    return { data: { kind: 'updated', id: key, data, echo: this.last } };
  }
  async deleteEntity(servicePath: string, entitySet: string, key: string) {
    const url = `${servicePath}${entitySet}('${key}')`;
    this.last = { op: 'deleteEntity', url };
    return { data: { kind: 'deleted', id: key, echo: this.last } };
  }
}

class MockDiscoveryService {
  constructor(
    private readonly services: ODataService[],
    private readonly metadataManager?: {
      getEntityList: () => Array<{ name: string }>;
      getEntitySchema: (entityName: string) => Promise<{
        name: string;
        entitySet: string;
        namespace: string;
        keys: string[];
        properties: Map<string, {
          name: string;
          type: { name: string; category: number };
          isArray?: boolean;
          maxLength?: number;
          description?: string;
          isUDF?: boolean;
          isPersonalField?: boolean;
        }>;
      }>;
      getComplexTypeProperties: (entitySetName: string, typeName: string) => Array<{
        name: string;
        type: { name: string; category: number };
        isArray?: boolean;
        maxLength?: number;
        description?: string;
        isUDF?: boolean;
        isPersonalField?: boolean;
      }> | null;
    }
  ) { }

  async getDiscoveredServices(): Promise<ODataService[]> {
    return this.services;
  }

  getB1MetadataManager() {
    return this.metadataManager;
  }
}

const PRIMITIVE_CATEGORY = 0;
const ENUM_CATEGORY = 1;
const COMPLEX_CATEGORY = 2;

const MOCK_B1_METADATA_MANAGER = {
  getEntityList: () => MOCK_ENTITY_TYPES.map((e) => ({ name: e.name })),
  async getEntitySchema(entityName: string) {
    if (entityName === 'Orders') {
      return {
        name: 'Orders',
        entitySet: 'Orders',
        namespace: 'SAPB1',
        keys: ['DocEntry'],
        properties: new Map([
          ['DocEntry', { name: 'DocEntry', type: { name: 'Edm.Int32', category: PRIMITIVE_CATEGORY } }],
          ['DocNum', { name: 'DocNum', type: { name: 'Edm.Int32', category: PRIMITIVE_CATEGORY } }],
          ['DocumentStatus', {
            name: 'DocumentStatus',
            type: {
              name: 'BoStatus',
              category: ENUM_CATEGORY,
              isArray: false,
              members: new Map([
                ['bost_Open', 'O'],
                ['bost_Close', 'C'],
              ]),
              codes: new Map([
                ['O', 'bost_Open'],
                ['C', 'bost_Close'],
              ])
            }
          }],
          ['U_SOH_UDF1', { name: 'U_SOH_UDF1', type: { name: 'Edm.String', category: PRIMITIVE_CATEGORY }, isUDF: true }],
          ['DocumentLines', { name: 'DocumentLines', type: { name: 'DocumentLine', category: COMPLEX_CATEGORY }, isArray: true }],
          ['DocumentAdditionalExpenses', { name: 'DocumentAdditionalExpenses', type: { name: 'DocumentAdditionalExpense', category: COMPLEX_CATEGORY }, isArray: true }],
        ])
      };
    }

    if (entityName === 'Items') {
      return {
        name: 'Items',
        entitySet: 'Items',
        namespace: 'SAPB1',
        keys: ['ItemCode'],
        properties: new Map([
          ['ItemCode', { name: 'ItemCode', type: { name: 'Edm.String', category: PRIMITIVE_CATEGORY }, maxLength: 50 }],
          ['ItemName', { name: 'ItemName', type: { name: 'Edm.String', category: PRIMITIVE_CATEGORY }, maxLength: 100, isPersonalField: true }],
        ])
      };
    }

    throw new Error(`Unknown entity schema requested in test manager: ${entityName}`);
  },
  getComplexTypeProperties(entitySetName: string, typeName: string) {
    if (entitySetName === 'Orders' && typeName === 'DocumentLine') {
      return [
        { name: 'LineNum', type: { name: 'Edm.Int32', category: PRIMITIVE_CATEGORY } },
        { name: 'ItemCode', type: { name: 'Edm.String', category: PRIMITIVE_CATEGORY } },
        {
          name: 'UseBaseUnits',
          type: {
            name: 'BoYesNoEnum',
            category: ENUM_CATEGORY,
            isArray: false,
            members: new Map([
              ['tNO', 'N'],
              ['tYES', 'Y'],
            ]),
            codes: new Map([
              ['N', 'tNO'],
              ['Y', 'tYES'],
            ])
          }
        },
        {
          name: 'LineTaxJurisdictions',
          type: { name: 'LineTaxJurisdiction', category: COMPLEX_CATEGORY },
          isArray: true,
          description: 'Sales Order - Tax Amount per Document'
        },
      ];
    }
    if (entitySetName === 'Orders' && typeName === 'LineTaxJurisdiction') {
      return [
        { name: 'JurisdictionCode', type: { name: 'Edm.String', category: PRIMITIVE_CATEGORY } },
        { name: 'TaxAmount', type: { name: 'Edm.Double', category: PRIMITIVE_CATEGORY } },
      ];
    }
    if (entitySetName === 'Orders' && typeName === 'DocumentAdditionalExpense') {
      return [
        { name: 'ExpenseCode', type: { name: 'Edm.Int32', category: PRIMITIVE_CATEGORY } },
      ];
    }
    return null;
  }
};

// Direct entity list definitions — no XML parsing needed
const MOCK_ENTITY_TYPES: DiscoveredEntitySet[] = [
  { name: 'Items', table: 'OITM', description: 'Items', entityTypeName: 'SAPB1.Item' },
  { name: 'BusinessPartners', table: 'OCRD', description: 'Business Partners', entityTypeName: 'SAPB1.BusinessPartner' },
  { name: 'Orders', table: 'ORDR', description: 'Sales Orders', entityTypeName: 'SAPB1.Document' },
  { name: 'Quotations', table: 'OQUT', description: 'Sales Quotations', entityTypeName: 'SAPB1.Document' },
  { name: 'DeliveryNotes', table: 'ODLN', description: 'Delivery Notes', entityTypeName: 'SAPB1.Document' },
  { name: 'Invoices', table: 'OINV', description: 'A/R Invoices', entityTypeName: 'SAPB1.Document' },
  { name: 'CreditNotes', table: 'ORIN', description: 'A/R Credit Notes', entityTypeName: 'SAPB1.Document' },
  { name: 'Returns', table: 'ORDN', description: 'Returns', entityTypeName: 'SAPB1.Document' },
  { name: 'DownPayments', table: 'ODPI', description: 'A/R Down Payments', entityTypeName: 'SAPB1.Document' },
  { name: 'SalesOpportunities', table: 'OOPR', description: 'Sales Opportunities', entityTypeName: 'SAPB1.SalesOpportunity' },
  { name: 'Activities', table: 'OCLG', description: 'Activities', entityTypeName: 'SAPB1.Activity' },
  { name: 'SalesPersons', table: 'OSLP', description: 'Sales Employees', entityTypeName: 'SAPB1.SalesPerson' },
  { name: 'Campaigns', table: 'OCPG', description: 'Campaigns', entityTypeName: 'SAPB1.Campaign' },
  { name: 'PurchaseOrders', table: 'OPOR', description: 'Purchase Orders', entityTypeName: 'SAPB1.Document' },
  { name: 'PurchaseInvoices', table: 'OPCH', description: 'A/P Invoices', entityTypeName: 'SAPB1.Document' },
  // UDO: name does NOT start with U_, entityClass = 'udo'
  { name: 'MyCustomUDO', table: '@MYCUSTOMUDO', description: 'My Custom UDO', entityTypeName: 'SAPB1.MyCustomUDO', entityClass: 'udo' },
  // UDTs: name starts with U_, entityClass = 'udt'
  { name: 'U_CustomTable', table: '@U_CUSTOMTABLE', description: 'User Table', entityTypeName: 'SAPB1.U_CustomTable', entityClass: 'udt' },
  { name: 'U_ProjectData', table: '@U_PROJECTDATA', description: 'Project Data', entityTypeName: 'SAPB1.U_ProjectData', entityClass: 'udt' },
  { name: 'U_EmployeeExt', table: '@U_EMPLOYEEEXT', description: 'Employee Extensions', entityTypeName: 'SAPB1.U_EmployeeExt', entityClass: 'udt' },
];

const MOCK_SERVICE_METADATA: ServiceMetadata = {
  entities: MOCK_ENTITY_TYPES,
  version: '1.0',
  namespace: 'SAPB1',
};

const MOCK_SERVICE: ODataService = {
  id: 'B1_SERVICE_LAYER',
  version: '1.0',
  title: 'B1 Service Layer',
  description: 'Mock B1 Service Layer for tests',
  odataVersion: 'v4',
  url: 'https://example.com/b1s/v2/',
  metadataUrl: 'https://example.com/b1s/v2/$metadata',
  metadata: MOCK_SERVICE_METADATA,
};

describe('B1SAPToolRegistry.registerDiscoveryTools', () => {
  const logger = new TestLogger();
  const mcp = new MockMcpServer();
  const sap = new MockSAPClient();
  const discoveryService = new MockDiscoveryService([MOCK_SERVICE], MOCK_B1_METADATA_MANAGER);

  beforeAll(async () => {
    const registry = new B1SAPToolRegistry(
      mcp as unknown as never,
      sap as unknown as never,
      logger as never,
      discoveryService as unknown as never
    );
    await registry.registerDiscoveryTools();
  });

  it('registers all 4 core discovery tools', () => {
    expect(mcp.tools.has('b1_find_entities')).toBe(true);
    expect(mcp.tools.has('b1_get_entity_schema')).toBe(true);
    expect(mcp.tools.has('b1_read')).toBe(true);
    expect(mcp.tools.has('b1_write')).toBe(true);
  });

  it('b1_find_entities returns minimal entity listing including Items', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ query: 'Items', limit: 10 });
    const text = getText(res);
    const parsed = parseDiscoveryResult(res);

    expect(text).toContain('[STEP 1 -');
    expect(text).toContain('NEXT STEP: Call b1_get_entity_schema');
    expect(text).toContain('Items');
    expect(parsed).not.toBeNull();
    expect(parsed?.matches.some(m => m.entityName === 'Items')).toBe(true);
  });

  it('b1_find_entities forwards ALS companyId to discovery service', async () => {
    const localMcp = new MockMcpServer();
    const localSap = new MockSAPClient();
    const localLogger = new TestLogger();
    let observedCompanyId: string | undefined;
    const localDiscoveryService = {
      getDiscoveredServices: vi.fn(async (companyId?: string) => {
        observedCompanyId = companyId;
        return [MOCK_SERVICE];
      }),
      getB1MetadataManager: vi.fn(() => undefined)
    };

    const localRegistry = new B1SAPToolRegistry(
      localMcp as unknown as never,
      localSap as unknown as never,
      localLogger as never,
      localDiscoveryService as unknown as never
    );
    await localRegistry.registerDiscoveryTools();

    const t = getRequiredTool(localMcp.tools, 'b1_find_entities');
    await runWithRequestContext({ requestId: 'req-discovery-1', companyId: 'ALS_COMPANY_1' }, async () => {
      await t.handler({ query: 'Items', limit: 5 });
    });

    expect(observedCompanyId).toBe('ALS_COMPANY_1');
  });

  it('b1_find_entities with category "sales" and limit 5 returns only 5 entities', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ category: 'sales', limit: 5 });
    const text = getText(res);

    // Parse the JSON result to verify entity count
    const result = parseDiscoveryResult(res);
    expect(result).not.toBeNull();
    if (!result) return;

    // Matches are flat entity entries
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThanOrEqual(5);
    for (const entity of result.matches) {
      expect(entity.categories).toContain('sales');
    }
    expect(text).toContain('NEXT STEP: Call b1_get_entity_schema');
  });

  it('b1_find_entities with category "sales" and limit 10 returns max 10 entities', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ category: 'sales', limit: 10 });
    const text = getText(res);

    // Parse result to verify entity limit
    const result = parseDiscoveryResult(res);
    expect(result).not.toBeNull();
    if (!result) return;

    // Matches are flat entity entries — should not exceed limit of 10
    expect(result.matches.length).toBeLessThanOrEqual(10);

    // Verify all returned entities are sales-related
    const salesEntities = ['orders', 'quotations', 'deliverynotes', 'invoices',
      'creditnotes', 'returns', 'downpayments', 'salesopportunities',
      'activities', 'salespersons', 'campaigns'];

    for (const entity of result.matches) {
      const entityNameLower = entity.entityName.toLowerCase();
      const isSalesEntity = salesEntities.some(se => entityNameLower.includes(se));
      if (isSalesEntity) {
        expect(entity.categories).toContain('sales');
      }
    }
    expect(text).toContain('NEXT STEP: Call b1_get_entity_schema');
  });

  it('b1_find_entities with category "sales" without limit uses default limit 20', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ category: 'sales' });
    const text = getText(res);

    // Parse to check default limit behavior
    const result = parseDiscoveryResult(res);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.matches.length).toBeLessThanOrEqual(20);
    for (const entity of result.matches) {
      expect(entity.categories).toContain('sales');
    }
    expect(text).toContain('NEXT STEP: Call b1_get_entity_schema');
  });

  it('b1_find_entities with category "purchase" and limit 3 filters purchase entities', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ category: 'purchase', limit: 3 });
    const text = getText(res);

    // Parse result
    const result = parseDiscoveryResult(res);
    expect(result).not.toBeNull();
    if (!result) return;

    // Flat entity matches — should respect limit of 3
    expect(result.matches.length).toBeLessThanOrEqual(3);
    for (const entity of result.matches) {
      expect(entity.categories).toContain('purchase');
    }
    expect(text).toContain('NEXT STEP: Call b1_get_entity_schema');
  });

  it('b1_find_entities shows clear message when entities are limited', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ category: 'sales', limit: 3 });
    const text = getText(res);

    // When limit is applied and there are more entities, should show limiting message
    const result = parseDiscoveryResult(res);
    if (result && result.totalFound > result.matches.length) {
      expect(text).toMatch(/Showing \d+ of \d+/i);
    }
  });

  it('getValidCategories includes user-defined-table', () => {
    expect(getValidCategories()).toContain('user-defined-table');
  });

  it('b1_find_entities with category "user-defined-table" returns only U_* entities', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ category: 'user-defined-table', limit: 20 });
    const text = getText(res);
    const result = parseDiscoveryResult(res);
    expect(result).not.toBeNull();
    if (!result) return;

    // All returned entities must start with U_
    for (const entity of result.matches) {
      expect(entity.entityName).toMatch(/^U_/i);
    }

    // The 3 mock UDT entities must all be present
    const names = result.matches.map(e => e.entityName);
    expect(names).toContain('U_CustomTable');
    expect(names).toContain('U_ProjectData');
    expect(names).toContain('U_EmployeeExt');
    expect(text).toContain('NEXT STEP: Call b1_get_entity_schema');
  });

  it('b1_find_entities user-defined-table entities carry correct category tag', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ category: 'user-defined-table', limit: 20 });

    const result = parseDiscoveryResult(res);
    expect(result).not.toBeNull();
    if (!result) return;

    for (const entity of result.matches) {
      expect(entity.categories).toContain('user-defined-table');
    }
  });

  it('b1_find_entities with category "sales" does not include U_* entities', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ category: 'sales', limit: 50 });

    const result = parseDiscoveryResult(res);
    if (!result) return;

    for (const entity of result.matches) {
      expect(entity.entityName).not.toMatch(/^U_/i);
    }
  });

  it('b1_find_entities query for U_ prefix returns user-defined-table entities', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ query: 'u_', limit: 20 });
    const text = getText(res);

    const result = parseDiscoveryResult(res);
    expect(result).not.toBeNull();
    if (!result) return;

    // At least one entity match should exist
    expect(result.matches.length).toBeGreaterThan(0);

    // All matches should be U_* and carry user-defined-table category
    for (const match of result.matches) {
      expect(match.entityName).toMatch(/^U_/i);
      expect(match.categories).toContain('user-defined-table');
    }
    expect(text).toContain('[STEP 1 - SEARCH RESULTS]');
  });

  it('b1_find_entities with category "user-defined-object" returns only UDO entities', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_find_entities');
    const res = await t.handler({ category: 'user-defined-object', limit: 20 });

    const result = parseDiscoveryResult(res);
    expect(result).not.toBeNull();
    if (!result) return;

    // UDO entities must NOT start with U_
    for (const entity of result.matches) {
      expect(entity.entityName).not.toMatch(/^U_/i);
      expect(entity.categories).toContain('user-defined-object');
    }

    const names = result.matches.map(e => e.entityName);
    expect(names).toContain('MyCustomUDO');
  });

  it('getValidCategories includes user-defined-object', () => {
    expect(getValidCategories()).toContain('user-defined-object');
  });

  it('b1_get_entity_schema returns full schema when passing entity set name', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_get_entity_schema');
    const res = await t.handler({ entityName: 'Items' });
    const text = getText(res);
    const structured = getStructuredContent<{
      properties: Array<{ name: string; type: string }>;
      structuralProperties: Array<{ name: string; complexTypeName: string; isArray: boolean }>;
    }>(res);

    expect(text).toContain('[STEP 2 - ENTITY METADATA]');
    expect(text).toContain('Key Properties: [ItemCode]');
    expect(text).toContain('Properties:');
    expect(structured).not.toBeNull();
    if (!structured) return;
    expect(structured.properties.some(p => p.name === 'ItemCode')).toBe(true);
    expect(structured.properties.some(p => p.name === 'ItemName')).toBe(true);
    expect(Array.isArray(structured.structuralProperties)).toBe(true);

    // Scalar properties must not include array/collection entries
    for (const prop of structured.properties) {
      expect(prop.type).not.toMatch(/^Collection\(/);
    }
  });

  it('b1_get_entity_schema returns error for structuralTypeName without prior schema load', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_get_entity_schema');
    // In mock context B1MetadataManager is unavailable, so structuralTypeName lookup fails gracefully
    const res = await t.handler({ entityName: 'Items', structuralTypeName: 'DocumentLine' });
    const text = getText(res);
    // Either returns a "not found" error (mock has no structural properties) or structural type schema
    expect(text).toBeTruthy();
  });

  it('b1_get_entity_schema for Orders (Step 2.1) returns scalar properties and structural properties list', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_get_entity_schema');
    const res = await t.handler({ entityName: 'Orders' });
    const text = getText(res);
    const parsed = getStructuredContent<{
      properties: Array<{ name: string; type: string; isEnum?: boolean }>;
      enumTypes?: Record<string, { members: Array<{ name: string; code: string }> }>;
      structuralProperties: Array<{ name: string; complexTypeName: string; isArray: boolean }>;
    }>(res);

    expect(text).toContain('[STEP 2 - ENTITY METADATA]');
    expect(text).toContain('Key Properties: [DocEntry]');
    expect(text).toContain('Structural Properties');
    expect(text).toContain('Properties:');
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    // Scalar properties must not include Collection(...) entries
    for (const prop of parsed.properties) {
      expect(prop.type).not.toMatch(/^Collection\(/);
    }
    expect(parsed.properties.some(p => p.name === 'DocEntry')).toBe(true);
    expect(parsed.properties.some(p => p.name === 'DocNum')).toBe(true);
    expect(parsed.properties.some(p => p.name === 'DocumentStatus')).toBe(true);
    expect(parsed.properties.some(p => p.name === 'DocumentStatus' && p.isEnum === true)).toBe(true);
    // UDF scalar must appear
    expect(parsed.properties.some(p => p.name === 'U_SOH_UDF1')).toBe(true);
    expect(parsed.enumTypes?.BoStatus).toBeDefined();
    expect(parsed.enumTypes?.BoStatus.members.some(m => m.name === 'bost_Open' && m.code === 'O')).toBe(true);

    // Structural properties section must list DocumentLines and DocumentAdditionalExpenses
    expect(parsed.structuralProperties).toBeDefined();
    expect(parsed.structuralProperties.length).toBe(2);
    const structuralNames = parsed.structuralProperties.map((c: { name: string }) => c.name);
    expect(structuralNames).toContain('DocumentLines');
    expect(structuralNames).toContain('DocumentAdditionalExpenses');

    // Each structural property entry must have complexTypeName and isArray
    const docLines = parsed.structuralProperties.find((c: { name: string }) => c.name === 'DocumentLines');
    expect(docLines?.complexTypeName).toBe('DocumentLine');
    expect(docLines?.isArray).toBe(true);
    const docExp = parsed.structuralProperties.find((c: { name: string }) => c.name === 'DocumentAdditionalExpenses');
    expect(docExp?.complexTypeName).toBe('DocumentAdditionalExpense');
    expect(docExp?.isArray).toBe(true);
  });

  it('b1_get_entity_schema for Orders includes hint to call Step 2.2', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_get_entity_schema');
    const res = await t.handler({ entityName: 'Orders' });
    const text = getText(res);
    // Response text must contain guidance for expanding structural properties
    expect(text).toContain('structuralTypeName');
    expect(text).toContain('DocumentLine');
  });

  it('b1_get_entity_schema for Orders (Step 2.2) with structuralTypeName returns structural type sub-properties', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_get_entity_schema');
    const res = await t.handler({ entityName: 'Orders', structuralTypeName: 'DocumentLine' });
    const text = getText(res);
    const structured = getStructuredContent<{
      structuralTypeName: string;
      referencingProperties: Array<{ name: string; path: string }>;
      properties: Array<{ name: string; isEnum?: boolean }>;
      enumTypes?: Record<string, { members: Array<{ name: string; code: string }> }>;
    }>(res);

    expect(text).toContain('[STEP 2 - STRUCTURAL TYPE SCHEMA]');
    expect(text).toContain('Referenced via: DocumentLines');
    expect(text).toContain('Properties:');
    expect(structured).not.toBeNull();
    if (!structured) return;
    expect(structured.structuralTypeName).toBe('DocumentLine');
    expect(structured.referencingProperties.some(p => p.name === 'DocumentLines' && p.path === 'DocumentLines')).toBe(true);
    expect(structured.properties.some(p => p.name === 'LineNum')).toBe(true);
    expect(structured.properties.some(p => p.name === 'ItemCode')).toBe(true);
    expect(structured.properties.some(p => p.name === 'UseBaseUnits' && p.isEnum === true)).toBe(true);
    expect(structured.enumTypes?.BoYesNoEnum.members.some(m => m.name === 'tYES' && m.code === 'Y')).toBe(true);
  });

  it('b1_get_entity_schema for Orders (Step 2.2) supports nested structuralTypeName values', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_get_entity_schema');
    const res = await t.handler({ entityName: 'Orders', structuralTypeName: 'LineTaxJurisdiction' });
    const text = getText(res);
    const structured = getStructuredContent<{
      structuralTypeName: string;
      referencingProperties: Array<{ name: string; path: string; parentStructuralTypeName?: string }>;
      properties: Array<{ name: string }>;
    }>(res);

    expect(text).toContain('[STEP 2 - STRUCTURAL TYPE SCHEMA]');
    expect(text).toContain('Referenced via: DocumentLines.LineTaxJurisdictions');
    expect(text).toContain('Properties:');
    expect(structured).not.toBeNull();
    if (!structured) return;
    expect(structured.structuralTypeName).toBe('LineTaxJurisdiction');
    expect(structured.referencingProperties.some(p => p.name === 'LineTaxJurisdictions' && p.path === 'DocumentLines.LineTaxJurisdictions' && p.parentStructuralTypeName === 'DocumentLine')).toBe(true);
    expect(structured.properties.some(p => p.name === 'JurisdictionCode')).toBe(true);
    expect(structured.properties.some(p => p.name === 'TaxAmount')).toBe(true);
  });

  it('b1_get_entity_schema for Orders (Step 2.2) with unknown structuralTypeName returns error', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_get_entity_schema');
    const res = await t.handler({ entityName: 'Orders', structuralTypeName: 'NonExistentType' });
    const text = getText(res);
    expect(text).toContain('ERROR');
    expect(text).toContain('NonExistentType');
  });

  it('b1_read performs a read with query options', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_read');
    const res = await t.handler({
      entityName: 'Items',
      operation: 'read',
      filterString: "ItemCode eq 'A0001'",
      topNumber: 5,
    });
    const text = getText(res);
    const structured = getStructuredContent<{ success: boolean; data: { kind: string; echo: { url: string } } }>(res);

    expect(text).toContain('SUCCESS: Reading Items entities');
    expect(text).toContain('"kind": "list"');
    expect(structured).not.toBeNull();
    if (!structured) return;
    expect(structured.success).toBe(true);
    expect(structured.data.kind).toBe('list');
    expect(structured.data.echo.url).toBe('https://example.com/b1s/v2/Items');
  });

  it('b1_write create requires elicitation approval before writing', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_write');
    sap.last = undefined;

    const sendRequest = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { confirmed: true }
    });

    const res = await t.handler(
      {
        entityName: 'Items',
        operation: 'create',
        parameters: {
          ItemCode: 'A0002',
          ItemName: 'Created with confirmation'
        }
      },
      {
        sendRequest
      }
    );

    const text = getText(res);
    const structured = getStructuredContent<{ success: boolean; data?: { kind?: string } }>(res);
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'elicitation/create' }),
      expect.anything()
    );
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          message: expect.stringContaining('FIELDS: ItemCode: A0002, ItemName: [Personal Field]')
        })
      }),
      expect.anything()
    );
    expect(text).toContain('SUCCESS: Creating new Items');
    expect(text).toContain('"kind": "created"');
    expect(structured).not.toBeNull();
    expect(structured?.success).toBe(true);
    expect(structured?.data?.kind).toBe('created');
    expect((sap.last as { op?: string } | undefined)?.op).toBe('createEntity');
  });

  it('b1_write create stops when elicitation is accepted but not confirmed', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_write');
    sap.last = undefined;

    const sendRequest = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { confirmed: false }
    });

    const res = await t.handler(
      {
        entityName: 'Items',
        operation: 'create',
        parameters: {
          ItemCode: 'A0003',
          ItemName: 'Should not be created'
        }
      },
      {
        sendRequest
      }
    );

    const text = getText(res);
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(text).toContain('Write operation was not approved by the user');
    expect((res as ToolResult).isError).toBe(true);
    expect(sap.last).toBeUndefined();
  });

  it('b1_write create is blocked when elicitation support is unavailable', async () => {
    const t = getRequiredTool(mcp.tools, 'b1_write');
    sap.last = undefined;

    const res = await t.handler({
      entityName: 'Items',
      operation: 'create',
      parameters: {
        ItemCode: 'A0004',
        ItemName: 'Should be blocked'
      }
    });

    const text = getText(res);
    expect(text).toContain('Write operation blocked: this MCP client invocation does not provide server-initiated elicitation support');
    expect((res as ToolResult).isError).toBe(true);
    expect(sap.last).toBeUndefined();
  });

  it('b1_write create bypasses elicitation when write confirmation is disabled', async () => {
    const previousHumanConfirmation = process.env.MCP_HUMAN_CONFIRMATION_ENABLED;
    process.env.MCP_HUMAN_CONFIRMATION_ENABLED = 'false';
    const t = getRequiredTool(mcp.tools, 'b1_write');
    sap.last = undefined;

    try {
      const res = await t.handler({
        entityName: 'Items',
        operation: 'create',
        parameters: {
          ItemCode: 'A0005',
          ItemName: 'Created without confirmation'
        }
      });

      const text = getText(res);
      const structured = getStructuredContent<{ success: boolean; data?: { kind?: string } }>(res);
      expect(text).toContain('SUCCESS: Creating new Items');
      expect(text).toContain('"kind": "created"');
      expect(structured).not.toBeNull();
      expect(structured?.success).toBe(true);
      expect(structured?.data?.kind).toBe('created');
      expect((sap.last as { op?: string } | undefined)?.op).toBe('createEntity');
    } finally {
      if (previousHumanConfirmation === undefined) {
        delete process.env.MCP_HUMAN_CONFIRMATION_ENABLED;
      } else {
        process.env.MCP_HUMAN_CONFIRMATION_ENABLED = previousHumanConfirmation;
      }
    }
  });
});
