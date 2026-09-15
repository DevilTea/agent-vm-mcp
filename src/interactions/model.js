import * as z from 'zod/v4';

export const REQUEST_USER_INPUT_TOOL = 'request_user_input';
export const INTERACTION_SCHEMA_VERSION = 1;
export const OTHER_OPTION_ID = 'other';
export const INTERACTION_STATUS_PENDING = 'pending';
export const INTERACTION_STATUS_SUBMITTED = 'submitted';

const OTHER_OPTION_LABEL = 'Other';
const OTHER_OPTION_CUSTOM_INPUT_PLACEHOLDER = 'Please specify another option';
const MAX_CALLER_SELECT_OPTIONS = 10;
const MAX_NORMALIZED_SELECT_OPTIONS = MAX_CALLER_SELECT_OPTIONS + 1;

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .describe('Stable identifier used to correlate this item with the user response.');

const optionSchema = z
  .object({
    id: identifierSchema,
    label: z.string().min(1).max(160),
    description: z.string().min(1).max(600).optional(),
    recommended: z.boolean().default(false),
    allowCustomInput: z
      .boolean()
      .optional()
      .describe('When true, selecting this option requires an additional inline text value.'),
    customInputPlaceholder: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('Placeholder for the additional inline text value when allowCustomInput is true.'),
  })
  .superRefine((option, ctx) => {
    if (option.customInputPlaceholder !== undefined && option.allowCustomInput !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['customInputPlaceholder'],
        message: 'customInputPlaceholder requires allowCustomInput=true.',
      });
    }
  });

function withUniqueOptions(schema) {
  return schema.superRefine((question, ctx) => {
    const seen = new Set();
    let recommended = 0;
    let otherCandidates = 0;
    for (const [index, option] of question.options.entries()) {
      if (seen.has(option.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', index, 'id'],
          message: `Duplicate option id: ${option.id}`,
        });
      }
      seen.add(option.id);
      if (option.recommended) recommended += 1;
      if (optionRepresentsOther(option)) otherCandidates += 1;
    }
    if (recommended > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'At most one option may be marked recommended.',
      });
    }
    if (otherCandidates > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'At most one option may represent the automatic Other choice.',
      });
    }
  });
}

const commonQuestionShape = {
  id: identifierSchema,
  prompt: z.string().min(1).max(600).describe('Question text without ordinal numbering; the host UI numbers questions for display.'),
  description: z.string().min(1).max(1_200).optional(),
  required: z.boolean().default(true),
};

function selectOptionsSchema(description, maxItems = MAX_CALLER_SELECT_OPTIONS) {
  return z
    .array(optionSchema)
    .min(2)
    .max(maxItems)
    .describe(description);
}

function optionRepresentsOther(option) {
  return option.id === OTHER_OPTION_ID || option.label.trim().toLowerCase() === OTHER_OPTION_LABEL.toLowerCase();
}

function automaticOtherOption(source = null) {
  return {
    ...(source ?? {}),
    id: OTHER_OPTION_ID,
    label: OTHER_OPTION_LABEL,
    recommended: source?.recommended === true,
    allowCustomInput: true,
    customInputPlaceholder: source?.customInputPlaceholder ?? OTHER_OPTION_CUSTOM_INPUT_PLACEHOLDER,
  };
}

function normalizeSelectQuestion(question) {
  const otherIndex = question.options.findIndex(optionRepresentsOther);
  if (otherIndex < 0) {
    return {
      ...question,
      options: [...question.options, automaticOtherOption()],
    };
  }

  return {
    ...question,
    options: question.options.map((option, index) => (
      index === otherIndex ? automaticOtherOption(option) : option
    )),
  };
}

function validateMultiSelectLimits(question, ctx) {
  const maxSelections = question.maxSelections ?? question.options.length;
  if (question.minSelections > maxSelections) {
    ctx.addIssue({
      code: 'custom',
      path: ['minSelections'],
      message: 'minSelections must not exceed maxSelections.',
    });
  }
  if (maxSelections > question.options.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxSelections'],
      message: 'maxSelections must not exceed the number of options.',
    });
  }
}

