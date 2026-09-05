export class Config {
    private readonly config: Map<string, unknown> = new Map();
    private static readonly defaultRequestBodyLimit = '1mb';
    private static readonly requestBodyLimitPattern = /^(?:\d+|[-+]?\d+(?:\.\d+)?\s*(?:kb|mb|gb|tb|pb))$/i;

    constructor() {
        this.loadConfiguration();
    }

    private loadConfiguration(): void {
        // Load from environment variables
        this.config.set('request.bodyLimit', this.parseRequestBodyLimit(process.env.REQUEST_BODY_LIMIT));
        this.config.set('cors.allowedOrigins', Config.parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS));
        this.config.set('log.level', process.env.APP_LOG_LEVEL || 'info');
        this.config.set('node.env', process.env.NODE_ENV || 'production');
        this.config.set('audit.log.fileEnabled', (process.env.AUDIT_LOG_FILE_ENABLED || 'true').trim().toLowerCase() === 'true');
        this.config.set('audit.log.consoleEnabled', (process.env.AUDIT_LOG_CONSOLE_ENABLED || 'false').trim().toLowerCase() === 'true');
        this.config.set('audit.log.maxSizeBytes', Config.parsePositiveInteger(process.env.AUDIT_LOG_MAX_SIZE_BYTES, 10 * 1024 * 1024));
        this.config.set('audit.log.retentionDays', Config.parsePositiveInteger(process.env.AUDIT_LOG_RETENTION_DAYS, 90));
        this.config.set('app.log.fileEnabled', (process.env.APP_LOG_FILE_ENABLED || 'true').trim().toLowerCase() === 'true');
        this.config.set('app.log.consoleEnabled', (process.env.APP_LOG_CONSOLE_ENABLED || 'false').trim().toLowerCase() === 'true');
        this.config.set('port', Number.parseInt(process.env.PORT || '3000'));
        this.config.set('https.enabled', (process.env.HTTPS_ENABLED || 'true').trim().toLowerCase() === 'true');
        this.config.set('https.keyPath', process.env.HTTPS_KEY_PATH || './certs/server.key');
        this.config.set('https.certPath', process.env.HTTPS_CERT_PATH || './certs/server.crt');
        this.config.set('https.caPath', process.env.HTTPS_CA_PATH || '');
        this.config.set('https.passphrase', process.env.HTTPS_PASSPHRASE || '');

        this.config.set('session.timeoutMinutes', Config.parsePositiveInteger(process.env.SESSION_TIMEOUT_MINUTES, 30));
        this.config.set('mcp.rateLimit.windowMinutes', Config.parsePositiveInteger(process.env.MCP_RATE_LIMIT_WINDOW_MINUTES, 1));
        this.config.set('mcp.rateLimit.max', Config.parsePositiveInteger(process.env.MCP_RATE_LIMIT_MAX, 120));
        this.config.set('mcp.humanConfirmationEnabled', (process.env.MCP_HUMAN_CONFIRMATION_ENABLED || 'true').trim().toLowerCase() === 'true');
        this.config.set('mcp.baseUrl', Config.parseOptionalAbsoluteUrl(process.env.MCP_BASE_URL));
        this.config.set('mcp.allowedHosts', Config.parseStringList(process.env.MCP_ALLOWED_HOSTS, ['127.0.0.1', 'localhost']));

        // SAP Business One Service Layer configuration
        this.config.set('b1.serviceLayerUrl', process.env.SERVICE_LAYER_ROOT_URL || '');
        this.config.set('auth.allowSelfSigned', (process.env.AUTH_ALLOW_SELF_SIGNED || 'false') == 'true');

        // Direct configuration
        this.config.set('b1.companyDb', process.env.B1_COMPANY_DB || '');
        this.config.set('b1.userName', process.env.B1_USERNAME || '');
        this.config.set('b1.password', process.env.B1_PASSWORD || '');

        // OAuth configuration
        const authBaseUrl = process.env.OAUTH_BASE_URL || '';
        this.config.set('auth.baseUrl', authBaseUrl && !authBaseUrl.endsWith('/') ? `${authBaseUrl}/` : authBaseUrl);
        this.config.set('sld.rootUrl', process.env.SLD_ROOT_URL || '');
        this.config.set('auth.clientId', process.env.OAUTH_CLIENT_ID || '');
        this.config.set('auth.clientSecret', process.env.OAUTH_CLIENT_SECRET || '');
        this.config.set('auth.validateAudience', (process.env.VALIDATE_AUDIENCE || 'true') == 'true');
        this.config.set('auth.requiredScopes', Config.parseStringList(process.env.OAUTH_REQUIRED_SCOPES, ['b1_mcp:access']));
        this.config.set('auth.verifyScopesEnabled', (process.env.OAUTH_VERIFY_SCOPES || 'true').trim().toLowerCase() === 'true');

        // Token validation mode: controls the resource server validates access tokens.
        const rawValidationMode = (process.env.TOKEN_VALIDATION_MODE || 'introspection-with-jwt-fallback').trim();
        const validValidationModes = ['introspection', 'jwt', 'introspection-with-jwt-fallback'];
        this.config.set('auth.validationMode',
            validValidationModes.includes(rawValidationMode) ? rawValidationMode : 'introspection-with-jwt-fallback'
        );
        this.config.set('company.listCacheTtl', Config.parsePositiveInteger(process.env.COMPANY_LIST_CACHE_TTL_MINUTES, 5));
        this.config.set('metadata.cacheTtlMinutes', Config.parsePositiveInteger(process.env.METADATA_CACHE_TTL_MINUTES, 30));

        // Determine authentication mode
        this.loadAuthenticationMode();
    }

    get<T = string>(key: string, defaultValue?: T): T {
        const value = this.config.get(key);
        if (value === undefined) {
            return defaultValue as T;
        }
        return value as T;
    }

    set(key: string, value: unknown): void {
        this.config.set(key, value);
    }

    has(key: string): boolean {
        return this.config.has(key);
    }

    getAll(): Record<string, unknown> {
        return Object.fromEntries(this.config);
    }

    private static parsePositiveInteger(value: string | undefined, fallback: number): number {
        const parsed = Number.parseInt(value?.trim() || '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    private static parseOptionalAbsoluteUrl(value: string | undefined): string {
        const normalizedValue = value?.trim() || '';
        if (!normalizedValue) {
            return '';
        }

        try {
            return new URL(normalizedValue).toString();
        } catch {
            process.stderr.write(`Invalid MCP_BASE_URL value "${normalizedValue}". Falling back to localhost-derived URLs.\n`);
            return '';
        }
    }

    private static parseStringList(value: string | undefined, fallback: string[]): string[] {
        const items = (value || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

        return items.length > 0 ? items : fallback;
    }

    private static parseCorsAllowedOrigins(value: string | undefined): string  {
        const raw = (value || '').trim();
        if (!raw) {
            return '';
        }
        const origins = raw
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean);
        return origins.includes('*') ? "*": origins.join(',');
    }

    private parseRequestBodyLimit(rawValue?: string): string {
        const value = (rawValue || Config.defaultRequestBodyLimit).trim();

        if (!Config.requestBodyLimitPattern.test(value)) {
            process.stderr.write(`Invalid REQUEST_BODY_LIMIT value "${value}". Falling back to default value "${Config.defaultRequestBodyLimit}".\n`);
            return Config.defaultRequestBodyLimit;
        }

        const numericValue = Number.parseFloat(value);
        if (!Number.isFinite(numericValue) || numericValue <= 0) {
            process.stderr.write(`Invalid REQUEST_BODY_LIMIT value "${value}". Falling back to default value "${Config.defaultRequestBodyLimit}".\n`);
            return Config.defaultRequestBodyLimit;
        }

        return value;
    }

    /**
     * Determine authentication mode based on environment variables
     * Supports explicit AUTHENTICATION_MODE setting or auto-detection
     * 
     * Priority:
     * 1. Explicit AUTHENTICATION_MODE environment variable ('direct' or 'oauth2')
     * 2. Auto-detection based on available OAuth2 configuration
     * 3. Default to 'direct' if legacy B1 config exists
     */
    private loadAuthenticationMode(): void {
        // Check for explicit authentication mode setting
        const explicitMode = process.env.AUTHENTICATION_MODE?.toLowerCase();

        if (explicitMode === 'oauth2' || explicitMode === 'oauth') {
            this.config.set('auth.mode', 'oauth');
            return;
        }

        if (explicitMode === 'direct') {
            this.config.set('auth.mode', 'direct');
            return;
        }

        // Auto-detect based on available configuration
        const hasOAuthConfig = !!(
            this.config.get('auth.baseUrl') &&
            this.config.get('auth.clientId')
        );

        const hasDirectConfig = !!(
            this.config.get('b1.serviceLayerUrl') &&
            this.config.get('b1.companyDb') &&
            this.config.get('b1.userName')
        );

        // OAuth2 takes precedence when both are configured
        if (hasOAuthConfig) {
            this.config.set('auth.mode', 'oauth');
        } else if (hasDirectConfig) {
            this.config.set('auth.mode', 'direct');
        } else {
            this.config.set('auth.mode', 'none');
        }
    }

    /**
     * Check if direct mode is enabled
     */
    isDirectMode(): boolean {
        const mode = this.get<string>('auth.mode', 'none');
        return mode === 'direct';
    }

    /**
     * Check if OAuth mode is enabled
     */
    isOAuthMode(): boolean {
        const mode = this.get<string>('auth.mode', 'none');
        return mode === 'oauth';
    }

    /**
     * Check if current runtime environment is production.
     *
     * Reads process.env at call time so tests and runtime overrides are respected.
     */
    isProduction(): boolean {
        const nodeEnv = (process.env.NODE_ENV || this.get<string>('node.env', 'production'))
            .trim()
            .toLowerCase();
        return nodeEnv === 'production';
    }

    /**
     * Check if current runtime environment is development.
     */
    isDevelopment(): boolean {
        const nodeEnv = (process.env.NODE_ENV || this.get<string>('node.env', 'production'))
            .trim()
            .toLowerCase();
        return nodeEnv === 'development';
    }
}

export function isHumanConfirmationEnabled(): boolean {
    return (process.env.MCP_HUMAN_CONFIRMATION_ENABLED || 'true').trim().toLowerCase() === 'true';
}

export const config = new Config();