// Empaqueta la Capa 1 compilada (dist/src) como IIFE global `AbsCounter`
// y la inyecta en web/template.html → abs-counter.html (un solo archivo, sin build para correr).
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
  entryPoints: [resolve(root, 'dist/src/index.js')],
  bundle: true,
  format: 'iife',
  globalName: 'AbsCounter',
  write: false,
});

const bundle = result.outputFiles[0].text;
const template = readFileSync(resolve(root, 'web/template.html'), 'utf8');
const marker = '/*__CORE_BUNDLE__*/';
if (!template.includes(marker)) throw new Error('marcador del bundle no encontrado en template.html');
const html = template.replace(marker, () => bundle);
writeFileSync(resolve(root, 'abs-counter.html'), html);
console.log(`abs-counter.html generado (${(html.length / 1024).toFixed(0)} KB)`);
