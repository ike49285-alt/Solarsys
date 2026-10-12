// Builds the single-file page published as an artifact: everything between
// <!-- page:start --> and <!-- page:end --> in index.html, with each
// <script src="src/…"> replaced by the file's contents.
//
//   node tools/build.mjs [out.html]      (default dist/solar-nebula.html)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'dist', 'solar-nebula.html');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('<!-- page:start -->'), end = html.indexOf('<!-- page:end -->');
if (start < 0 || end < 0) throw new Error('page markers not found in index.html');
let page = html.slice(start + '<!-- page:start -->'.length, end);
let count = 0;
page = page.replace(/<script src="(src\/[\w.-]+\.js)"><\/script>/g, (_, file) => {
  count++;
  const src = readFileSync(join(root, file), 'utf8');
  if (src.includes('</script')) throw new Error(`${file} contains "</script", which would end the inline script early`);
  return `<script>\n${src}\n</script>`;
});
if (count === 0) throw new Error('no scripts were inlined');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page.trim() + '\n');
console.log(`wrote ${out}: ${count} scripts, ${(page.length / 1024).toFixed(0)} KB`);
