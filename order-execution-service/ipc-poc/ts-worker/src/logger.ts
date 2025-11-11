import { appendFileSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import bs58 from 'bs58';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_LOG_PATH = resolve(__dirname, '..', 'logs', 'ts-worker-debug.log');

function resolveLogPath(): string {
  const envPath = process.env.WORKER_LOG_PATH;
  if (!envPath) {
    return DEFAULT_LOG_PATH;
  }
  return isAbsolute(envPath) ? envPath : resolve(WORKSPACE_ROOT, envPath);
}

const LOG_PATH = resolveLogPath();
let logReady = false;

function serialize(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (val && typeof val === 'object') {
          if (typeof (val as any).toJSON === 'function') {
            return (val as any).toJSON();
          }
          if (typeof (val as any).toBase58 === 'function') {
            return (val as any).toBase58();
          }
          if (typeof (val as any).toString === 'function' && (val as any).toString !== Object.prototype.toString) {
            return (val as any).toString();
          }
        }
        return val;
      },
    );
  } catch (err) {
    return `[unserializable:${(err as Error).message}]`;
  }
}

export function debugLog(message: string, payload?: unknown) {
  try {
    if (!logReady) {
      mkdirSync(dirname(LOG_PATH), { recursive: true });
      logReady = true;
    }
    const ts = new Date().toISOString();
    const line = payload === undefined ? message : `${message} ${serialize(payload)}`;
    appendFileSync(LOG_PATH, `[${ts}] ${line}\n`);
  } catch (err) {
    // Swallow logging errors to avoid crashing the worker.
  }
}

function isValidBase58(str: string): boolean {
  try {
    bs58.decode(str);
    return true;
  } catch {
    return false;
  }
}

export function decodeValuesInPayload(payload: unknown): unknown {
  if (typeof payload === 'string') {
    // Try to decode if it looks like a base58 string (Solana addresses are typically 32-44 chars)
    if (payload.length >= 32 && payload.length <= 44 && isValidBase58(payload)) {
      try {
        return Array.from(bs58.decode(payload));
      } catch {
        return payload;
      }
    }
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map(item => decodeValuesInPayload(item));
  }

  if (typeof payload === 'object' && payload !== null) {
    const result: Record<string, unknown> = {};
    for (const key in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        result[key] = decodeValuesInPayload((payload as Record<string, unknown>)[key]);
      }
    }
    return result;
  }

  return payload;
}

export function printPayload(filename: string, payload: unknown) {
  const timestamp = new Date().toISOString();
  const dumpDir = resolve(__dirname, '..', 'dumps');
  const decodedPayload = decodeValuesInPayload(payload);
  mkdirSync(dumpDir, { recursive: true });
  const dumpPath = resolve(dumpDir, filename + '_' + timestamp + '.json');
  appendFileSync(dumpPath, JSON.stringify(decodedPayload, null, 2));
}
