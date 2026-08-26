import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenManager } from '../../utils/token-manager.js';
import { Config } from '../../utils/config.js';
import { Logger } from '../../loggers/app-logger.js';

function restoreEnv(original: NodeJS.ProcessEnv) {
    for (const key of Object.keys(process.env)) {
        if (!(key in original)) {
            delete process.env[key];
        }
    }
    for (const [key, value] of Object.entries(original)) {
        process.env[key] = value;
    }
}

function mockFetchOnce(payload: unknown) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => payload,
        text: async () => JSON.stringify(payload)
    } as unknown as Response);
}

function createUnsignedJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.signature`;
}

function createActiveTokenPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        active: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'b1_mcp:access',
        client_id: 'b1_mcp_client',
        ...overrides
    };
}

function createJwtPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        aud: 'b1_mcp_client',
        azp: 'b1_mcp_client',
        preferred_username: 'b1manager',
        ...overrides
    };
}

describe('TokenManager — audience validation', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let logger: Logger;

    beforeEach(() => {
        originalEnv = { ...process.env };

        process.env.OAUTH_BASE_URL = 'https://keycloak.example.com/realms/B1/';
        process.env.OAUTH_CLIENT_ID = 'b1_mcp_client';
        process.env.OAUTH_CLIENT_SECRET = 'secret';

        delete process.env.VALIDATE_AUDIENCE;

        logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        } as unknown as Logger;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreEnv(originalEnv);
    });

    function createManager(): TokenManager {
        return new TokenManager(logger, new Config());
    }

    function createLocalJwtManager(): TokenManager {
        process.env.TOKEN_VALIDATION_MODE = 'jwt';

        const manager = createManager();
        vi.spyOn(manager as unknown as { verifyJwtSignature: () => Promise<void> }, 'verifyJwtSignature').mockResolvedValue(undefined);
        return manager;
    }

    it('validates by default and throws on mismatch', async () => {
        mockFetchOnce(createActiveTokenPayload({
            aud: 'some-other-audience'
        }));

        const manager = createManager();

        await expect(
            manager.verifyAccessToken('token', false)
        ).rejects.toThrow(/audience validation failed/i);
    });

    it('skips validation when VALIDATE_AUDIENCE=false', async () => {
        process.env.VALIDATE_AUDIENCE = 'false';

        mockFetchOnce(createActiveTokenPayload({
            aud: 'some-other-audience'
        }));

        const manager = createManager();

        await expect(
            manager.verifyAccessToken('token', false)
        ).resolves.toMatchObject({
            clientId: 'b1_mcp_client'
        });
    });

    it('accepts when aud includes the client id', async () => {
        mockFetchOnce(createActiveTokenPayload({
            aud: ['account', 'b1_mcp_client']
        }));

        const manager = createManager();

        await expect(
            manager.verifyAccessToken('token', false)
        ).resolves.toMatchObject({
            clientId: 'b1_mcp_client'
        });
    });

    it('throws when aud is missing and validation is enabled', async () => {
        mockFetchOnce(createActiveTokenPayload());

        const manager = createManager();

        await expect(
            manager.verifyAccessToken('token', false)
        ).rejects.toThrow(/audience validation failed/i);
    });

    it('extracts userName from preferred_username when the token is a JWT', async () => {
        mockFetchOnce(createActiveTokenPayload({
            aud: 'b1_mcp_client'
        }));

        const manager = createManager();
        const token = createUnsignedJwt(createJwtPayload());

        await expect(
            manager.verifyAccessToken(token, false)
        ).resolves.toMatchObject({
            clientId: 'b1_mcp_client',
            userName: 'b1manager'
        });
    });

    it('accepts local JWT validation when aud matches the client id', async () => {
        const manager = createLocalJwtManager();
        const token = createUnsignedJwt(createJwtPayload());

        await expect(
            manager.verifyAccessToken(token, false)
        ).resolves.toMatchObject({
            clientId: 'b1_mcp_client',
            userName: 'b1manager'
        });
    });

    it('rejects local JWT validation when aud does not include the client id', async () => {
        const manager = createLocalJwtManager();
        const token = createUnsignedJwt(createJwtPayload({
            aud: 'https://public.example.com/mcp'
        }));

        await expect(
            manager.verifyAccessToken(token, false)
        ).rejects.toThrow(/clientId b1_mcp_client/i);
    });
});
