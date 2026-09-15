import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

export async function resolveBashExecutable(env = process.env) {
  const searchPath = env.PATH ?? '';

  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, 'bash');
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching the server's PATH.
    }
  }

  const error = new Error('Bash is required but no executable named "bash" is available on the MCP server PATH.');
  error.code = 'execution_shell_unavailable';
  throw error;
}
