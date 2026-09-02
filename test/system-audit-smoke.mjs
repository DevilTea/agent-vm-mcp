import assert from 'node:assert/strict';

import { collectSystemAudit } from '../src/system-audit.js';

function result(stdout = '', { ok = true, code = 0, stderr = '' } = {}) {
  return { ok, code, timedOut: false, error: null, stdout, stderr };
}

const calls = [];
const deps = {
  now: () => new Date('2026-09-02T00:00:00.000Z'),
  findExecutable: async (name) => (name === 'future-cli' ? '/fake/future-cli' : null),
  listExecutables: async (directory) =>
    directory === '/fake/local-bin'
      ? [{ name: 'future-direct', path: '/fake/local-bin/future-direct' }]
      : [],
  readFile: async () => {
    throw new Error('fixture unexpectedly read a file');
  },
  fetchJson: async () => {
    throw new Error('fixture unexpectedly used the network');
  },
  runCommand: async (command, args) => {
    calls.push([command, ...args]);
    if (command === '/fake/future-cli' && args[0] === '--version') {
      return result('future-cli 3.0.0\n');
    }
    if (command === 'mise' && args.join(' ') === 'ls --json') {
      return result(JSON.stringify({
        'future-mise': [
          {
            version: '1.2.3',
            requested_version: '1.2.3',
            install_path: '/fake/mise/future-mise/1.2.3',
            installed: true,
            active: true,
          },
        ],
      }));
    }
    if (command === 'mise' && args.join(' ') === 'latest future-mise') {
      return result('1.2.4\n');
    }
    if (command === 'npm' && args.join(' ') === 'ls -g --depth=0 --json') {
      return result(JSON.stringify({
        dependencies: {
          'future-npm': { version: '2.0.0' },
        },
      }));
    }
    if (command === 'npm' && args.join(' ') === 'view future-npm version --json') {
      return result('"2.1.0"\n');
    }
    if (command === 'apt' && args.join(' ') === 'list --upgradable') {
      return result('Listing...\n');
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  },
};

const audit = await collectSystemAudit({
  checkLatest: true,
  home: '/fake/home',
  config: {
    version: 1,
    directExecutableDirs: ['/fake/local-bin'],
    aliases: {},
    latestSources: {},
    installations: [],
    services: [],
    repositories: [],
    projects: [],
    coverage: { managedElsewhere: {} },
  },
  capabilitiesConfig: {
    version: 1,
    commands: [
      {
        name: 'future-cli',
        category: 'build',
        summary: 'A newly-added curated tool',
        versionArgs: ['--version'],
      },
    ],
    probes: [],
  },
  agentRuntime: { runtime: null, harnesses: [] },
  bridgeStatus: { bridges: [] },
  deps,
});

const byId = new Map(audit.inventory.map((item) => [item.id, item]));
for (const id of ['future-mise', 'future-npm', 'future-cli', 'future-direct']) {
  assert.ok(byId.has(id), `auto-discovery omitted ${id}`);
  assert.equal(byId.get(id).installed, true, `${id} should be installed`);
}

assert.equal(byId.get('future-mise').latestVersion, '1.2.4');
assert.equal(byId.get('future-mise').status, 'update');
assert.equal(byId.get('future-npm').latestVersion, '2.1.0');
assert.equal(byId.get('future-npm').status, 'update');
assert.equal(byId.get('future-cli').currentVersion, '3.0.0');
assert.equal(byId.get('future-cli').status, 'untracked');
assert.equal(byId.get('future-direct').status, 'untracked');

const untrackedIds = new Set(audit.coverage.untracked.map((item) => item.id));
assert.ok(untrackedIds.has('future-cli'), 'new curated CLI without source must be visibly untracked');
assert.ok(untrackedIds.has('future-direct'), 'new direct executable without source must be visibly untracked');
assert.equal(audit.coverage.untrackedCount, 2);
assert.equal(audit.coverage.updateSourceKnownCount, 2);
assert.equal(audit.summary.updates, 2);
assert.equal(audit.sourceErrors.length, 0);
assert.ok(calls.some((call) => call.join(' ') === 'mise latest future-mise'));
assert.ok(calls.some((call) => call.join(' ') === 'npm view future-npm version --json'));

console.log('PASS system audit future-tool coverage');

const failingDeps = {
  ...deps,
  runCommand: async (command, args, options) => {
    if (command === 'npm' && args.join(' ') === 'view future-npm version --json') {
      return result('', { ok: false, code: 1, stderr: 'registry unavailable' });
    }
    return deps.runCommand(command, args, options);
  },
};
const failSoftAudit = await collectSystemAudit({
  checkLatest: true,
  home: '/fake/home',
  config: {
    version: 1,
    directExecutableDirs: [],
    aliases: {},
    latestSources: {},
    installations: [],
    services: [],
    repositories: [],
    projects: [],
    coverage: { managedElsewhere: {} },
  },
  capabilitiesConfig: { version: 1, commands: [], probes: [] },
  agentRuntime: { runtime: null, harnesses: [] },
  bridgeStatus: { bridges: [] },
  deps: failingDeps,
});
assert.ok(
  failSoftAudit.sourceErrors.some((entry) => entry.source === 'latest:future-npm'),
  'latest-source failure must be reported without failing the entire audit',
);
assert.equal(
  failSoftAudit.inventory.find((item) => item.id === 'future-npm')?.status,
  'unknown',
  'failed latest lookup should leave the item visible as unknown',
);

console.log('PASS system audit fail-soft source handling');

let harnessProbeAttempted = false;
const harnessGuardAudit = await collectSystemAudit({
  checkLatest: false,
  home: '/fake/home',
  config: {
    version: 1,
    directExecutableDirs: [],
    aliases: {},
    latestSources: {},
    installations: [
      {
        id: 'agy-absolute-path-probe',
        kind: 'command',
        command: '/home/agent/.local/bin/agy',
        args: ['--version'],
      },
    ],
    services: [],
    repositories: [],
    projects: [],
    coverage: { managedElsewhere: {} },
  },
  capabilitiesConfig: { version: 1, commands: [], probes: [] },
  agentRuntime: { runtime: null, harnesses: [] },
  bridgeStatus: { bridges: [] },
  deps: {
    ...deps,
    findExecutable: async () => {
      harnessProbeAttempted = true;
      return '/home/agent/.local/bin/agy';
    },
  },
});
assert.equal(harnessProbeAttempted, false, 'absolute-path coding harness probes must be rejected before PATH resolution');
assert.ok(
  harnessGuardAudit.sourceErrors.some(
    (entry) => entry.source === 'installation:agy-absolute-path-probe' && entry.error.includes('coding harness command'),
  ),
  'absolute-path coding harness installation must be rejected visibly',
);
console.log('PASS system audit coding-harness absolute-path guard');

const controller = new AbortController();
let cancellationSignalObserved = false;
const cancellationDeps = {
  ...deps,
  findExecutable: async () => null,
  listExecutables: async () => [],
  runCommand: async (_command, _args, options = {}) => {
    cancellationSignalObserved ||= options.signal === controller.signal;
    return await new Promise((resolve) => {
      if (options.signal?.aborted) {
        resolve(result('', { ok: false, code: null, stderr: 'aborted' }));
        return;
      }
      options.signal?.addEventListener(
        'abort',
        () => resolve(result('', { ok: false, code: null, stderr: 'aborted' })),
        { once: true },
      );
    });
  },
};
const cancellationAudit = collectSystemAudit({
  checkLatest: false,
  signal: controller.signal,
  home: '/fake/home',
  config: {
    version: 1,
    directExecutableDirs: [],
    aliases: {},
    latestSources: {},
    installations: [],
    services: [],
    repositories: [],
    projects: [],
    coverage: { managedElsewhere: {} },
  },
  capabilitiesConfig: { version: 1, commands: [], probes: [] },
  agentRuntime: { runtime: null, harnesses: [] },
  bridgeStatus: { bridges: [] },
  deps: cancellationDeps,
});
setTimeout(() => controller.abort(new Error('audit cancelled by test')), 10);
await assert.rejects(cancellationAudit, /audit cancelled by test/);
assert.equal(cancellationSignalObserved, true, 'MCP cancellation signal must reach audit command probes');
console.log('PASS system audit cancellation propagation');
