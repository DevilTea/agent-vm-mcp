import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const historicalHtml = await fs.readFile(new URL('../src/interactions/hosts/chatgpt-app.html', import.meta.url), 'utf8');
const v2Html = await fs.readFile(new URL('../src/interactions/hosts/chatgpt-app-v2.html', import.meta.url), 'utf8');
const scriptSource = historicalHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
const v2ScriptSource = v2Html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
assert.ok(scriptSource, 'historical interaction UI script missing');
assert.ok(v2ScriptSource, 'v2 interaction UI script missing');

function attributeValue(element, name) {
  if (name.startsWith('data-')) return element.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
  return element[name];
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.type = '';
    this.name = '';
    this.id = '';
    this.placeholder = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.eventListeners = new Map();
    this.attributes = new Map();
    this.classList = {
      toggle: (className, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force) classes.add(className);
        else classes.delete(className);
        this.className = [...classes].join(' ');
      },
    };
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node == null) continue;
      const child = typeof node === 'string' ? new FakeElement('#text') : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, listener) {
    const listeners = this.eventListeners.get(type) ?? [];
    listeners.push(listener);
    this.eventListeners.set(type, listeners);
  }

  dispatchEvent(event) {
    const current = event;
    if (!current.target) current.target = this;
    current.currentTarget = this;
    for (const listener of this.eventListeners.get(current.type) ?? []) listener(current);
    if (current.bubbles !== false && this.parentNode) this.parentNode.dispatchEvent(current);
    return !current.defaultPrevented;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  matches(selector) {
    return selector.split(',').some((part) => this.matchesSingle(part.trim()));
  }

  matchesSingle(selector) {
    if (!selector) return false;
    const pseudoChecked = selector.includes(':checked');
    if (pseudoChecked && !this.checked) return false;
    selector = selector.replace(':checked', '');

    const tagMatch = selector.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
    if (tagMatch && this.tagName !== tagMatch[0].toLowerCase()) return false;
    if (!tagMatch && selector.startsWith('#')) {
      const id = selector.slice(1);
      if (this.id !== id) return false;
    }

    for (const match of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
      const [, name, expected] = match;
      const actual = attributeValue(this, name);
      if (actual === undefined || (expected !== undefined && String(actual) !== expected)) return false;
    }

    for (const match of selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
      if (!this.className.split(/\s+/).includes(match[1])) return false;
    }

    return true;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches?.(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches?.(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return { height: Math.max(1, this.children.length * 20) };
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html');
    this.documentElement.dataset = {};
    this.body = new FakeElement('body');
    this.root = new FakeElement('main');
    this.root.id = 'root';
    this.documentElement.append(this.body);
    this.body.append(this.root);
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById(id) {
    if (this.root.id === id) return this.root;
    return this.documentElement.querySelector(`#${id}`);
  }
}

function event(type, target = null) {
  return {
    type,
    target,
    bubbles: true,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function makeHarness(server, source = scriptSource, { accelerateTimeouts = false } = {}) {
  const document = new FakeDocument();
  const windowListeners = new Map();
  const storage = new Map();
  const parent = {
    postMessage(message) {
      queueMicrotask(() => server.receive(message, window));
    },
  };
  const window = {
    parent,
    innerWidth: 412,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    dispatchMessage(data) {
      for (const listener of windowListeners.get('message') ?? []) {
        listener({ source: parent, data });
      }
    },
  };
  const requestAnimationFrame = (callback) => setTimeout(callback, 0);
  const viewSetTimeout = (callback, delay, ...args) => setTimeout(
    callback,
    accelerateTimeouts && delay === 30_000 ? 10 : delay,
    ...args,
  );
  const context = vm.createContext({
    window,
    document,
    CSS: { escape: (value) => String(value) },
    requestAnimationFrame,
    console,
    setTimeout: viewSetTimeout,
    clearTimeout,
    queueMicrotask,
  });
  new vm.Script(source, { filename: 'chatgpt-app-inline.js' }).runInContext(context);
  return { document, window, storage };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

const request = {
  title: 'Unicode input',
  submitLabel: 'Submit',
  questions: [
    { id: 'emoji', kind: 'text', prompt: 'Two emoji', required: true, multiline: false, maxLength: 2 },
    { id: 'cjk', kind: 'text', prompt: 'Two CJK characters', required: true, multiline: false, maxLength: 2 },
  ],
};
const interactionId = '4d1a0f43-7e33-4d48-9f0f-1b2f5af8e2dc';
const serverState = {
  status: 'pending',
  answers: null,
  submissionCount: 0,
  proxyMode: 'wrapped-null-elided',
};
const messages = [];
function callToolResult(state) {
  if (serverState.proxyMode === 'wrapped-invalid') {
    return {
      toolResult: {
        bridgeMeta: { transport: 'host' },
        content: [{ type: 'json', data: state }],
      },
    };
  }
  const toolResult = {
    content: [{ type: 'text', text: JSON.stringify(state) }],
  };
  if (serverState.proxyMode === 'wrapped-null-elided') {
    toolResult.structuredContent = Object.fromEntries(
      Object.entries(state).filter(([, value]) => value !== null),
    );
  } else if (serverState.proxyMode.endsWith('structured')) {
    toolResult.structuredContent = state;
  }
  return serverState.proxyMode.startsWith('wrapped') ? { toolResult } : toolResult;
}
const server = {
  receive(message, view) {
    if (message.method === 'ui/initialize') {
      view.dispatchMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2026-01-26',
          hostCapabilities: { serverTools: {}, message: {} },
          hostContext: {},
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      if (message.params.name === 'request_user_input_state') {
        const state = {
          schemaVersion: 1,
          interactionId,
          status: serverState.status,
          answers: clone(serverState.answers),
          submittedAt: serverState.status === 'submitted' ? '2026-09-15T00:00:00.000Z' : null,
        };
        view.dispatchMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: callToolResult(state),
        });
        return;
      }
      if (message.params.name === 'request_user_input_submit') {
        serverState.submissionCount += 1;
        if (serverState.status === 'pending') {
          serverState.status = 'submitted';
          serverState.answers = clone(message.params.arguments.answers);
          const state = {
            schemaVersion: 1,
            interactionId,
            status: 'submitted',
            answers: clone(serverState.answers),
            submittedAt: '2026-09-15T00:00:00.000Z',
            submission: 'created',
          };
          view.dispatchMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: callToolResult(state),
          });
        } else {
          const state = {
            schemaVersion: 1,
            interactionId,
            status: 'submitted',
            answers: clone(serverState.answers),
            submittedAt: '2026-09-15T00:00:00.000Z',
            submission: 'duplicate',
          };
          view.dispatchMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: callToolResult(state),
          });
        }
        return;
      }
    }
    if (message.method === 'ui/message') {
      messages.push(message.params);
      view.dispatchMessage({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  },
};

const first = makeHarness(server);
await waitFor(() => first.window, 'first HTML harness did not start');
first.window.dispatchMessage({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-input',
  params: { arguments: request },
});
first.window.dispatchMessage({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-result',
  params: {
    structuredContent: {
      schemaVersion: 1,
      interactionId,
      request,
      state: { schemaVersion: 1, interactionId, status: 'pending', answers: null, submittedAt: null },
    },
  },
});

await waitFor(
  () => first.document.root.querySelector('form')?.querySelector('[name="emoji"]') !== null &&
    first.document.root.querySelector('form')?.querySelector('button')?.disabled === false,
  'first HTML form did not hydrate pending server state',
);
const firstForm = first.document.root.querySelector('form');
const emojiInput = firstForm.querySelector('[name="emoji"]');
const cjkInput = firstForm.querySelector('[name="cjk"]');
emojiInput.value = '😀😀😀';
emojiInput.dispatchEvent(event('input', emojiInput));
assert.equal(emojiInput.value, '😀😀', 'typing must count emoji by Unicode code points');
emojiInput.value = '😀😀😀';
emojiInput.dispatchEvent(event('paste', emojiInput));
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(emojiInput.value, '😀😀', 'paste must be truncated by Unicode code points');
cjkInput.value = '中文';
cjkInput.dispatchEvent(event('input', cjkInput));
assert.equal(cjkInput.value, '中文', 'two CJK characters must remain accepted');
firstForm.dispatchEvent(event('submit', firstForm));
await waitFor(() => serverState.status === 'submitted' && messages.length === 1, 'first form did not submit through server state and ui/message');
assert.deepEqual(serverState.answers, [
  { questionId: 'emoji', kind: 'text', value: '😀😀' },
  { questionId: 'cjk', kind: 'text', value: '中文' },
]);
assert.equal(firstForm.querySelector('[name="emoji"]').disabled, true);
assert.equal(firstForm.querySelector('button').disabled, true);
assert.equal(firstForm.querySelector('.status').textContent, 'Submitted.');

serverState.proxyMode = 'wrapped-structured';
const second = makeHarness(server);
second.window.dispatchMessage({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-input',
  params: { arguments: request },
});
second.window.dispatchMessage({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-result',
  params: {
    structuredContent: {
      schemaVersion: 1,
      interactionId,
      request,
      state: { schemaVersion: 1, interactionId, status: 'pending', answers: null, submittedAt: null },
    },
  },
});
await waitFor(
  () => second.document.root.querySelector('form')?.querySelector('[name="emoji"]')?.disabled === true,
  'second HTML widget did not hydrate submitted server state',
);
const secondForm = second.document.root.querySelector('form');
assert.equal(secondForm.querySelector('[name="emoji"]').value, '😀😀');
assert.equal(secondForm.querySelector('[name="cjk"]').value, '中文');
assert.equal(secondForm.querySelector('button').disabled, true);
assert.equal(secondForm.querySelector('.status').textContent, 'Submitted.');
assert.equal(serverState.submissionCount, 1, 'hydration must not submit a duplicate response');

serverState.proxyMode = 'wrapped-invalid';
const third = makeHarness(server);
third.window.dispatchMessage({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-input',
  params: { arguments: request },
});
third.window.dispatchMessage({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-result',
  params: {
    structuredContent: {
      schemaVersion: 1,
      interactionId,
      request,
      state: { schemaVersion: 1, interactionId, status: 'pending', answers: null, submittedAt: null },
    },
  },
});
await waitFor(
  () => third.document.root.querySelector('.status')?.textContent.includes('Response shape:'),
  'invalid server state did not expose a safe response-shape diagnostic',
);
const diagnostic = third.document.root.querySelector('.status').textContent;
assert.match(diagnostic, /Response shape: object\{toolResult:object\{/);
assert.match(diagnostic, /bridgeMeta:object\{transport:string\}/);
assert.match(diagnostic, /content:array\(1\)\[object\{data,type\}\]/);
assert.equal(diagnostic.includes(interactionId), false, 'diagnostic must not expose interaction IDs');
assert.equal(diagnostic.includes('😀😀'), false, 'diagnostic must not expose answer values');

const v2Request = {
  title: 'Storage strategy',
  description: 'Choose a durable storage direction.',
  submitLabel: 'Submit',
  questions: [
    {
      id: 'storage',
      kind: 'single_select',
      prompt: 'Where should raw knowledge live?',
      required: true,
      options: [
        { id: 'files', label: 'Files' },
        {
          id: 'external',
          label: 'External storage',
          allowCustomInput: true,
          customInputPlaceholder: 'Name the service',
        },
        {
          id: 'other',
          label: 'Other',
          allowCustomInput: true,
          customInputPlaceholder: 'Describe another option',
        },
      ],
    },
    {
      id: 'formats',
      kind: 'multi_select',
      prompt: 'Which formats should be supported?',
      required: true,
      minSelections: 1,
      maxSelections: 2,
      options: [
        { id: 'markdown', label: 'Markdown' },
        { id: 'html', label: 'HTML' },
        {
          id: 'other',
          label: 'Other',
          allowCustomInput: true,
          customInputPlaceholder: 'Describe another format',
        },
      ],
    },
    {
      id: 'reason',
      kind: 'text',
      prompt: 'Why is this suitable?',
      required: true,
      multiline: false,
      maxLength: 2_000,
    },
  ],
};

function makeV2Server(id, { messageFailures = 0, lostMessageAcks = 0, persistenceFailures = 0 } = {}) {
  const state = { interactionId: id, status: 'pending', answers: null };
  const events = [];
  const messages = [];
  const server = {
    receive(message, view) {
      if (message.method === 'ui/initialize') {
        view.dispatchMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2026-01-26',
            hostCapabilities: { serverTools: {}, message: {} },
            hostContext: {},
          },
        });
        return;
      }
      if (message.method === 'tools/call' && message.params.name === 'request_user_input_state_v2') {
        events.push('state');
        view.dispatchMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            structuredContent: {
              schemaVersion: 1,
              interactionId: id,
              status: state.status,
              answers: clone(state.answers),
              submittedAt: state.status === 'submitted' ? '2026-09-15T00:00:00.000Z' : null,
            },
          },
        });
        return;
      }
      if (message.method === 'tools/call' && message.params.name === 'request_user_input_submit_v2') {
        events.push('submit');
        if (persistenceFailures > 0) {
          persistenceFailures -= 1;
          view.dispatchMessage({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32000, message: 'simulated persistence failure' },
          });
          return;
        }
        if (state.status === 'pending') {
          state.status = 'submitted';
          state.answers = clone(message.params.arguments.answers);
        }
        view.dispatchMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            structuredContent: {
              schemaVersion: 1,
              interactionId: id,
              status: state.status,
              answers: clone(state.answers),
              submittedAt: '2026-09-15T00:00:00.000Z',
              submission: 'created',
            },
          },
        });
        return;
      }
      if (message.method === 'ui/message') {
        events.push('message');
        if (messageFailures > 0) {
          messageFailures -= 1;
          view.dispatchMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: { isError: true },
          });
          return;
        }
        if (lostMessageAcks > 0) {
          lostMessageAcks -= 1;
          return;
        }
        messages.push(clone(message.params));
        view.dispatchMessage({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    },
  };
  return { server, state, events, messages };
}

