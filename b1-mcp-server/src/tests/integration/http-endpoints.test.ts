/**
 * Integration tests for the Express HTTP layer.
 *
 * Tests run against the real Express app with OAuth mode active (as configured in .env).
 * No mocking is used — endpoints either don't require auth or test that auth is enforced.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

describe('HTTP Endpoints', () => {
    let app: Application;

    beforeAll(async () => {
        const { createApp } = await import('../../index.js');
        app = createApp();
    }, 15000);

    describe('GET /health', () => {
        it('responds with a health status (healthy or degraded depending on env)', async () => {
            const res = await request(app).get('/health');
            expect([200, 503]).toContain(res.status);
            expect(['healthy', 'degraded']).toContain(res.body.status);
            expect(res.body.version).toBeTypeOf('string');
            expect(res.body.timestamp).toBeTypeOf('string');
        });

        it('includes audit logger and personal field cache checks', async () => {
            const res = await request(app).get('/health');
            expect(res.body.checks).toBeDefined();
            expect(res.body.checks.auditLogger).toBeDefined();
            expect(res.body.checks.personalFieldCache).toBeDefined();
        });
    });

    describe('GET /docs', () => {
        it('returns API documentation with all endpoints listed', async () => {
            const res = await request(app).get('/docs');
            expect(res.status).toBe(200);
            expect(res.body.title).toBeTypeOf('string');
            expect(res.body.endpoints['GET /health']).toBeTypeOf('string');
            expect(res.body.endpoints['POST /mcp']).toBeTypeOf('string');
            expect(res.body.endpoints['DELETE /mcp']).toBeTypeOf('string');
            expect(res.body.endpoints['GET /docs']).toBeTypeOf('string');
        });

        it('includes MCP capabilities description', async () => {
            const res = await request(app).get('/docs');
            expect(res.body.mcpCapabilities).toBeDefined();
            expect(res.body.mcpCapabilities.tools).toBeTypeOf('string');
        });
    });

    describe('HEAD /mcp', () => {
        it('returns 401 in OAuth mode (GET route with auth intercepts HEAD requests)', async () => {
            // In OAuth mode, Express applies the GET /mcp route handler (which has auth middleware)
            // to HEAD requests before the explicit HEAD handler is reached.
            const res = await request(app).head('/mcp');
            expect(res.status).toBe(401);
        });
    });

    describe('OAuth authentication enforcement', () => {
        it('GET /mcp returns 401 without a bearer token', async () => {
            const res = await request(app).get('/mcp');
            expect(res.status).toBe(401);
        });

        it('POST /mcp returns 401 without a bearer token', async () => {
            const res = await request(app)
                .post('/mcp')
                .set('Content-Type', 'application/json')
                .set('Accept', 'application/json, text/event-stream')
                .send({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: { name: 'test', version: '0.1.0' },
                    },
                });
            expect(res.status).toBe(401);
        });

        it('GET /mcp returns 401 or 500 with a malformed bearer token (behavior depends on OAuth server reachability)', async () => {
            // With TOKEN_VALIDATION_MODE=introspection, an invalid token triggers an introspection call.
            // If the OAuth server is unreachable this results in a 500; if reachable, a 401.
            const res = await request(app)
                .get('/mcp')
                .set('Authorization', 'Bearer not-a-real-token');
            expect([401, 500]).toContain(res.status);
        });

        it('OAuth Protected Resource Metadata endpoint is available', async () => {
            // Path: /.well-known/oauth-protected-resource/<resource-server-path>
            // The SDK appends the resource server URL path (/mcp) to the base well-known path.
            const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');
            expect(res.status).toBe(200);
            expect(res.body.resource).toBeTypeOf('string');
        });
    });

    describe('DELETE /mcp — unauthenticated session management', () => {
        it('returns 400 when session ID is missing', async () => {
            const res = await request(app).delete('/mcp');
            expect(res.status).toBe(400);
            expect(res.body.error).toBeTypeOf('string');
        });

        it('returns 400 when session ID does not match any active session', async () => {
            const res = await request(app)
                .delete('/mcp')
                .set('mcp-session-id', 'nonexistent-session-id');
            expect(res.status).toBe(400);
        });
    });

    describe('404 handling', () => {
        it('returns 404 with error details for unknown routes', async () => {
            const res = await request(app).get('/not-a-real-path');
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Not Found');
            expect(Array.isArray(res.body.availableEndpoints)).toBe(true);
            expect(res.body.availableEndpoints).toContain('/health');
            expect(res.body.availableEndpoints).toContain('/mcp');
        });

        it('returns 404 for unknown POST routes', async () => {
            const res = await request(app).post('/unknown-endpoint').send({});
            expect(res.status).toBe(404);
        });
    });
});
