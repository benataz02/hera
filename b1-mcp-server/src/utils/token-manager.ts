import { Logger } from '../loggers/app-logger.js';
import { Config } from './config.js';
import { Agent as UndiciAgent, type Dispatcher } from 'undici';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
/**
 * Token information returned from introspection
 */
interface TokenInfo {
    token: string;
    clientId: string;
    userName?: string;
    scopes: string[];
    expiresAt: number;
}

/**
 * OAuth token manager with introspection capabilities
 */
export class TokenManager {
    private readonly logger: Logger;
    private readonly config: Config;
    private readonly tokenCache: Map<string, { info: TokenInfo; introspectedAt: number }> = new Map();
    private readonly cacheExpiry = 60000; // 1 minute cache
    /** Per-instance undici dispatcher for self-signed certificate bypass (only when allowSelfSigned=true). */
    private readonly insecureDispatcher: Dispatcher | undefined;

    // JWKS caching: to avoid fetching the JWKS on every token verification, we cache it in memory with a TTL (e.g.1 hour)
    private readonly jwksCacheTtlMs = 60 * 60 * 1000;
    // Assume jwks_uri is stable for a given issuer; cache for process lifetime.
    private jwksUriCache: string | null = null;
    private jwkSetCache: {
        jwksUri: string;
        fetchedAt: number;
        jwkSet: ReturnType<typeof createLocalJWKSet>;
    } | null = null;

    constructor(logger: Logger, config: Config) {
        this.logger = logger;
        this.config = config;

        const allowSelfSigned = this.config.get<boolean>('auth.allowSelfSigned', false);
        if (allowSelfSigned) {
            this.insecureDispatcher = new UndiciAgent({ connect: { rejectUnauthorized: false } });
            this.logger.warn('SSL verification disabled (AUTH_ALLOW_SELF_SIGNED=true). Use only for local/dev.');
        } else {
            this.logger.info('SSL verification enabled (AUTH_ALLOW_SELF_SIGNED not set or false)');
        }
    }

    private normalizeAudienceValue(value: string): string {
        return value.trim().replace(/\/+$/, '');
    }

    private createAudienceValidationError(clientId: string, aud?: string | string[]): Error {
        const audText = aud === undefined ? '<missing aud>' : JSON.stringify(aud);
        return new Error(
            `Token audience validation failed. Expected token audience to include clientId ${clientId}, ` +
            `but got ${audText}. ` +
            `Configure your OAuth provider to include the OAuth client ID in the token audience, ` +
            `or set VALIDATE_AUDIENCE=false to skip audience validation.`
        );
    }

    /** Returns true for errors that are definitive rejections from the AS and must not be retried or bypassed. */
    private isDefinitiveError(error: Error): boolean {
        return error.message.includes('Token audience validation failed') ||
            error.message.includes('Token is not active');
    }

    /**
     * Create OAuth URLs from configuration
     */
    private createOAuthUrls() {
        const authBaseUrl = new URL(this.config.get<string>('auth.baseUrl'));
        return {
            issuer: authBaseUrl.toString(),
            introspection_endpoint: new URL('protocol/openid-connect/token/introspect', authBaseUrl).toString(),
            authorization_endpoint: new URL('protocol/openid-connect/auth', authBaseUrl).toString(),
            token_endpoint: new URL('protocol/openid-connect/token', authBaseUrl).toString(),
        };
    }

