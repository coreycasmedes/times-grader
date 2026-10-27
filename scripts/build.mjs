// Inlines the engine, reader, model and app into single HTML files.
//   dist/index.html            full page for any web host (GitHub Pages etc.)
//   dist/claude-artifact.html  body-only version for publishing as a Claude artifact
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const stripExport = (src, name) => src.replace(`if (typeof module !== 'undefined') module.exports = ${name};`, '');

let html = read('src/app.html');
const parts = {
  '/*ENGINE*/': stripExport(read('src/paper.js'), 'Paper'),
  '/*READER*/': stripExport(read('src/reader.js'), 'Reader'),
  '/*MODEL*/': read('model/model.json'),
  '/*APP*/': read('src/app.js'),
};
for (const [marker, code] of Object.entries(parts)) {
  if (!html.includes(marker)) throw new Error(`missing ${marker} in src/app.html`);
  html = html.replace(marker, () => code); // function form: no $-pattern surprises
}

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/claude-artifact.html'), html);
const head = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  '<style>body{margin:0}[hidden]{display:none!important}img{max-width:100%}' +
  ':root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}</style>\n';
writeFileSync(join(root, 'dist/index.html'), head + html.replace('<div class="wrap" id="app">', '</head><body>\n<div class="wrap" id="app">') + '\n</body></html>\n');
console.log(`built dist/index.html (${Math.round(html.length / 1024)} KB)`);
