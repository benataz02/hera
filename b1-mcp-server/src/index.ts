import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

import { B1MCPServer, createB1MCPServer } from './mcp-server.js';
import { Logger } from './loggers/app-logger.js';
import { AuditLogger } from './loggers/audit-logger.js';
import { config } from './utils/config.js';
import { TokenManager } from './utils/token-manager.js';
import { buildRequestAuditEntry, resolveRequestSourceIp, type RequestAuditOptions } from './utils/server-audit.js';
import { B1Client } from './services/b1-client.js';
import { B1DiscoveryService } from './services/b1-discovery.js';
import { pkgName, pkgVersion } from './utils/pkg.js';
import { runWithRequestContext, type B1RequestContext } from './utils/request-context.js';

/**
 * Express server hosting SAP Business One Service Layer MCP Server with session management
 *
 * This server provides HTTP transport for the SAP Business One Service Layer MCP server using the
 * latest streamable HTTP transport with proper session management.
 */

const logger = new Logger(pkgName);
const auditLogger = new AuditLogger('mcp-audit');
const tokenManager = new TokenManager(logger, config);
const sapClient = new B1Client(logger, config);
const sapDiscoveryService = new B1DiscoveryService(sapClient, logger, config);

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function recordServerAudit(req: express.Request | undefined, options: RequestAuditOptions): void {
    auditLogger.record(buildRequestAuditEntry({ req, ...options }));
}

function getCompanyId(req: express.Request): string | undefined {
    const companyId = req.get('x-b1-companyID')?.trim();
    return companyId || undefined;
}

function resolveBaseMcpUrl(port: number, protocol: 'http' | 'https' = 'http'): URL {
    const configuredBaseUrl = config.get<string>('mcp.baseUrl', '').trim();
    if (configuredBaseUrl) {
        return new URL('mcp', configuredBaseUrl);
    }

    return new URL('mcp', `${protocol}://localhost:${port}`);
}

function warnIfInsecureProductionUrl(serverUrl: URL): void {
    if (!config.isProduction()) {
        return;
    }

    if (serverUrl.protocol === 'https:') {
        return;
    }

    logger.warn(
        `Production is resolving the MCP base URL over HTTP (${serverUrl.toString()}). ` +
        'Public production traffic should use HTTPS. HTTP is only acceptable on a private hop behind a TLS-terminating reverse proxy or gateway. If TLS is terminated upstream, set MCP_BASE_URL to the external https URL.'
    );
}

function warnIfSelfSignedProductionCertificate(certBuffer: Buffer, _certPath: string): void {
    if (!config.isProduction()) {
        return;
    }

    try {
        const certificate = new X509Certificate(certBuffer);
        if (certificate.issuer === certificate.subject) {
            logger.warn(
                `Production HTTPS certificate appears self-signed. ` +
                'Use a CA-signed certificate for public production deployments, or terminate TLS at a trusted gateway and set MCP_BASE_URL accordingly.'
            );
        }
    } catch (error) {
        logger.warn(
            `Unable to inspect HTTPS certificate for self-signed status: ${toErrorMessage(error)}`
        );
    }
}

type AuthenticatedRequest = express.Request & {
    auth?: {
        token?: string;
        clientId?: string;
        expiresAt?: number;
        extra?: {
            userName?: string;
        };
    };
};

type VerifiedAuthInfo = NonNullable<AuthenticatedRequest['auth']>;

function buildRequestContext(req: express.Request, authInfo?: VerifiedAuthInfo, companyId?: string): B1RequestContext {
    return {
        requestId: randomUUID(),
        token: authInfo?.token,
        companyId,
        userName: authInfo?.extra?.userName ?? authInfo?.clientId,
        sourceIp: resolveRequestSourceIp(req)
    };
}

// Session storage for HTTP transport with user context
const sessions: Map<string, {
    mcpInstance: B1MCPServer;
    transport: StreamableHTTPServerTransport;
    startedAt: Date;
    lastSeenAt: Date;
    userToken?: string;
    userName?: string;
    companyId?: string;
}> = new Map();

