import { AuditLogger, type AuditEntry } from '../loggers/audit-logger.js';

type HeaderValue = string | string[] | undefined;

export type AuditRequestLike = {
    headers?: Record<string, HeaderValue>;
    ip?: string;
    socket?: {
        remoteAddress?: string | null;
    };
    method?: string;
    path?: string;
};

export type RequestAuditOptions = Omit<AuditEntry, 'sourceIp' | 'companyId' | 'details'> & {
    componentId?: string;
    req?: AuditRequestLike;
    companyId?: string | null;
    details?: Record<string, unknown>;
};

function readHeader(headers: Record<string, HeaderValue> | undefined, name: string): string | undefined {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()];
    if (Array.isArray(value)) {
        return value.find((item) => item.trim())?.trim();
    }

    const trimmedValue = value?.trim();
    return trimmedValue || undefined;
}

export function resolveRequestSourceIp(req?: AuditRequestLike): string | undefined {
    const requestIp = req?.ip?.trim();
    if (requestIp) {
        return requestIp;
    }

    const socketIp = req?.socket?.remoteAddress?.trim();
    return socketIp || undefined;
}

export function resolveRequestCompanyId(req?: AuditRequestLike): string | undefined {
    return readHeader(req?.headers, 'x-b1-companyID');
}

export function resolveRequestSessionId(req?: AuditRequestLike): string | undefined {
    return readHeader(req?.headers, 'mcp-session-id');
}

export function buildRequestAuditEntry(options: RequestAuditOptions): AuditEntry {
    const sessionId = resolveRequestSessionId(options.req);
    const requestDetails = options.req?.method || options.req?.path || sessionId
        ? {
            method: options.req?.method,
            path: options.req?.path,
            sessionId
        }
        : undefined;

    return {
        event: options.event,
        eventId: options.eventId,
        category: options.category,
        subCategory: options.subCategory,
        userName: options.userName,
        outcome: options.outcome,
        message: options.message,
        sourceIp: resolveRequestSourceIp(options.req),
        companyId: AuditLogger.resolveCompanyId(options.companyId ?? resolveRequestCompanyId(options.req)),
        componentId: options.componentId,
        details: {
            ...options.details,
            ...(requestDetails ? { request: requestDetails } : {})
        }
    };
}