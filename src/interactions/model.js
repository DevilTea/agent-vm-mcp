import * as z from 'zod/v4';

export const REQUEST_USER_INPUT_TOOL = 'request_user_input';
export const INTERACTION_SCHEMA_VERSION = 1;

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .describe('Stable identifier used to correlate this item with the user response.');

const optionSchema = z.object({
  id: identifierSchema,
  label: z.string().min(1).max(160),
  description: z.string().min(1).max(600).optional(),
  recommended: z.boolean().default(false),
});

function withUniqueOptions(schema) {
  return schema.superRefine((question, ctx) => {
    const seen = new Set();
    let recommended = 0;
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
    }
    if (recommended > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'At most one option may be marked recommended.',
      });
    }
  });
}

const commonQuestionShape = {
  id: identifierSchema,
  prompt: z.string().min(1).max(600),
  description: z.string().min(1).max(1_200).optional(),
  required: z.boolean().default(true),
};

const singleSelectQuestionSchema = withUniqueOptions(
  z.object({
    ...commonQuestionShape,
    kind: z.literal('single_select'),
    options: z.array(optionSchema).min(2).max(10),
  }),
);

const multiSelectQuestionSchema = withUniqueOptions(
  z.object({
    ...commonQuestionShape,
    kind: z.literal('multi_select'),
    options: z.array(optionSchema).min(2).max(10),
    minSelections: z.number().int().min(0).max(10).default(0),
    maxSelections: z.number().int().min(1).max(10).optional(),
  }).superRefine((question, ctx) => {
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
  }),
);

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

export const interactionRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(1_500).optional(),
    questions: z.array(interactionQuestionSchema).min(1).max(6),
    submitLabel: z.string().min(1).max(80).default('Submit'),
  })
  .superRefine((request, ctx) => {
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

export const interactionResultSchema = z.object({
  schemaVersion: z.literal(INTERACTION_SCHEMA_VERSION),
  interactionId: z.string().uuid(),
  request: interactionRequestSchema,
});

function questionFallback(question, index) {
  const lines = [`${index + 1}. ${question.prompt}`];
  if (question.description) lines.push(`   ${question.description}`);

  if (question.kind === 'single_select' || question.kind === 'multi_select') {
    for (const option of question.options) {
      const recommendation = option.recommended ? ' [recommended]' : '';
      const description = option.description ? ` — ${option.description}` : '';
      lines.push(`   - ${option.id}: ${option.label}${recommendation}${description}`);
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
