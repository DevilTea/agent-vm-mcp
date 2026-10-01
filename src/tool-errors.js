function normalizeCode(code, fallback) {
  const value = typeof code === 'string' && code.length > 0 ? code : fallback;
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'TOOL_ERROR';
}

export function toolError(code, message, details = undefined, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export function structuredErrorResult(error, fallbackCode = 'TOOL_ERROR') {
  const code = error?.name === 'AbortError'
    ? 'CANCELLED'
    : normalizeCode(error?.code, fallbackCode);
  const details = error?.details && typeof error.details === 'object'
    ? error.details
    : undefined;

  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: {
          code,
          message: error?.message || 'Tool operation failed.',
          ...(details === undefined ? {} : { details }),
        },
      }, null, 2),
    }],
  };
}

export function withStructuredErrors(handler, fallbackCode = 'TOOL_ERROR') {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return structuredErrorResult(error, fallbackCode);
    }
  };
}
