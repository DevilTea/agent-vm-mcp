import { access, readdir, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { resolveConfigPath } from './config-path.js';
const COMMAND_TIMEOUT_MS = 8_000;
const LATEST_LOOKUP_TIMEOUT_MS = 15_000;
const COMMAND_OUTPUT_LIMIT = 512 * 1024;
const LOOKUP_CONCURRENCY = 4;
const CODING_HARNESS_COMMANDS = new Set(['codex', 'agy', 'claude']);

function expandHome(value, home) {
  return value.replaceAll('@HOME@', home);
}

function firstNonEmptyLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function trimOutput(buffer) {
  if (buffer.length <= COMMAND_OUTPUT_LIMIT) return buffer;
  return buffer.subarray(0, COMMAND_OUTPUT_LIMIT);
}

function defaultRunCommand(command, args, options = {}) {
  if (options.signal?.aborted) {
    return Promise.resolve({
      ok: false,
      code: null,
      timedOut: false,
      aborted: true,
      error: 'aborted',
      stdout: '',
      stderr: '',
    });
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const append = (target, chunk) => trimOutput(Buffer.concat([target, chunk]));
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const finish = (code = null, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        ok: !timedOut && !aborted && error === null && code === 0,
        code,
        timedOut,
        aborted,
        error: error?.message ?? null,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    timer.unref();

    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
  });
}

async function defaultFetchJson(url, options = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? COMMAND_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetch(url, {
      headers: options.headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function defaultFindExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function defaultListExecutables(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || /(?:\.old(?:\.|$)|\.bak$|\.tmp$|~$)/.test(entry.name)) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const candidate = path.join(directory, entry.name);
    try {
      await access(candidate, fsConstants.X_OK);
      result.push({ name: entry.name, path: candidate });
    } catch {
      // Non-executable files are not tool candidates.
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function defaultDeps() {
  return {
    runCommand: defaultRunCommand,
    fetchJson: defaultFetchJson,
    findExecutable: defaultFindExecutable,
    listExecutables: defaultListExecutables,
    readFile,
    now: () => new Date(),
  };
}

function validateConfig(config) {
  if (!config || config.version !== 1) throw new Error('system-audit config must have version 1');
  for (const key of ['directExecutableDirs', 'installations', 'services', 'repositories', 'projects']) {
    if (config[key] !== undefined && !Array.isArray(config[key])) {
      throw new Error(`system-audit config ${key} must be an array`);
    }
  }
  if (config.aliases !== undefined && (typeof config.aliases !== 'object' || Array.isArray(config.aliases))) {
    throw new Error('system-audit config aliases must be an object');
  }
  if (config.latestSources !== undefined && (typeof config.latestSources !== 'object' || Array.isArray(config.latestSources))) {
    throw new Error('system-audit config latestSources must be an object');
  }
  return config;
}

async function loadJsonFile(filePath, deps) {
  return JSON.parse(await deps.readFile(filePath, 'utf8'));
}

function canonicalId(rawId, config) {
  return config.aliases?.[rawId] ?? rawId;
}

function extractVersion(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = text.match(/(?:^|[^0-9])v?(\d+\.\d+(?:\.\d+)?(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? (text || null);
}

function normalizeVersion(value, source = {}) {
  let result = String(value ?? '').trim();
  if (source.stripPrefix && result.startsWith(source.stripPrefix)) {
    result = result.slice(source.stripPrefix.length);
  }
  return (extractVersion(result) ?? result) || null;
}

function parseVersionParts(value) {
  const normalized = extractVersion(value);
  if (!normalized) return null;
  const match = normalized.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    numbers: [match[1], match[2], match[3] ?? '0', match[4] ?? '0'].map(Number),
    prerelease: match[5] ?? null,
  };
}

function compareVersions(current, latest) {
  const a = parseVersionParts(current);
  const b = parseVersionParts(latest);
  if (!a || !b) return String(current) === String(latest) ? 0 : null;
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function versionChangeKind(current, latest) {
  const a = parseVersionParts(current);
  const b = parseVersionParts(latest);
  if (!a || !b) return null;
  if (a.numbers[0] !== b.numbers[0]) return 'major';
  if (a.numbers[1] !== b.numbers[1]) return 'minor';
  if (a.numbers[2] !== b.numbers[2] || a.numbers[3] !== b.numbers[3] || a.prerelease !== b.prerelease) return 'patch';
  return 'none';
}

function systemManagedPath(executablePath) {
  return ['/usr/bin/', '/bin/', '/usr/sbin/', '/sbin/'].some((prefix) => executablePath?.startsWith(prefix));
}

function provenanceKey(value) {
  return JSON.stringify(value);
}

function ensureItem(inventory, rawId, config) {
  const id = canonicalId(rawId, config);
  if (!inventory.has(id)) {
    inventory.set(id, {
      id,
      installed: false,
      available: null,
      currentVersion: null,
      resolvedVersion: null,
      resolvedPath: null,
      installedVersions: [],
      activeVersion: null,
      requestedVersion: null,
      paths: [],
      categories: [],
      provenance: [],
      updateSource: null,
      updateSourceOrigin: null,
      managedBy: null,
      latestVersion: null,
      updateAvailable: null,
      changeKind: null,
      status: 'unknown',
      lookupError: null,
      versionMismatch: null,
    });
  }
  return inventory.get(id);
}

function pushUnique(array, value, key = (entry) => entry) {
  const candidate = key(value);
  if (!array.some((entry) => key(entry) === candidate)) array.push(value);
}

function addProvenance(item, value) {
  pushUnique(item.provenance, value, provenanceKey);
}

function addVersion(item, value) {
  const version = extractVersion(value);
  if (!version) return;
  pushUnique(item.installedVersions, version);
  if (!item.currentVersion) item.currentVersion = version;
}

function setSource(item, source, origin, { override = false } = {}) {
  if (!source || (item.updateSource && !override)) return;
  item.updateSource = { ...source };
  item.updateSourceOrigin = origin;
}

async function discoverCurated({ inventory, config, capabilitiesConfig, agentRuntime, deps, sourceErrors }) {
  const harnesses = new Map((agentRuntime?.harnesses ?? []).map((entry) => [entry.kind, entry]));
  for (const definition of capabilitiesConfig.commands ?? []) {
    const item = ensureItem(inventory, definition.name, config);
    pushUnique(item.categories, definition.category ?? 'other');
    addProvenance(item, { kind: 'curated-cli', name: definition.name });

    let executable = null;
    let version = null;
    if (definition.category === 'agent-harness') {
      const harness = harnesses.get(definition.name);
      executable = harness?.path ?? null;
      version = harness?.version ?? null;
      item.available = harness?.available ?? false;
    } else {
      executable = await deps.findExecutable(definition.name);
      item.available = executable !== null;
      if (executable && Array.isArray(definition.versionArgs)) {
        const result = await deps.runCommand(executable, definition.versionArgs, { timeoutMs: 2_000 });
        if (result.stdout || result.stderr) version = firstNonEmptyLine(`${result.stdout}\n${result.stderr}`);
      }
    }

    if (executable) {
      pushUnique(item.paths, executable);
      item.resolvedPath ??= executable;
    }
    if (item.available) item.installed = true;
    const resolvedVersion = extractVersion(version);
    if (resolvedVersion) item.resolvedVersion ??= resolvedVersion;
    addVersion(item, version);
    if (!item.updateSource && systemManagedPath(executable)) item.managedBy = 'apt/system';
  }
}

async function discoverMise({ inventory, config, deps, sourceErrors }) {
  const result = await deps.runCommand('mise', ['ls', '--json']);
  if (!result.ok) {
    sourceErrors.push({ source: 'mise:list', error: (result.error ?? result.stderr.trim()) || `exit ${result.code}` });
    return;
  }
  const parsed = safeJsonParse(result.stdout);
  if (!parsed || typeof parsed !== 'object') {
    sourceErrors.push({ source: 'mise:list', error: 'invalid JSON output' });
    return;
  }

  for (const [tool, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries)) continue;
    const item = ensureItem(inventory, tool, config);
    const installedEntries = entries.filter((entry) => entry?.installed !== false);
    if (installedEntries.length === 0) continue;
    item.installed = true;
    item.available ??= true;
    for (const entry of installedEntries) {
      addVersion(item, entry.version);
      if (entry.install_path) pushUnique(item.paths, entry.install_path);
      addProvenance(item, {
        kind: 'mise',
        tool,
        version: entry.version ?? null,
        active: entry.active === true,
        requestedVersion: entry.requested_version ?? null,
      });
      if (entry.active) {
        item.activeVersion = extractVersion(entry.version);
        item.currentVersion ??= item.activeVersion;
      }
      if (entry.requested_version) item.requestedVersion = extractVersion(entry.requested_version) ?? entry.requested_version;
    }
    if (!item.currentVersion) item.currentVersion = item.requestedVersion ?? item.installedVersions[0] ?? null;
    if (item.resolvedVersion && item.activeVersion && item.resolvedVersion !== item.activeVersion) {
      item.versionMismatch = {
        configuredVersion: item.requestedVersion ?? item.activeVersion,
        activeVersion: item.activeVersion,
        resolvedVersion: item.resolvedVersion,
        resolvedPath: item.resolvedPath,
      };
    }
    if (tool.startsWith('npm:')) {
      setSource(item, { kind: 'npm', package: tool.slice(4) }, 'inferred:mise-npm');
    } else {
      setSource(item, { kind: 'mise', tool }, 'inferred:mise');
    }
  }
}

async function discoverGlobalNpm({ inventory, config, deps, sourceErrors, home }) {
  const result = await deps.runCommand('npm', ['ls', '-g', '--depth=0', '--json'], { cwd: home || undefined });
  const parsed = safeJsonParse(result.stdout);
  if (!parsed || typeof parsed.dependencies !== 'object') {
    sourceErrors.push({ source: 'npm:global-list', error: (result.error ?? result.stderr.trim()) || 'invalid JSON output' });
    return;
  }
  for (const [packageName, metadata] of Object.entries(parsed.dependencies)) {
    const item = ensureItem(inventory, packageName, config);
    item.installed = true;
    item.available ??= true;
    addVersion(item, metadata?.version);
    addProvenance(item, { kind: 'npm-global', package: packageName, version: metadata?.version ?? null });
    setSource(item, { kind: 'npm', package: packageName }, 'inferred:npm-global');
  }
}

async function discoverDirectExecutables({ inventory, config, deps, sourceErrors, home }) {
  for (const rawDirectory of config.directExecutableDirs ?? []) {
    const directory = expandHome(rawDirectory, home);
    try {
      const entries = await deps.listExecutables(directory);
      for (const entry of entries) {
        const item = ensureItem(inventory, entry.name, config);
        item.installed = true;
        item.available ??= true;
        pushUnique(item.paths, entry.path);
        addProvenance(item, { kind: 'direct-executable', directory, name: entry.name });
      }
    } catch (error) {
      sourceErrors.push({ source: `direct:${directory}`, error: error.message });
    }
  }
}

async function discoverInstallations({ inventory, config, deps, sourceErrors }) {
  for (const installation of config.installations ?? []) {
    try {
      if (installation.kind === 'npm-project') {
        const packagePath = path.join(installation.root, 'node_modules', installation.package, 'package.json');
        const metadata = JSON.parse(await deps.readFile(packagePath, 'utf8'));
        const item = ensureItem(inventory, installation.id, config);
        item.installed = true;
        item.available ??= true;
        addVersion(item, metadata.version);
        addProvenance(item, {
          kind: 'npm-project',
          root: installation.root,
          package: installation.package,
          version: metadata.version ?? null,
        });
        setSource(item, { kind: 'npm', package: installation.package }, 'inferred:npm-project');
        if (installation.managedBy) item.managedBy = installation.managedBy;
        continue;
      }

      if (installation.kind === 'command') {
        if (CODING_HARNESS_COMMANDS.has(path.basename(installation.command))) {
          sourceErrors.push({
            source: `installation:${installation.id}`,
            error: `coding harness command ${installation.command} is not allowed as a system-audit command probe`,
          });
          continue;
        }
        const executable = await deps.findExecutable(installation.command);
        const item = ensureItem(inventory, installation.id, config);
        item.available = executable !== null;
        if (!executable) continue;
        item.installed = true;
        pushUnique(item.paths, executable);
        const result = await deps.runCommand(executable, installation.args ?? ['--version'], { timeoutMs: 2_000 });
        const versionLine = firstNonEmptyLine(`${result.stdout}
${result.stderr}`);
        addVersion(item, versionLine);
        addProvenance(item, {
          kind: 'command-installation',
          command: installation.command,
          args: installation.args ?? ['--version'],
          path: executable,
        });
        if (installation.managedBy) item.managedBy = installation.managedBy;
        continue;
      }

      sourceErrors.push({ source: `installation:${installation.id}`, error: `unsupported kind ${installation.kind}` });
    } catch (error) {
      if (error?.code !== 'ENOENT') sourceErrors.push({ source: `installation:${installation.id}`, error: error.message });
    }
  }
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveLatest(item, deps, home) {
  const source = item.updateSource;
  if (!source) return null;
  if (source.kind === 'npm') {
    const result = await deps.runCommand('npm', ['view', source.package, 'version', '--json'], { cwd: home || undefined, timeoutMs: LATEST_LOOKUP_TIMEOUT_MS });
    if (!result.ok) throw new Error(result.timedOut ? 'npm view timed out' : ((result.error ?? result.stderr.trim()) || `npm view exited ${result.code}`));
    const parsed = safeJsonParse(result.stdout);
    return normalizeVersion(typeof parsed === 'string' ? parsed : firstNonEmptyLine(result.stdout), source);
  }
  if (source.kind === 'mise') {
    const result = await deps.runCommand('mise', ['latest', source.tool], { timeoutMs: LATEST_LOOKUP_TIMEOUT_MS });
    if (!result.ok) throw new Error(result.timedOut ? 'mise latest timed out' : ((result.error ?? result.stderr.trim()) || `mise latest exited ${result.code}`));
    return normalizeVersion(firstNonEmptyLine(result.stdout), source);
  }
  if (source.kind === 'github-release') {
    const metadata = await deps.fetchJson(`https://api.github.com/repos/${source.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-vm-mcp-system-audit' },
      timeoutMs: LATEST_LOOKUP_TIMEOUT_MS,
    });
    return normalizeVersion(metadata.tag_name ?? metadata.name, source);
  }
  throw new Error(`unsupported update source kind ${source.kind}`);
}

function finalizeInventory({ inventory, config, checkLatest }) {
  const managedElsewhere = config.coverage?.managedElsewhere ?? {};
  for (const item of inventory.values()) {
    if (managedElsewhere[item.id]) item.managedBy ??= 'configured-managed-elsewhere';
    if (!item.installed) {
      item.status = 'unavailable';
      continue;
    }
    if (item.versionMismatch) {
      item.status = 'mismatch';
      continue;
    }
    if (!item.updateSource) {
      item.status = item.managedBy ? 'managed' : 'untracked';
      continue;
    }
    if (!checkLatest) {
      item.status = 'unchecked';
      continue;
    }
    if (item.lookupError || !item.latestVersion || !item.currentVersion) {
      item.status = 'unknown';
      continue;
    }
    const comparison = compareVersions(item.currentVersion, item.latestVersion);
    item.changeKind = versionChangeKind(item.currentVersion, item.latestVersion);
    if (comparison === null) {
      item.updateAvailable = item.currentVersion !== item.latestVersion;
    } else {
      item.updateAvailable = comparison < 0;
    }
    item.status = item.updateAvailable ? 'update' : 'current';
  }
}

async function inspectServices(config, deps, sourceErrors) {
  return await mapLimit(config.services ?? [], LOOKUP_CONCURRENCY, async (service) => {
    const result = await deps.runCommand('systemctl', [
      'show', service, '--no-page',
      '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'NRestarts',
    ]);
    if (!result.ok) {
      sourceErrors.push({ source: `service:${service}`, error: (result.error ?? result.stderr.trim()) || `exit ${result.code}` });
      return { id: service, healthy: null, error: result.stderr.trim() || result.error };
    }
    const fields = Object.fromEntries(result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
    return {
      id: service,
      loadState: fields.LoadState ?? null,
      activeState: fields.ActiveState ?? null,
      subState: fields.SubState ?? null,
      mainPid: Number(fields.MainPID ?? 0),
      restarts: Number(fields.NRestarts ?? 0),
      healthy: fields.LoadState === 'loaded' && fields.ActiveState === 'active' && fields.SubState === 'running',
    };
  });
}

function trackingRelation(stdout) {
  const line = firstNonEmptyLine(stdout);
  const match = line?.match(/^(\d+)\s+(\d+)$/);
  if (!match) throw new Error(`unexpected git rev-list --left-right --count output: ${line ?? '<empty>'}`);
  const ahead = Number(match[1]);
  const behind = Number(match[2]);
  let state = 'in_sync';
  if (ahead > 0 && behind > 0) state = 'diverged';
  else if (ahead > 0) state = 'ahead';
  else if (behind > 0) state = 'behind';
  return { state, ahead, behind };
}

async function inspectRepositories(config, deps, sourceErrors, checkLatest) {
  return await mapLimit(config.repositories ?? [], LOOKUP_CONCURRENCY, async (repo) => {
    const trackingRef = `refs/remotes/origin/${repo.branch}`;
    const [statusResult, headResult, trackingResult] = await Promise.all([
      deps.runCommand('git', ['-C', repo.path, 'status', '--short', '--branch']),
      deps.runCommand('git', ['-C', repo.path, 'rev-parse', 'HEAD']),
      deps.runCommand('git', ['-C', repo.path, 'rev-parse', trackingRef]),
    ]);
    const errors = [statusResult, headResult].filter((result) => !result.ok);
    if (errors.length > 0) {
      const error = errors.map((result) => result.error ?? result.stderr.trim()).filter(Boolean).join('; ');
      sourceErrors.push({ source: `repo:${repo.id}`, error });
      return { id: repo.id, path: repo.path, healthy: null, error };
    }

    const head = firstNonEmptyLine(headResult.stdout);
    const trackingHead = trackingResult.ok ? firstNonEmptyLine(trackingResult.stdout) : null;
    let tracking = {
      ref: trackingRef,
      head: trackingHead,
      state: null,
      ahead: null,
      behind: null,
    };
    if (trackingHead) {
      const relationResult = await deps.runCommand('git', [
        '-C', repo.path, 'rev-list', '--left-right', '--count', `HEAD...${trackingRef}`,
      ]);
      if (relationResult.ok) {
        try {
          tracking = { ...tracking, ...trackingRelation(relationResult.stdout) };
        } catch (error) {
          sourceErrors.push({ source: `repo-tracking:${repo.id}`, error: error.message });
        }
      } else {
        sourceErrors.push({
          source: `repo-tracking:${repo.id}`,
          error: (relationResult.error ?? relationResult.stderr.trim()) || `exit ${relationResult.code}`,
        });
      }
    }

    let remote = {
      checked: false,
      head: null,
      matchesHead: null,
      matchesTrackingHead: null,
      changedFromTracking: null,
    };
    if (checkLatest) {
      const remoteResult = await deps.runCommand('git', ['-C', repo.path, 'ls-remote', 'origin', `refs/heads/${repo.branch}`]);
      if (remoteResult.ok) {
        const remoteHead = firstNonEmptyLine(remoteResult.stdout)?.split(/\s+/)[0] ?? null;
        remote = {
          checked: true,
          head: remoteHead,
          matchesHead: remoteHead && head ? remoteHead === head : null,
          matchesTrackingHead: remoteHead && trackingHead ? remoteHead === trackingHead : null,
          changedFromTracking: remoteHead && trackingHead ? remoteHead !== trackingHead : null,
        };
      } else {
        const error = (remoteResult.error ?? remoteResult.stderr.trim()) || `exit ${remoteResult.code}`;
        sourceErrors.push({ source: `repo-remote:${repo.id}`, error });
        remote = { ...remote, checked: true, error };
      }
    }

    const statusLines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
    const dirty = statusLines.slice(1).length > 0;
    return {
      id: repo.id,
      path: repo.path,
      branch: repo.branch,
      head,
      tracking,
      remote,
      dirty,
      status: statusLines[0] ?? null,
    };
  });
}

function normalizeOutdatedPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return [];
  return Object.entries(payload).map(([name, value]) => ({ name, ...(value ?? {}) }));
}

async function inspectProjects(config, deps, sourceErrors) {
  return await mapLimit(config.projects ?? [], LOOKUP_CONCURRENCY, async (project) => {
    if (project.packageManager !== 'pnpm') {
      const error = `unsupported package manager ${project.packageManager}`;
      sourceErrors.push({ source: `project:${project.id}`, error });
      return { id: project.id, path: project.path, outdated: [], error };
    }
    const result = await deps.runCommand('pnpm', ['outdated', '--format', 'json'], { cwd: project.path });
    const stdout = result.stdout.trim();
    if (stdout) {
      const parsed = safeJsonParse(result.stdout);
      if (parsed === null) {
        const error = 'invalid pnpm outdated JSON output';
        sourceErrors.push({ source: `project:${project.id}`, error });
        return { id: project.id, path: project.path, packageManager: project.packageManager, outdated: [], error };
      }
      return {
        id: project.id,
        path: project.path,
        packageManager: project.packageManager,
        outdated: normalizeOutdatedPayload(parsed),
      };
    }
    if (!result.ok) {
      const error = (result.error ?? result.stderr.trim()) || `pnpm outdated failed with exit ${result.code}`;
      sourceErrors.push({ source: `project:${project.id}`, error });
      return { id: project.id, path: project.path, packageManager: project.packageManager, outdated: [], error };
    }
    return {
      id: project.id,
      path: project.path,
      packageManager: project.packageManager,
      outdated: [],
    };
  });
}

function parseAptUpgradable(text) {
  const packages = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith('Listing...')) continue;
    const match = line.match(/^([^/]+)\/\S+\s+(\S+)\s+(\S+)(?:\s+\[upgradable from: ([^\]]+)\])?/);
    if (!match) continue;
    packages.push({ name: match[1], candidate: match[2], arch: match[3], current: match[4] ?? null });
  }
  return packages;
}

async function inspectApt(deps, sourceErrors) {
  const result = await deps.runCommand('apt', ['list', '--upgradable']);
  if (!result.ok && !result.stdout.trim()) {
    sourceErrors.push({ source: 'apt:upgradable', error: (result.error ?? result.stderr.trim()) || `exit ${result.code}` });
    return { upgradable: [], error: result.stderr.trim() || result.error };
  }
  return { upgradable: parseAptUpgradable(result.stdout) };
}

function compactItem(item) {
  return {
    id: item.id,
    currentVersion: item.currentVersion,
    latestVersion: item.latestVersion,
    changeKind: item.changeKind,
    status: item.status,
    versionMismatch: item.versionMismatch,
  };
}

export async function collectSystemAudit(options = {}) {
  const baseDeps = { ...defaultDeps(), ...(options.deps ?? {}) };
  const signal = options.signal;
  const deps = {
    ...baseDeps,
    runCommand: async (command, args, commandOptions = {}) => {
      signal?.throwIfAborted();
      const result = await baseDeps.runCommand(command, args, {
        ...commandOptions,
        signal: commandOptions.signal ?? signal,
      });
      signal?.throwIfAborted();
      return result;
    },
    fetchJson: async (url, fetchOptions = {}) => {
      signal?.throwIfAborted();
      const result = await baseDeps.fetchJson(url, {
        ...fetchOptions,
        signal: fetchOptions.signal ?? signal,
      });
      signal?.throwIfAborted();
      return result;
    },
  };
  signal?.throwIfAborted();
  const checkLatest = options.checkLatest !== false;
  const home = options.home ?? process.env.HOME ?? '';
  const configPath = await resolveConfigPath({
    filename: 'system-audit.json',
    envName: 'AGENT_MCP_SYSTEM_AUDIT_CONFIG',
    explicitPath: options.configPath,
  });
  const config = validateConfig(options.config ?? await loadJsonFile(configPath, deps));
  const capabilitiesPath = expandHome(
    await resolveConfigPath({
      filename: 'capabilities.json',
      explicitPath:
        options.capabilitiesPath ??
        process.env.AGENT_MCP_CAPABILITIES_CONFIG ??
        config.capabilitiesPath,
    }),
    home,
  );
  const capabilitiesConfig = options.capabilitiesConfig ?? await loadJsonFile(capabilitiesPath, deps);
  const sourceErrors = [];
  const inventory = new Map();

  await discoverCurated({ inventory, config, capabilitiesConfig, agentRuntime: options.agentRuntime, deps, sourceErrors });
  await Promise.all([
    discoverMise({ inventory, config, deps, sourceErrors }),
    discoverGlobalNpm({ inventory, config, deps, sourceErrors, home }),
    discoverDirectExecutables({ inventory, config, deps, sourceErrors, home }),
    discoverInstallations({ inventory, config, deps, sourceErrors }),
  ]);
  signal?.throwIfAborted();

  for (const [id, source] of Object.entries(config.latestSources ?? {})) {
    const item = ensureItem(inventory, id, config);
    setSource(item, source, 'config', { override: true });
  }

  if (checkLatest) {
    const candidates = [...inventory.values()].filter((item) => item.installed && item.updateSource);
    await mapLimit(candidates, LOOKUP_CONCURRENCY, async (item) => {
      try {
        item.latestVersion = await resolveLatest(item, deps, home);
      } catch (error) {
        item.lookupError = error.message;
        sourceErrors.push({ source: `latest:${item.id}`, error: error.message });
      }
    });
  }
  signal?.throwIfAborted();

  finalizeInventory({ inventory, config, checkLatest });
  const [services, repositories, projectDependencies, apt] = await Promise.all([
    inspectServices(config, deps, sourceErrors),
    inspectRepositories(config, deps, sourceErrors, checkLatest),
    inspectProjects(config, deps, sourceErrors),
    inspectApt(deps, sourceErrors),
  ]);
  signal?.throwIfAborted();

  const items = [...inventory.values()].sort((a, b) => a.id.localeCompare(b.id));
  const installedItems = items.filter((item) => item.installed);
  const untracked = installedItems
    .filter((item) => !item.updateSource && !item.managedBy)
    .map((item) => ({
      id: item.id,
      currentVersion: item.currentVersion,
      paths: item.paths,
      provenance: item.provenance,
      reason: 'Discovered installed tool has no inferred or configured update source.',
    }));
  const updates = items.filter((item) => item.status === 'update').map(compactItem);
  const current = items.filter((item) => item.status === 'current').map(compactItem);
  const mismatches = items.filter((item) => item.status === 'mismatch').map(compactItem);
  const unknown = items.filter((item) => ['unknown', 'unchecked', 'untracked'].includes(item.status)).map(compactItem);

  const result = {
    generatedAt: deps.now().toISOString(),
    checkLatest,
    summary: {
      updates: updates.length,
      current: current.length,
      mismatches: mismatches.length,
      unknown: unknown.length,
      untracked: untracked.length,
      unavailable: items.filter((item) => item.status === 'unavailable').length,
      aptUpdates: apt.upgradable.length,
      projectDependencyUpdates: projectDependencies.reduce((sum, project) => sum + project.outdated.length, 0),
      unhealthyServices: services.filter((service) => service.healthy === false).length,
      dirtyRepositories: repositories.filter((repo) => repo.dirty === true).length,
      repositoriesTrackingAhead: repositories.filter((repo) => repo.tracking?.state === 'ahead').length,
      repositoriesTrackingBehind: repositories.filter((repo) => repo.tracking?.state === 'behind').length,
      repositoriesTrackingDiverged: repositories.filter((repo) => repo.tracking?.state === 'diverged').length,
      repositoriesRemoteChanged: repositories.filter((repo) => repo.remote?.changedFromTracking === true).length,
      sourceErrors: sourceErrors.length,
    },
    updates,
    current,
    mismatches,
    unknown,
    coverage: {
      discoveredCount: items.length,
      installedCount: installedItems.length,
      trackedCount: installedItems.filter((item) => item.updateSource || item.managedBy).length,
      updateSourceKnownCount: installedItems.filter((item) => item.updateSource).length,
      managedElsewhereCount: installedItems.filter((item) => !item.updateSource && item.managedBy).length,
      untrackedCount: untracked.length,
      untracked,
    },
    inventory: items,
    services,
    repositories,
    apt,
    projectDependencies,
    bridges: options.bridgeStatus?.bridges ?? [],
    sourceErrors,
  };
  return result;
}
