/**
 * Simple logger for the NocoDB MCP Server
 * Provides structured logging with different levels
 */

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    NONE = 4,
}

class Logger {
    private level: LogLevel;
    private enableDebug: boolean;

    constructor() {
        // Check for debug mode from environment
        this.enableDebug = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
        this.level = this.enableDebug ? LogLevel.DEBUG : LogLevel.INFO;
    }

    private formatMessage(level: string, message: string, meta?: Record<string, any>): string {
        const timestamp = new Date().toISOString();
        const metaStr = meta ? ` ${JSON.stringify(this.redactSensitive(meta))}` : '';
        return `[${timestamp}] [${level}] ${message}${metaStr}`;
    }

    /**
     * Redact sensitive information from logs
     */
    private redactSensitive(obj: any): any {
        if (typeof obj !== 'object' || obj === null) {
            return obj;
        }

        const sensitiveKeys = ['token', 'password', 'secret', 'api_token', 'xc-token', 'authorization'];
        const redacted = Array.isArray(obj) ? [...obj] : { ...obj };

        for (const key in redacted) {
            if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
                redacted[key] = '***REDACTED***';
            } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
                redacted[key] = this.redactSensitive(redacted[key]);
            }
        }

        return redacted;
    }

    debug(message: string, meta?: Record<string, any>): void {
        if (this.level <= LogLevel.DEBUG) {
            console.log(this.formatMessage('DEBUG', message, meta));
        }
    }

    info(message: string, meta?: Record<string, any>): void {
        if (this.level <= LogLevel.INFO) {
            console.log(this.formatMessage('INFO', message, meta));
        }
    }

    warn(message: string, meta?: Record<string, any>): void {
        if (this.level <= LogLevel.WARN) {
            console.warn(this.formatMessage('WARN', message, meta));
        }
    }

    error(message: string, meta?: Record<string, any>): void {
        if (this.level <= LogLevel.ERROR) {
            console.error(this.formatMessage('ERROR', message, meta));
        }
    }

    /**
     * Log API request
     */
    logRequest(method: string, url: string, params?: Record<string, any>): void {
        this.debug(`API Request: ${method} ${url}`, params);
    }

    /**
     * Log API response
     */
    logResponse(method: string, url: string, status: number, duration?: number): void {
        const meta: Record<string, any> = { status };
        if (duration !== undefined) {
            meta.duration = `${duration}ms`;
        }
        this.debug(`API Response: ${method} ${url}`, meta);
    }

    /**
     * Set log level dynamically
     */
    setLevel(level: LogLevel): void {
        this.level = level;
    }
}

// Export singleton instance
export const logger = new Logger();