/**
 * Clean up inactive sessions.
 *
 * A session is considered inactive if it has been idle (no requests) longer than the configured timeout.
 * Default session timeout is 30 minutes and can be overridden with SESSION_TIMEOUT_MINUTES.
 */
function cleanupInactiveSessions(): void {
    const now = new Date();
    const minutes = config.get<number>('session.timeoutMinutes', 30);
    const maxAge = (!Number.isFinite(minutes) || Number.isNaN(minutes) || minutes <= 0)
        ? 30 * 60 * 1000
        : Math.floor(minutes * 60 * 1000);

    for (const [sessionId, session] of Array.from(sessions.entries())) {
        const lastSeenAt = session.lastSeenAt ?? session.startedAt;
        if (now.getTime() - lastSeenAt.getTime() > maxAge) {
            auditLogger.record({
                event: 'SessionExpired',
                category: 'SessionManagement',
                subCategory: 'Lifecycle',
                outcome: 'info',
                message: `Session expired due to inactivity`,
                userName: session.userName,
                companyId: session.companyId,
                details: {
                    sessionId,
                    idleMilliseconds: now.getTime() - lastSeenAt.getTime()
                }
            });
            logger.info(`Cleaning up inactive session: ${sessionId}`);
            session.transport.close();
            sessions.delete(sessionId);
        }
    }
}

/**
 * Token verifier for OAuth bearer auth
 */
const tokenVerifier = {
    verifyAccessToken: async (token: string): Promise<{
        token: string;
        clientId: string;
        scopes: string[];
        expiresAt: number;
        extra: {
            userName?: string;
        };
    }> => {
        try {
            const tokenInfo = await tokenManager.verifyAccessToken(token, true);
            return {
                ...tokenInfo,
                extra: {
                    userName: tokenInfo.userName
                }
            };
        } catch (error) {
            auditLogger.record({
                event: 'AccessTokenVerificationFailed',
                category: 'Authentication',
                subCategory: 'BearerToken',
                outcome: 'failure',
                message: 'Bearer token verification failed',
                details: {
                    reason: toErrorMessage(error)
                }
            });
            logger.error('Token verification failed:', error);
            throw error;
        }
    }
};

/**
 * Get or create a session for the given session ID with optional user context
 */
