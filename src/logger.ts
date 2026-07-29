import process from 'node:process';
import pino from 'pino';

function readLogLevel(): string {
  // biome-ignore lint/complexity/useLiteralKeys: Bracket access required by TS4111 (noPropertyAccessFromIndexSignature).
  return process.env['LOG_LEVEL'] ?? 'info';
}

export const logger = pino(
  {
    level: readLogLevel(),
    base: { app: 'slack-manager-ai-helper' },
  },
  pino.destination(2), // all logs should go to stderr
);

export type LogLevel = pino.Level;
