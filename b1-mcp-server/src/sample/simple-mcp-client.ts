/**
 * Simple MCP Client Sample for SAP Business One
 *
 * Demonstrates the full integration flow:
 *   1. Authenticate via OAuth 2.0 Authorization Code + PKCE (browser-based)
 *   2. Fetch the available B1 company list from the System Landscape Directory (SLD)
 *   3. Prompt the user to interactively select a company
 *   4. Discover entity types with b1_find_entities
 *   5. Explore entity schemas with b1_get_entity_schema (including structural types)
 *   6. Read entity data with b1_read
 *
 * Prerequisites:
 *   - A running B1 MCP server (default: http://localhost:3000)
 *   - An OAuth client with Authorization Code + PKCE enabled in your identity provider
 *   - http://127.0.0.1:{PORT}/callback registered as an allowed redirect URI
 *
 * Environment variables (create a .env file or set them in your shell):
 *   MCP_SERVER_URL          URL of the B1 MCP server. Default: http://localhost:3000
 *   TEST_MCP_CLIENT_ID      OAuth 2.0 client ID for this application (required)
 *   SLD_ROOT_URL            Root URL of the SAP B1 System Landscape Directory (required)
 *   TEST_OAUTH_SCOPES       Space-separated scopes. Default: email b1_mcp:access profile
 *   AUTH_ALLOW_SELF_SIGNED  Set to 'true' to accept self-signed TLS certs (dev only)
 *
 * Run:
 *   npm run simple-mcp-client
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ─── Configuration ─────────────────────────────────────────────────────────────

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:3000';
const CLIENT_ID = process.env.TEST_MCP_CLIENT_ID ?? '';
const SLD_ROOT_URL = process.env.SLD_ROOT_URL ?? '';
const SCOPES = process.env.TEST_OAUTH_SCOPES ?? 'email b1_mcp:access profile';

// ─── OAuth 2.0 PKCE helpers ────────────────────────────────────────────────────

function generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Opens the given URL in the default system browser. */
function openBrowser(url: string): void {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`Refusing to open non-HTTP(S) URL: ${url}`);
    }

    const command = process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
            ? 'rundll32'
            : 'xdg-open';

    const args = process.platform === 'darwin'
        ? [url]
        : process.platform === 'win32'
            ? ['url.dll,FileProtocolHandler', url]
            : [url];

    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', err => {
        console.error('[oauth] Could not open browser automatically:', err.message);
    });
    child.unref();
}

/**
 * Starts a temporary local HTTP server to receive the OAuth callback code.
 * The server listens on a random available port at 127.0.0.1.
 */
async function startCallbackServer(): Promise<{
    port: number;
    waitForCode(): Promise<string>;
    close(): void;
}> {
    return new Promise((resolveServer, rejectServer) => {
        let resolveCode!: (code: string) => void;
        let rejectCode!: (err: Error) => void;
        const codePromise = new Promise<string>((res, rej) => {
            resolveCode = res;
            rejectCode = rej;
        });

        const server = http.createServer((req, res) => {
            const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
            const code = parsed.searchParams.get('code');
            const error = parsed.searchParams.get('error');

            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`<html><body><h2>Authentication failed: ${error}</h2><p>You may close this tab.</p></body></html>`);
                rejectCode(new Error(`OAuth error: ${error} — ${parsed.searchParams.get('error_description') ?? ''}`));
            } else if (code) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Authentication successful!</h2><p>You may close this tab.</p><script>window.close();</script></body></html>');
                resolveCode(code);
            } else {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Unexpected request');
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolveServer({ port, waitForCode: () => codePromise, close: () => server.close() });
        });

        server.on('error', rejectServer);
    });
}

/**
 * Discovers the OAuth authorization and token endpoints from the MCP server's
 * /.well-known/oauth-protected-resource metadata, then from the OIDC discovery document.
 */
async function discoverOAuthEndpoints(mcpServerUrl: string): Promise<{
    authorizationEndpoint: string;
    tokenEndpoint: string;
}> {
    const resourceMeta = await fetch(`${mcpServerUrl}/.well-known/oauth-protected-resource/mcp`)
        .then(r => r.json()) as { authorization_servers?: string[] };

    const authServerBase = resourceMeta.authorization_servers?.[0]?.replace(/\/$/, '');
    if (!authServerBase) throw new Error('No authorization_servers in OAuth protected-resource metadata');

    const oidc = await fetch(`${authServerBase}/.well-known/openid-configuration`)
        .then(r => r.json()) as { authorization_endpoint: string; token_endpoint: string };

    if (!oidc.authorization_endpoint || !oidc.token_endpoint) {
        throw new Error('OIDC discovery did not return authorization_endpoint / token_endpoint');
    }

    return { authorizationEndpoint: oidc.authorization_endpoint, tokenEndpoint: oidc.token_endpoint };
}

