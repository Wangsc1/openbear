import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveWebReuse, mobileRoot } = require('../../web-reuse.config.js');
const srcRoot = path.join(mobileRoot, 'src');

function withExtension(file) {
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  for (const ext of ['.ts', '.js', '.mjs']) if (fs.existsSync(file + ext)) return file + ext;
  for (const ext of ['/index.ts', '/index.js']) if (fs.existsSync(file + ext)) return file + ext;
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const origin = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : '';
  const resolved = resolveWebReuse(specifier, origin);
  if (resolved.filePath) return { url: pathToFileURL(resolved.filePath).href, shortCircuit: true, format: 'module' };
  let request = resolved.request;
  if (request.startsWith('@/')) request = path.join(srcRoot, request.slice(2));
  else if (request.startsWith('.') && origin.startsWith(mobileRoot)) request = path.resolve(path.dirname(origin), request);
  if (path.isAbsolute(request)) {
    const file = withExtension(request);
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
