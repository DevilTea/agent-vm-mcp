import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as z from 'zod/v4';

import {
  INTERACTION_SCHEMA_VERSION,
  INTERACTION_STATUS_PENDING,
  INTERACTION_STATUS_SUBMITTED,
  interactionAnswerSchema,
  normalizeInteractionAnswers,
  normalizedInteractionRequestSchema,
} from './model.js';

const INTERACTION_STORE_VERSION = 1;

const interactionRecordSchema = z.object({
  interactionId: z.string().uuid(),
  request: normalizedInteractionRequestSchema,
  status: z.enum([INTERACTION_STATUS_PENDING, INTERACTION_STATUS_SUBMITTED]),
  answers: z.array(interactionAnswerSchema).nullable(),
  createdAt: z.string().datetime(),
  submittedAt: z.string().datetime().nullable(),
});

const interactionStoreFileSchema = z.object({
  version: z.literal(INTERACTION_STORE_VERSION),
  interactions: z.array(interactionRecordSchema).max(10_000),
});

function storeError(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

export function defaultInteractionStatePath(env = process.env) {
  if (env.AGENT_INTERACTION_STATE_PATH) return env.AGENT_INTERACTION_STATE_PATH;

  const stateDirectory = env.AGENT_STATE_DIR || path.join(
    env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state'),
    'agent-vm-mcp',
  );
  return path.join(stateDirectory, 'interactions.json');
}

function clone(value) {
  return structuredClone(value);
}

function stateFromRecord(record) {
  return {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    interactionId: record.interactionId,
    status: record.status,
    answers: record.answers === null ? null : clone(record.answers),
    submittedAt: record.submittedAt,
  };
}

function recordForPersistence(record) {
  return {
    interactionId: record.interactionId,
    request: clone(record.request),
    status: record.status,
    answers: record.answers === null ? null : clone(record.answers),
    createdAt: record.createdAt,
    submittedAt: record.submittedAt,
  };
}

export class InteractionStore {
  #statePath;
  #records = new Map();
  #mutationQueue = Promise.resolve();

  constructor({ statePath = defaultInteractionStatePath() } = {}) {
    this.#statePath = path.resolve(statePath);
  }

  static async open(options = {}) {
    const store = new InteractionStore(options);
    await store.#load();
    return store;
  }

  get statePath() {
    return this.#statePath;
  }

  async create(request) {
    return this.#enqueueMutation(async () => {
      const normalizedRequest = normalizedInteractionRequestSchema.parse(request);
      let interactionId;
      do {
        interactionId = randomUUID();
      } while (this.#records.has(interactionId));

      const record = {
        interactionId,
        request: normalizedRequest,
        status: INTERACTION_STATUS_PENDING,
        answers: null,
        createdAt: new Date().toISOString(),
        submittedAt: null,
      };
      this.#records.set(interactionId, record);
      try {
        await this.#write();
      } catch (error) {
        this.#records.delete(interactionId);
        throw error;
      }
      return clone(record);
    });
  }

  async getState(interactionId) {
    return this.#enqueueMutation(async () => stateFromRecord(this.#record(interactionId)));
  }

  async submit(interactionId, answers) {
    return this.#enqueueMutation(async () => {
      const record = this.#record(interactionId);
      const normalizedAnswers = normalizeInteractionAnswers(record.request, answers);

      if (record.status === INTERACTION_STATUS_SUBMITTED) {
        if (JSON.stringify(record.answers) === JSON.stringify(normalizedAnswers)) {
          return { ...stateFromRecord(record), submission: 'duplicate' };
        }
        throw storeError(
          'interaction_already_submitted',
          `Interaction ${interactionId} has already been submitted with different answers.`,
        );
      }

      const previous = clone(record);
      record.status = INTERACTION_STATUS_SUBMITTED;
      record.answers = normalizedAnswers;
      record.submittedAt = new Date().toISOString();
      try {
        await this.#write();
      } catch (error) {
        this.#records.set(interactionId, previous);
        throw error;
      }
      return { ...stateFromRecord(record), submission: 'created' };
    });
  }

  async close() {
    await this.#mutationQueue;
  }

  #record(interactionId) {
    const record = this.#records.get(interactionId);
    if (!record) {
      throw storeError('interaction_not_found', `Unknown interactionId: ${interactionId}.`);
    }
    return record;
  }

  #enqueueMutation(operation) {
    const task = this.#mutationQueue.then(operation);
    this.#mutationQueue = task.catch(() => {});
    return task;
  }

  async #load() {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.#statePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw storeError('interaction_state_unreadable', `Unable to read durable interaction state: ${error.message}`, error);
    }

    const result = interactionStoreFileSchema.safeParse(parsed);
    if (!result.success) {
      throw storeError(
        'interaction_state_unreadable',
        `Unable to read durable interaction state: ${result.error.issues[0]?.message ?? 'unsupported format.'}`,
      );
    }

    for (const persisted of result.data.interactions) {
      if (this.#records.has(persisted.interactionId)) {
        throw storeError('interaction_state_unreadable', `Duplicate interactionId in durable state: ${persisted.interactionId}.`);
      }
      if (
        (persisted.status === INTERACTION_STATUS_PENDING && (persisted.answers !== null || persisted.submittedAt !== null)) ||
        (persisted.status === INTERACTION_STATUS_SUBMITTED && (persisted.answers === null || persisted.submittedAt === null))
      ) {
        throw storeError('interaction_state_unreadable', `Inconsistent durable state for interaction ${persisted.interactionId}.`);
      }

      const answers = persisted.status === INTERACTION_STATUS_SUBMITTED
        ? normalizeInteractionAnswers(persisted.request, persisted.answers)
        : null;
      this.#records.set(persisted.interactionId, {
        ...persisted,
        request: clone(persisted.request),
        answers,
      });
    }
  }

  async #write() {
    const directory = path.dirname(this.#statePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#statePath}.tmp-${process.pid}-${randomUUID()}`;
    const data = {
      version: INTERACTION_STORE_VERSION,
      interactions: [...this.#records.values()].map(recordForPersistence),
    };

    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.#statePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw storeError('interaction_state_unwritable', `Unable to write durable interaction state: ${error.message}`, error);
    }
  }
}

export { stateFromRecord };
