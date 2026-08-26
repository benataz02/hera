import { AuditLogger } from '../loggers/audit-logger.js';
import { config } from './config.js';

/**
 * Centralized error handling and classification utility.
 *
 * Intended for uncaught errors that escape to top-level server hooks such as
 * the MCP server's `onerror` callback. Expected downstream failures, including
 * SAP B1 Service Layer 4xx/5xx responses, are usually handled earlier by tool
 * handlers and returned as normal MCP tool errors instead of being routed here.
 */
export class ErrorHandler {
    private static readonly auditLog = new AuditLogger('ErrorHandler');

    /**
     * Extract a human-readable message from any thrown value.
     * Handles Error instances, SAP B1 API error shapes, and primitives.
     */
    static toMessage(error: unknown): string {
        if (error === null || error === undefined) {
            return 'Unknown error';
        }
        if (typeof error === 'string') {
            return error;
        }
        if (typeof error !== 'object') {
            return String(error);
        }
        // SAP B1 Service Layer wraps errors as { error: { message: { value: '...' } } }
        const b1 = error as { error?: { message?: { value?: string } } };
        if (b1.error?.message?.value) {
            return b1.error.message.value;
        }
        const e = error as { message?: unknown };
        if (typeof e.message === 'string' && e.message) {
            return e.message;
        }
        return String(error);
    }

    /**
     * Record an uncaught error for audit/monitoring.
     *
     * Call this only when the error was not already converted into an explicit
     * tool or HTTP response.
     */
    static handle(error: unknown): void {
        const category = this.categorizeError(error);
        let errorDetail: { message?: string; code?: string; statusCode?: number } = {};
        if (typeof error === 'object' && error !== null) {
            errorDetail = error as typeof errorDetail;
        }
        this.auditLog.record({
            event: 'UnhandledError',
            category: 'ErrorHandling',
            subCategory: 'UnhandledException',
            outcome: 'failure',
            message: `Unhandled error [${category}]`,
            details: {
                message: this.toMessage(error),
                code: errorDetail.code,
                statusCode: errorDetail.statusCode,
                category
            }
        });
        if (config.isProduction()) {
            // Send to monitoring service
        }
    }

    static categorizeError(error: unknown): string {
        if (typeof error !== 'object' || error === null) {
            return typeof error === 'string' ? 'StringError' : 'Unknown';
        }
        const errorInfo = error as {
            statusCode?: number;
            status?: number;
            code?: string;
            message?: string;
            stack?: string;
            name?: string;
        };

        // HTTP status — prefer statusCode, fall back to status
        const httpStatus = errorInfo.statusCode ?? errorInfo.status;
        if (httpStatus) {
            switch (httpStatus) {
                case 400: return 'BadRequest';
                case 401: return 'Authentication';
                case 403: return 'Authorization';
                case 404: return 'NotFound';
                case 405: return 'MethodNotAllowed';
                case 409: return 'Conflict';
                case 422: return 'ValidationError';
                case 429: return 'RateLimited';
                case 500: return 'ServerError';
                case 502: return 'BadGateway';
                case 503: return 'ServiceUnavailable';
                case 504: return 'GatewayTimeout';
                default:
                    if (httpStatus >= 400 && httpStatus < 500) return 'ClientError';
                    if (httpStatus >= 500) return 'ServerError';
                    return 'HttpError';
            }
        }

        // Node.js / network error codes
        if (errorInfo.code) {
            const code = errorInfo.code.toUpperCase();
            if (code === 'ECONNREFUSED') return 'ConnectionRefused';
            if (code === 'ECONNRESET') return 'ConnectionReset';
            if (code === 'ENOTFOUND') return 'DnsResolutionFailed';
            if (code === 'ETIMEDOUT' || code.includes('TIMEOUT')) return 'Timeout';
            if (code.includes('CERT') || code.includes('SSL') || code.includes('TLS')) return 'SslError';
            if (code.startsWith('ECONNECT') || code.includes('CONNECTION')) return 'Connection';
            if (code === 'EACCES' || code === 'EPERM') return 'PermissionDenied';
            if (code === 'ENOENT') return 'FileNotFound';
            if (code === 'EMFILE' || code === 'ENFILE') return 'ResourceExhausted';
        }

        // Standard Error subclass names
        if (errorInfo.name) {
            if (errorInfo.name === 'SyntaxError') return 'ParseError';
            if (errorInfo.name === 'TypeError') return 'TypeError';
            if (errorInfo.name === 'RangeError') return 'RangeError';
            if (errorInfo.name === 'AbortError') return 'Aborted';
        }

        // SAP B1 Service Layer error envelope
        const b1 = error as { error?: { message?: { value?: string } } };
        if (b1.error?.message?.value) {
            return 'B1ApiError';
        }

        // Message heuristics as last resort
        const msg = (errorInfo.message ?? '').toLowerCase();
        if (msg.includes('timeout')) return 'Timeout';
        if (msg.includes('unauthorized') || msg.includes('authentication')) return 'Authentication';
        if (msg.includes('forbidden') || msg.includes('authorization')) return 'Authorization';
        if (msg.includes('not found')) return 'NotFound';
        if (msg.includes('parse') || msg.includes('json')) return 'ParseError';
        if (msg.includes('network') || msg.includes('socket') || msg.includes('connect')) return 'Connection';

        return 'Unknown';
    }
}