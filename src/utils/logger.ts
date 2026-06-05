import winston from 'winston';
import { maskSensitiveData } from './maskSensitiveData.js';

// Custom format to mask sensitive data in logs
const maskSensitiveDataFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const maskedMessage = maskSensitiveData(message);
  const maskedMeta = maskSensitiveData(meta);
  
  const logEntry = {
    timestamp,
    level,
    message: maskedMessage,
    ...maskedMeta
  };
  
  return JSON.stringify(logEntry);
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'error',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    maskSensitiveDataFormat
  ),
  transports: [
    new winston.transports.File({ filename: '/dev/null', silent: true }),
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  ],
});