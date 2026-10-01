import { toolError } from './tool-errors.js';

const VERSION = 1;
const MAX_CURSOR_LENGTH = 1024;

export function encodeOpaqueCursor(kind, payload) {
  return Buffer.from(JSON.stringify({ v: VERSION, kind, ...payload }), 'utf8').toString('base64url');
}

export function decodeOpaqueCursor(cursor, kind) {
  if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH) {
    throw toolError('INVALID_CURSOR', `Invalid ${kind} cursor.`, { kind });
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw toolError('INVALID_CURSOR', `Invalid ${kind} cursor.`, { kind });
  }

  if (!decoded || typeof decoded !== 'object' || decoded.v !== VERSION || decoded.kind !== kind) {
    throw toolError('INVALID_CURSOR', `Invalid ${kind} cursor.`, { kind });
  }
  return decoded;
}

export function nonNegativeCursorOffset(value, field, kind) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw toolError('INVALID_CURSOR', `Invalid ${kind} cursor offset.`, { kind, field });
  }
  return value;
}
