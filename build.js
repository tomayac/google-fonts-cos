#!/usr/bin/env node
// Runs generator.html in headless Chrome to produce minified COS embed code
// and injects the result into index.html (static variant) and
// index-dynamic.html (dynamic variant).
//
// Usage:
//   npm install
//   node build.js
//
// Idempotent: on the first run it replaces <!-- COS demo marker --> in each
// target file; on subsequent runs it replaces the whole
// <!-- COS demo -->…<!-- /COS demo --> block, so re-running always produces
// a fresh result.

import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const INJECT_RE =
  /<!-- COS demo -->[\s\S]*?<!-- \/COS demo -->|<!-- COS demo marker -->/;

const calcUrl = `file://${resolve(__dirname, 'generator.html')}`;

async function generate(browser, { loaderFiles, variantRadioId, label }) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.error(`[page error] ${err.message}`));

  await page.goto(calcUrl, { waitUntil: 'load' });

  // Serve loader source file(s) from disk so the file:// origin restriction
  // doesn't block the relative fetch() calls inside generator.html.
  await page.evaluate((files) => {
    const orig = window.fetch;
    window.fetch = (url, ...args) => {
      if (typeof url === 'string') {
        for (const [name, src] of Object.entries(files)) {
          if (url.includes(name))
            return Promise.resolve(new Response(src, { status: 200 }));
        }
      }
      return orig.call(window, url, ...args);
    };
  }, loaderFiles);

  await page.click(`#${variantRadioId}`);

  console.log(`Generating ${label} COS code…`);
  await page.click('#run');

  await page.waitForSelector('#output-section pre', { timeout: 120_000 });

  const output = await page.$eval('#output-section pre', (el) =>
    el.textContent.trim()
  );
  if (!output) {
    const status = await page.$eval('#status', (el) => el.textContent);
    throw new Error(`Empty output for ${label}. Status: "${status}"`);
  }
  console.log(`  ${output.length} chars generated.`);

  await page.close();
  return output;
}

function inject(filePath, output) {
  const html = readFileSync(filePath, 'utf8');
  if (!INJECT_RE.test(html)) {
    throw new Error(
      `No injection point found in ${filePath}.\n` +
        'Add  <!-- COS demo marker -->  where the code should go.'
    );
  }
  writeFileSync(
    filePath,
    html.replace(INJECT_RE, `<!-- COS demo -->\n${output}\n<!-- /COS demo -->`),
    'utf8'
  );
  console.log(`  ${filePath} updated.`);
}

console.log('Launching browser…');
const browser = await puppeteer.launch({ channel: 'chrome', headless: true });

try {
  const staticSrc = readFileSync(
    resolve(__dirname, 'cos-loader-static.js'),
    'utf8'
  );
  const dynamicSrc = readFileSync(
    resolve(__dirname, 'cos-loader-dynamic.js'),
    'utf8'
  );

  // ── Static build → index.html ────────────────────────────────────────────
  const staticOutput = await generate(browser, {
    loaderFiles: { 'cos-loader-static.js': staticSrc },
    variantRadioId: 'variant-static',
    label: 'static',
  });
  inject(resolve(__dirname, 'index-static.html'), staticOutput);

  // ── Dynamic build → index-dynamic.html ──────────────────────────────────
  const dynamicOutput = await generate(browser, {
    loaderFiles: { 'cos-loader-dynamic.js': dynamicSrc },
    variantRadioId: 'variant-dynamic',
    label: 'dynamic',
  });
  inject(resolve(__dirname, 'index-dynamic.html'), dynamicOutput);
} finally {
  await browser.close();
}
