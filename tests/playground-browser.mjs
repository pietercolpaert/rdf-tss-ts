// Run after `npm run build:site`: opens every example of the playground in a real browser
// and checks that it renders, that units convert, and that no script error occurs.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const root = resolve(new URL('../_site', import.meta.url).pathname);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.ttl': 'text/turtle', '.csv': 'text/csv', '.arrows': 'application/vnd.apache.arrow.stream', '.parquet': 'application/vnd.apache.parquet',
};
const server = createServer(async (req, res) => {
  try {
    const path = normalize(join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html')));
    if (!path.startsWith(root)) throw new Error('outside');
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const executablePath = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium'].find(
  (p) => p && existsSync(p),
);
assert.ok(executablePath, 'no Chrome found: set CHROME');
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const problems = [];
let failed = false;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => message.type() === 'error' && problems.push(`console error: ${message.text()}`));
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()}`));

  const ready = () => page.waitForFunction(() => !document.getElementById('result').hidden && document.querySelector('#panel-chart svg'), { timeout: 20000 });
  const text = (selector) => page.$eval(selector, (e) => e.textContent);

  await page.goto(base, { waitUntil: 'networkidle0' });
  await ready();
  const examples = JSON.parse(await (await fetch(`${base}examples/index.json`)).text());
  assert.ok(examples.length >= 10, 'the examples are listed');
  console.log(`first example: ${await text('#title')}`);

  // every example renders a chart, in every format
  for (const example of examples) {
    await page.click(`.chip[data-id="${example.id}"]`);
    await page.waitForFunction((id) => document.querySelector(`.chip[data-id="${id}"]`)?.getAttribute('aria-pressed') === 'true' && !document.getElementById('result').hidden, {}, example.id);
    await ready();
    const status = await text('#status');
    assert.equal(status, '', `${example.id}: ${status}`);
    const paths = await page.$$eval('#panel-chart svg path.line', (nodes) => nodes.filter((n) => (n.getAttribute('d') ?? '').length > 5).length);
    assert.ok(paths >= 1, `${example.id} draws a line`);
    const subtitle = await text('#subtitle');
    console.log(`  ok ${example.id.padEnd(28)} ${subtitle}`);
  }

  // units: temperature in Fahrenheit, with QUDT through eyemind
  await page.click('.chip[data-id="weather-csv"]');
  await page.waitForFunction(() => document.querySelector('.chip[data-id="weather-csv"]')?.getAttribute('aria-pressed') === 'true');
  await ready();
  const charts = await page.$$('#panel-chart .chart');
  assert.equal(charts.length, 4, 'four charts: temperature, humidity, wind speed, pressure');
  const before = await page.$eval('#panel-chart .chart:nth-of-type(2) h3, #panel-chart .chart h3', (e) => e.textContent);
  const titles = await page.$$eval('#panel-chart .chart h3', (nodes) => nodes.map((n) => n.textContent));
  assert.ok(titles.some((t) => t.includes('°C')), `a chart in °C: ${titles}`);
  const index = titles.findIndex((t) => t.includes('°C'));
  await (await page.$$('#panel-chart .chart select'))[index].select('http://qudt.org/vocab/unit/DEG_F');
  await page.waitForFunction((i) => document.querySelectorAll('#panel-chart .chart h3')[i].textContent.includes('°F'), { timeout: 30000 }, index);
  const note = await page.$$eval('#panel-chart .chart .note', (nodes, i) => nodes[i].textContent, index);
  assert.match(note, /Converted from °C to °F/);
  const tooltipValues = await page.$$eval('#panel-chart .chart svg', (svgs, i) => svgs[i].querySelectorAll('circle').length, index);
  assert.ok(tooltipValues > 0, 'the converted chart has points');
  console.log(`  ok units: ${before} -> °F (${note.slice(0, 60)}…)`);
  // the table shows the converted numbers: 8 + 5 sin(...) °C at 09:00 is 8 °C = 46.4 °F
  await page.click('#tab-table');
  await page.waitForFunction(() => document.querySelector('#panel-table table'));
  const rows = await page.$$eval('#panel-table tbody tr', (trs) => trs.slice(9, 10).map((tr) => [...tr.children].map((td) => td.textContent)));
  assert.equal(rows[0][0], '2026-11-17T09:00:00Z');
  assert.equal(rows[0][1], '46.4', `converted at 09:00: ${rows[0]}`);

  // every other tab, for a Telraam location
  await page.click('.chip[data-id="telraam-27387"]');
  await page.waitForFunction(() => document.querySelector('.chip[data-id="telraam-27387"]')?.getAttribute('aria-pressed') === 'true');
  await ready();
  assert.equal(await page.$$eval('#panel-chart .legend label', (l) => l.length), 8, 'eight series in one chart');
  await page.click('#tab-metadata');
  await page.waitForFunction(() => document.querySelector('#panel-metadata pre'));
  assert.match(await text('#panel-metadata pre'), /tss:CSVSnippet/);
  await page.click('#tab-messages');
  await page.waitForFunction(() => document.querySelector('#panel-messages .message'));
  assert.match(await text('#panel-messages'), /sosa:Observation/);
  await page.click('#tab-validate');
  await page.waitForFunction(() => document.querySelector('#panel-validate .badge'));
  assert.match(await text('#panel-validate'), /conforms/);
  await page.click('#tab-compare');
  await page.waitForFunction(() => document.querySelector('#panel-compare .facts'));
  const facts = await text('#panel-compare .facts');
  assert.match(facts, /smaller/);
  console.log(`  ok compared to the LDES: ${facts.replace(/\s+/g, ' ').trim()}`);

  assert.deepEqual(problems, [], 'no errors in the page');
  console.log('playground ok');
} catch (error) {
  failed = true;
  console.error(error);
  if (problems.length) console.error(problems);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
