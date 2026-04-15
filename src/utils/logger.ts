import winston from 'winston';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';

const LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    verbose: 4,
};

const COLORS: Record<string, (s: string) => string> = {
    error: chalk.red,
    warn: chalk.yellow,
    info: chalk.cyan,
    debug: chalk.gray,
    verbose: chalk.magenta,
};

const ICONS: Record<string, string> = {
    error: '✖',
    warn: '⚠',
    info: '●',
    debug: '○',
    verbose: '◌',
};

function consoleFormat(): winston.Logform.Format {
    return winston.format.printf(({ level, message, timestamp, ...meta }: winston.Logform.TransformableInfo) => {
        const icon = ICONS[level] ?? '·';
        const color = COLORS[level] ?? ((s: string) => s);
        const ts = chalk.gray(new Date(timestamp as string).toLocaleTimeString());
        const prefix = color(`${icon} [${level.toUpperCase()}]`);
        const msg = typeof message === 'string' ? message : JSON.stringify(message);
        
        // Hide technical metadata from normal people unless they are in DEBUG mode
        let metaStr = '';
        if (process.env['COS_DEBUG'] === 'true' || process.env['COS_LOG_LEVEL'] === 'debug') {
            metaStr = Object.keys(meta).length > 0 ? chalk.gray(' ' + JSON.stringify(meta)) : '';
        }
        
        return `${ts} ${prefix} ${msg}${metaStr}`;
    });
}

let loggerInstance: winston.Logger | null = null;

export function createLogger(logDir: string, level: string = 'info'): winston.Logger {
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    const transports: winston.transport[] = [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp(),
                consoleFormat()
            ),
        }),
        new winston.transports.File({
            filename: path.join(logDir, 'cos-error.log'),
            level: 'error',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5,
        }),
        new winston.transports.File({
            filename: path.join(logDir, 'cos.log'),
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            maxsize: 50 * 1024 * 1024,
            maxFiles: 10,
        }),
    ];

    loggerInstance = winston.createLogger({
        levels: LEVELS,
        level,
        transports,
        exitOnError: false,
    });

    return loggerInstance;
}

export function getLogger(): winston.Logger {
    if (!loggerInstance) {
        loggerInstance = winston.createLogger({
            levels: LEVELS,
            level: process.env['COS_LOG_LEVEL'] ?? 'info',
            transports: [
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.timestamp(),
                        consoleFormat()
                    ),
                }),
            ],
        });
    }
    return loggerInstance;
}

export const logger = {
    error: (msg: string, meta?: Record<string, unknown>) => getLogger().error(msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => getLogger().warn(msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => getLogger().info(msg, meta),
    debug: (msg: string, meta?: Record<string, unknown>) => getLogger().debug(msg, meta),
    verbose: (msg: string, meta?: Record<string, unknown>) => getLogger().verbose(msg, meta),
    
    /**
     * Diagnostic reporting helpers
     */
    reportBug: (bugType: 'error' | 'warning', message: string, context?: Record<string, unknown>) => {
        if (bugType === 'error') {
            logger.error(`[DIAGNOSTIC ERROR] ${message}`, context);
        } else {
            logger.warn(`[DIAGNOSTIC WARNING] ${message}`, context);
        }
    },

    reportSuccess: (message: string) => {
        logger.info(`[DIAGNOSTIC SUCCESS] ${message}`);
    }
};