    private async fetchJson<T>(url: string, timeoutMs = 10000): Promise<T> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'GET',
                signal: controller.signal,
                ...(this.insecureDispatcher ? { dispatcher: this.insecureDispatcher } : {})
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                throw new Error(`${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`);
            }

            return await response.json() as T;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private async getJwksUri(): Promise<string> {
        if (this.jwksUriCache) {
            return this.jwksUriCache;
        }

        const oauthUrls = this.createOAuthUrls();
        const issuerUrl = new URL(oauthUrls.issuer);
        const wellKnownUrl = new URL('.well-known/openid-configuration', issuerUrl).toString();

        this.logger.debug(`Fetching OIDC discovery document: ${wellKnownUrl}`);
        const discovery = await this.fetchJson<{ jwks_uri?: string }>(wellKnownUrl);
        if (!discovery.jwks_uri) {
            throw new Error('OIDC discovery document missing jwks_uri');
        }

        this.jwksUriCache = discovery.jwks_uri;
        return discovery.jwks_uri;
    }

    private async getJwkSet(forceRefresh = false): Promise<ReturnType<typeof createLocalJWKSet>> {
        const jwksUri = await this.getJwksUri();
        if (
            !forceRefresh &&
            this.jwkSetCache &&
            (Date.now() - this.jwkSetCache.fetchedAt) < this.jwksCacheTtlMs
        ) {
            return this.jwkSetCache.jwkSet;
        }

        this.logger.debug(`Fetching JWKS: ${jwksUri}`);
        const jwks = await this.fetchJson<{ keys: unknown[] }>(jwksUri);
        if (!jwks || !Array.isArray(jwks.keys)) {
            throw new Error('Invalid JWKS response');
        }

        const jwkSet = createLocalJWKSet(jwks as unknown as JSONWebKeySet);
        this.jwkSetCache = { jwksUri, fetchedAt: Date.now(), jwkSet };
        return jwkSet;
    }

    /**
     * Verify a JWT signature against Keycloak JWKS.
     * Uses OIDC discovery to find `jwks_uri`, then verifies via `jose`.
     */
    private async verifyJwtSignature(token: string): Promise<void> {
        const jwkSet = await this.getJwkSet(false);
        try {
            await jwtVerify(token, jwkSet, { clockTolerance: 5 });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            // Key rotation / cache staleness: refresh JWKS and retry once.
            this.logger.warn(`JWT verification failed; refreshing JWKS and retrying once: ${message}`);
            const refreshed = await this.getJwkSet(true);
            try {
                await jwtVerify(token, refreshed, { clockTolerance: 5 });
            } catch (error2) {
                const message2 = error2 instanceof Error ? error2.message : String(error2);
                throw new Error(`JWT signature verification failed: ${message2}`);
            }
        }
    }

    /**
     * Call the AS introspection endpoint with retries.
     * Throws immediately on definitive AS rejections (active=false, bad audience).
     * Throws a connectivity error after exhausting retries.
     */
    private async introspectToken(
        token: string,
        clientId: string,
        clientSecret: string
    ): Promise<TokenInfo> {
        const oauthUrls = this.createOAuthUrls();
        this.logger.debug(`Token introspection endpoint: ${oauthUrls.introspection_endpoint}`);

        let lastError: Error | null = null;
        let attemptsMade = 0;

        for (let attempt = 1; attempt <= 3; attempt++) {
            attemptsMade = attempt;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                try {
                    const response = await fetch(oauthUrls.introspection_endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            token,
                            token_type_hint: 'access_token',
                            client_id: clientId,
                            ...(clientSecret ? { client_secret: clientSecret } : {})
                        }),
                        signal: controller.signal,
                        ...(this.insecureDispatcher ? { dispatcher: this.insecureDispatcher } : {})
                    });

                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        const errorBody = await response.text().catch(() => '');
                        throw new Error(
                            `Token introspection failed (attempt ${attempt}/3): ${response.status} ${response.statusText} - ${errorBody}`
                        );
                    }

                    const introspection = await response.json() as {
                        active: boolean;
                        exp?: number;
                        scope?: string;
                        client_id?: string;
                        aud?: string | string[];
                    };

                    if (!introspection.active) {
                        throw new Error('Token is not active');
                    }

                    const validateAudience = this.config.get<boolean>('auth.validateAudience', true);
                    if (validateAudience) {
                        if (!introspection.aud) {
                            throw this.createAudienceValidationError(clientId, undefined);
                        }
                        const audiences = Array.isArray(introspection.aud) ? introspection.aud : [introspection.aud];
                        const isAudienceValid = audiences.some(aud => {
                            try {
                                return this.normalizeAudienceValue(aud) === this.normalizeAudienceValue(clientId);
                            } catch { return false; }
                        });
                        if (!isAudienceValid) {
                            throw this.createAudienceValidationError(clientId, introspection.aud);
                        }
                    }
                    return {
                        token,
                        clientId: introspection.client_id || clientId,
                        userName: this.resolveUserNameFromToken(token, introspection.client_id || clientId),
                        scopes: introspection.scope ? introspection.scope.split(' ') : [],
                        expiresAt: introspection.exp ?? Math.floor(Date.now() / 1000) + 3600
                    };

                } finally {
                    clearTimeout(timeoutId);
                }

            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));

                // Definitive AS rejections must not be retried.
                if (this.isDefinitiveError(lastError)) throw lastError;

                this.logger.warn(`Token introspection attempt ${attempt}/3 failed: ${lastError.message}`);
                this.logger.debug(`Introspection endpoint: ${oauthUrls.introspection_endpoint}`);
                this.logger.debug(`Error name: ${lastError.name}`);
                this.logger.debug(`Error stack: ${lastError.stack}`);
                if ('cause' in lastError) {
                    this.logger.debug(`Error cause: ${JSON.stringify(lastError.cause)}`);
                }

                if (attempt < 3) {
                    const delay = 1000 * attempt; // exponential backoff: 1s, 2s
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw new Error(`Introspection unavailable after ${attemptsMade} attempt(s): ${lastError?.message}`);
    }

    /**
     * Validate a JWT locally: verify signature against JWKS and check audience.
     * For local JWT validation, matching the OAuth client ID is sufficient.
     * Does not contact the AS — cannot detect revoked tokens.
     */
    private async validateTokenLocally(
        token: string,
        clientId: string
    ): Promise<TokenInfo> {
        const payload = this.decodeTokenPayload(token);
        await this.verifyJwtSignature(token);

        const validateAudience = this.config.get<boolean>('auth.validateAudience', true);
        if (validateAudience) {
            const aud = payload.aud as string | string[] | undefined;
            const audiences = Array.isArray(aud) ? aud : (aud ? [aud] : []);
            const isAudienceValid = audiences.some(a => {
                try {
                    return this.normalizeAudienceValue(a) === this.normalizeAudienceValue(clientId);
                } catch { return false; }
            });
            if (!isAudienceValid) {
                throw this.createAudienceValidationError(clientId, aud);
            }
        }

        return {
            token,
            clientId: (payload.azp as string) || (payload.client_id as string) || clientId,
            userName: this.resolveUserNameFromPayload(payload, clientId),
            scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
            expiresAt: typeof payload.exp === 'number' ? payload.exp : Math.floor(Date.now() / 1000) + 3600
        };
    }

    /**
     * Verify an access token using the configured validation mode:
     *   introspection                  — remote only; fails closed if AS is unreachable
     *   jwt                            — local JWT only; no revocation check
     *   introspection-with-jwt-fallback — remote first, local JWT on connectivity failure (default)
     */
    async verifyAccessToken(
        token: string,
        useCache = true
    ): Promise<TokenInfo> {
        if (useCache) {
            const cached = this.tokenCache.get(token);
            if (cached &&
                Date.now() - cached.introspectedAt < this.cacheExpiry &&
                cached.info.expiresAt > Math.floor(Date.now() / 1000)) {
                this.logger.debug('Using cached token verification result');
                return cached.info;
            }
        }

        const clientId = this.config.get<string>('auth.clientId');
        const clientSecret = this.config.get<string>('auth.clientSecret');
        const mode = this.config.get<string>('auth.validationMode', 'introspection-with-jwt-fallback');

        let tokenInfo: TokenInfo;

        if (mode === 'jwt') {
            this.logger.debug('Token validation mode: jwt (local only — revocation not checked)');
            tokenInfo = await this.validateTokenLocally(token, clientId);

        } else if (mode === 'introspection') {
            this.logger.debug('Token validation mode: introspection (remote only)');
            tokenInfo = await this.introspectToken(token, clientId, clientSecret);

        } else {
            // introspection-with-jwt-fallback (default)
            this.logger.debug('Token validation mode: introspection-with-jwt-fallback');
            try {
                tokenInfo = await this.introspectToken(token, clientId, clientSecret);
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                if (this.isDefinitiveError(err)) throw err;
                // Connectivity failure — fall back to local JWT validation.
                this.logger.warn(`Introspection unavailable; falling back to local JWT validation: ${err.message}`);
                try {
                    tokenInfo = await this.validateTokenLocally(token, clientId);
                } catch (jwtError) {
                    const jwtMessage = jwtError instanceof Error ? jwtError.message : String(jwtError);
                    throw new Error(`Token verification failed: introspection unavailable (${err.message}); local JWT validation also failed: ${jwtMessage}`);
                }
            }
        }

        this.tokenCache.set(token, { info: tokenInfo, introspectedAt: Date.now() });
        return tokenInfo;
    }

    /**
     * Clear the token cache
     */
    clearCache(): void {
        this.tokenCache.clear();
        this.logger.debug('Token cache cleared');
    }

    /**
     * Check if a token is about to expire
     * @param expiresAt Token expiry timestamp in Unix seconds
     * @param thresholdMinutes Minutes before expiry to consider "about to expire"
     */
    isTokenExpiringSoon(expiresAt: number, thresholdMinutes = 5): boolean {
        const threshold = Math.floor(Date.now() / 1000) + (thresholdMinutes * 60);
        return expiresAt <= threshold;
    }

    /**
     * Decode a JWT payload without signature verification.
     * Used by validateTokenLocally; never used as a standalone trust decision.
     */
    private decodeTokenPayload(token: string): Record<string, unknown> {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid JWT format');
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
    }
    private resolveUserNameFromToken(token: string, fallbackUserName?: string): string | undefined {
        try {
            const payload = this.decodeTokenPayload(token);
            return this.resolveUserNameFromPayload(payload, fallbackUserName);
        } catch {
            return fallbackUserName;
        }
    }

    private resolveUserNameFromPayload(payload: Record<string, unknown>, fallbackUserName?: string): string | undefined {
        const preferredUsername = payload.preferred_username || payload.name || payload.email;
        if (typeof preferredUsername === 'string' && preferredUsername.trim()) {
            return preferredUsername;
        }

        return fallbackUserName;
    }
}
