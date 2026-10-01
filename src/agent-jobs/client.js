import http from 'node:http';
import { socketPath } from './store.js';
import { decodeOpaqueCursor, encodeOpaqueCursor, nonNegativeCursorOffset } from '../opaque-cursor.js';
import { toolError } from '../tool-errors.js';

const POLL_CURSOR_KIND = 'agent_poll';
const POLL_OFFSET_FIELDS = ['stdoutOffset', 'stderrOffset', 'eventOffset', 'invalidLineOffset'];

function request(method, endpoint, payload, signal, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : JSON.stringify(payload);
    const req = http.request({
      socketPath: socketPath(),
      path: endpoint,
      method,
      timeout: timeoutMs,
      headers: body == null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      signal,
    }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) {
          req.destroy(new Error('Job manager response exceeded 2 MiB'));
        } else chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400) {
            const error = new Error(data.message || 'Job manager request failed');
            error.code = data.error || 'agent_job_error';
            reject(error);
          } else resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Job manager request timed out')));
    req.on('error', (error) => {
      if (['ENOENT','ECONNREFUSED'].includes(error.code)) {
        const wrapped = new Error(
          'Agent background job service is unavailable. Verify agent-jobd.service before retrying. ' +
          'If this was an agent_start request whose response was lost, use the same idempotencyKey.'
        );
        wrapped.code = 'agent_job_service_unavailable';
        reject(wrapped);
      } else reject(error);
    });
    req.end(body);
  });
}

function query(args) {
  const value = new URLSearchParams();
  for (const [key, entry] of Object.entries(args)) {
    if (entry !== undefined && entry !== null) value.set(key, String(entry));
  }
  return value.toString();
}

export function jobHealth(signal) {
  return request('GET', '/health', null, signal);
}

export function jobStart(args, signal) {
  return request('POST', '/jobs', args, signal);
}

export function jobList({ cwd, limit = 64 } = {}, signal) {
  return request('GET', '/jobs?' + query({ cwd, limit }), null, signal);
}

export async function jobPoll({ runId, cursor, ...options }, signal) {
  const hasExplicitOffsets = POLL_OFFSET_FIELDS.some((field) => options[field] !== undefined);
  if (cursor !== undefined && hasExplicitOffsets) {
    throw toolError(
      'CURSOR_OFFSET_CONFLICT',
      'agent_poll cursor cannot be combined with explicit stream offsets.',
      { fields: POLL_OFFSET_FIELDS.filter((field) => options[field] !== undefined) },
    );
  }

  let offsets = {};
  if (cursor !== undefined) {
    const decoded = decodeOpaqueCursor(cursor, POLL_CURSOR_KIND);
    if (decoded.runId !== runId) {
      throw toolError('CURSOR_TARGET_MISMATCH', 'agent_poll cursor belongs to a different run.', {
        expectedRunId: runId,
        cursorRunId: decoded.runId ?? null,
      });
    }
    offsets = Object.fromEntries(POLL_OFFSET_FIELDS.map((field) => [
      field,
      nonNegativeCursorOffset(decoded[field], field, POLL_CURSOR_KIND),
    ]));
  } else {
    offsets = Object.fromEntries(POLL_OFFSET_FIELDS
      .filter((field) => options[field] !== undefined)
      .map((field) => [field, options[field]]));
  }

  // Long polling is capped at 15 seconds; leave a small transport margin.
  const result = await request(
    'GET',
    '/jobs/' + runId + '/poll?' + query({ ...offsets, waitMs: options.waitMs }),
    null,
    signal,
    Math.min(20_000, (options.waitMs ?? 10_000) + 5000),
  );
  return {
    ...result,
    cursor: encodeOpaqueCursor(POLL_CURSOR_KIND, {
      runId,
      stdoutOffset: result.stdout.nextOffset,
      stderrOffset: result.stderr.nextOffset,
      eventOffset: result.structured.events.nextOffset,
      invalidLineOffset: result.structured.invalidLines.nextOffset,
    }),
  };
}

export function jobResult({ runId }, signal) {
  return request('GET', '/jobs/' + runId + '/result', null, signal);
}

export function jobCancel({ runId }, signal) {
  return request('POST', '/jobs/' + runId + '/cancel', {}, signal);
}
