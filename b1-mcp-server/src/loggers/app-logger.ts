import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { pkgName } from '../utils/pkg.js';
import { config } from '../utils/config.js';

export class AppLogger {
    private static readonly defaultLogFilePath = path.join(process.cwd(), 'logs', 'app.log');
    private static readonly defaultMaxSizeBytes = 10 * 1024 * 1024;
    private static readonly defaultRetentionDays = 30;
    private static readonly defaultZippedArchive = true;
    private static readonly defaultCreateSymlink = true;
    private readonly winstonLogger: winston.Logger;

    constructor(private readonly moduleName: string) {
        this.winstonLogger = winston.createLogger({
            level: process.env.APP_LOG_LEVEL || 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.json()
            ),
            defaultMeta: {
                module: this.moduleName,
                service: pkgName
            },
            transports: AppLogger.createTransports()
        });
    }

    private static createTransports(): winston.transport[] {
        const transports: winston.transport[] = [];

        if (config.get<boolean>('app.log.consoleEnabled', false)) {
            transports.push(new winston.transports.Console());
        }

        if (!config.get<boolean>('app.log.fileEnabled', true)) {
            return transports;
        }

        const logFilePath = AppLogger.resolveLogFilePath();

        try {
            fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
            transports.push(
                new DailyRotateFile({
                    filename: AppLogger.resolveRotatedLogFilePath(logFilePath),
                    datePattern: 'YYYY-MM-DD',
                    maxSize: AppLogger.resolveMaxSizeBytes(),
                    maxFiles: AppLogger.resolveRetentionPolicy(),
                    zippedArchive: AppLogger.resolveZippedArchive(),
                    createSymlink: AppLogger.resolveCreateSymlink(),
                    symlinkName: AppLogger.resolveSymlinkName(logFilePath)
                })
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`Failed to initialize file logging at ${logFilePath}: ${message}\n`);
        }

        return transports;
    }

    private static resolveLogFilePath(): string {
        const configuredPath = process.env.APP_LOG_FILE_PATH?.trim();
        return configuredPath ? path.resolve(configuredPath) : AppLogger.defaultLogFilePath;
    }

    private static resolveRotatedLogFilePath(logFilePath: string): string {
        const parsedPath = path.parse(logFilePath);
        const rotatedBaseName = parsedPath.ext
            ? `${parsedPath.name}-%DATE%${parsedPath.ext}`
            : `${parsedPath.base}-%DATE%`;

        return path.join(parsedPath.dir, rotatedBaseName);
    }

    private static resolveMaxSizeBytes(): number {
        return AppLogger.parsePositiveInteger(
            process.env.APP_LOG_MAX_SIZE_BYTES,
            AppLogger.defaultMaxSizeBytes
        );
    }

    private static resolveRetentionPolicy(): string | number {
        const retentionDays = AppLogger.parsePositiveInteger(
            process.env.APP_LOG_RETENTION_DAYS,
            AppLogger.defaultRetentionDays
        );

        return `${retentionDays}d`;
    }

    private static resolveZippedArchive(): boolean {
        return AppLogger.parseBoolean(
            process.env.APP_LOG_ZIPPED_ARCHIVE,
            AppLogger.defaultZippedArchive
        );
    }

    private static resolveCreateSymlink(): boolean {
        return AppLogger.parseBoolean(
            process.env.APP_LOG_CREATE_SYMLINK,
            AppLogger.defaultCreateSymlink
        );
    }

    private static resolveSymlinkName(logFilePath: string): string {
        const configuredName = process.env.APP_LOG_SYMLINK_NAME?.trim();
        if (configuredName) {
            return configuredName;
        }

        const parsedPath = path.parse(logFilePath);
        return parsedPath.ext
            ? `${parsedPath.name}-current${parsedPath.ext}`
            : `${parsedPath.base}-current.log`;
    }

    private static parsePositiveInteger(value: string | undefined, fallbackValue: number): number {
        const parsedValue = Number.parseInt(value?.trim() || '', 10);
        return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
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

    debug(message: string, meta?: unknown): void {
        this.winstonLogger.debug(message, meta);
    }

    info(message: string, meta?: unknown): void {
        this.winstonLogger.info(message, meta);
    }

    warn(message: string, meta?: unknown): void {
        this.winstonLogger.warn(message, meta);
    }

    error(message: string, meta?: unknown): void {
        this.winstonLogger.error(message, meta);
    }
}

export { AppLogger as Logger };