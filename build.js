#!/usr/bin/env node
// Runs hash-calculator.html in headless Chrome, captures the generated COS
// embed code, and injects it into index.html at the marker comment.
//
// Usage:
//   npm install
//   node build.js
//
// Idempotent: on the first run it replaces <!-- COS demo marker -->; on
// subsequent runs it replaces the whole <!-- COS demo -->…<!-- /COS demo -->
// block, so re-running always produces a fresh result.

import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const INJECT_RE =
  /<!-- COS demo -->[\s\S]*?<!-- \/COS demo -->|<!-- COS demo marker -->/;

const indexPath = resolve(__dirname, 'index.html');
const calcUrl = `file://${resolve(__dirname, 'generator.html')}`;
const loaderSrc = readFileSync(resolve(__dirname, 'cos-loader.js'), 'utf8');

console.log('Launching browser…');
const browser = await puppeteer.launch({ channel: 'chrome', headless: true });

try {
  const page = await browser.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.error(`[page error] ${err.message}`));

  console.log('Opening generator.html…');
  await page.goto(calcUrl, { waitUntil: 'load' });

  // Serve cos-loader.js from disk so the file:// origin restriction doesn't
  // block the relative fetch() inside hash-calculator.html.
  await page.evaluate((src) => {
    const orig = window.fetch;
    window.fetch = (url, ...args) => {
      if (typeof url === 'string' && url.includes('cos-loader.js')) {
        return Promise.resolve(new Response(src, { status: 200 }));
      }
      return orig.call(window, url, ...args);
    };
  }, loaderSrc);

  console.log('Generating COS code (fetching fonts + esbuild minification)…');
  await page.click('#run');

  // The pre element appears only on success; timeout surfaces fetch/build errors.
  await page.waitForSelector('#output-section pre', { timeout: 120_000 });

  const output = await page.$eval('#output-section pre', (el) =>
    el.textContent.trim()
  );
  if (!output) {
    const status = await page.$eval('#status', (el) => el.textContent);
    throw new Error(`Empty output. Status: "${status}"`);
  }
  console.log(`Generated ${output.length} chars of COS embed code.`);

  const html = readFileSync(indexPath, 'utf8');
  if (!INJECT_RE.test(html)) {
    throw new Error(
      'No injection point found in index.html.\n' +
        'Add  <!-- COS demo marker -->  where the code should go.'
    );
  }

  writeFileSync(
    indexPath,
    html.replace(INJECT_RE, `<!-- COS demo -->\n${output}\n<!-- /COS demo -->`),
    'utf8'
  );
  console.log('index.html updated.');
} finally {
  await browser.close();
}