// ─── Token store ───────────────────────────────────────────────────────────────

interface TokenStore {
    accessToken: string;
    refreshToken: string | undefined;
    /** Unix timestamp (ms) when the access token expires. */
    expiresAt: number;
    /** Cached so refresh calls don't need to re-run endpoint discovery. */
    tokenEndpoint: string;
}

/**
 * Exchanges an authorization code for a full token set.
 */
async function exchangeCodeForToken(params: {
    tokenEndpoint: string;
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
}): Promise<TokenStore> {
    const res = await fetch(params.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: params.code,
            code_verifier: params.codeVerifier,
            client_id: params.clientId,
            redirect_uri: params.redirectUri,
        }).toString(),
    });
    if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
        tokenEndpoint: params.tokenEndpoint,
    };
}

/**
 * STEP 1 — Authenticate
 *
 * Runs a browser-based OAuth 2.0 Authorization Code + PKCE flow and returns a TokenStore.
 * The browser is opened automatically; the user logs in with their SAP BTP / IDP credentials.
 */
async function authenticate(): Promise<TokenStore> {
    if (!CLIENT_ID) throw new Error('TEST_MCP_CLIENT_ID environment variable is required');

    if (process.env.AUTH_ALLOW_SELF_SIGNED === 'true') {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        console.warn('[oauth] TLS certificate verification disabled (AUTH_ALLOW_SELF_SIGNED=true)');
    }

    console.log('[Step 1] Discovering OAuth endpoints from:', MCP_SERVER_URL);
    const { authorizationEndpoint, tokenEndpoint } = await discoverOAuthEndpoints(MCP_SERVER_URL);

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const callbackServer = await startCallbackServer();
    const redirectUri = `http://127.0.0.1:${callbackServer.port}/callback`;

    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('scope', SCOPES);

    console.log('[Step 1] Opening browser for SSO login...');
    console.log('         (If the browser does not open, visit the URL below manually)');
    console.log('        ', authUrl.toString());
    openBrowser(authUrl.toString());

    let code: string;
    try {
        code = await callbackServer.waitForCode();
    } finally {
        callbackServer.close();
    }

    console.log('[Step 1] Authorization code received. Exchanging for access token...');
    const accessToken = await exchangeCodeForToken({ tokenEndpoint, code, codeVerifier, clientId: CLIENT_ID, redirectUri });
    console.log('[Step 1] Access token obtained successfully.\n');
    return accessToken;
}

// ─── Token refresh ─────────────────────────────────────────────────────────────

/**
 * Exchanges a refresh token for a new access token without user interaction.
 * Some OAuth servers rotate the refresh token on each use — the new one is stored
 * if returned, otherwise the original is kept.
 */
async function refreshAccessToken(store: TokenStore): Promise<TokenStore> {
    if (!store.refreshToken) throw new Error('No refresh token available');

    const res = await fetch(store.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: store.refreshToken,
            client_id: CLIENT_ID,
        }).toString(),
    });
    if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);

    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? store.refreshToken,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
        tokenEndpoint: store.tokenEndpoint,
    };
}

/**
 * Returns a valid access token, refreshing silently if it is about to expire.
 * Falls back to a full browser PKCE re-authentication when:
 *   - no refresh token was issued, or
 *   - the refresh token itself has been rejected (expired / revoked).
 *
 * Call this before every operation that needs an access token.
 */
async function getValidAccessToken(store: TokenStore): Promise<{ accessToken: string; store: TokenStore }> {
    const REFRESH_BUFFER_MS = 60_000; // refresh 60 s before expiry

    if (Date.now() < store.expiresAt - REFRESH_BUFFER_MS) {
        return { accessToken: store.accessToken, store };
    }

    if (store.refreshToken) {
        try {
            console.log('[oauth] Access token expiring — refreshing silently...');
            const refreshed = await refreshAccessToken(store);
            console.log('[oauth] Token refreshed successfully.');
            return { accessToken: refreshed.accessToken, store: refreshed };
        } catch (err) {
            console.warn('[oauth] Silent refresh failed:', (err as Error).message);
            console.warn('[oauth] Falling back to browser re-authentication...');
        }
    }

    // No refresh token or refresh failed — run the full browser PKCE flow again.
    const newStore = await authenticate();
    return { accessToken: newStore.accessToken, store: newStore };
}

// ─── MCP client helpers ────────────────────────────────────────────────────────

/**
 * Creates and connects an MCP client to the B1 MCP server.
 *
 * Pass `companyId` to target a specific SAP B1 company database.
 * The company ID is sent as the x-b1-companyID header on every MCP request.
 */