async function resolveSession(
    req: express.Request | undefined,
    sessionId?: string,
    authInfo?: VerifiedAuthInfo,
    companyId?: string
): Promise<{
    sessionId: string;
    server: B1MCPServer;
    transport: StreamableHTTPServerTransport;
}>
{
    const verifiedUserName = authInfo?.extra?.userName ?? authInfo?.clientId;
    const verifiedToken = authInfo?.token;

    // Check for existing session
    if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        logger.debug(`Reusing existing session: ${sessionId}`);
        session.lastSeenAt = new Date();
        if (verifiedToken) {
            try {
                if (typeof authInfo?.expiresAt === 'number' && tokenManager.isTokenExpiringSoon(authInfo.expiresAt)) {
                    logger.warn('Token expiring soon');
                }
                session.userName = verifiedUserName;
                session.userToken = verifiedToken;
                if (companyId) {
                    const previousCompanyId = session.companyId;
                    session.companyId = companyId;
                    if (previousCompanyId && previousCompanyId !== companyId) {
                        recordServerAudit(req, {
                            event: 'SessionCompanyContextChanged',
                            category: 'SessionManagement',
                            subCategory: 'Context',
                            outcome: 'success',
                            userName: verifiedUserName,
                            companyId,
                            details: {
                                sessionId,
                                previousCompanyId
                            }
                        });
                    }
                }
            } catch (error) {
                const tokenError = error instanceof Error && error.message.includes('not active')
                    ? new Error('Access token expired. User must re-authenticate.')
                    : error;
                recordServerAudit(req, {
                    event: 'SessionTokenVerificationFailed',
                    category: 'Authentication',
                    subCategory: 'SessionReuse',
                    outcome: 'failure',
                    userName: session.userName,
                    companyId: companyId ?? session.companyId,
                    details: {
                        sessionId,
                        reason: toErrorMessage(tokenError)
                    }
                });
                logger.warn(`Token verification failed for session ${sessionId}:`, tokenError);
                // Continue with old token - will fail on next SAP API call if truly expired
            }
        }

        return {
            sessionId,
            server: session.mcpInstance,
            transport: session.transport
        };
    }

    // Create new session
    const newSessionId = sessionId || randomUUID();
    logger.info(`Creating new MCP session: ${newSessionId}`);
    let userName: string | undefined;

    try {
        if (verifiedToken) {
            userName = verifiedUserName;
        }

        // Create and initialize MCP server with discovery service
        const mcpServer = await createB1MCPServer(sapDiscoveryService);

        // Create HTTP transport
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: (id) => {
                logger.debug(`Session initialized: ${id}`);
            },
            enableDnsRebindingProtection: config.isProduction(),
            allowedHosts: config.get<string[]>('mcp.allowedHosts')
        });

        // Connect server to transport
        await mcpServer.getServer().connect(transport);

        // Store session with user context if provided
        const now = new Date();
        sessions.set(newSessionId, {
            mcpInstance: mcpServer,
            transport,
            startedAt: now,
            lastSeenAt: now,
            userToken: verifiedToken,
            userName,
            companyId
        });

        // Clean up session when transport closes
        transport.onclose = () => {
            logger.info(`Transport closed for session: ${newSessionId}`);
            sessions.delete(newSessionId);
        };

        logger.info(`Session created successfully: ${newSessionId}`);

        recordServerAudit(req, {
            event: 'SessionCreated',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            outcome: 'success',
            userName,
            companyId,
            details: {
                sessionId: newSessionId,
                authenticated: !!verifiedToken,
                transport: 'streamable-http'
            }
        });
        return {
            sessionId: newSessionId,
            server: mcpServer,
            transport
        };

    } catch (error) {
        recordServerAudit(req, {
            event: 'SessionCreateFailed',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            outcome: 'failure',
            userName,
            companyId,
            details: {
                sessionId: newSessionId,
                reason: toErrorMessage(error)
            }
        });
        logger.error(`Failed to create session: ${error}`);
        throw error;
    }
}

/**
 * Create Express application
 */
