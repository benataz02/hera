import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from '../utils/config.js';
import { pkgName } from '../utils/pkg.js';
import { getRequestContext } from '../utils/request-context.js';

export type AuditOutcome = 'success' | 'failure' | 'attempt' | 'info';
export type AuditCategory =
    | 'Authentication'
    | 'Authorization'
    | 'DataModification'
    | 'ErrorHandling'
    | 'RateLimiting'
    | 'RequestProcessing'
    | 'RequestValidation'
    | 'SessionManagement';

export type AuditSubCategory =
    | 'BearerToken'
    | 'Context'
    | 'Create'
    | 'Delete'
    | 'Lifecycle'
    | 'McpEndpoint'
    | 'Protocol'
    | 'SessionOwnership'
    | 'SessionReuse'
    | 'Update'
    | 'UnhandledException';

export type AuditEntry = {
    eventId?: string;
    event: string;
    category: AuditCategory;
    subCategory: AuditSubCategory;
    userName?: string;
    outcome?: AuditOutcome;
    message?: string;
    sourceIp?: string;
    companyId?: string | null;
    componentId?: string;
    details?: unknown;
};

export class AuditLogger {
    private static readonly defaultCompanyId = 'n/a';
    private static readonly defaultLogFilePath = path.join(process.cwd(), 'logs', 'audit.log');
    private static readonly defaultMaxSizeBytes = 10 * 1024 * 1024;
    private static readonly defaultRetentionDays = 90;
    private static readonly defaultZippedArchive = true;
    private static readonly defaultCreateSymlink = true;
    private readonly winstonLogger: winston.Logger;
    private healthy = true;
    private lastErrorMessage?: string;

