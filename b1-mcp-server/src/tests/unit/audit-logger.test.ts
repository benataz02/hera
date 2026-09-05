import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('AuditLogger', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreEnv(originalEnv);
    });

    it('configures day-based retention settings when file logging is enabled', async () => {
        process.env.NODE_ENV = 'production';
        process.env.AUDIT_LOG_FILE_PATH = './logs/custom-audit.log';
        process.env.AUDIT_LOG_MAX_SIZE_BYTES = '2048';
        process.env.AUDIT_LOG_RETENTION_DAYS = '7';

        const mkdirSync = vi.fn();
        const createLogger = vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }));
        const dailyRotateTransport = vi.fn(function MockDailyRotateTransport(options) {
            return { kind: 'daily-rotate', options };
        });
        const consoleTransport = vi.fn(function MockConsoleTransport() {
            return { kind: 'console' };
        });

        vi.doMock('node:fs', () => ({
            default: { mkdirSync }
        }));
        vi.doMock('winston', () => ({
            default: {
                createLogger,
                format: {
                    combine: vi.fn(() => 'combined-format'),
                    timestamp: vi.fn(() => 'timestamp-format'),
                    errors: vi.fn(() => 'errors-format'),
                    json: vi.fn(() => 'json-format')
                },
                transports: {
                    Console: consoleTransport
                }
            }
        }));
        vi.doMock('winston-daily-rotate-file', () => ({
            default: dailyRotateTransport
        }));

        const { AuditLogger } = await import('../../loggers/audit-logger.js');
        new AuditLogger('test-module');

        expect(mkdirSync).toHaveBeenCalledTimes(1);
        expect(dailyRotateTransport).toHaveBeenCalledWith(expect.objectContaining({
            filename: expect.stringMatching(/logs\/custom-audit-%DATE%\.log$|logs\/custom-audit-%DATE%\.log|logs\\custom-audit-%DATE%\.log$/),
            datePattern: 'YYYY-MM-DD',
            maxSize: 2048,
            maxFiles: '7d',
            zippedArchive: true,
            createSymlink: true,
            symlinkName: 'custom-audit-current.log'
        }));
        expect(createLogger).toHaveBeenCalledWith(expect.objectContaining({
            transports: [{ kind: 'daily-rotate', options: expect.any(Object) }]
        }));
    });

    it('adds a generated audit event id when recording an entry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-21T12:34:56.789Z'));

        const info = vi.fn();
        const createLogger = vi.fn(() => ({
            info,
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }));
        const consoleTransport = vi.fn(function MockConsoleTransport() {
            return { kind: 'console' };
        });

        vi.doMock('node:crypto', () => ({
            randomUUID: vi.fn(() => 'audit-event-id-123')
        }));
        vi.doMock('winston', () => ({
            default: {
                createLogger,
                format: {
                    combine: vi.fn(() => 'combined-format'),
                    timestamp: vi.fn(() => 'timestamp-format'),
                    errors: vi.fn(() => 'errors-format'),
                    json: vi.fn(() => 'json-format')
                },
                transports: {
                    Console: consoleTransport
                }
            }
        }));
        vi.doMock('winston-daily-rotate-file', () => ({
            default: vi.fn(function MockDailyRotateTransport(options) {
                return { kind: 'daily-rotate', options };
            })
        }));

        const { AuditLogger } = await import('../../loggers/audit-logger.js');
        const logger = new AuditLogger('test-module');

        logger.record({
            event: 'SessionCreated',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            userName: 'manager',
            outcome: 'success',
            sourceIp: '192.168.1.10',
            companyId: 'SBODEMOUS',
            componentId: 'mcp-session-service',
            details: { sessionId: 'abc' }
        });

        expect(info).toHaveBeenCalledWith('SessionCreated', expect.objectContaining({
            eventId: 'audit-event-id-123',
            event: 'SessionCreated',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            username: 'manager',
            outcome: 'success',
            sourceIp: '192.168.1.10',
            companyId: 'SBODEMOUS',
            componentId: 'mcp-session-service',
            details: { sessionId: 'abc' }
        }));

        vi.useRealTimers();
    });

    it('uses OAUTH_CLIENT_ID as the component id when configured', async () => {
        process.env.OAUTH_CLIENT_ID = 'b1-mcp-client';

        const info = vi.fn();
        const createLogger = vi.fn(() => ({
            info,
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }));
        const consoleTransport = vi.fn(function MockConsoleTransport() {
            return { kind: 'console' };
        });

        vi.doMock('winston', () => ({
            default: {
                createLogger,
                format: {
                    combine: vi.fn(() => 'combined-format'),
                    timestamp: vi.fn(() => 'timestamp-format'),
                    errors: vi.fn(() => 'errors-format'),
                    json: vi.fn(() => 'json-format')
                },
                transports: {
                    Console: consoleTransport
                }
            }
        }));
        vi.doMock('winston-daily-rotate-file', () => ({
            default: vi.fn(function MockDailyRotateTransport(options) {
                return { kind: 'daily-rotate', options };
            })
        }));

        const { AuditLogger } = await import('../../loggers/audit-logger.js');
        const logger = new AuditLogger('test-module');

        logger.record({
            event: 'SessionCreated',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            componentId: 'mcp-session-service'
        });

        expect(info).toHaveBeenCalledWith('SessionCreated', expect.objectContaining({
            componentId: 'b1-mcp-client'
        }));
    });

    it('falls back to n/a when companyId is missing', async () => {
        const info = vi.fn();
        const createLogger = vi.fn(() => ({
            info,
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }));
        const consoleTransport = vi.fn(function MockConsoleTransport() {
            return { kind: 'console' };
        });

        vi.doMock('winston', () => ({
            default: {
                createLogger,
                format: {
                    combine: vi.fn(() => 'combined-format'),
                    timestamp: vi.fn(() => 'timestamp-format'),
                    errors: vi.fn(() => 'errors-format'),
                    json: vi.fn(() => 'json-format')
                },
                transports: {
                    Console: consoleTransport
                }
            }
        }));
        vi.doMock('winston-daily-rotate-file', () => ({
            default: vi.fn(function MockDailyRotateTransport(options) {
                return { kind: 'daily-rotate', options };
            })
        }));

        const { AuditLogger } = await import('../../loggers/audit-logger.js');
        const logger = new AuditLogger('test-module');

        logger.record({
            event: 'SessionCreated',
            category: 'SessionManagement',
            subCategory: 'Lifecycle',
            companyId: null
        });

        expect(info).toHaveBeenCalledWith('SessionCreated', expect.objectContaining({
            companyId: 'n/a'
        }));
    });

    it('leaves userName undefined when no explicit or request-context user is available', async () => {
        const info = vi.fn();
        const createLogger = vi.fn(() => ({
            info,
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }));
        const consoleTransport = vi.fn(function MockConsoleTransport() {
            return { kind: 'console' };
        });
        vi.doMock('winston', () => ({
            default: {
                createLogger,
                format: {
                    combine: vi.fn(() => 'combined-format'),
                    timestamp: vi.fn(() => 'timestamp-format'),
                    errors: vi.fn(() => 'errors-format'),
                    json: vi.fn(() => 'json-format')
                },
                transports: {
                    Console: consoleTransport
                }
            }
        }));
        vi.doMock('winston-daily-rotate-file', () => ({
            default: vi.fn(function MockDailyRotateTransport(options) {
                return { kind: 'daily-rotate', options };
            })
        }));

        const { AuditLogger } = await import('../../loggers/audit-logger.js');
        const logger = new AuditLogger('test-module');

        logger.record({
            event: 'SessionCreated',
            category: 'SessionManagement',
            subCategory: 'Lifecycle'
        });

        expect(info).toHaveBeenCalledWith('SessionCreated', expect.objectContaining({
            username: undefined
        }));
    });

    it('allows gzip compression to be disabled explicitly', async () => {
        process.env.NODE_ENV = 'production';
        process.env.AUDIT_LOG_ZIPPED_ARCHIVE = 'false';

        const createLogger = vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }));
        const dailyRotateTransport = vi.fn(function MockDailyRotateTransport(options) {
            return { kind: 'daily-rotate', options };
        });
        const consoleTransport = vi.fn(function MockConsoleTransport() {
            return { kind: 'console' };
        });

        vi.doMock('winston', () => ({
            default: {
                createLogger,
                format: {
                    combine: vi.fn(() => 'combined-format'),
                    timestamp: vi.fn(() => 'timestamp-format'),
                    errors: vi.fn(() => 'errors-format'),
                    json: vi.fn(() => 'json-format')
                },
                transports: {
                    Console: consoleTransport
                }
            }
        }));
        vi.doMock('winston-daily-rotate-file', () => ({
            default: dailyRotateTransport
        }));

        const { AuditLogger } = await import('../../loggers/audit-logger.js');
        new AuditLogger('test-module');

        expect(dailyRotateTransport).toHaveBeenCalledWith(expect.objectContaining({
            zippedArchive: false
        }));
        expect(AuditLogger.describeRetentionPolicy()).toContain('gzip disabled');
    });

    it('allows the symlink to be disabled explicitly', async () => {
        process.env.NODE_ENV = 'production';
        process.env.AUDIT_LOG_CREATE_SYMLINK = 'false';

        const createLogger = vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }));
        const dailyRotateTransport = vi.fn(function MockDailyRotateTransport(options) {
            return { kind: 'daily-rotate', options };
        });
        const consoleTransport = vi.fn(function MockConsoleTransport() {
            return { kind: 'console' };
        });

        vi.doMock('winston', () => ({
            default: {
                createLogger,
                format: {
                    combine: vi.fn(() => 'combined-format'),
                    timestamp: vi.fn(() => 'timestamp-format'),
                    errors: vi.fn(() => 'errors-format'),
                    json: vi.fn(() => 'json-format')
                },
                transports: {
                    Console: consoleTransport
                }
            }
        }));
        vi.doMock('winston-daily-rotate-file', () => ({
            default: dailyRotateTransport
        }));

        const { AuditLogger } = await import('../../loggers/audit-logger.js');
        new AuditLogger('test-module');

        expect(dailyRotateTransport).toHaveBeenCalledWith(expect.objectContaining({
            createSymlink: false,
            symlinkName: 'audit-current.log'
        }));
        expect(AuditLogger.describeRetentionPolicy()).toContain('symlink disabled');
    });

    it('ignores AUDIT_LOG_MAX_FILES and uses day-based retention', async () => {
        process.env.NODE_ENV = 'production';
        process.env.AUDIT_LOG_MAX_FILES = '5';

        const createLogger = vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }));
        const dailyRotateTransport = vi.fn(function MockDailyRotateTransport(options) {
            return { kind: 'daily-rotate', options };
        });
        const consoleTransport = vi.fn(function MockConsoleTransport() {
            return { kind: 'console' };
        });

        vi.doMock('winston', () => ({
            default: {
                createLogger,
                format: {
                    combine: vi.fn(() => 'combined-format'),
                    timestamp: vi.fn(() => 'timestamp-format'),
                    errors: vi.fn(() => 'errors-format'),
                    json: vi.fn(() => 'json-format')
                },
                transports: {
                    Console: consoleTransport
                }
            }
        }));
        vi.doMock('winston-daily-rotate-file', () => ({
            default: dailyRotateTransport
        }));

        const { AuditLogger } = await import('../../loggers/audit-logger.js');
        new AuditLogger('test-module');

        expect(dailyRotateTransport).toHaveBeenCalledWith(expect.objectContaining({
            maxFiles: '90d'
        }));
    });

    it('still configures a file transport outside production when file logging is enabled', async () => {
        process.env.NODE_ENV = 'development';

        const createLogger = vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }));
        const dailyRotateTransport = vi.fn(function MockDailyRotateTransport(options) {
            return { kind: 'daily-rotate', options };
        });
        const consoleTransport = vi.fn(function MockConsoleTransport() {
            return { kind: 'console' };
        });

        vi.doMock('winston', () => ({
            default: {
                createLogger,
                format: {
                    combine: vi.fn(() => 'combined-format'),
                    timestamp: vi.fn(() => 'timestamp-format'),
                    errors: vi.fn(() => 'errors-format'),
                    json: vi.fn(() => 'json-format')
                },
                transports: {
                    Console: consoleTransport
                }
            }
        }));
        vi.doMock('winston-daily-rotate-file', () => ({
            default: dailyRotateTransport
        }));

        const { AuditLogger } = await import('../../loggers/audit-logger.js');
        new AuditLogger('test-module');

        expect(dailyRotateTransport).toHaveBeenCalledWith(expect.objectContaining({
            filename: expect.stringMatching(/logs\/audit-%DATE%\.log$|logs\\audit-%DATE%\.log$/),
            maxFiles: '90d'
        }));
        expect(createLogger).toHaveBeenCalledWith(expect.objectContaining({
            transports: [{ kind: 'daily-rotate', options: expect.any(Object) }]
        }));
    });
});