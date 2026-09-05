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

describe('AppLogger', () => {
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
        process.env.APP_LOG_FILE_PATH = './logs/custom-app.log';
        process.env.APP_LOG_MAX_SIZE_BYTES = '4096';
        process.env.APP_LOG_RETENTION_DAYS = '14';

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

        const { AppLogger } = await import('../../loggers/app-logger.js');
        new AppLogger('test-module');

        expect(mkdirSync).toHaveBeenCalledTimes(1);
        expect(dailyRotateTransport).toHaveBeenCalledWith(expect.objectContaining({
            filename: expect.stringMatching(/logs\/custom-app-%DATE%\.log$|logs\/custom-app-%DATE%\.log|logs\\custom-app-%DATE%\.log$/),
            datePattern: 'YYYY-MM-DD',
            maxSize: 4096,
            maxFiles: '14d',
            zippedArchive: true,
            createSymlink: true,
            symlinkName: 'custom-app-current.log'
        }));
        expect(createLogger).toHaveBeenCalledWith(expect.objectContaining({
            transports: [{ kind: 'daily-rotate', options: expect.any(Object) }]
        }));
    });

    it('allows gzip compression to be disabled explicitly', async () => {
        process.env.NODE_ENV = 'production';
        process.env.APP_LOG_ZIPPED_ARCHIVE = 'false';

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

        const { AppLogger } = await import('../../loggers/app-logger.js');
        new AppLogger('test-module');

        expect(dailyRotateTransport).toHaveBeenCalledWith(expect.objectContaining({
            zippedArchive: false
        }));
    });

    it('allows the symlink to be disabled explicitly', async () => {
        process.env.NODE_ENV = 'production';
        process.env.APP_LOG_CREATE_SYMLINK = 'false';

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

        const { AppLogger } = await import('../../loggers/app-logger.js');
        new AppLogger('test-module');

        expect(dailyRotateTransport).toHaveBeenCalledWith(expect.objectContaining({
            createSymlink: false,
            symlinkName: 'app-current.log'
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

        const { AppLogger } = await import('../../loggers/app-logger.js');
        new AppLogger('test-module');

        expect(dailyRotateTransport).toHaveBeenCalledWith(expect.objectContaining({
            filename: expect.stringMatching(/logs\/app-%DATE%\.log$|logs\\app-%DATE%\.log$/),
            maxFiles: '30d'
        }));
        expect(createLogger).toHaveBeenCalledWith(expect.objectContaining({
            transports: [{ kind: 'daily-rotate', options: expect.any(Object) }]
        }));
    });
});