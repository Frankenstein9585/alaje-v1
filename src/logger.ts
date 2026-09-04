import pino from 'pino';

/**
 * Structured logging is a Phase 1 requirement, not a nicety: the prior system's
 * worst bugs (phone-format mismatch, duplicate external codes) were only
 * diagnosable from real request data. Every log line that touches a message
 * carries business_id and wa_message_id so a repro needs no debug patch.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', 'headers.authorization', '*.WHATSAPP_TOKEN'],
    remove: true,
  },
  // Readable output while developing and demoing; raw JSON in production so
  // logs stay machine-parseable.
  ...(process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT === 'json'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
            messageFormat: '{msg}',
            singleLine: false,
          },
        },
      }),
});

export type Logger = pino.Logger;

/**
 * Last 4 digits only. Enough to tell two testers apart in a log without
 * printing a customer's full number every line.
 */
export function maskNumber(number: string): string {
  return number.length <= 4 ? number : `***${number.slice(-4)}`;
}
