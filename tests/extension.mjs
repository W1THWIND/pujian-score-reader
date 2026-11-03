import { chromium } from '@playwright/test';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('extension');
const context = await chromium.launchPersistentContext('', {
  channel: 'msedge', headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/reader.html`);
  await page.locator('#file').setInputFiles(process.argv[2]);
  await page.waitForFunction(() => !document.getElementById('perform').disabled, { timeout: 120000 });
  await page.waitForFunction(() => document.getElementById('score').width === 1400);
  assert.match(await page.locator('#docMeta').textContent(), /5 页/);
  await page.locator('#perform').click(); await page.waitForTimeout(350);
  assert.equal(await page.locator('.topbar').isVisible(), true);
  await page.locator('#startPerformance').click();
  await page.locator('#stage').click(); await page.waitForTimeout(350);
  assert.match(await page.locator('#position').textContent(), /第 2 \/ 5 页/);
  assert.deepEqual(errors, []);
  console.log('PASS: Edge loaded unpacked Manifest V3 extension; PDF worker, local import and page turn work.');
} finally { await context.close(); }
