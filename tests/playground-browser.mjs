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
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    console.error(`404 ${req.url}`);
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
  // the gold prices are read from GitHub: answer with three years of months, so the test runs offline
  const GOLD = 'https://raw.githubusercontent.com/datasets/gold-prices/';
  const goldMonths = Array.from({ length: 36 }, (_, n) => `${1833 + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-01,${(18.93 + n / 10).toFixed(3)}`);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (!request.url().startsWith(GOLD)) return request.continue();
    request.respond({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: `Date,Price\n${goldMonths.join('\n')}\n` });
  });

  const ready = () => page.waitForFunction(() => !document.getElementById('result').hidden && document.querySelector('#panel-chart svg'), { timeout: 20000 });
  const text = (selector) => page.$eval(selector, (e) => e.textContent);
  /** Pick a dataset in the drop-down and wait until it is shown. */
  const choose = async (id) => {
    await page.select('#dataset', id);
    await page.waitForFunction((id) => decodeURIComponent(location.hash.slice(1)) === id && !document.getElementById('result').hidden, { timeout: 30000 }, id);
    await ready();
  };

  await page.goto(base, { waitUntil: 'networkidle0' });
  await ready();
  const examples = JSON.parse(await (await fetch(`${base}examples/index.json`)).text());
  assert.ok(examples.length >= 10, 'the examples are listed');
  console.log(`first example: ${await text('#title')}`);

  // every example renders a chart, in every format
  // the drop-down groups them in categories
  const groups = await page.$$eval('#dataset optgroup', (nodes) => nodes.map((n) => n.label));
  assert.ok(groups.length >= 3, `categories: ${groups}`);
  console.log(`categories: ${groups.join(' | ')}`);
  // the data files of the core datasets are on GitHub: scripts/datahub.ts reads them when it writes their
  // descriptions; here only the gold prices are read, from a stand-in
  const remote = examples.filter((e) => e.remote);
  assert.ok(remote.length >= 40, `the time series of the core datasets on GitHub: ${remote.length}`);
  for (const example of examples.filter((e) => !e.remote || e.id === 'gold-prices')) {
    await choose(example.id);
    const status = await text('#status');
    assert.equal(status, '', `${example.id}: ${status}`);
    const paths = await page.$$eval('#panel-chart svg path.line', (nodes) => nodes.filter((n) => (n.getAttribute('d') ?? '').length > 5).length);
    assert.ok(paths >= 1, `${example.id} draws a line`);
    const subtitle = await text('#subtitle');
    console.log(`  ok ${example.id.padEnd(28)} ${subtitle}`);
  }

  // gold prices: a time grid of one month without a step field, over a CSV file on another site
  await choose('gold-prices');
  assert.match(await text('#subtitle'), /CSV source · 36 rows · 2 fields · from 1833-01-01T00:00:00Z · growing/);
  // the unit the metadata makes of QUDT units shows its qudt:symbol, and has no conversion to choose
  assert.equal(await text('#panel-chart .chart h3'), 'Gold price ($/oz{Troy})');
  assert.equal((await page.$$('#panel-chart .chart select')).length, 0, 'no unit to convert to');
  await page.click('#tab-table');
  await page.waitForFunction(() => document.querySelector('#panel-table table'));
  const goldRows = await page.$$eval('#panel-table tbody tr', (trs) => [0, 13].map((i) => [...trs[i].children].map((td) => td.textContent)));
  assert.deepEqual(goldRows, [
    ['1833-01-01T00:00:00Z', '18.930', '1833-01-01'],
    ['1834-02-01T00:00:00Z', '20.230', '1834-02-01'],
  ]);
  console.log(`  ok gold: the rows are at their month; ${goldRows[1].join(' ')}`);
  await page.click('#tab-chart');

  // units: temperature in Fahrenheit, with QUDT through eyemind
  await choose('weather-csv');
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
  // the code sample names the unit per field: the other fields keep theirs
  const code = await text('#code');
  assert.match(code, /unit: \{ temp\w*: unit\('DEG_F'\) \}/, `the code sample: ${code}`);
  const tooltipValues = await page.$$eval('#panel-chart .chart svg', (svgs, i) => svgs[i].querySelectorAll('circle').length, index);
  assert.ok(tooltipValues > 0, 'the converted chart has points');
  console.log(`  ok units: ${before} -> °F (${note.slice(0, 60)}…)`);
  // the table shows the converted numbers: 8 + 5 sin(...) °C at 09:00 is 8 °C = 46.4 °F
  await page.click('#tab-table');
  await page.waitForFunction(() => document.querySelector('#panel-table table'));
  const rows = await page.$$eval('#panel-table tbody tr', (trs) => trs.slice(9, 10).map((tr) => [...tr.children].map((td) => td.textContent)));
  assert.equal(rows[0][0], '2026-11-17T09:00:00Z');
  assert.equal(rows[0][1], '46.4', `converted at 09:00: ${rows[0]}`);

  // months of Telraam data in a binary format, with a speed in km/h that converts to m/s
  const months = examples.find((e) => e.id.startsWith('telraam-months-'));
  if (months) {
    await choose(months.id);
    const subtitle = await text('#subtitle');
    const rowCount = Number(/(\d+) rows/.exec(subtitle)?.[1]);
    assert.ok(rowCount > 1500, `months of hourly rows: ${subtitle}`);
    const titles = await page.$$eval('#panel-chart .chart h3', (nodes) => nodes.map((n) => n.textContent));
    const speed = titles.findIndex((t) => t.includes('km/h'));
    assert.ok(speed >= 0, `a speed chart in km/h: ${titles}`);
    await (await (await page.$$('#panel-chart .chart'))[speed].$('select')).select('http://qudt.org/vocab/unit/M-PER-SEC');
    await page.waitForFunction((i) => document.querySelectorAll('#panel-chart .chart h3')[i].textContent.includes('m/s'), { timeout: 30000 }, speed);
    console.log(`  ok months: ${subtitle}; speed km/h -> m/s`);

    // months of hourly values are downsampled to a daily average, and zooming in shows the raw values
    const chartStatus = (i) => page.$$eval('#panel-chart .chart .chart-status', (nodes, i) => nodes[i].textContent, i);
    const counts = titles.findIndex((t) => !t.includes('km/h'));
    assert.match(await chartStatus(counts), /average per day with a band from the minimum to the maximum/);
    const box = await (await page.$$('#panel-chart .chart svg'))[counts].boundingBox();
    const dragTo = async (from, to) => {
      await page.mouse.move(box.x + box.width * from, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * to, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    };
    await dragTo(0.5, 0.6); // about 11 days: a point per 3 hours, or raw
    await page.waitForFunction((i) => !/per day/.test(document.querySelectorAll('#panel-chart .chart .chart-status')[i].textContent), {}, counts);
    const zoomed = await chartStatus(counts);
    assert.match(zoomed, /average per (3 hours|6 hours|hour)|all shown/, zoomed);
    await dragTo(0.4, 0.45); // about 4 days: the raw values
    await page.waitForFunction((i) => /all shown/.test(document.querySelectorAll('#panel-chart .chart .chart-status')[i].textContent), {}, counts);
    await page.$$eval('#panel-chart .chart .overlay', (nodes, i) => nodes[i].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), counts);
    await page.waitForFunction((i) => /per day/.test(document.querySelectorAll('#panel-chart .chart .chart-status')[i].textContent), {}, counts);
    // the charts of a source zoom together: the speed chart follows the counts chart
    await dragTo(0.5, 0.6);
    await page.waitForFunction((i) => !/per day/.test(document.querySelectorAll('#panel-chart .chart .chart-status')[i].textContent), {}, speed);
    const ticks = (i) => page.$$eval('#panel-chart .chart', (nodes, i) => [...nodes[i].querySelectorAll('.axis text[text-anchor="middle"]')].map((t) => t.textContent).join('|'), i);
    assert.equal(await ticks(speed), await ticks(counts), 'both charts show the same times');
    await page.$$eval('#panel-chart .chart .chart-tools button', (nodes) => nodes[0].click());
    await page.waitForFunction((i) => /per day/.test(document.querySelectorAll('#panel-chart .chart .chart-status')[i].textContent), {}, speed);
    console.log('  ok months: downsampled to days, zoom shows more, double-click zooms out');
  }

  // patterns: the matrix profile and the contextual matrix profile of months of hourly values
  if (months) {
    await page.click('#tab-patterns');
    await page.waitForFunction(() => document.querySelector('#panel-patterns canvas.cmp'), { timeout: 60000 });
    const patternsStatus = await text('#panel-patterns .status');
    assert.match(patternsStatus, /windows of 22 values compared in \d+ ms/, patternsStatus);
    const windowLabel = () => page.$eval('#panel-patterns input[type=number]', (input) => input.closest('label').textContent);
    assert.match(await windowLabel(), /= 22 h, one value per 1 h: a day minus the shift tolerance, so a window that starts late still ends within its day/);
    assert.equal(await page.$$eval('#panel-patterns .chart svg', (nodes) => nodes.length >= 2), true, 'the series and its matrix profile');
    const size = await page.$eval('#panel-patterns canvas.cmp', (c) => [c.width, c.height]);
    assert.ok(size[0] > 100 && size[0] === size[1], `a square heatmap of days: ${size}`);
    const canvas = await page.$('#panel-patterns canvas.cmp');
    await canvas.evaluate((c) => c.scrollIntoView({ block: 'center' }));
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
    await page.waitForFunction(() => document.querySelector('#panel-patterns .cmp-match svg path.line'));
    assert.match(await text('#panel-patterns .cmp-match'), /the best match is the window of 22 h/);
    assert.ok((await page.$$('#panel-patterns .cmp-list li')).length >= 3, 'the days that differ most');
    // another window length is computed again
    await page.$eval('#panel-patterns input[type=number]', (input) => {
      input.value = '12';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => /windows of 12 values compared/.test(document.querySelector('#panel-patterns .status').textContent), { timeout: 60000 });
    assert.match(await windowLabel(), /= 12 h, one value per 1 h$/, 'a shorter window needs no explanation');
    console.log(`  ok patterns: ${patternsStatus}; heatmap ${size[0]} x ${size[1]} days`);
    await page.click('#tab-chart');
  }

  // your own URL
  await page.select('#dataset', '__custom__');
  assert.equal(await page.$eval('#url-form', (f) => f.hidden), false, 'the URL form appears');
  await page.$eval('#url', (input) => (input.value = ''));
  await page.type('#url', `${base}examples/weather-csv.ttl`);
  await page.click('#open');
  await page.waitForFunction(() => document.getElementById('dataset').value === 'weather-csv', { timeout: 20000 });

  // every other tab, for a Telraam location
  await choose('telraam-27387');
  assert.equal(await page.$$eval('#panel-chart .legend label', (l) => l.length), 8, 'eight series in one chart');
  await page.click('#tab-metadata');
  await page.waitForFunction(() => document.querySelector('#panel-metadata pre'));
  assert.match(await text('#panel-metadata pre'), /tss:CSVSource/);
  await page.click('#tab-messages');
  await page.waitForFunction(() => document.querySelector('#panel-messages .message'));
  // the expansion: the points link to their field; with the alignment, they are SOSA observations too
  assert.match(await text('#panel-messages'), /tss:hasPoint/);
  assert.match(await text('#panel-messages'), /tss:field/);
  await page.select('#msg-align', 'sosa');
  await page.waitForFunction(() => /sosa:Observation/.test(document.querySelector('#panel-messages').textContent));
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