async function openV2Form(testServer, id) {
  const harness = makeHarness(testServer.server, v2ScriptSource, { accelerateTimeouts: true });
  harness.window.dispatchMessage({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-input',
    params: { arguments: v2Request },
  });
  harness.window.dispatchMessage({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      structuredContent: {
        schemaVersion: 1,
        interactionId: id,
        request: v2Request,
        state: { schemaVersion: 1, interactionId: id, status: 'pending', answers: null, submittedAt: null },
      },
    },
  });
  await waitFor(
    () => harness.document.root.querySelector('form')?.querySelector('button')?.disabled === false,
    `v2 form did not become available for submission (status: ${harness.document.root.querySelector('.status')?.textContent ?? 'missing'})`,
  );
  return harness;
}

function assertV2FreeTextControlsAreTwoRowTextareas(form) {
  const textQuestion = form.querySelector('[name="reason"]');
  assert.equal(textQuestion?.tagName?.toLowerCase(), 'textarea', 'v2 text questions must render as textarea');
  assert.equal(textQuestion?.rows, 2, 'v2 text questions must default to two rows');

  const customInputs = form.querySelectorAll('[data-custom-input="true"]');
  assert.ok(customInputs.length > 0, 'v2 fixture must include custom inputs');
  for (const input of customInputs) {
    assert.equal(input.tagName?.toLowerCase(), 'textarea', 'v2 custom free-text inputs must render as textarea');
    assert.equal(input.rows, 2, 'v2 custom free-text inputs must default to two rows');
  }
}

