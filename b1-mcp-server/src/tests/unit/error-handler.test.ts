import { beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.hoisted(() => vi.fn());

vi.mock('../../loggers/audit-logger.js', () => ({
    AuditLogger: class {
        record(entry: unknown): void {
            record(entry);
        }
    }
}));

describe('ErrorHandler', () => {
    beforeEach(() => {
        record.mockReset();
        vi.resetModules();
    });

    it('does not include stack traces in audit error details', async () => {
        const { ErrorHandler } = await import('../../utils/error-handler.js');
        const error = new Error('Invalid Host header: localhost:3000');
        error.stack = 'Error: Invalid Host header: localhost:3000\n    at some/internal/path.js:1:1';

        ErrorHandler.handle(error);

        expect(record).toHaveBeenCalledWith(expect.objectContaining({
            event: 'UnhandledError',
            category: 'ErrorHandling',
            subCategory: 'UnhandledException',
            outcome: 'failure',
            details: expect.objectContaining({
                message: 'Invalid Host header: localhost:3000',
                category: 'Unknown'
            })
        }));

        expect(record.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({
            details: expect.objectContaining({
                stack: expect.any(String)
            })
        }));
    });
});