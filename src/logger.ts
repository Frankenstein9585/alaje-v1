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
});

export type Logger = pino.Logger;