function fillV2Form(form) {
  const storageOption = form.querySelector('input[name="storage"][value="external"]');
  storageOption.checked = true;
  storageOption.dispatchEvent(event('change', storageOption));
  const custom = form.querySelector('[data-custom-input="true"][data-option-id="external"]');
  custom.value = 'Archive service';

  for (const optionId of ['markdown', 'html']) {
    const option = form.querySelector(`input[name="formats"][value="${optionId}"]`);
    option.checked = true;
    option.dispatchEvent(event('change', option));
  }
  const reason = form.querySelector('[name="reason"]');
  reason.value = 'Keep provenance';
  reason.dispatchEvent(event('input', reason));
}

const retryInteractionId = '8f24815f-2caf-4aeb-b60d-85bf455aadf3';
const retryServer = makeV2Server(retryInteractionId, { messageFailures: 1 });
const retryHarness = await openV2Form(retryServer, retryInteractionId);
const retryForm = retryHarness.document.root.querySelector('form');
assertV2FreeTextControlsAreTwoRowTextareas(retryForm);
fillV2Form(retryForm);
retryForm.dispatchEvent(event('submit', retryForm));
await waitFor(
  () => retryForm.querySelector('.status')?.textContent.includes('Could not send response'),
  'failed ui/message did not show a retryable error',
);
assert.equal(retryServer.state.status, 'pending', 'ui/message failure must leave authoritative server state pending');
assert.equal(retryServer.events.includes('submit'), false, 'v2 must not persist before ui/message succeeds');
const retryableForm = retryHarness.document.root.querySelector('form');
assert.equal(retryableForm.querySelector('button').disabled, false, 'ui/message failure must re-enable Submit');