const singleSelectQuestionSchema = withUniqueOptions(
  z.object({
    ...commonQuestionShape,
    kind: z.literal('single_select'),
    options: selectOptionsSchema(
      'Caller-supplied choices. The normalized question always includes one reserved `other` choice with a required inline free-text input; do not add it manually.',
    ),
  }),
).transform(normalizeSelectQuestion);

const multiSelectQuestionSchema = withUniqueOptions(
  z.object({
    ...commonQuestionShape,
    kind: z.literal('multi_select'),
    options: selectOptionsSchema(
      'Caller-supplied choices. The normalized question always includes one reserved `other` choice with a required inline free-text input; do not add it manually.',
    ),
    minSelections: z.number().int().min(0).max(MAX_NORMALIZED_SELECT_OPTIONS).default(0),
    maxSelections: z.number().int().min(1).max(MAX_NORMALIZED_SELECT_OPTIONS).optional(),
  }),
).transform(normalizeSelectQuestion).superRefine(validateMultiSelectLimits);

const textQuestionSchema = z.object({
  ...commonQuestionShape,
  kind: z.literal('text'),
  placeholder: z.string().max(300).optional(),
  multiline: z.boolean().default(false),
  maxLength: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(2_000)
    .describe('Maximum number of Unicode code points in the response; surrogate pairs count as one.'),
});

const booleanQuestionSchema = z.object({
  ...commonQuestionShape,
  kind: z.literal('boolean'),
  trueLabel: z.string().min(1).max(80).default('Yes'),
  falseLabel: z.string().min(1).max(80).default('No'),
  recommendedValue: z.boolean().optional(),
});

export const interactionQuestionSchema = z.union([
  singleSelectQuestionSchema,
  multiSelectQuestionSchema,
  textQuestionSchema,
  booleanQuestionSchema,
]);

function withUniqueQuestions(schema) {
  return schema.superRefine((request, ctx) => {
    const seen = new Set();
    for (const [index, question] of request.questions.entries()) {
      if (seen.has(question.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['questions', index, 'id'],
          message: `Duplicate question id: ${question.id}`,
        });
      }
      seen.add(question.id);
    }
  });
}

export const interactionRequestSchema = withUniqueQuestions(
  z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(1_500).optional(),
    questions: z.array(interactionQuestionSchema).min(1).max(6),
    submitLabel: z.string().min(1).max(80).default('Submit'),
  }),
);

function requireAutomaticOther(question, ctx) {
  const otherOptions = question.options.filter((option) => option.id === OTHER_OPTION_ID);
  if (otherOptions.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Select questions must include exactly one automatic Other choice.',
    });
    return;
  }

  const [other] = otherOptions;
  if (
    other.label !== OTHER_OPTION_LABEL ||
    other.allowCustomInput !== true ||
    typeof other.customInputPlaceholder !== 'string'
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'The automatic Other choice must require an inline free-text input.',
    });
  }
}

const normalizedSingleSelectQuestionSchema = withUniqueOptions(
  z.object({
    ...commonQuestionShape,
    kind: z.literal('single_select'),
    options: selectOptionsSchema(
      'Normalized choices, including the reserved `other` choice with required inline free-text input.',
      MAX_NORMALIZED_SELECT_OPTIONS,
    ),
  }),
).superRefine(requireAutomaticOther);

const normalizedMultiSelectQuestionSchema = withUniqueOptions(
  z.object({
    ...commonQuestionShape,
    kind: z.literal('multi_select'),
    options: selectOptionsSchema(
      'Normalized choices, including the reserved `other` choice with required inline free-text input.',
      MAX_NORMALIZED_SELECT_OPTIONS,
    ),
    minSelections: z.number().int().min(0).max(MAX_NORMALIZED_SELECT_OPTIONS).default(0),
    maxSelections: z.number().int().min(1).max(MAX_NORMALIZED_SELECT_OPTIONS).optional(),
  }).superRefine(validateMultiSelectLimits),
).superRefine(requireAutomaticOther);

const normalizedInteractionQuestionSchema = z.union([
  normalizedSingleSelectQuestionSchema,
  normalizedMultiSelectQuestionSchema,
  textQuestionSchema,
  booleanQuestionSchema,
]);

