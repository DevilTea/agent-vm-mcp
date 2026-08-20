import path from 'node:path';

const MIME_BY_EXTENSION = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.xml', 'application/xml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.jsx', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.sh', 'text/x-shellscript'],
  ['.log', 'text/plain'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.tgz', 'application/gzip'],
  ['.tar', 'application/x-tar'],
]);

const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
  'application/yaml',
  'application/xml',
  'application/javascript',
]);

export function inferMimeType(filePath) {
  return MIME_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

export function isTextMimeType(mimeType) {
  return mimeType.startsWith('text/') || TEXT_APPLICATION_TYPES.has(mimeType) || mimeType.endsWith('+json') || mimeType.endsWith('+xml');
}

