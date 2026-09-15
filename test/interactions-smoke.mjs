import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import {
  OTHER_OPTION_ID,
  REQUEST_USER_INPUT_TOOL,
  interactionRequestSchema,
} from '../src/interactions/model.js';
import { CHATGPT_INTERACTION_RESOURCE_URI } from '../src/interactions/hosts/chatgpt.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-interactions-'));
const bridgesPath = path.join(root, 'bridges.json');
await fs.writeFile(bridgesPath, '{"version":1,"bridges":[]}\n');

async function connect(hostKind) {
  const client = new Client({ name: `interactions-${hostKind}`, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'src/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: root,
      MCP_BRIDGES_CONFIG: bridgesPath,
      AGENT_HERDR_BIN: path.join(root, 'missing-herdr'),
      AGENT_HERDR_BOOTSTRAP: 'external',
      AGENT_MCP_HOST: hostKind,
    },
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}

function parseJsonToolResult(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'tool result did not contain text JSON');
  return JSON.parse(text);
}

function allToolPages(client) {
  return (async () => {
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  })();
}

try {
  const normalized = interactionRequestSchema.parse({
    title: 'Architecture decision',
    questions: [
      {
        id: 'storage',
        kind: 'single_select',
        prompt: 'Choose storage.',
        options: [
          { id: 'files', label: 'Files', recommended: true },
          { id: 'db', label: 'Database' },
          {
            id: 'other',
            label: 'Other',
            allowCustomInput: true,
            customInputPlaceholder: 'Describe the storage option',
          },
        ],
      },
      {
        id: 'features',
        kind: 'multi_select',
        prompt: 'Choose features.',
        required: false,
        options: [
          { id: 'a', label: 'A' },
          {
            id: 'b',
            label: 'B',
            allowCustomInput: true,
            customInputPlaceholder: 'Explain B',
          },
        ],
        maxSelections: 2,
      },
      {
        id: 'notes',
        kind: 'text',
        prompt: 'Anything else?',
        required: false,
        multiline: true,
      },
      {
        id: 'confirm',
        kind: 'boolean',
        prompt: 'Proceed?',
        trueLabel: 'Proceed',
        falseLabel: 'Stop',
        recommendedValue: true,
      },
    ],
  });
  assert.equal(normalized.submitLabel, 'Submit');
  assert.equal(normalized.questions[0].required, true);
  assert.equal(normalized.questions[0].options[2].allowCustomInput, true);
  assert.equal(normalized.questions[0].options[2].customInputPlaceholder, 'Describe the storage option');
  assert.equal(normalized.questions[0].options.filter((option) => option.id === OTHER_OPTION_ID).length, 1);
  assert.equal(normalized.questions[1].options[1].allowCustomInput, true);
  assert.equal(normalized.questions[1].options[1].customInputPlaceholder, 'Explain B');
  assert.equal('allowCustomInput' in normalized.questions[0].options[0], false);
  assert.equal(normalized.questions[2].maxLength, 2_000);

  const automaticOther = interactionRequestSchema.parse({
    title: 'Automatic Other choices',
    questions: [
      {
        id: 'single',
        kind: 'single_select',
        prompt: 'Choose one.',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      {
        id: 'multi',
        kind: 'multi_select',
        prompt: 'Choose any.',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        minSelections: 1,
        maxSelections: 3,
      },
    ],
  });
  for (const question of automaticOther.questions) {
    assert.deepEqual(question.options.map((option) => option.id), ['a', 'b', OTHER_OPTION_ID]);
    assert.equal(question.options.filter((option) => option.id === OTHER_OPTION_ID).length, 1);
    assert.deepEqual(question.options.at(-1), {
      id: OTHER_OPTION_ID,
      label: 'Other',
      recommended: false,
      allowCustomInput: true,
      customInputPlaceholder: 'Please specify another option',
    });
  }
  assert.equal(automaticOther.questions[1].options.length, 3);
  assert.equal(automaticOther.questions[1].minSelections, 1);
  assert.equal(automaticOther.questions[1].maxSelections, 3);

  const normalizedByLabel = interactionRequestSchema.parse({
    title: 'Existing Other label',
    questions: [
      {
        id: 'choice',
        kind: 'single_select',
        prompt: 'Choose.',
        options: [
          { id: 'a', label: 'A' },
          { id: 'custom-route', label: '  other  ', allowCustomInput: false },
        ],
      },
    ],
  });
  assert.deepEqual(normalizedByLabel.questions[0].options.map((option) => option.id), ['a', OTHER_OPTION_ID]);
  assert.deepEqual(normalizedByLabel.questions[0].options[1], {
    id: OTHER_OPTION_ID,
    label: 'Other',
    recommended: false,
    allowCustomInput: true,
    customInputPlaceholder: 'Please specify another option',
  });

  assert.throws(
    () =>
      interactionRequestSchema.parse({
        title: 'Duplicate questions',
        questions: [
          { id: 'same', kind: 'text', prompt: 'One' },
          { id: 'same', kind: 'text', prompt: 'Two' },
        ],
      }),
    /Duplicate question id/,
  );

  assert.throws(
    () =>
      interactionRequestSchema.parse({
        title: 'Recommendations',
        questions: [
          {
            id: 'choice',
            kind: 'single_select',
            prompt: 'Choose.',
            options: [
              { id: 'a', label: 'A', recommended: true },
              { id: 'b', label: 'B', recommended: true },
            ],
          },
        ],
      }),
    /At most one option may be marked recommended/,
  );

  assert.throws(
    () =>
      interactionRequestSchema.parse({
        title: 'Invalid custom input',
        questions: [
          {
            id: 'choice',
            kind: 'single_select',
            prompt: 'Choose.',
            options: [
              { id: 'a', label: 'A', customInputPlaceholder: 'Explain A' },
              { id: 'b', label: 'B' },
            ],
          },
        ],
      }),
    /customInputPlaceholder requires allowCustomInput=true/,
  );

  const generic = await connect('generic');
  try {
    const tools = await allToolPages(generic);
    assert.equal(
      tools.some((tool) => tool.name === REQUEST_USER_INPUT_TOOL),
      false,
      'generic host must not expose ChatGPT interaction UI tool',
    );
    const capabilities = parseJsonToolResult(await generic.callTool({ name: 'capabilities', arguments: {} }));
    assert.equal(capabilities.mcp.nativeTools.includes(REQUEST_USER_INPUT_TOOL), false);
  } finally {
    await generic.close().catch(() => {});
  }

  const chatgpt = await connect('chatgpt');
  try {
    const tools = await allToolPages(chatgpt);
    const interactionTool = tools.find((tool) => tool.name === REQUEST_USER_INPUT_TOOL);
    assert.ok(interactionTool, 'ChatGPT interaction tool missing');
    assert.equal(interactionTool._meta?.ui?.resourceUri, CHATGPT_INTERACTION_RESOURCE_URI);
    assert.equal(interactionTool._meta?.['ui/resourceUri'], CHATGPT_INTERACTION_RESOURCE_URI);
    assert.deepEqual(interactionTool._meta?.ui?.visibility, ['model']);
    assert.match(interactionTool.description ?? '', /Do not prefix question prompts with ordinal numbers/);
    assert.match(interactionTool.description ?? '', /Prefer single_select for binary choices too/);
    assert.match(interactionTool.description ?? '', /automatically includes exactly one reserved option/);
    assert.match(interactionTool.description ?? '', /required inline free-text input/);
    assert.match(interactionTool.description ?? '', /do not add Other yourself/);
    assert.match(JSON.stringify(interactionTool.inputSchema), /allowCustomInput/);
    assert.match(JSON.stringify(interactionTool.inputSchema), /customInputPlaceholder/);
    assert.match(JSON.stringify(interactionTool.inputSchema), /reserved `other` choice/);
    const capabilities = parseJsonToolResult(await chatgpt.callTool({ name: 'capabilities', arguments: {} }));
    assert.equal(capabilities.mcp.nativeTools.includes(REQUEST_USER_INPUT_TOOL), true);

    const resource = await chatgpt.readResource({ uri: CHATGPT_INTERACTION_RESOURCE_URI });
    assert.equal(resource.contents.length, 1);
    const content = resource.contents[0];
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.equal(typeof content.text, 'string');
    assert.equal(content._meta?.['openai/widgetPrefersBorder'], true);
    assert.equal(content._meta?.ui?.prefersBorder, true);
    const resourceDigest = createHash('sha256')
      .update(content.text)
      .update('\0')
      .update(JSON.stringify(content._meta))
      .digest('hex')
      .slice(0, 12);
    assert.equal(
      CHATGPT_INTERACTION_RESOURCE_URI,
      `ui://agent-vm/request-user-input/v1-${resourceDigest}.html`,
    );
    assert.match(content.text, /ui\/initialize/);
    assert.match(content.text, /ui\/notifications\/initialized/);
    assert.match(content.text, /ui\/message/);
    assert.match(content.text, /2026-01-26/);
    assert.match(content.text, /option\.allowCustomInput === true/);
    assert.match(content.text, /for \(const option of question\.options \?\? \[\]\)/);
    assert.match(content.text, /data-custom-input/);
    assert.match(content.text, /const customValue = input\.value\.trim\(\)/);
    assert.match(content.text, /Please provide additional details/);
    assert.match(content.text, /Custom value \[/);
    assert.match(content.text, /customValues\[optionId\]/);
    assert.match(content.text, /FORM_STATE_PREFIX/);
    assert.match(content.text, /window\.localStorage\.setItem/);
    assert.match(content.text, /restorePersistedForm/);
    assert.match(content.text, /fieldset\s*\{[\s\S]*padding:\s*0 12px/);
    assert.match(content.text, /function displayQuestionPrompt/);
    assert.match(content.text, /prompt\.startsWith\(ordinal\)/);

    const scriptMatch = content.text.match(/<script>([\s\S]*?)<\/script>/i);
    assert.ok(scriptMatch, 'interaction UI script missing');
    new vm.Script(scriptMatch[1], { filename: 'chatgpt-app-inline.js' });

    const result = await chatgpt.callTool({
      name: REQUEST_USER_INPUT_TOOL,
      arguments: {
        title: 'Storage strategy',
        description: 'Choose the direction for the next design step.',
        questions: [
          {
            id: 'storage',
            kind: 'single_select',
            prompt: 'Where should raw knowledge live?',
            options: [
              { id: 'git', label: 'Git' },
              { id: 'external', label: 'External storage', recommended: true },
            ],
          },
          {
            id: 'formats',
            kind: 'multi_select',
            prompt: 'Which formats should be supported?',
            options: [
              { id: 'markdown', label: 'Markdown' },
              { id: 'html', label: 'HTML' },
            ],
            maxSelections: 2,
          },
        ],
      },
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.schemaVersion, 1);
    assert.match(result.structuredContent?.interactionId ?? '', /^[0-9a-f-]{36}$/i);
    assert.equal(result.structuredContent?.request?.questions?.[0]?.required, true);
    assert.deepEqual(
      result.structuredContent?.request?.questions?.[0]?.options?.map((option) => option.id),
      ['git', 'external', OTHER_OPTION_ID],
    );
    assert.equal(result.structuredContent?.request?.questions?.[0]?.options?.[2]?.label, 'Other');
    assert.equal(result.structuredContent?.request?.questions?.[0]?.options?.[2]?.allowCustomInput, true);
    assert.equal(
      result.structuredContent?.request?.questions?.[0]?.options?.[2]?.customInputPlaceholder,
      'Please specify another option',
    );
    assert.deepEqual(
      result.structuredContent?.request?.questions?.[1]?.options?.map((option) => option.id),
      ['markdown', 'html', OTHER_OPTION_ID],
    );
    assert.equal(result.structuredContent?.request?.questions?.[1]?.options?.[2]?.allowCustomInput, true);
    assert.equal(result.structuredContent?.request?.questions?.[1]?.maxSelections, 2);
    assert.equal(result.structuredContent?.request?.questions?.[1]?.options?.length, 3);
    assert.match(result.content?.[0]?.text ?? '', /custom input required/);
    assert.match(result.content?.[0]?.text ?? '', /other: Other/);
    assert.match(result.content?.[0]?.text ?? '', /Wait for the user response/);
  } finally {
    await chatgpt.close().catch(() => {});
  }

  console.log('PASS structured interaction model and ChatGPT adapter');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