retryableForm.dispatchEvent(event('submit', retryableForm));
await waitFor(
  () => retryServer.state.status === 'submitted' && retryServer.messages.length === 1,
  'retry after ui/message failure did not send and persist once',
);
assert.ok(
  retryServer.events.lastIndexOf('message') < retryServer.events.lastIndexOf('submit'),
  'v2 must attempt ui/message before authoritative submission',
);
assert.equal(retryServer.messages.length, 1, 'successful retry must produce one user message');
const sentMessage = retryServer.messages[0];
assert.deepEqual(Object.keys(sentMessage).sort(), ['content', 'role']);
assert.equal(sentMessage.role, 'user');
assert.equal(sentMessage.content.length, 1);
assert.equal(sentMessage.content[0].type, 'text');
const responseText = sentMessage.content[0].text;
assert.match(responseText, /Title: Storage strategy/);
assert.match(responseText, /1\. Where should raw knowledge live\?/);
assert.match(responseText, /Answer: External storage/);
assert.match(responseText, /Value: external/);
assert.match(responseText, /Custom value \[External storage \/ external\]: Archive service/);
assert.match(responseText, /2\. Which formats should be supported\?/);
assert.match(responseText, /Answer: Markdown/);
assert.match(responseText, /Value: markdown/);
assert.match(responseText, /Answer: HTML/);
assert.match(responseText, /Value: html/);
assert.match(responseText, /3\. Why is this suitable\?/);
assert.match(responseText, /Answer: Keep provenance/);
assert.match(responseText, /Value: "Keep provenance"/);
assert.equal('structuredContent' in sentMessage, false, 'the user response must be understandable without a structured payload');
const submittedForm = retryHarness.document.root.querySelector('form');
submittedForm.dispatchEvent(event('submit', submittedForm));
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(retryServer.messages.length, 1, 'a submitted v2 form must not send a duplicate message');

