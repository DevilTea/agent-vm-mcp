import * as z from 'zod/v4';

export const REQUEST_USER_INPUT_TOOL = 'request_user_input';
export const INTERACTION_SCHEMA_VERSION = 1;
export const OTHER_OPTION_ID = 'other';

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
  maxLength: z.number().int().min(1).max(10_000).default(2_000),
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

const normalizedInteractionRequestSchema = withUniqueQuestions(
  z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(1_500).optional(),
    questions: z.array(normalizedInteractionQuestionSchema).min(1).max(6),
    submitLabel: z.string().min(1).max(80).default('Submit'),
  }),
);

export const interactionResultSchema = z.object({
  schemaVersion: z.literal(INTERACTION_SCHEMA_VERSION),
  interactionId: z.string().uuid(),
  request: normalizedInteractionRequestSchema,
});

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
