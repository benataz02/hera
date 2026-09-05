/**
 * Shared OAuth 2.0 Authorization Code + PKCE helper.
 *
 * Used by:
 *   src/tests/integration/mcp-protocol.test.ts — integration tests
 *
 * getAccessToken() is the main entry point:
 *   - Runs a browser-based PKCE flow when the process is interactive
 *     (TTY detected, or TEST_OAUTH_INTERACTIVE=true).
 *   - Returns undefined otherwise (caller should skip auth-required work).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { exec } from 'node:child_process';
import type { AddressInfo } from 'node:net';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OAuthEndpoints {
    authorizationEndpoint: string;
    tokenEndpoint: string;
}

export interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in?: number;
}

export interface CallbackServer {
    port: number;
    waitForCode(): Promise<string>;
    close(): void;
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── Local callback server ────────────────────────────────────────────────────

export function startCallbackServer(): Promise<CallbackServer> {
    return new Promise((resolveServer, rejectServer) => {
        let resolveCode: (code: string) => void;
        let rejectCode: (err: Error) => void;
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
                res.end(`<html><body><h2>Authentication failed: ${error}</h2><p>You can close this tab.</p></body></html>`);
                rejectCode(new Error(`OAuth error: ${error} — ${parsed.searchParams.get('error_description') ?? ''}`));
            } else if (code) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Authentication successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>');
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

// ─── Browser ──────────────────────────────────────────────────────────────────

export function openBrowser(url: string): void {
    const cmd =
        process.platform === 'darwin' ? `open "${url}"` :
        process.platform === 'win32'  ? `start "" "${url}"` :
                                        `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) console.error('[oauth-client] Could not open browser automatically:', err.message);
    });
}

// ─── Endpoint discovery ───────────────────────────────────────────────────────

export async function discoverOAuthEndpoints(mcpServerUrl: string): Promise<OAuthEndpoints> {
    const resourceMeta = await fetch(`${mcpServerUrl}/.well-known/oauth-protected-resource/mcp`)
        .then(r => r.json()) as { resource: string; authorization_servers?: string[] };

    const authServerBase = resourceMeta.authorization_servers?.[0]?.replace(/\/$/, '');
    if (!authServerBase) throw new Error('No authorization_servers in OAuth protected-resource metadata');

    const oidcConfig = await fetch(`${authServerBase}/.well-known/openid-configuration`)
        .then(r => r.json()) as { authorization_endpoint: string; token_endpoint: string };

    if (!oidcConfig.authorization_endpoint || !oidcConfig.token_endpoint) {
        throw new Error('OIDC discovery did not return authorization_endpoint / token_endpoint');
    }

    return { authorizationEndpoint: oidcConfig.authorization_endpoint, tokenEndpoint: oidcConfig.token_endpoint };
}

// ─── Token exchange ───────────────────────────────────────────────────────────

export async function exchangeCodeForToken(params: {
    tokenEndpoint: string;
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
}): Promise<TokenResponse> {
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
    return res.json() as Promise<TokenResponse>;
}

// ─── Full PKCE flow ───────────────────────────────────────────────────────────

export async function doPkceFlow(options: {
    mcpServerUrl: string;
    clientId: string;
    scopes: string;
}): Promise<string> {
    const { mcpServerUrl, clientId, scopes } = options;

    if (process.env.AUTH_ALLOW_SELF_SIGNED === 'true') {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        console.warn('[oauth-client] TLS certificate verification disabled (AUTH_ALLOW_SELF_SIGNED=true)');
    }

    console.log('[oauth-client] Discovering OAuth endpoints...');
    const { authorizationEndpoint, tokenEndpoint } = await discoverOAuthEndpoints(mcpServerUrl);

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const callbackServer = await startCallbackServer();
    const redirectUri = `http://127.0.0.1:${callbackServer.port}/callback`;

    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('scope', scopes);

    console.log('[oauth-client] Opening browser for SSO login...');
    console.log(`(If the browser does not open, visit:\n  ${authUrl.toString()})`);
    openBrowser(authUrl.toString());

    let code: string;
    try {
        code = await callbackServer.waitForCode();
    } finally {
        callbackServer.close();
    }
    console.log('[oauth-client] Authorization code received. Exchanging for token...');

    const tokens = await exchangeCodeForToken({ tokenEndpoint, code, codeVerifier, clientId, redirectUri });
    console.log(`[oauth-client] Token received (expires_in: ${tokens.expires_in ?? 'unknown'}s)`);
    return tokens.access_token;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Obtain an access token via a browser-based PKCE flow (interactive processes only).
 * Returns undefined when the process is not interactive (caller should skip auth work).
 *
 * @param mcpServerUrl  Override the MCP server URL used for endpoint discovery.
 *                      Defaults to MCP_SERVER_URL env var or http://localhost:3000.
 */
export async function getAccessToken(mcpServerUrl?: string): Promise<string | undefined> {
    const isInteractive = process.env.TEST_OAUTH_INTERACTIVE === 'true' || process.stdout.isTTY;
    if (!isInteractive) return undefined;

    const clientId = process.env.TEST_MCP_CLIENT_ID;
    if (!clientId) throw new Error('TEST_MCP_CLIENT_ID is required for OAuth PKCE flow');

    const serverUrl = mcpServerUrl ?? process.env.MCP_SERVER_URL ?? 'http://localhost:3000';
    const scopes = process.env.TEST_OAUTH_SCOPES ?? 'email b1_mcp:access profile';

    return doPkceFlow({ mcpServerUrl: serverUrl, clientId, scopes });
}