async function connectMcpClient(accessToken: string, companyId: string): Promise<Client> {
    const client = new Client({ name: 'b1-sample-client', version: '1.0.0' });

    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (companyId) headers['x-b1-companyID'] = companyId;

    const transport = new StreamableHTTPClientTransport(
        new URL(`${MCP_SERVER_URL}/mcp`),
        { requestInit: { headers } },
    );

    await client.connect(transport);
    return client;
}

/**
 * Extracts the JSON payload from a B1 MCP tool result.
 *
 * All B1 tools return a human-readable text block followed by a JSON payload.
 * This helper finds the last JSON object or array in the response text.
 */
function extractJson<T = unknown>(result: Record<string, unknown>): T {
    // Prefer structuredContent when present (cleaner machine-readable payload).
    if (result['structuredContent'] !== undefined) return result['structuredContent'] as T;

    const content = result['content'] as Array<{ type?: string; text?: string }> | undefined;
    const text = content?.[0]?.type === 'text' ? (content[0].text ?? '') : '';

    const lastObj = text.lastIndexOf('\n{');
    const lastArr = text.lastIndexOf('\n[');
    const idx = Math.max(lastObj, lastArr);

    if (idx >= 0) return JSON.parse(text.slice(idx + 1)) as T;
    if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text) as T;
    throw new Error(`No JSON payload found in tool response:\n${text}`);
}

/** Returns true when the tool result is an error response. */
function isError(result: Record<string, unknown>): boolean {
    if (result['isError'] === true) return true;
    const content = result['content'] as Array<{ type?: string; text?: string }> | undefined;
    return content?.[0]?.text?.startsWith('ERROR:') ?? false;
}

// ─── SLD company list ──────────────────────────────────────────────────────────

interface B1Company {
    CompanyID: string;
    CompanyName: string;
}

/**
 * Fetches the list of SAP B1 companies the current user can access from the
 * System Landscape Directory (SLD).
 *
 * The SLD_ROOT_URL environment variable must be set to the root URL of your SLD instance.
 */
async function fetchCompaniesFromSld(accessToken: string): Promise<B1Company[]> {
    if (!SLD_ROOT_URL) throw new Error('SLD_ROOT_URL environment variable is required');

    const url = `${SLD_ROOT_URL}/sld/sld0100.svc/CurrentUserInfo?IncludeB1UserBinding=true`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`SLD request failed (${res.status}): ${await res.text()}`);

    type SldResponse = { d?: { CurrentUserInfo?: { B1UserBindings?: { results?: Record<string, unknown>[] } } } };
    const data = await res.json() as SldResponse;
    const results = data.d?.CurrentUserInfo?.B1UserBindings?.results ?? [];

    return results.map(item => ({
        CompanyID: (item['CompanyID'] as string) ?? '',
        CompanyName: (item['CompanyDisplayName'] as string) ?? '',
    }));
}

/**
 * Displays a numbered list of companies and prompts the user to pick one.
 * Resolves with the selected company.
 */
async function promptSelectCompany(companies: B1Company[]): Promise<B1Company> {
    console.log('[Step 3] Select a company:');
    companies.forEach((c, i) => console.log(`         ${i + 1}. ${c.CompanyName} (${c.CompanyID})`));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    return new Promise((resolve, reject) => {
        const ask = () => {
            rl.question(`\n         Enter number (1–${companies.length}): `, answer => {
                const idx = parseInt(answer.trim(), 10) - 1;
                if (idx >= 0 && idx < companies.length) {
                    rl.close();
                    resolve(companies[idx]!);
                } else {
                    console.log(`         Invalid choice. Please enter a number between 1 and ${companies.length}.`);
                    ask();
                }
            });
        };
        rl.on('error', reject);
        ask();
    });
}