export const normalizedInteractionRequestSchema = withUniqueQuestions(
  z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(1_500).optional(),
    questions: z.array(normalizedInteractionQuestionSchema).min(1).max(6),
    submitLabel: z.string().min(1).max(80).default('Submit'),
  }),
);

const interactionAnswerValueSchema = z.union([
  z.string().max(10_000),
  z.array(z.string().max(64)).max(MAX_NORMALIZED_SELECT_OPTIONS),
  z.boolean(),
  z.null(),
]);

export const interactionAnswerSchema = z
  .object({
    questionId: identifierSchema,
    kind: z.enum(['single_select', 'multi_select', 'text', 'boolean']),
    value: interactionAnswerValueSchema,
    customValues: z.record(identifierSchema, z.string().max(10_000)).optional(),
  })
  .strict();

export const interactionAnswersSchema = z.array(interactionAnswerSchema).min(1).max(6);

export const interactionStateSchema = z.object({
  schemaVersion: z.literal(INTERACTION_SCHEMA_VERSION),
  interactionId: z.string().uuid(),
  status: z.enum([INTERACTION_STATUS_PENDING, INTERACTION_STATUS_SUBMITTED]),
  answers: z.array(interactionAnswerSchema).nullable(),
  submittedAt: z.string().datetime().nullable(),
});

export const interactionSubmissionResultSchema = interactionStateSchema.extend({
  submission: z.enum(['created', 'duplicate']),
});

export const interactionResultSchema = z.object({
  schemaVersion: z.literal(INTERACTION_SCHEMA_VERSION),
  interactionId: z.string().uuid(),
  request: normalizedInteractionRequestSchema,
  state: interactionStateSchema,
});

function invalidInteractionAnswers(message) {
  const error = new Error(message);
  error.code = 'invalid_interaction_answers';
  return error;
}

function assertAnswer(condition, message) {
  if (!condition) throw invalidInteractionAnswers(message);
}

function normalizeCustomValues(question, selectedValues, rawCustomValues) {
  const customValues = rawCustomValues ?? {};
  const selected = new Set(selectedValues);
  const optionsById = new Map(question.options.map((option) => [option.id, option]));

  for (const optionId of Object.keys(customValues)) {
    const option = optionsById.get(optionId);
    assertAnswer(option, `Unknown custom option ${optionId} for question ${question.id}.`);
    assertAnswer(selected.has(optionId), `Custom value for unselected option ${optionId} is not allowed.`);
    assertAnswer(option.allowCustomInput === true, `Option ${optionId} does not accept a custom value.`);
  }

  const normalized = {};
  for (const option of question.options) {
    if (!selected.has(option.id) || option.allowCustomInput !== true) continue;
    const customValue = customValues[option.id];
    assertAnswer(typeof customValue === 'string' && customValue.trim().length > 0, `A custom value is required for option ${option.id}.`);
    normalized[option.id] = customValue.trim();
  }

  return normalized;
}

