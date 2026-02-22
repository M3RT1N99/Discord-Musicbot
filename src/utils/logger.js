// src/utils/logger.js
// Winston logging configuration

const winston = require('winston');
const path = require('path');

// Define log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
        let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
        if (stack) log += `\n${stack}`;
        return log;
    })
);

// Create logger instance
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    transports: [
        // Console transport with colors
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        }),
        // File transport for errors
        // TIP: Use /tmp for LOG_DIR to avoid Windows/Host I/O lags during playback
        new winston.transports.File({
            filename: path.join(process.env.LOG_DIR || '/tmp', 'error.log'),
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        // File transport for all logs
        new winston.transports.File({
            filename: path.join(process.env.LOG_DIR || '/tmp', 'combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5
        })
    ]
});

// Export logger
module.exports = logger;