export function createApp(port: number = config.get<number>('port')): express.Application {
    const app = express();

    // Security and parsing middleware
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                connectSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'"],
                scriptSrc: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'none'"]
            }
        }
    }));

    const isProduction = config.isProduction();
    const allowedOrigins = config.get('cors.allowedOrigins');
    if (isProduction) {
        if (allowedOrigins === "*") {
            logger.warn('CORS is configured to allow all origins in production via CORS_ALLOWED_ORIGINS="*".');
        } else if (allowedOrigins.length === 0) {
            logger.warn('CORS_ALLOWED_ORIGINS is not set in production. Cross-origin browser clients will be blocked until it is configured.');
        }
    }
    const origin = allowedOrigins === "*" ? 
        "*" : 
        allowedOrigins.length == 0 ? 
        false : 
        allowedOrigins.split(',').map(origin => origin.trim()).filter(Boolean);
    app.use(cors({
        origin: origin,
        credentials: true,
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'MCP-Protocol-Version', 'Authorization', 'x-b1-companyID', 'x-custom-auth-headers']
    }));

    const requestBodyLimit = config.get<string>('request.bodyLimit');
    app.use(express.json({ limit: requestBodyLimit }));
    app.use(express.urlencoded({ extended: true, limit: requestBodyLimit }));

    const mcpRateLimitWindowMinutes = config.get<number>('mcp.rateLimit.windowMinutes');
    const mcpRateLimitMax = config.get<number>('mcp.rateLimit.max');
    const mcpRateLimiter = rateLimit({
        windowMs: mcpRateLimitWindowMinutes * 60 * 1000,
        max: mcpRateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => {
            const rawSessionId = (req.headers['mcp-session-id'] as string | undefined)?.trim();
            if (rawSessionId) {
                return `sid:${rawSessionId.slice(0, 128)}`;
            }

            const requestIp = resolveRequestSourceIp(req) || req.ip || req.socket.remoteAddress || 'unknown';
            return `ip:${ipKeyGenerator(requestIp)}`;
        },
        handler: (req, res) => {
            recordServerAudit(req, {
                event: 'McpRateLimitExceeded',
                category: 'RateLimiting',
                subCategory: 'McpEndpoint',
                outcome: 'failure',
                message: 'Rate limit exceeded for MCP endpoint',
                details: {
                    maxRequests: mcpRateLimitMax,
                    windowMinutes: mcpRateLimitWindowMinutes
                }
            });
            const maybeJsonRpc = (req as express.Request).body as { jsonrpc?: unknown; id?: unknown } | undefined;
            if (maybeJsonRpc && maybeJsonRpc.jsonrpc === '2.0') {
                return res.status(429).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32029, // Application-defined — free to use
                        message: 'Too Many Requests: rate limit exceeded'
                    },
                    id: Object.prototype.hasOwnProperty.call(maybeJsonRpc, 'id') ? maybeJsonRpc.id : null
                });
            }

            res.status(429).json({
                error: 'Too Many Requests',
                message: 'Rate limit exceeded'
            });
        }
    });

    // Request logging middleware
    app.use((req, res, next) => {
        logger.debug(`${req.method} ${req.path}`, {
            sessionId: req.headers['mcp-session-id'],
            userAgent: req.headers['user-agent']
        });
        next();
    });

    const advertisedProtocol = config.get<boolean>('https.enabled', false) ? 'https' : 'http';
    const serverUrl = resolveBaseMcpUrl(port, advertisedProtocol);
    const oauthRequiredScopes = config.get<string[]>('auth.requiredScopes');
    // OAuth metadata router (only in OAuth mode)
    if (config.isOAuthMode()) {
        const authBaseUrl = new URL(config.get<string>('auth.baseUrl'));
        const oauthMetadata: OAuthMetadata = {
            issuer: authBaseUrl.toString(),
            introspection_endpoint: new URL('protocol/openid-connect/token/introspect', authBaseUrl).toString(),
            authorization_endpoint: new URL('protocol/openid-connect/auth', authBaseUrl).toString(),
            token_endpoint: new URL('protocol/openid-connect/token', authBaseUrl).toString(),
            response_types_supported: ['code'],
        };

        // The resource server URL should be the base URL of the MCP server (without /mcp)
        const resourceServerUrl = new URL(serverUrl.toString().replace(/\/mcp$/, '/'));
        app.use(mcpAuthMetadataRouter({
            oauthMetadata,
            resourceServerUrl: resourceServerUrl,
            scopesSupported: oauthRequiredScopes,
            resourceName: 'SAP B1 MCP Server',
        }));

        logger.info('OAuth authentication enabled');
    }

    // Main MCP endpoint - handles all MCP communication
    // Apply bearer auth middleware in OAuth mode
    const authMiddleware = config.isOAuthMode()
        ? requireBearerAuth({
            verifier: tokenVerifier,
            requiredScopes: config.get<boolean>('auth.verifyScopesEnabled') ? oauthRequiredScopes : [],
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(serverUrl),
        })
        : (req: express.Request, res: express.Response, next: express.NextFunction) => next();

    // Rate limit all MCP endpoint calls (GET/POST/DELETE/HEAD)
    app.use('/mcp', mcpRateLimiter);

    // Public health check endpoint; no authentication required.
    app.get('/health', (req, res) => {
        const auditHealth = auditLogger.getHealthSummary();
        const personalFieldHealth = sapDiscoveryService.getPersonalFieldCacheHealthSummary();
        const overallHealthy = auditHealth.healthy && personalFieldHealth.healthy;
        const status = overallHealthy ? 'healthy' : 'degraded';

        res.status(overallHealthy ? 200 : 503).json({
            status,
            timestamp: new Date().toISOString(),
            version: pkgVersion,
            checks: {
                auditLogger: {
                    healthy: auditHealth.healthy,
                    ...(auditHealth.error ? { error: auditHealth.error } : {})
                },
                personalFieldCache: {
                    healthy: personalFieldHealth.healthy,
                    ...(personalFieldHealth.error ? { error: personalFieldHealth.error } : {})
                }
            }
        });
    });

    // MCP server info endpoint (no authentication)
    app.get('/mcp', authMiddleware, async (req, res) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const acceptsSSE = req.headers['accept']?.includes('text/event-stream');
        const authInfo = config.isOAuthMode() ? (req as AuthenticatedRequest).auth : undefined;
        const companyId = getCompanyId(req);

        // SSE stream request from MCP client — delegate to transport
        if (sessionId && sessions.has(sessionId) && acceptsSSE) {
            const session = sessions.get(sessionId)!;
            session.lastSeenAt = new Date();
            const requestContext = buildRequestContext(req, authInfo, companyId);
            logger.debug('Handling MCP SSE stream request', {
                requestId: requestContext.requestId,
                sessionId,
                companyId,
                hasAuthToken: !!requestContext.token
            });
            await runWithRequestContext(requestContext, async () => {
                await session.transport.handleRequest(req, res);
            });
            return;
        }

        const serverInfo = {
            name: pkgName,
            version: pkgVersion,
            description: 'MCP server for SAP Business One Service Layer OData services with dynamic CRUD operations',
            protocol: {
                version: LATEST_PROTOCOL_VERSION,
                transport: 'streamable-http'
            },
            capabilities: {
                tools: {},
                resources: {},
                logging: {}
            },
            features: [
                'Dynamic SAP Business One Service Layer OData service discovery',
                'CRUD operations for all discovered entities',
                'Natural language query support',
                'Session-based HTTP transport',
                'Real-time service metadata'
            ],
            endpoints: {
                health: '/health',
                mcp: '/mcp',
                docs: '/docs'
            },
            activeSessions: sessions.size
        };
        res.json(serverInfo);
    });

    app.post('/mcp', authMiddleware, async (req, res) => {
        let requestContext: B1RequestContext | undefined;
        try {
            // Get session ID from header
            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            // Extract user token from authInfo (set by bearer auth middleware in OAuth mode)
            const authInfo = config.isOAuthMode() ? (req as AuthenticatedRequest).auth : undefined;
            const companyId = getCompanyId(req);

            let session;

            if (sessionId && sessions.has(sessionId)) {
                // Reuse existing session
                session = await resolveSession(req, sessionId, authInfo, companyId);
            } else if (!sessionId && isInitializeRequest(req.body)) {
                // New initialization request
                session = await resolveSession(req, undefined, authInfo, companyId);
            } else {
                // Invalid request
                recordServerAudit(req, {
                    event: 'InvalidMcpRequest',
                    category: 'RequestValidation',
                    subCategory: 'Protocol',
                    outcome: 'failure',
                    companyId,
                    message: 'Rejected MCP request with invalid session state',
                    details: {
                        hasSessionId: !!sessionId,
                        isInitializeRequest: isInitializeRequest(req.body)
                    }
                });
                logger.warn(`Invalid MCP request - no session ID and not initialize request`);
                return res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid session ID provided or not an initialize request'
                    },
                    id: req.body?.id || null
                });
            }

            requestContext = buildRequestContext(req, authInfo, companyId);
            logger.debug('Handling MCP POST request', {
                requestId: requestContext.requestId,
                sessionId,
                companyId,
                isInitialize: isInitializeRequest(req.body),
                hasAuthToken: !!requestContext.token
            });

            // Handle the request within immutable request-scoped auth context
            await runWithRequestContext(requestContext, async () => {
                await session.transport.handleRequest(req, res, req.body);
            });

        } catch (error) {
            recordServerAudit(req, {
                event: 'McpRequestFailed',
                category: 'RequestProcessing',
                subCategory: 'McpEndpoint',
                outcome: 'failure',
                companyId: getCompanyId(req),
                message: 'MCP request processing failed',
                details: {
                    requestId: requestContext?.requestId,
                    reason: toErrorMessage(error)
                }
            });
            logger.error('Error handling MCP request:', {
                requestId: requestContext?.requestId,
                error: toErrorMessage(error)
            });

            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}`
                    },
                    id: req.body?.id || null
                });
            }
        }
    });

    // Handle session termination
    app.delete('/mcp', async (req, res) => {
        try {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            if (!sessionId || !sessions.has(sessionId)) {
                recordServerAudit(req, {
                    event: 'SessionTerminationRejected',
                    category: 'SessionManagement',
                    subCategory: 'Lifecycle',
                    outcome: 'failure',
                    message: 'Rejected session termination with invalid session id',
                    details: {
                        sessionId,
                        reason: 'invalid-session-id'
                    }
                });
                logger.warn(`Cannot terminate - invalid session ID: ${sessionId}`);
                return res.status(400).json({
                    error: 'Invalid or missing session ID'
                });
            }

            const session = sessions.get(sessionId)!;
            const userToken = config.isOAuthMode() ? (req as AuthenticatedRequest).auth?.token : undefined;
            if(session.userToken != userToken) {
                recordServerAudit(req, {
                    event: 'SessionTerminationRejected',
                    category: 'Authorization',
                    subCategory: 'SessionOwnership',
                    outcome: 'failure',
                    userName: session.userName,
                    companyId: session.companyId,
                    message: 'Rejected session termination due to ownership mismatch',
                    details: {
                        sessionId,
                        reason: 'token-mismatch'
                    }
                });
                logger.warn(`Unauthorized session termination attempt for session ${sessionId}`);
                return res.status(403).json({
                    error: 'Forbidden: You do not have permission to terminate this session'
                });
            }

            // Handle the termination request
            await session.transport.handleRequest(req, res);

            // Clean up session
            sessions.delete(sessionId);
            recordServerAudit(req, {
                event: 'SessionTerminated',
                category: 'SessionManagement',
                subCategory: 'Lifecycle',
                outcome: 'success',
                userName: session.userName,
                companyId: session.companyId,
                message: 'Session terminated successfully',
                details: {
                    sessionId
                }
            });
            logger.info(`Session terminated: ${sessionId}`);

        } catch (error) {
            recordServerAudit(req, {
                event: 'SessionTerminationFailed',
                category: 'SessionManagement',
                subCategory: 'Lifecycle',
                outcome: 'failure',
                message: 'Session termination failed',
                details: {
                    reason: toErrorMessage(error)
                }
            });
            logger.error('Error terminating session:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    // Handle HEAD requests to /mcp (for health checks)
    app.head('/mcp', (req, res) => {
        res.status(200).end();
    });

    // Public API documentation endpoint; no authentication required.
    app.get('/docs', (req, res) => {
        res.json({
            title: 'SAP Business One Service Layer MCP Server API',
            description: 'Model Context Protocol server for SAP Business One Service Layer OData services',
            version: pkgVersion,
            endpoints: {
                'GET /health': 'Health check endpoint',
                'GET /mcp': 'MCP server information',
                'POST /mcp': 'Main MCP communication endpoint',
                'DELETE /mcp': 'Session termination endpoint',
                'GET /docs': 'This API documentation'
            },
            mcpCapabilities: {
                tools: 'Dynamic CRUD operations for all discovered SAP entities',
                resources: 'Service metadata and entity information',
                logging: 'Comprehensive logging support'
            },
            usage: {
                exampleQueries: [
                    '"Show me what entities are available for business partners"',
                    '"Show me the top 10 customers by balance"',
                    '"Create a new customer with name X Technology"',
                    '"Update customer C20000 to have Federal Tax ID US25-12345"',
                    '"List all sales orders from this week"'
                ],
                workflowSteps: [
                    'Search: Search entities by category and name',
                    'Schema Retrieval: Get detailed entity schemas',
                    'Execution: Perform CRUD operations',
                ],
                sessionManagement: 'Automatic session creation with optional OAuth'
            }
        });
    });

    // Handle 404s
    app.use((req, res) => {
        logger.warn(`404 - Not found: ${req.method} ${req.path}`);
        res.status(404).json({
            error: 'Not Found',
            message: `The requested endpoint ${req.method} ${req.path} was not found`,
            availableEndpoints: ['/health', '/mcp', '/docs']
        });
    });

    // Global error handler
    app.use((error: Error, req: express.Request, res: express.Response) => {
        logger.error('Unhandled error:', error);

        if (!res.headersSent) {
            res.status(500).json({
                error: 'Internal Server Error',
                message: config.isDevelopment() ? error.message : 'Something went wrong'
            });
        }
    });

    // Clean up expired sessions every hour
    setInterval(cleanupInactiveSessions, 60 * 60 * 1000);

    return app;
}

/**
 * Start the server
 */
export async function startServer(port: number = 3000): Promise<void> {
    const httpsEnabled = config.get<boolean>('https.enabled', true);
    const advertisedProtocol: 'http' | 'https' = httpsEnabled ? 'https' : 'http';

    const app = createApp(port);
    const serverUrl = resolveBaseMcpUrl(port, advertisedProtocol);
    warnIfInsecureProductionUrl(serverUrl);

    let server: HttpServer | HttpsServer;
    let listenerLabel: 'HTTP' | 'HTTPS';

    if (httpsEnabled) {
        const httpsKeyPath = config.get<string>('https.keyPath', '').trim();
        const httpsCertPath = config.get<string>('https.certPath', '').trim();
        const httpsCaPath = config.get<string>('https.caPath', '').trim();
        const httpsPassphrase = config.get<string>('https.passphrase', '');

        if (!httpsKeyPath || !httpsCertPath) {
            throw new Error('HTTPS is enabled but HTTPS_KEY_PATH and/or HTTPS_CERT_PATH are not configured.');
        }

        const httpsKeyBuffer = readFileSync(httpsKeyPath);
        const httpsCertBuffer = readFileSync(httpsCertPath);
        const httpsCaBuffer = httpsCaPath ? readFileSync(httpsCaPath) : undefined;
        warnIfSelfSignedProductionCertificate(httpsCertBuffer, httpsCertPath);

        server = createHttpsServer({
            key: httpsKeyBuffer,
            cert: httpsCertBuffer,
            ...(httpsCaBuffer ? { ca: httpsCaBuffer } : {}),
            ...(httpsPassphrase ? { passphrase: httpsPassphrase } : {})
        }, app);
        listenerLabel = 'HTTPS';
    } else {
        server = createHttpServer(app);
        listenerLabel = 'HTTP';
    }

    return new Promise((resolve, reject) => {
        try {
            const onError = (error: Error) => {
                server.off('error', onError);
                logger.error('Server startup failed:', error);
                reject(error);
            };

            server.on('error', onError);
            server.listen(port, async () => {
                server.off('error', onError);
                logger.info(`SAP Business One Service Layer MCP Server listening on ${listenerLabel} port ${port}`);
                logger.info('Available routes: /health, /docs, /mcp');
                logger.info('Initializing SAP Business One Service Layer MCP Server...');

                // Discover SAP Business One Service Layer OData services
                if (config.isDirectMode()) {
                    logger.info('Discovering SAP Business One Service Layer OData services...');
                    const discoveredServices = await sapDiscoveryService.getDiscoveredServices();
                    logger.info(`Discovered ${discoveredServices.length} OData services`);
                } else if (config.isOAuthMode()) {
                    logger.info('OAuth mode: Service discovery will occur on first authenticated request');
                } else {
                    logger.warn('No authentication mode configured. Please set up OAuth or direct authentication.');
                }

                resolve();
            });

            // Graceful shutdown
            process.on('SIGTERM', () => {
                logger.info('SIGTERM received, shutting down gracefully...');

                // Close all sessions
                for (const [sessionId, session] of sessions.entries()) {
                    logger.info(`Closing session: ${sessionId}`);
                    session.transport.close();
                }
                sessions.clear();

                server.close(() => {
                    logger.info('Server shut down successfully');
                    process.exit(0);
                });
            });

        } catch (error) {
            logger.error(`Failed to start server:`, error);
            reject(error);
        }
    });
}

// Start server if this file is run directly (not during Vitest integration tests)
if (!process.env.VITEST) {
    const port = Number.parseInt(process.env.PORT || '3000');
    try {
        await startServer(port);
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}
