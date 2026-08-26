import { describe, expect, it } from 'vitest';

import {
    buildRequestAuditEntry,
    resolveRequestCompanyId,
    resolveRequestSessionId,
    resolveRequestSourceIp
} from '../../utils/server-audit.js';

describe('server-audit helpers', () => {
    it('extracts request metadata into a structured audit entry', () => {
        const entry = buildRequestAuditEntry({
            req: {
                ip: '203.0.113.10',
                method: 'POST',
                path: '/mcp',
                headers: {
                    'mcp-session-id': 'session-123',
                    'x-b1-companyID': 'SBODEMOUS'
                }
            },
            event: 'SessionCreated',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            outcome: 'success',
            userName: 'manager',
            details: {
                authenticated: true
            }
        });

        expect(entry).toMatchObject({
            event: 'SessionCreated',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            outcome: 'success',
            userName: 'manager',
            sourceIp: '203.0.113.10',
            companyId: 'SBODEMOUS',
            details: {
                authenticated: true,
                request: {
                    method: 'POST',
                    path: '/mcp',
                    sessionId: 'session-123'
                }
            }
        });
    });

    it('falls back to the socket address and supports explicit company overrides', () => {
        expect(resolveRequestSourceIp({ socket: { remoteAddress: '127.0.0.1' } })).toBe('127.0.0.1');
        expect(resolveRequestCompanyId({ headers: { 'x-b1-companyID': 'SBODEMOUS' } })).toBe('SBODEMOUS');
        expect(resolveRequestCompanyId({ headers: { 'x-b1-companyid': 'SBODEMOUS' } })).toBe('SBODEMOUS');
        expect(resolveRequestSessionId({ headers: { 'mcp-session-id': 'session-456' } })).toBe('session-456');

        const entry = buildRequestAuditEntry({
            req: {
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-b1-companyID': 'IGNORED' }
            },
            event: 'SessionExpired',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            companyId: 'OVERRIDE',
            details: {}
        });

        expect(entry.sourceIp).toBe('127.0.0.1');
        expect(entry.companyId).toBe('OVERRIDE');
    });

    it('uses n/a when no company id is available', () => {
        const entry = buildRequestAuditEntry({
            req: {
                socket: { remoteAddress: '127.0.0.1' }
            },
            event: 'SessionExpired',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            companyId: null,
            details: {}
        });

        expect(entry.companyId).toBe('n/a');
    });
});