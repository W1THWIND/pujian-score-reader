import { mkdir, cp, copyFile } from 'node:fs/promises';
await mkdir('extension/vendor', { recursive: true });
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) await copyFile(`node_modules/pdfjs-dist/build/${file}`, `extension/vendor/${file}`);
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${folder}`, `extension/vendor/${folder}`, { recursive: true });
await copyFile('node_modules/pdfjs-dist/LICENSE', 'extension/vendor/PDFJS-LICENSE');
console.log('Ready: load the extension/ folder in Chrome or Edge.');