// ─── Main sample flow ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // ── Step 1: Authenticate ──────────────────────────────────────────────────
    let tokenStore = await authenticate();

    // Convenience wrapper: returns a valid access token, refreshing silently
    // (or re-authenticating via browser) whenever the token is about to expire.
    // Call this before every operation that requires an access token.
    const token = async (): Promise<string> => {
        const result = await getValidAccessToken(tokenStore);
        tokenStore = result.store;
        return result.accessToken;
    };

    // ── Step 2: Fetch companies from SLD ─────────────────────────────────────
    //
    // Query the System Landscape Directory to get the list of SAP B1 company
    // databases the authenticated user is allowed to access.

    console.log('[Step 2] Fetching company list from SLD...');
    const companies = await fetchCompaniesFromSld(await token());
    if (companies.length === 0) throw new Error('No companies available for this user in SLD.');

    console.log(`[Step 2] Found ${companies.length} company/ies.\n`);

    // ── Step 3: Select a company ──────────────────────────────────────────────
    //
    // Prompt the user to pick a company, then connect to the MCP server with
    // the selected company ID passed as the x-b1-companyID request header.

    const targetCompany = await promptSelectCompany(companies);
    console.log(`\n[Step 3] Connecting to: ${targetCompany.CompanyName} (${targetCompany.CompanyID})`);
    const client = await connectMcpClient(await token(), targetCompany.CompanyID);

    // ── Step 4: Discover entities ─────────────────────────────────────────────
    //
    // b1_find_entities searches the B1 OData metadata for entity types that match
    // a keyword. Use it to discover which entity names to pass to other tools.

    console.log('[Step 4] Searching for entity types related to "orders"...');
    const findResult = await client.callTool({
        name: 'b1_find_entities',
        arguments: { query: 'orders', limit: 5 },
    });
    if (isError(findResult)) throw new Error(`b1_find_entities failed:\n${JSON.stringify(findResult, null, 2)}`);

    const findData = extractJson<{ query: string; matches: Array<{ entityName: string; description?: string }> }>(findResult);
    console.log(`[Step 4] Found ${findData.matches.length} matches:`);
    for (const m of findData.matches) console.log(`         • ${m.entityName}${m.description ? ' — ' + m.description : ''}`);
    console.log();

    // ── Step 5: Explore entity schema ─────────────────────────────────────────
    //
    // b1_get_entity_schema returns the properties, key fields, and structural
    // (complex) types of a given entity.
    //
    // Step 5.1 — get the top-level entity schema.
    // Step 5.2 — drill into a structural type (e.g. document line items).

    console.log('[Step 5.1] Getting schema for the Orders entity...');
    const schemaResult = await client.callTool({
        name: 'b1_get_entity_schema',
        arguments: { entityName: 'Orders' },
    });
    if (isError(schemaResult)) throw new Error(`b1_get_entity_schema failed:\n${JSON.stringify(schemaResult, null, 2)}`);

    const schema = extractJson<{
        entity: { entitySet: string; keyProperties: string[] };
        properties: Array<{ name: string; type: string }>;
        structuralProperties: Array<{ name: string; complexTypeName: string }>;
    }>(schemaResult);

    console.log(`[Step 5.1] Orders entity:`);
    console.log(`           Key properties : ${schema.entity.keyProperties.join(', ')}`);
    console.log(`           Total properties: ${schema.properties.length}`);
    console.log(`           Structural types: ${schema.structuralProperties.map(s => s.name).join(', ')}\n`);

    // Step 5.2 — drill into DocumentLines to see the line-item fields.
    const docLines = schema.structuralProperties.find(s => s.name === 'DocumentLines')
        ?? schema.structuralProperties[0];

    if (docLines) {
        console.log(`[Step 5.2] Drilling into structural type: ${docLines.complexTypeName}`);
        const drillResult = await client.callTool({
            name: 'b1_get_entity_schema',
            arguments: { entityName: 'Orders', structuralTypeName: docLines.complexTypeName },
        });

        if (!isError(drillResult)) {
            const drillSchema = extractJson<{
                structuralTypeName: string;
                properties: Array<{ name: string; type: string }>;
            }>(drillResult);
            console.log(`[Step 5.2] ${drillSchema.structuralTypeName} has ${drillSchema.properties.length} properties.`);
            console.log(`           First 5: ${drillSchema.properties.slice(0, 5).map(p => p.name).join(', ')}\n`);
        }
    }

    // ── Step 6: Read entity data ───────────────────────────────────────────────
    //
    // b1_read queries B1 data via the Service Layer OData API.
    // Supported operations:
    //   read         — list entities (supports $top, $filter, $select, $orderby)
    //   read-single  — fetch one entity by its key properties

    console.log('[Step 6] Reading the 3 most recent open sales orders...');
    const readResult = await client.callTool({
        name: 'b1_read',
        arguments: {
            entityName: 'Orders',
            operation: 'read',
            topNumber: 3,
            selectString: 'DocEntry,DocNum,CardName,DocTotal,DocumentStatus',
            filterString: "DocumentStatus eq 'bost_Open'",
            orderByString: 'DocEntry desc',
        },
    });
    if (isError(readResult)) throw new Error(`b1_read failed:\n${JSON.stringify(readResult, null, 2)}`);

    const readData = extractJson<{ data: { value: Array<Record<string, unknown>> } }>(readResult);
    const orders = readData.data.value;
    console.log(`[Step 6] Retrieved ${orders.length} order(s):`);
    for (const order of orders) {
        console.log(`         • DocNum ${order['DocNum']} | ${order['CardName']} | Total: ${order['DocTotal']}`);
    }
    console.log();

    // ── Done ──────────────────────────────────────────────────────────────────

    await client.close();
    console.log('Done. All steps completed successfully.');
}

main().catch(err => {
    console.error('Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
});
