/**
 * Integration tests for the MCP protocol over HTTP (OAuth mode).
 *
 * A real Node.js HTTP server is started on a random port.
 * No mocking is used — the server runs with its real OAuth configuration.
 *
 * Token acquisition (in priority order):
 *   1. Interactive TTY or TEST_OAUTH_INTERACTIVE=true — browser-based OAuth PKCE flow
 *   2. Neither — authenticated suite is skipped automatically
 *
 * Company resolution:
 *   Always fetches the full company list from SLD; write tests use the first 3.
 *
 * Write tools: b1_write runs live with MCP_HUMAN_CONFIRMATION_ENABLED=false (create+delete,
 *   update+revert pairs). b1_copy_document and b1_create_payment are schema-only checks.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getAccessToken } from './oauth-client.js';
import { fetchCompanyList, type B1Company } from './sld-client.js';
import { parseToolJson, isToolError } from './tool-response-parser.js';

const runAuthenticated = true;

// All tools the server exposes in OAuth mode.
const CORE_TOOLS = ['b1_find_entities', 'b1_get_entity_schema', 'b1_read', 'b1_write'];
const OAUTH_TOOLS = ['b1_list_companies', 'b1_select_company'];
const WORKFLOW_TOOLS = ['b1_copy_document', 'b1_create_payment'];
const ALL_EXPECTED_TOOLS = [...CORE_TOOLS, ...OAUTH_TOOLS, ...WORKFLOW_TOOLS];

describe('MCP Protocol Integration (OAuth)', () => {
    let baseUrl: string;
    let httpServer: ReturnType<typeof createServer>;

    beforeAll(async () => {
        const { createApp } = await import('../../index.js');
        const app = createApp();
        httpServer = createServer(app);
        await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
        const { port } = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
    }, 15000);

    afterAll(async () => {
        await new Promise<void>(resolve => httpServer?.close(() => resolve()));
    });

    // ── Unauthenticated (always run) ──────────────────────────────────────────

    describe('unauthenticated MCP client', () => {
        it('connection without bearer token is rejected at the transport layer', async () => {
            const client = new Client({ name: 'unauth-test-client', version: '1.0.0' });
            const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
            await expect(client.connect(transport)).rejects.toThrow();
        });

        it('connection with an invalid token is rejected', async () => {
            const client = new Client({ name: 'invalid-token-client', version: '1.0.0' });
            const transport = new StreamableHTTPClientTransport(
                new URL(`${baseUrl}/mcp`),
                { requestInit: { headers: { Authorization: 'Bearer this-is-not-a-valid-token' } } }
            );
            await expect(client.connect(transport)).rejects.toThrow();
        });
    });

    // ── Authenticated ─────────────────────────────────────────────────────────

    describe.skipIf(!runAuthenticated)('authenticated MCP protocol', () => {
        let accessToken: string;
        let companies: B1Company[];

        beforeAll(async () => {
            const token = await getAccessToken(baseUrl);
            if (!token) throw new Error('Could not obtain access token for authenticated tests');
            accessToken = token;

            companies = await fetchCompanyList(accessToken);
            if (companies.length === 0) throw new Error('No companies returned from SLD');
            console.log(`\nTesting ${companies.length} company/ies: ${companies.map(c => `${c.CompanyName} (${c.CompanyID})`).join(', ')}`);
        }, 120000);

        async function connectClient(companyId: string): Promise<Client> {
            const client = new Client({ name: 'auth-test-client', version: '1.0.0' });
            const transport = new StreamableHTTPClientTransport(
                new URL(`${baseUrl}/mcp`),
                {
                    requestInit: {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'x-b1-companyID': companyId,
                        },
                    },
                }
            );
            await client.connect(transport);
            return client;
        }

        // ── Server status ───────────────────────────────────────────────────

        it('GET /mcp returns server status', async () => {
            const res = await fetch(`${baseUrl}/mcp`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            expect(res.status).toBe(200);
            const body = await res.json() as { activeSessions: number };
            expect(body.activeSessions).toBeGreaterThanOrEqual(0);
        });

        // ── Tool registry ───────────────────────────────────────────────────

        it('tools/list exposes all expected tools', async () => {
            const client = await connectClient(companies[0].CompanyID);
            try {
                const { tools } = await client.listTools();
                const names = tools.map(t => t.name);
                for (const name of ALL_EXPECTED_TOOLS) {
                    expect(names, `tool "${name}" should be registered`).toContain(name);
                }
            } finally {
                await client.close().catch(() => undefined);
            }
        });

        it('every tool has a description and an input schema', async () => {
            const client = await connectClient(companies[0].CompanyID);
            try {
                const { tools } = await client.listTools();
                for (const tool of tools) {
                    expect(tool.description, `${tool.name}: missing description`).toBeTypeOf('string');
                    expect((tool.description as string).length, `${tool.name}: empty description`).toBeGreaterThan(0);
                    expect(tool.inputSchema, `${tool.name}: missing inputSchema`).toBeDefined();
                }
            } finally {
                await client.close().catch(() => undefined);
            }
        });

        // ── Per-company read tool tests (loop through all companies) ────────

        it('b1_find_entities returns a structured response for each company', async () => {
            for (const company of companies) {
                const client = await connectClient(company.CompanyID);
                try {
                    const result = await client.callTool({
                        name: 'b1_find_entities',
                        arguments: { query: 'orders', limit: 5 },
                    });
                    const data = parseToolJson<{
                        query: string;
                        matches: Array<{ entityName: string }>;
                    }>(result);
                    expect(data.query, `[${company.CompanyID}] query field`).toBe('orders');
                    expect(data.matches.length, `[${company.CompanyID}] should return matches`).toBeGreaterThan(0);
                } finally {
                    await client.close().catch(() => undefined);
                }
            }
        }, 60000);

        it('b1_get_entity_schema Step 2.1: Items entity includes key and common properties', async () => {
            for (const company of companies) {
                const client = await connectClient(company.CompanyID);
                try {
                    const result = await client.callTool({
                        name: 'b1_get_entity_schema',
                        arguments: { entityName: 'Items' },
                    });
                    const schema = parseToolJson<{
                        entity: { name: string; entitySet: string; keyProperties: string[] };
                        properties: Array<{ name: string }>;
                        structuralProperties: Array<{ name: string; complexTypeName: string }>;
                    }>(result);
                    expect(schema.entity.entitySet, `[${company.CompanyID}] entitySet`).toBe('Items');
                    expect(schema.entity.keyProperties, `[${company.CompanyID}] ItemCode should be a key property`).toContain('ItemCode');
                    expect(schema.properties.some(p => p.name === 'ItemName'), `[${company.CompanyID}] ItemName should be present`).toBe(true);
                    expect(schema.structuralProperties.length, `[${company.CompanyID}] should have structural properties`).toBeGreaterThan(0);
                } finally {
                    await client.close().catch(() => undefined);
                }
            }
        }, 60000);

        it('b1_get_entity_schema Step 2.1: Orders entity includes DocEntry key and DocumentLines structural property', async () => {
            for (const company of companies) {
                const client = await connectClient(company.CompanyID);
                try {
                    const result = await client.callTool({
                        name: 'b1_get_entity_schema',
                        arguments: { entityName: 'Orders' },
                    });
                    const schema = parseToolJson<{
                        entity: { name: string; entitySet: string; keyProperties: string[] };
                        structuralProperties: Array<{ name: string; complexTypeName: string }>;
                    }>(result);
                    expect(schema.entity.entitySet, `[${company.CompanyID}] entitySet`).toBe('Orders');
                    expect(schema.entity.keyProperties, `[${company.CompanyID}] DocEntry should be a key property`).toContain('DocEntry');
                    expect(schema.structuralProperties.some(p => p.name === 'DocumentLines'), `[${company.CompanyID}] DocumentLines should be a structural property`).toBe(true);
                } finally {
                    await client.close().catch(() => undefined);
                }
            }
        }, 60000);

        it('b1_get_entity_schema Step 2.2: drills into a structural type of Items', async () => {
            for (const company of companies) {
                const client = await connectClient(company.CompanyID);
                try {
                    // Step 2.1 — discover the Items schema and extract the first structural type name.
                    const step1 = await client.callTool({
                        name: 'b1_get_entity_schema',
                        arguments: { entityName: 'Items' },
                    });
                    const schema1 = parseToolJson<{
                        structuralProperties: Array<{ name: string; complexTypeName: string }>;
                    }>(step1);
                    const structuralTypeName = schema1.structuralProperties[0]?.complexTypeName ?? null;

                    expect(
                        structuralTypeName,
                        `[${company.CompanyID}] Step 2.1 must expose at least one structuralProperty with a complexTypeName`
                    ).not.toBeNull();

                    // Step 2.2 — drill into the discovered structural type.
                    const step2 = await client.callTool({
                        name: 'b1_get_entity_schema',
                        arguments: { entityName: 'Items', structuralTypeName: structuralTypeName! },
                    });
                    expect(
                        isToolError(step2),
                        `[${company.CompanyID}] Step 2.2 should not return an error for type "${structuralTypeName}"`
                    ).toBe(false);
                    const schema2 = parseToolJson<{
                        structuralTypeName: string;
                        properties: Array<{ name: string }>;
                    }>(step2);
                    expect(schema2.structuralTypeName, `[${company.CompanyID}] response should name the requested type`).toBe(structuralTypeName);
                    expect(schema2.properties.length, `[${company.CompanyID}] structural type should have properties`).toBeGreaterThan(0);
                } finally {
                    await client.close().catch(() => undefined);
                }
            }
        }, 60000);

        it('b1_get_entity_schema Step 2.2: drills into Orders DocumentLines structural type', async () => {
            for (const company of companies) {
                const client = await connectClient(company.CompanyID);
                try {
                    // Step 2.1 — get Orders schema.
                    const step1 = await client.callTool({
                        name: 'b1_get_entity_schema',
                        arguments: { entityName: 'Orders' },
                    });
                    const schema1 = parseToolJson<{
                        structuralProperties: Array<{ name: string; complexTypeName: string }>;
                    }>(step1);

                    // DocumentLines must appear as a structural property.
                    expect(
                        schema1.structuralProperties.some(p => p.name === 'DocumentLines'),
                        `[${company.CompanyID}] DocumentLines should be a structural property of Orders`
                    ).toBe(true);

                    // Extract the first structural type name for Step 2.2.
                    const structuralTypeName = schema1.structuralProperties[0]?.complexTypeName ?? null;
                    expect(
                        structuralTypeName,
                        `[${company.CompanyID}] Orders Step 2.1 must expose at least one structural type with a complexTypeName`
                    ).not.toBeNull();

                    // Step 2.2 — drill into the structural type.
                    const step2 = await client.callTool({
                        name: 'b1_get_entity_schema',
                        arguments: { entityName: 'Orders', structuralTypeName: structuralTypeName! },
                    });
                    expect(
                        isToolError(step2),
                        `[${company.CompanyID}] Step 2.2 should not return an error for type "${structuralTypeName}"`
                    ).toBe(false);
                    const schema2 = parseToolJson<{
                        structuralTypeName: string;
                        properties: Array<{ name: string }>;
                    }>(step2);
                    expect(schema2.structuralTypeName, `[${company.CompanyID}] response should name the requested type`).toBe(structuralTypeName);
                    expect(schema2.properties.length, `[${company.CompanyID}] structural type should have properties`).toBeGreaterThan(0);
                } finally {
                    await client.close().catch(() => undefined);
                }
            }
        }, 60000);

        it('b1_get_entity_schema: returns an error for an unrecognized entity name', async () => {
            const client = await connectClient(companies[0].CompanyID);
            try {
                const result = await client.callTool({
                    name: 'b1_get_entity_schema',
                    arguments: { entityName: 'NonExistentEntity_XYZ_123' },
                });
                expect(
                    isToolError(result),
                    'should indicate entity not found'
                ).toBe(true);
            } finally {
                await client.close().catch(() => undefined);
            }
        });

        it('b1_get_entity_schema: returns an error for an unrecognized structural type', async () => {
            const client = await connectClient(companies[0].CompanyID);
            try {
                const result = await client.callTool({
                    name: 'b1_get_entity_schema',
                    arguments: { entityName: 'Items', structuralTypeName: 'NonExistentType_XYZ_123' },
                });
                expect(
                    isToolError(result),
                    'should indicate structural type not found'
                ).toBe(true);
            } finally {
                await client.close().catch(() => undefined);
            }
        });

        it('b1_read returns an entity list for each company', async () => {
            for (const company of companies) {
                const client = await connectClient(company.CompanyID);
                try {
                    const result = await client.callTool({
                        name: 'b1_read',
                        arguments: { entityName: 'Items', operation: 'read', topNumber: 1 },
                    });
                    const data = parseToolJson<{ success: boolean; data: { value: unknown[] } }>(result);
                    expect(data.data.value.length, `[${company.CompanyID}] should return at least one entity`).toBeGreaterThan(0);
                } finally {
                    await client.close().catch(() => undefined);
                }
            }
        }, 60000);

        it('b1_read read-single returns one entity by key for each company', async () => {
            for (const company of companies) {
                const client = await connectClient(company.CompanyID);
                try {
                    // First fetch one item to get a valid key
                    const listResult = await client.callTool({
                        name: 'b1_read',
                        arguments: { entityName: 'Items', operation: 'read', topNumber: 1, selectString: 'ItemCode' },
                    });
                    const listData = parseToolJson<{ success: boolean; data: { value: Array<{ ItemCode: string }> } }>(listResult);
                    const itemCode = listData.data.value[0]?.ItemCode;
                    expect(itemCode, `[${company.CompanyID}] list read should return an ItemCode`).toBeTruthy();

                    // Fetch the single entity by valid key
                    const singleResult = await client.callTool({
                        name: 'b1_read',
                        arguments: { entityName: 'Items', operation: 'read-single', parameters: { ItemCode: itemCode } },
                    });
                    expect(isToolError(singleResult), `[${company.CompanyID}] read-single should not error`).toBe(false);
                    const singleData = parseToolJson<{ success: boolean; data: { ItemCode: string } }>(singleResult);
                    expect(singleData.data.ItemCode, `[${company.CompanyID}] read-single should return the requested item`).toBe(itemCode);

                    // Fetch with a non-existent key derived from the real one
                    const notFoundResult = await client.callTool({
                        name: 'b1_read',
                        arguments: { entityName: 'Items', operation: 'read-single', parameters: { ItemCode: itemCode + '_INVALID' } },
                    });
                    expect(isToolError(notFoundResult), `[${company.CompanyID}] read-single with non-existent key should return an error`).toBe(true);
                } finally {
                    await client.close().catch(() => undefined);
                }
            }
        }, 60000);

        // ── Write tool schema checks ────────────────────────────────────────

        it('b1_write has required fields: entityName, operation, parameters', async () => {
            const client = await connectClient(companies[0].CompanyID);
            try {
                const { tools } = await client.listTools();
                const tool = tools.find(t => t.name === 'b1_write');
                expect(tool).toBeDefined();
                const required: string[] = (tool!.inputSchema as { required?: string[] })?.required ?? [];
                expect(required).toContain('entityName');
                expect(required).toContain('operation');
                expect(required).toContain('parameters');
            } finally {
                await client.close().catch(() => undefined);
            }
        });
    });

    // ── Workflow tools — schema checks ────────────────────────────────────────
    //
    // b1_copy_document and b1_create_payment require elicitation confirmation and
    // would mutate live SAP B1 data. Only input schema is verified here.

    describe.skipIf(!runAuthenticated)('workflow tool schema checks', () => {
        let accessToken: string;
        let companyId: string;

        beforeAll(async () => {
            accessToken = (await getAccessToken(baseUrl))!;
            const companies = await fetchCompanyList(accessToken);
            if (companies.length === 0) throw new Error('No companies returned from SLD');
            companyId = companies[0].CompanyID;
        }, 120000);

        async function connectClient(): Promise<Client> {
            const client = new Client({ name: 'workflow-schema-client', version: '1.0.0' });
            const transport = new StreamableHTTPClientTransport(
                new URL(`${baseUrl}/mcp`),
                { requestInit: { headers: { Authorization: `Bearer ${accessToken}`, 'x-b1-companyID': companyId } } }
            );
            await client.connect(transport);
            return client;
        }

        it('b1_copy_document has required fields: sourceEntityName, sourceDocEntry, targetEntityName', async () => {
            const client = await connectClient();
            try {
                const { tools } = await client.listTools();
                const tool = tools.find(t => t.name === 'b1_copy_document');
                expect(tool).toBeDefined();
                const required: string[] = (tool!.inputSchema as { required?: string[] })?.required ?? [];
                expect(required).toContain('sourceEntityName');
                expect(required).toContain('sourceDocEntry');
                expect(required).toContain('targetEntityName');
            } finally {
                await client.close().catch(() => undefined);
            }
        });

        it('b1_create_payment has required fields: cardCode, invoiceDocEntries, paymentAmount', async () => {
            const client = await connectClient();
            try {
                const { tools } = await client.listTools();
                const tool = tools.find(t => t.name === 'b1_create_payment');
                expect(tool).toBeDefined();
                const required: string[] = (tool!.inputSchema as { required?: string[] })?.required ?? [];
                expect(required).toContain('cardCode');
                expect(required).toContain('invoiceDocEntries');
                expect(required).toContain('paymentAmount');
            } finally {
                await client.close().catch(() => undefined);
            }
        });
    });

    // ── b1_write live calls (confirmation disabled) ───────────────────────────
    //
    // A second server instance is started with MCP_HUMAN_CONFIRMATION_ENABLED=false
    // so write operations execute without elicitation. Tests run in pairs to leave
    // SAP B1 data unchanged: create+delete and update+revert.

    describe.skipIf(!runAuthenticated)('b1_write live operations (confirmation disabled)', () => {
        let writeBaseUrl: string;
        let writeHttpServer: ReturnType<typeof createServer>;
        let writeToken: string;
        let writeCompanies: B1Company[];

        beforeAll(async () => {
            process.env.MCP_HUMAN_CONFIRMATION_ENABLED = 'false';
            const { createApp } = await import('../../index.js');
            const app = createApp();
            writeHttpServer = createServer(app);
            await new Promise<void>(resolve => writeHttpServer.listen(0, '127.0.0.1', resolve));
            const { port } = writeHttpServer.address() as AddressInfo;
            writeBaseUrl = `http://127.0.0.1:${port}`;

            const token = await getAccessToken(writeBaseUrl);
            if (!token) throw new Error('Could not obtain access token for write tests');
            writeToken = token;

            writeCompanies = (await fetchCompanyList(writeToken)).slice(0, 3);
            if (writeCompanies.length === 0) throw new Error('No companies returned from SLD');
            console.log(`\nWrite-testing ${writeCompanies.length} company/ies: ${writeCompanies.map(c => `${c.CompanyName} (${c.CompanyID})`).join(', ')}`);
        }, 120000);

        afterAll(async () => {
            process.env.MCP_HUMAN_CONFIRMATION_ENABLED = 'true';
            await new Promise<void>(resolve => writeHttpServer?.close(() => resolve()));
        });

        async function connectWriteClient(companyId: string): Promise<Client> {
            const client = new Client({ name: 'write-test-client', version: '1.0.0' });
            const transport = new StreamableHTTPClientTransport(
                new URL(`${writeBaseUrl}/mcp`),
                { requestInit: { headers: { Authorization: `Bearer ${writeToken}`, 'x-b1-companyID': companyId } } }
            );
            await client.connect(transport);
            return client;
        }

        it('b1_write create and delete an Item for each company', async () => {
            for (const company of writeCompanies) {
                const client = await connectWriteClient(company.CompanyID);
                const testItemCode = `TEST_MCP_${Date.now()}`;
                try {
                    // Create
                    const createResult = await client.callTool({
                        name: 'b1_write',
                        arguments: {
                            entityName: 'Items',
                            operation: 'create',
                            parameters: { ItemCode: testItemCode, ItemName: 'MCP Integration Test Item', ItemType: 'itItems' }
                        },
                    });
                    expect(isToolError(createResult), `[${company.CompanyID}] create should succeed`).toBe(false);
                    expect(parseToolJson<{ success: boolean }>(createResult).success).toBe(true);

                    // Delete
                    const deleteResult = await client.callTool({
                        name: 'b1_write',
                        arguments: {
                            entityName: 'Items',
                            operation: 'delete',
                            parameters: { ItemCode: testItemCode }
                        },
                    });
                    expect(isToolError(deleteResult), `[${company.CompanyID}] delete should succeed`).toBe(false);
                    expect(parseToolJson<{ success: boolean }>(deleteResult).success).toBe(true);
                } finally {
                    await client.close().catch(() => undefined);
                }
            }
        }, 120000);

        it('b1_write update an Item name and revert it for each company', async () => {
            for (const company of writeCompanies) {
                const client = await connectWriteClient(company.CompanyID);
                try {
                    // Fetch one item to get a valid key and current name
                    const listResult = await client.callTool({
                        name: 'b1_read',
                        arguments: { entityName: 'Items', operation: 'read', topNumber: 1, selectString: 'ItemCode,ItemName' },
                    });
                    const listData = parseToolJson<{ success: boolean; data: { value: Array<{ ItemCode: string; ItemName: string }> } }>(listResult);
                    const { ItemCode, ItemName } = listData.data.value[0]!;

                    // Update name
                    const updateResult = await client.callTool({
                        name: 'b1_write',
                        arguments: {
                            entityName: 'Items',
                            operation: 'update',
                            parameters: { ItemCode, ItemName: ItemName + ' (test)' }
                        },
                    });
                    expect(isToolError(updateResult), `[${company.CompanyID}] update should succeed`).toBe(false);
                    expect(parseToolJson<{ success: boolean }>(updateResult).success).toBe(true);

                    // Revert name
                    const revertResult = await client.callTool({
                        name: 'b1_write',
                        arguments: {
                            entityName: 'Items',
                            operation: 'update',
                            parameters: { ItemCode, ItemName }
                        },
                    });
                    expect(isToolError(revertResult), `[${company.CompanyID}] revert should succeed`).toBe(false);
                    expect(parseToolJson<{ success: boolean }>(revertResult).success).toBe(true);
                } finally {
                    await client.close().catch(() => undefined);
                }
            }
        }, 120000);
    });
});