function normalizeAnswerForQuestion(question, answer) {
  assertAnswer(answer.kind === question.kind, `Answer kind for question ${question.id} does not match the original request.`);
  const rawCustomValues = answer.customValues ?? {};

  if (question.kind === 'single_select') {
    assertAnswer(answer.value === null || typeof answer.value === 'string', `Answer value for question ${question.id} must be one option or null.`);
    const allowed = new Set(question.options.map((option) => option.id));
    assertAnswer(answer.value === null || allowed.has(answer.value), `Unknown option for question ${question.id}.`);
    assertAnswer(question.required === false || answer.value !== null, `A response is required for question ${question.id}.`);
    return {
      questionId: question.id,
      kind: question.kind,
      value: answer.value,
      customValues: normalizeCustomValues(
        question,
        answer.value === null ? [] : [answer.value],
        rawCustomValues,
      ),
    };
  }

  if (question.kind === 'multi_select') {
    assertAnswer(Array.isArray(answer.value), `Answer value for question ${question.id} must be an array.`);
    const selected = new Set(answer.value);
    assertAnswer(selected.size === answer.value.length, `Duplicate options are not allowed for question ${question.id}.`);
    const allowed = new Set(question.options.map((option) => option.id));
    assertAnswer(answer.value.every((optionId) => allowed.has(optionId)), `Unknown option for question ${question.id}.`);

    const minSelections = Math.max(question.required === false ? 0 : 1, question.minSelections ?? 0);
    const maxSelections = question.maxSelections ?? question.options.length;
    assertAnswer(answer.value.length >= minSelections, `Question ${question.id} requires at least ${minSelections} selection(s).`);
    assertAnswer(answer.value.length <= maxSelections, `Question ${question.id} allows at most ${maxSelections} selection(s).`);

    const values = question.options
      .map((option) => option.id)
      .filter((optionId) => selected.has(optionId));
    return {
      questionId: question.id,
      kind: question.kind,
      value: values,
      customValues: normalizeCustomValues(question, values, rawCustomValues),
    };
  }

  assertAnswer(Object.keys(rawCustomValues).length === 0, `Question ${question.id} does not accept custom values.`);

  if (question.kind === 'boolean') {
    assertAnswer(answer.value === null || typeof answer.value === 'boolean', `Answer value for question ${question.id} must be boolean or null.`);
    assertAnswer(question.required === false || answer.value !== null, `A response is required for question ${question.id}.`);
    return { questionId: question.id, kind: question.kind, value: answer.value };
  }

  assertAnswer(answer.value === null || typeof answer.value === 'string', `Answer value for question ${question.id} must be text or null.`);
  if (answer.value !== null) {
    assertAnswer(Array.from(answer.value).length <= question.maxLength, `Answer for question ${question.id} exceeds maxLength in Unicode code points.`);
  }
  const value = answer.value === null ? null : answer.value.trim() || null;
  assertAnswer(question.required === false || value !== null, `A response is required for question ${question.id}.`);
  return { questionId: question.id, kind: question.kind, value };
}

export function normalizeInteractionAnswers(request, answers) {
  const parsed = interactionAnswersSchema.safeParse(answers);
  if (!parsed.success) {
    throw invalidInteractionAnswers(parsed.error.issues[0]?.message ?? 'Invalid interaction answers.');
  }

  assertAnswer(parsed.data.length === request.questions.length, 'Answers must contain exactly one entry for every question.');
  const byQuestionId = new Map();
  for (const answer of parsed.data) {
    assertAnswer(!byQuestionId.has(answer.questionId), `Duplicate answer for question ${answer.questionId}.`);
    byQuestionId.set(answer.questionId, answer);
  }

  return request.questions.map((question) => {
    const answer = byQuestionId.get(question.id);
    assertAnswer(answer, `Missing answer for question ${question.id}.`);
    return normalizeAnswerForQuestion(question, answer);
  });
}

function questionFallback(question, index) {
  const lines = [`${index + 1}. ${question.prompt}`];
  if (question.description) lines.push(`   ${question.description}`);

  if (question.kind === 'single_select' || question.kind === 'multi_select') {
    for (const option of question.options) {
      const recommendation = option.recommended ? ' [recommended]' : '';
      const customInput = option.allowCustomInput ? ' [custom input required]' : '';
      const description = option.description ? ` — ${option.description}` : '';
      const placeholder = option.customInputPlaceholder ? ` (placeholder: ${option.customInputPlaceholder})` : '';
      lines.push(`   - ${option.id}: ${option.label}${recommendation}${customInput}${placeholder}${description}`);
    }
  } else if (question.kind === 'boolean') {
    const trueRecommendation = question.recommendedValue === true ? ' [recommended]' : '';
    const falseRecommendation = question.recommendedValue === false ? ' [recommended]' : '';
    lines.push(`   - true: ${question.trueLabel}${trueRecommendation}`);
    lines.push(`   - false: ${question.falseLabel}${falseRecommendation}`);
  } else {
    lines.push(question.multiline ? '   - Free-form multiline response.' : '   - Free-form response.');
  }

  if (!question.required) lines.push('   Optional.');
  return lines;
}

export function formatInteractionFallback(request, interactionId) {
  const lines = [
    `User input requested: ${request.title}`,
    `Interaction ID: ${interactionId}`,
  ];
  if (request.description) lines.push(request.description);
  lines.push('');
  request.questions.forEach((question, index) => lines.push(...questionFallback(question, index)));
  lines.push('', 'Wait for the user response before resolving these choices.');
  return lines.join('\n');
}