const lostAckInteractionId = '870a05d6-91c5-4483-91c6-ffbfb2c22da2';
const lostAckServer = makeV2Server(lostAckInteractionId, { lostMessageAcks: 1 });
const lostAckHarness = await openV2Form(lostAckServer, lostAckInteractionId);
const lostAckForm = lostAckHarness.document.root.querySelector('form');
fillV2Form(lostAckForm);
lostAckForm.dispatchEvent(event('submit', lostAckForm));
await new Promise((resolve) => setTimeout(resolve, 20));
await waitFor(
  () => lostAckForm.querySelector('.status')?.textContent.includes('Could not send response'),
  'lost ui/message acknowledgement did not time out to a retryable state',
);
assert.equal(lostAckServer.state.status, 'pending', 'lost ui/message acknowledgement must not submit server state');
assert.equal(lostAckServer.messages.length, 0);
const lostAckRetryForm = lostAckHarness.document.root.querySelector('form');
assert.equal(lostAckRetryForm.querySelector('button').disabled, false);
lostAckRetryForm.dispatchEvent(event('submit', lostAckRetryForm));
await waitFor(
  () => lostAckServer.state.status === 'submitted' && lostAckServer.messages.length === 1,
  'form could not retry after a lost ui/message acknowledgement',
);

const persistenceFailureInteractionId = '4e02db2f-7e98-4cf8-975f-7a4653b7a2fd';
const persistenceFailureServer = makeV2Server(persistenceFailureInteractionId, { persistenceFailures: 1 });
const persistenceFailureHarness = await openV2Form(persistenceFailureServer, persistenceFailureInteractionId);
const persistenceFailureForm = persistenceFailureHarness.document.root.querySelector('form');
fillV2Form(persistenceFailureForm);
persistenceFailureForm.dispatchEvent(event('submit', persistenceFailureForm));
await waitFor(
  () => persistenceFailureForm.querySelector('.status')?.textContent.includes('submission state could not be saved'),
  'successful ui/message followed by persistence failure was not reported',
);
assert.equal(persistenceFailureServer.state.status, 'pending', 'simulated secondary persistence failure must not change server state');
assert.equal(persistenceFailureServer.messages.length, 1, 'the primary user message should still be sent once');
assert.equal(persistenceFailureForm.querySelector('button').disabled, true, 'successful message must latch the rendered form');
persistenceFailureHarness.window.dispatchMessage({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-input',
  params: { arguments: v2Request },
});
persistenceFailureHarness.window.dispatchMessage({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-result',
  params: {
    structuredContent: {
      schemaVersion: 1,
      interactionId: persistenceFailureInteractionId,
      request: v2Request,
      state: { schemaVersion: 1, interactionId: persistenceFailureInteractionId, status: 'pending', answers: null, submittedAt: null },
    },
  },
});
await waitFor(
  () => persistenceFailureHarness.document.root.querySelector('form')?.querySelector('button')?.disabled === true,
  'v2 re-render lost its local sent-message latch after persistence failure',
);
persistenceFailureHarness.document.root.querySelector('form').dispatchEvent(
  event('submit', persistenceFailureHarness.document.root.querySelector('form')),
);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(persistenceFailureServer.messages.length, 1, 'secondary persistence failure must not automatically resend the user message');
assert.equal(persistenceFailureServer.events.filter((entry) => entry === 'submit').length, 1);

console.log('PASS historical v1 and current v2 embedded ChatGPT interaction behavior');
