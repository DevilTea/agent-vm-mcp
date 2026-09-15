import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const html = await fs.readFile(new URL('../src/interactions/hosts/chatgpt-app.html', import.meta.url), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
assert.ok(scriptSource, 'interaction UI script missing');

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

function makeHarness(server) {
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
  const context = vm.createContext({
    window,
    document,
    CSS: { escape: (value) => String(value) },
    requestAnimationFrame,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });
  new vm.Script(scriptSource, { filename: 'chatgpt-app-inline.js' }).runInContext(context);
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

console.log('PASS embedded ChatGPT interaction HTML behavior');