    constructor(private readonly moduleName: string) {
        const transportSetup = AuditLogger.createTransports();
        if (transportSetup.initializationError) {
            this.markUnhealthy(transportSetup.initializationError);

            const isProduction = config.isProduction();
            if (isProduction) {
                throw new Error(`Audit logger initialization failed: ${transportSetup.initializationError}`);
            }
        }

        this.winstonLogger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            defaultMeta: {
                module: this.moduleName,
                service: pkgName,
                logType: 'audit'
            },
            transports: transportSetup.transports
        });

        for (const transport of transportSetup.transports) {
            const emitterTransport = transport as unknown as {
                on?: (event: string, listener: (error: unknown) => void) => void;
            };

            emitterTransport.on?.('error', (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                this.markUnhealthy(`Audit transport runtime error: ${message}`);
                process.stderr.write(`Audit transport runtime failure: ${message}\n`);
            });
        }
    }

    private static isFileLoggingEnabled(): boolean {
        return config.get<boolean>('audit.log.fileEnabled', true);
    }

    private static isConsoleLoggingEnabled(): boolean {
        return config.get<boolean>('audit.log.consoleEnabled', false);
    }

    private static createTransports(): { transports: winston.transport[]; initializationError?: string } {
        const transports: winston.transport[] = [];

        if (AuditLogger.isConsoleLoggingEnabled()) {
            transports.push(new winston.transports.Console());
        }

        if (!AuditLogger.isFileLoggingEnabled()) {
            return { transports };
        }

        const logFilePath = AuditLogger.resolveLogFilePath();
        let initializationError: string | undefined;

        try {
            fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
            transports.push(
                new DailyRotateFile({
                    filename: AuditLogger.resolveRotatedLogFilePath(logFilePath),
                    datePattern: 'YYYY-MM-DD',
                    maxSize: AuditLogger.resolveMaxSizeBytes(),
                    maxFiles: AuditLogger.resolveRetentionPolicy(),
                    zippedArchive: AuditLogger.resolveZippedArchive(),
                    createSymlink: AuditLogger.resolveCreateSymlink(),
                    symlinkName: AuditLogger.resolveSymlinkName(logFilePath)
                })
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            initializationError = `Failed to initialize audit logging at ${logFilePath}: ${message}`;
            process.stderr.write(`${initializationError}\n`);
        }

        return { transports, initializationError };
    }

    private markUnhealthy(message: string): void {
        this.healthy = false;
        this.lastErrorMessage = message;
    }

    isHealthy(): boolean {
        return this.healthy;
    }

    getLastErrorMessage(): string | undefined {
        return this.lastErrorMessage;
    }

    getHealthSummary(): { healthy: boolean; error?: string } {
        return {
            healthy: this.healthy,
            ...(this.lastErrorMessage ? { error: this.lastErrorMessage } : {})
        };
    }

    static describeRetentionPolicy(): string {
        const logFilePath = AuditLogger.resolveLogFilePath();
        const retentionPolicy = AuditLogger.resolveRetentionPolicy();
        const maxSizeBytes = AuditLogger.resolveMaxSizeBytes();
        const zippedArchive = AuditLogger.resolveZippedArchive();
        const createSymlink = AuditLogger.resolveCreateSymlink();
        const symlinkName = AuditLogger.resolveSymlinkName(logFilePath);
        const retentionDescription = retentionPolicy;
        const archiveDescription = zippedArchive ? 'gzip enabled for rotated files' : 'gzip disabled';
        const symlinkDescription = createSymlink ? `symlink ${path.join(path.dirname(logFilePath), symlinkName)}` : 'symlink disabled';

        if (!AuditLogger.isFileLoggingEnabled()) {
            return `console-only logging (file output disabled; set AUDIT_LOG_FILE_ENABLED=false to disable; configured file path ${logFilePath})`;
        }

        return `daily rotation at ${logFilePath}, retention ${retentionDescription}, max file size ${maxSizeBytes} bytes, ${archiveDescription}, ${symlinkDescription}`;
    }

    private static resolveLogFilePath(): string {
        const configuredPath = process.env.AUDIT_LOG_FILE_PATH?.trim();
        return configuredPath ? path.resolve(configuredPath) : AuditLogger.defaultLogFilePath;
    }

    private static resolveRotatedLogFilePath(logFilePath: string): string {
        const parsedPath = path.parse(logFilePath);
        const rotatedBaseName = parsedPath.ext
            ? `${parsedPath.name}-%DATE%${parsedPath.ext}`
            : `${parsedPath.base}-%DATE%`;

        return path.join(parsedPath.dir, rotatedBaseName);
    }

    private static resolveMaxSizeBytes(): number {
        return config.get<number>('audit.log.maxSizeBytes', AuditLogger.defaultMaxSizeBytes);
    }

    private static resolveRetentionPolicy(): string {
        return `${config.get<number>('audit.log.retentionDays', AuditLogger.defaultRetentionDays)}d`;
    }

    private static resolveZippedArchive(): boolean {
        return AuditLogger.parseBoolean(
            process.env.AUDIT_LOG_ZIPPED_ARCHIVE,
            AuditLogger.defaultZippedArchive
        );
    }

    private static resolveCreateSymlink(): boolean {
        return AuditLogger.parseBoolean(
            process.env.AUDIT_LOG_CREATE_SYMLINK,
            AuditLogger.defaultCreateSymlink
        );
    }

    private static resolveSymlinkName(logFilePath: string): string {
        const configuredName = process.env.AUDIT_LOG_SYMLINK_NAME?.trim();
        if (configuredName) {
            return configuredName;
        }

        const parsedPath = path.parse(logFilePath);
        return parsedPath.ext
            ? `${parsedPath.name}-current${parsedPath.ext}`
            : `${parsedPath.base}-current.log`;
    }

    private static parseBoolean(value: string | undefined, fallbackValue: boolean): boolean {
        const normalizedValue = value?.trim().toLowerCase();
        if (normalizedValue === 'true') {
            return true;
        }
        if (normalizedValue === 'false') {
            return false;
        }
        return fallbackValue;
    }

    static resolveCompanyId(companyId?: string | null): string {
        const normalizedCompanyId = companyId?.trim();
        return normalizedCompanyId || AuditLogger.defaultCompanyId;
    }

    private resolveComponentId(entryComponentId?: string): string {
        const configuredComponentId = process.env.OAUTH_CLIENT_ID?.trim();
        if (configuredComponentId) {
            return configuredComponentId;
        }

        return entryComponentId || this.moduleName;
    }

    record(entry: AuditEntry): void {
        const eventId = entry.eventId || randomUUID();
        const componentId = this.resolveComponentId(entry.componentId);
        const requestContext = getRequestContext();
        const userName = entry.userName ?? requestContext?.userName;
        const companyId = AuditLogger.resolveCompanyId(entry.companyId);
        this.winstonLogger.info(entry.message || entry.event, {
            eventId: eventId,
            event: entry.event,
            category: entry.category,
            subCategory: entry.subCategory,
            username: userName,
            outcome: entry.outcome || 'info',
            sourceIp: entry.sourceIp,
            companyId,
            componentId,
            details: entry.details
        });
    }
}

export { AuditLogger as AuditLog };