import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const pdfPath = process.argv[2];
if (!pdfPath) throw new Error('Usage: node tests/browser.mjs <path-to-piano-score.pdf>');
const root = path.resolve('extension');
const server = createServer(async (req, res) => {
  const target = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.wasm': 'application/wasm' })[path.extname(target)] || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'");
    res.end(await readFile(target));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('test-results', { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/reader.html`);
  await page.screenshot({ path: 'test-results/welcome.png' });
  await page.locator('#file').setInputFiles(pdfPath);
  await page.locator('#perform').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('perform').disabled, { timeout: 120000 });
  await page.waitForFunction(() => document.getElementById('score').width === 1400);
  const metadata = await page.locator('#docMeta').textContent();
  await page.screenshot({ path: 'test-results/score-page.png' });
  await page.locator('#editButton').click();
  await page.waitForFunction(() => document.querySelectorAll('.handle').length >= 4);
  await page.screenshot({ path: 'test-results/editor-page1.png' });
  const pages = [];
  for (;;) {
    await page.waitForTimeout(150);
    pages.push({ page: await page.locator('#editPageLabel').textContent(), recognition: await page.locator('#recognition').textContent(), cuts: await page.locator('.handle[data-kind=cut]').count() });
    const png = await page.locator('#editCanvas').evaluate(c => c.toDataURL('image/png').split(',')[1]);
    await writeFile(`test-results/original-page${pages.length}.png`, Buffer.from(png, 'base64'));
    if (await page.locator('#editNext').isDisabled()) break;
    await page.locator('#editNext').click(); await page.waitForTimeout(200);
  }
  assert.deepEqual(pages.map(p => p.cuts + 1), [2, 4, 4, 4, 3], 'actual reference score system counts');
  // Return to first page, edit a node, undo, then add and persist one.
  while (!(await page.locator('#editPrev').isDisabled())) { await page.locator('#editPrev').click(); await page.waitForTimeout(120); }
  const before = await page.locator('.handle[data-kind=cut]').count();
  await page.locator('#addCut').click(); assert.equal(await page.locator('.handle[data-kind=cut]').count(), before + 1);
  await page.locator('#undo').click(); assert.equal(await page.locator('.handle[data-kind=cut]').count(), before);
  const handle = page.locator('.handle[data-kind=cut]').first();
  if (before > 0) {
    const old = await handle.getAttribute('style');
    await handle.focus(); await page.keyboard.press('ArrowDown');
    assert.notEqual(await handle.getAttribute('style'), old);
    await page.locator('#undo').click(); assert.equal(await handle.getAttribute('style'), old);
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 15, { steps: 5 }); await page.mouse.up();
    assert.notEqual(await handle.getAttribute('style'), old, 'drag moves node');
    await page.locator('#undo').click(); assert.equal(await handle.getAttribute('style'), old);
  }
  await page.locator('#addCut').click();
  await page.locator('#closeEdit').click();
  await page.locator('#mode').selectOption('row');
  await page.waitForTimeout(300);
  const start = await page.locator('#position').textContent();
  await page.locator('#stage').click(); assert.equal(await page.locator('#position').textContent(), start, 'switch off prevents clicks');
  await page.locator('#startPerformance').click(); await page.waitForTimeout(300);
  assert.equal(await page.locator('#perform').getAttribute('aria-checked'), 'true', 'starting performance automatically enables mouse');
  await page.locator('#stage').click(); await page.waitForTimeout(400);
  assert.match(await page.locator('#position').textContent(), /谱行 2 \//, 'mouse works immediately after start');
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.locator('#perform').click();
  assert.equal(await page.locator('#perform').getAttribute('aria-checked'), 'false');
  await page.locator('#perform').click(); await page.waitForTimeout(300);
  assert.equal(await page.locator('.sidebar').isVisible(), true, 'mouse toggle does not start performance');
  await page.locator('#startPerformance').click(); await page.waitForTimeout(300);
  for (const selector of ['.topbar', '.sidebar', '.reader-toolbar', '.reader-footer', '#notice']) assert.equal(await page.locator(selector).isVisible(), false, 'performance view hides controls');
  assert.equal(await page.locator('#stage').evaluate(el => Math.round(el.getBoundingClientRect().height)), 1000);
  await page.locator('#stage').dblclick({ delay: 20 }); await page.waitForTimeout(400);
  assert.match(await page.locator('#position').textContent(), /谱行 2 \//, 'double click only advances once');
  await page.locator('#stage').click({ button: 'right' }); await page.waitForTimeout(400);
  assert.match(await page.locator('#position').textContent(), /谱行 1 \//);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
  assert.match(await page.locator('#position').textContent(), /谱行 2 \//);
  await page.screenshot({ path: 'test-results/playing.png' });
  const referenceHeight = await page.locator('#score').evaluate(c => c.height);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.topbar').isVisible(), true);
  await page.locator('#overlap').uncheck();
  await page.waitForFunction(h => document.getElementById('score').height < h, referenceHeight);
  assert.match(await page.locator('#position').textContent(), /谱行 2 \//, 'reference switch does not turn pages');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#perform').getAttribute('aria-checked'), 'true', 'Esc preserves mouse setting');
  await page.waitForTimeout(500);
  await page.reload(); await page.waitForFunction(() => !document.getElementById('perform').disabled, { timeout: 120000 });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#mode').inputValue(), 'row');
  assert.equal(await page.locator('#overlap').isChecked(), false, 'reference preference persists');
  await page.locator('#overlap').check();
  await page.waitForFunction(h => document.getElementById('score').height === h, referenceHeight);
  assert.match(await page.locator('#position').textContent(), /谱行 2 \//);
  assert.equal(await page.locator('#perform').getAttribute('aria-checked'), 'false');
  await page.locator('#editButton').click(); await page.waitForTimeout(400);
  assert.equal(await page.locator('.handle[data-kind=cut]').count(), before + 1);
  await page.locator('#closeEdit').click();
  // Restore automatic nodes after verifying manual persistence, for visual QA.
  await page.locator('#editButton').click(); await page.waitForTimeout(200);
  await page.locator('#reanalyze').click(); await page.waitForTimeout(200);
  await page.waitForFunction(() => !document.getElementById('reanalyze').disabled);
  assert.equal(await page.locator('.handle[data-kind=cut]').count(), before);
  await page.locator('#closeEdit').click();
  await page.waitForFunction(() => document.getElementById('docMeta').textContent.includes('17 个阅读段'));
  await page.screenshot({ path: 'test-results/clean-lines.png' });
  // Capture the real score in performance mode after restoring correct nodes.
  await page.locator('#startPerformance').click(); await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/ready-to-play.png' });
  await page.keyboard.press('Escape');
  await page.locator('#mode').selectOption('two');
  await page.waitForTimeout(250);
  const pos = Number((await page.locator('#position').textContent()).match(/谱行 (\d+)/)[1]);
  await page.locator('#next').click(); await page.waitForTimeout(250);
  assert.match(await page.locator('#position').textContent(), new RegExp(`谱行 ${pos + 2} /`));
  // A corrupt import should leave the existing readable score intact.
  await page.locator('#file').setInputFiles({ name: 'invalid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('invalid pdf') });
  await page.waitForFunction(() => document.getElementById('loading').hidden);
  assert.equal(await page.locator('#docName').textContent(), path.basename(pdfPath));
  assert.equal(await page.locator('#perform').isEnabled(), true);
  const report = { metadata, pages, errors, checks: ['import actual score', 'all-page recognition', 'node add/undo', 'node keyboard adjustment', 'master switch off/on', 'double click debounce', 'right-click back', 'keyboard', 'Esc', 'restore PDF/layout/position', 'two-row advance'] };
  await writeFile('test-results/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
} finally { await browser?.close(); server.close(); }
