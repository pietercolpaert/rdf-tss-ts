# rdf-tss-ts

A TypeScript library to read, follow and write [RDF Time Series Snippets](https://knowledgeonwebscale.github.io/rdf-timeseriessnippets/) (RDF-TSS).

> **Status: first implementation of an API draft.** The RDF-TSS spec itself is marked *Not Ready For Implementation*, so names and behaviour may still change. This version follows the proposal of [pull request #25](https://github.com/KNowledgeOnWebScale/rdf-timeseriessnippets/pull/25): a snippet *grows* until it is *ended* with `tss:immutable true`, and followers use plain HTTP (`Range`, `ETag`, `max-age`).

**Try the [playground](https://pietercolpaert.github.io/rdf-tss-ts/)**: pick a dataset from the drop-down (months of Telraam traffic counts and speeds, and a day of weather in every format), see charts, convert units with QUDT, and see the RDF Messages. The Telraam data is read from the [Telraam LDES](https://ldes.telraam-api.net/measurements) as RDF Messages and turned into binary snippets, see [Telraam](#telraam).

## What is a snippet?

A snippet is a table of readings described in RDF: one time column, and one column per field. The RDF metadata says what each field observes (property, unit, sensor, feature of interest), the time window, and whether the snippet has ended (`tss:immutable true`). A snippet that has not ended is *growing*: points are only ever added at its end. The points themselves are stored in one of five ways, set by the snippet's class:

| Snippet class | Where the points are | Can be appended to |
|---|---|---|
| `tss:EmbeddedRDFSnippet` | RDF nodes in the same document | yes |
| `tss:EmbeddedJSONSnippet` | an `rdf:JSON` literal in the same document | yes |
| `tss:CSVSnippet` | an external CSV file | yes* |
| `tss:ArrowSnippet` | an external Arrow file | yes* (IPC streaming format; the IPC file format is read-only, for immutable snippets) |
| `tss:ParquetSnippet` | an external Parquet file | no, written once |

\* Growing is by appending bytes: a CSV row, an Arrow record batch, or a message at the end of an RDF Message Log. An embedded RDF snippet is an [RDF Message Log](https://w3c-cg.github.io/rsp/spec/messages): the metadata is the first message and every point is a message. See [Open spec issues](#open-spec-issues).

## Install

```sh
npm install rdf-tss
```

The library runs in Node and in the browser. Reading local files, and all writing to files, needs Node. In the browser, read with `Snippet.fetch` or from an RDF/JS `Dataset`.

Metadata documents are loaded with [ldfetch](https://github.com/pietercolpaert/ldfetch), so they can be in any RDF syntax, also as an RDF Message Log (the messages are merged, and kept for following). Data files (CSV, Arrow, Parquet) are fetched with plain HTTP.

Formats and units need packages that you only install when you use them (optional peer dependencies):

| You use | Install |
|---|---|
| Arrow snippets | `apache-arrow` |
| Parquet snippets | `hyparquet` (reading), `hyparquet-writer` (writing) |
| `unit: 'qudt'`, `unit: <IRI>`, `convertUnit` | `eyemind` (version 0.8.4) |

## Reading snippets

### Read a snippet

```ts
import { Snippet } from 'rdf-tss';

const snippet = await Snippet.open('./weather-2026-11.ttl');

for await (const reading of snippet.read()) {
  console.log(reading.time, reading.get('temperature')?.value);
}
```

`Snippet.open` reads a local file. For a remote snippet use `Snippet.fetch`:

```ts
const snippet = await Snippet.fetch('https://example.org/weather/2026-11.ttl');
```

Fields are identified by their local name (`temperature`) or by their full IRI (`https://example.org/fields/temperature`). The local name is the part after the last `#` or `/`. If two fields share a local name, using it throws an error; use the IRI then.

If the document contains several snippets, pick one:

```ts
const snippet = await Snippet.open(file, { snippet: 'https://example.org/weather/2026-11#snippet' });
```

### Read a time range and selected fields

```ts
for await (const r of snippet.read({
  from: '2026-11-17T00:00:00Z',     // included
  until: '2026-11-18T00:00:00Z',    // excluded
  fields: ['temperature'],
})) { … }
```

### Choose the unit

```ts
snippet.read();                          // unit: 'source' (default), exact text as published
snippet.read({ unit: 'qudt' });          // converted to the QUDT normalized unit
snippet.read({ unit: 'http://qudt.org/vocab/unit/DEG_F' });  // converted to a unit you choose
```

Conversion only applies to fields with a `tss:unit`. Converted values are numbers computed with the [QUDT](https://qudt.org/) unit catalog of [eyemind](https://github.com/eyereasoner/eyemind), so they are `xsd:double`s rounded to 12 significant digits; only `'source'` keeps the published text exactly. Converting to a unit of a different dimension throws `UnitConversionError`, and so does a unit that is not in the catalog.

The conversion of a unit is looked up once, with eyemind, and then applied to every reading with plain arithmetic, so reading stays fast. In the browser, hand the library eyemind's `main` yourself, see the [playground](playground/app.ts).

### Follow a live snippet

```ts
const controller = new AbortController();

for await (const r of snippet.read({
  from: '2026-11-17T12:00:00Z',
  follow: true,                      // or { interval: 'PT30S' }
  signal: controller.signal,
})) {
  render(r);
}
```

With `follow: true`, the stream first returns the existing points and then keeps polling for new ones. It does what a client of any growing file does, and no more:

- **Appended bytes only.** A CSV or Arrow file, and an embedded RDF Message Log, are asked for with `Range: bytes=<length so far>-`. The server answers `206` with the new bytes, `416` when nothing was added, and `200` with the whole file when it does not support ranges (then the library skips what it already has). A file that got shorter is read again from the start. Only complete rows, record batches and messages are used; a half-written one is waited for.
- **The metadata of an external snippet** is fetched again every round, to see whether the snippet has ended; HTTP caching (`ETag`, `max-age`) does the rest. The default interval is the `max-age` of the response (at least a second), or 10 seconds.
- **Parquet** is written once and is always immutable: nothing to follow.

It ends when:

- the snippet has ended (`tss:immutable true`), after the remaining points,
- you set an `until` and a point at or after it has been seen,
- you call `controller.abort()`, or stop iterating with `break`.

On an immutable snippet, `follow: true` behaves like a normal read, so you can always pass it.

### Turn readings into RDF Messages

```ts
import { toRDFMessages } from 'rdf-tss';

for await (const message of toRDFMessages(snippet.read({ follow: true }))) {
  publish(message);   // one message per reading, one observation per measured field
}
```

The default mapping uses SOSA, QUDT and Dublin Core, as in the informative section of the spec. Pass `{ mapping: myMapper }` to use another vocabulary.

What you get follows the spec's expansion into observations:

- Only fields with `tss:observedProperty` produce observations. A status or identifier column produces nothing, and describing fields are not output on their own.
- Each observation links back to the snippet (`dcterms:source`), and states the observed property, sensor, feature of interest, unit, time and result.
- The result is the `Value` as read: its text and datatype, and its unit after any conversion. Use `snippet.read({ unit: 'qudt' })` and the observations carry the converted value and the new unit together.
- The first message also carries the description from the snippet's metadata of the IRIs the observations use (observed properties, sensors, …), without any TSS terms. Set `description: 'every'` to repeat it in each message, or `'none'` to leave it out.

## Writing snippets

Writing is more advanced than reading and needs Node.

### Create a new snippet and write to it

```ts
import { Snippet } from 'rdf-tss';

const ex = 'https://example.org/';

const snippet = await Snippet.create({
  id: `${ex}weather/2026-11#snippet`,
  kind: 'CSV',
  dataFile: './weather-2026-11.csv',
  file: './weather-2026-11.ttl',     // the metadata: written now, and after every append
  csv: { delimiter: ',', encoding: 'utf-8', header: true },
  timeField: { id: `${ex}fields/time`, columnName: 'time' },
  fields: [{
    id: `${ex}fields/temperature`,
    columnName: 'temp',
    datatype: 'http://www.w3.org/2001/XMLSchema#decimal',
    observedProperty: `${ex}props/airTemperature`,
    unit: 'http://qudt.org/vocab/unit/DEG_C',
    sensor: `${ex}sensors/s1`,
  }],
});

await snippet.append({
  time: '2026-11-17T12:00:00Z',
  values: { temperature: '8.4' },    // local name or full IRI
});

await snippet.append([   // a batch: either all readings are added, or none
  { time: '2026-11-17T12:10:00Z', values: { temperature: '8.6' } },
  { time: '2026-11-17T12:20:00Z', values: { temperature: '8.5' } },
]);

await snippet.close();
```

With `file`, the metadata is kept up to date on disk, so followers see every append; without it, call `await snippet.serialize('text/turtle')` and write the result yourself. The lock is taken on the metadata file (or on the data file when there is no `file`).

Each `append` checks the readings (datatypes, unique increasing times, inside the `from`/`until` window of the snippet) and then only *adds data at the end*: a CSV row, an Arrow record batch, a message of the log. The window is fixed when the snippet is created, and no summaries are written while it grows. If a reading does not conform, nothing is changed and a `ValidationError` is thrown.

### Continue writing to an existing snippet

```ts
const snippet = await Snippet.open('./weather-2026-11.ttl', { write: true });
await snippet.append(next);
```

The metadata file is rewritten after every `append` (as Turtle, JSON-LD, … according to its extension; comments and prefixes are not kept).

Opening for writing fails with:

- `NotWritableError` if the snippet is immutable or its class can't be appended to (Parquet),
- `LockError` if another process is already writing. Only one writer is allowed at a time.

### Finish a snippet

```ts
await snippet.close({ freeze: true });   // ends the snippet: tss:immutable true; followers stop
```

`close()` alone releases the lock and leaves the snippet growing, so that you can continue later. `close({ freeze: true })` ends it: the metadata gets `tss:immutable true` and, with `summaries` (the default), a stored summary of every field, computed over the whole snippet; an Arrow stream gets its end-of-stream marker. An embedded RDF snippet gets a final message.

For Parquet, rows are collected in memory and the file is written on `close()`. Parquet snippets are always immutable once written.

## API

`Dataset` is the RDF/JS [`DatasetCore`](https://rdf.js.org/types/) interface.

### Opening and fetching

```ts
// local file (Node) or Dataset
Snippet.open(source: string | Dataset, options?: {
  snippet?: string;          // IRI of the snippet, if the document has several
  write?: boolean;           // default false; true returns a WritableSnippet
}): Promise<ReadableSnippet>   // WritableSnippet when write is true

// remote document, loaded with ldfetch
Snippet.fetch(source: string | URL, options?: {
  snippet?: string;          // IRI of the snippet, if the document has several
  fetch?: typeof fetch;      // custom fetch for the data files and following, e.g. with authentication
  headers?: Record<string, string>;   // headers for every request
  loader?: RdfLoader;        // replace ldfetch for the metadata
  localFiles?: boolean;      // default false: whether the document may refer to local files
  unitConverter?: UnitConverter;   // default: eyemind with QUDT
}): Promise<ReadableSnippet>
```

In the future, writing could also target a remote location that supports POST (e.g., through the LWS protocol).

### `ReadableSnippet`

| Member | Description |
|---|---|
| `id` | IRI of the snippet |
| `kind` | `'EmbeddedRDF' \| 'EmbeddedJSON' \| 'CSV' \| 'Parquet' \| 'Arrow'` |
| `metadata` | time field, fields, `from`, `until`, `immutable`, labels |
| `read(options?)` | `AsyncIterable<Reading>`, see below |
| `summary(field)` | the summary stored in the snippet for a field |
| `validate()` | a `Report` listing every rule that fails and where |

`read` options:

| Option | Default | Description |
|---|---|---|
| `from` | snippet start | included |
| `until` | snippet end | excluded |
| `fields` | all | fields to include, by local name or IRI |
| `unit` | `'source'` | `'source'`, `'qudt'`, or a unit IRI |
| `follow` | `false` | `true` or `{ interval }` (an `xsd:duration`) |
| `signal` | none | `AbortSignal` to stop |

### Creating and writing

```ts
Snippet.create(options: CreateOptions): Promise<WritableSnippet>
```

| `CreateOptions` | Description |
|---|---|
| `id`, `kind` | IRI of the snippet; `'EmbeddedRDF' \| 'EmbeddedJSON' \| 'CSV' \| 'Parquet' \| 'Arrow'` |
| `timeField`, `fields` | `{ id, columnName? }` and a list of `{ id, columnName?, datatype?, label?, observedProperty?, unit?, sensor?, featureOfInterest?, … }`; the column name defaults to the local name, the datatype to `xsd:decimal` |
| `dataFile` | path of the data file of an external snippet |
| `file` | path of the metadata file, kept up to date; the lock is taken on it |
| `csv` | `{ delimiter?, encoding?, header? }` |
| `immutable`, `from`, `until`, `label` | as in the metadata; a new snippet grows, unless `immutable` |
| `summaries` | store a summary of every field when the snippet ends, default `true` |
| `prefixes` | prefixes for the Turtle of the metadata |

### `WritableSnippet` (extends `ReadableSnippet`)

| Member | Description |
|---|---|
| `append(reading \| readings[])` | adds readings; all or nothing |
| `serialize(mediaType?, prefixes?)` | the metadata (and embedded points) as Turtle, TriG, N-Triples, N-Quads or JSON-LD |
| `close({ freeze? })` | writes outstanding data, releases the lock; `freeze` ends the snippet (`tss:immutable true`, summaries) |

### `Reading`

```ts
interface Reading {
  snippet: ReadableSnippet;              // the snippet this reading comes from
  time: string;                          // xsd:dateTimeStamp, exactly as published
  get(field: string): Value | undefined; // local name or IRI; undefined means no value
  fields(): Iterable<[string, Value]>;
}

interface Value {
  value: string;      // lexical form; exact text when unit is 'source'
  datatype: string;   // xsd datatype IRI
  unit?: string;      // unit IRI after any conversion
  toNative(): number | bigint | boolean | Date | string;
}
```

Values are kept as text because the spec preserves exact text: `"2.50"` stays `"2.50"`. Call `toNative()` when you want a JavaScript value.

### Helpers

```ts
toRDFMessages(readings: AsyncIterable<Reading>, options?: {
  mapping?: 'sosa' | ObservationMapper;
  description?: 'first' | 'every' | 'none';   // metadata of the IRIs used; default 'first'
}): AsyncIterable<RDFMessage>

convertUnit(value: string, from: string, to: string | 'qudt'): Promise<string>
```

### Errors

| Error | When |
|---|---|
| `ValidationError` | the metadata or data does not conform; carries a `Report` |
| `NotWritableError` | writing to an immutable snippet, or to one whose class can't be appended to |
| `LockError` | another process is writing to the snippet |
| `UnitConversionError` | no unit, unknown unit, or units of different dimensions |

## Open spec issues

The library depends on these points, which the spec does not define yet:

- **Following a stream:** the library follows with HTTP `Range`, `ETag` and `max-age` and stops at `tss:immutable true`, as in [pull request #25](https://github.com/KNowledgeOnWebScale/rdf-timeseriessnippets/pull/25). `tss:mutable` and `tss:committedUntil` are gone; the validator reports them as removed terms. Not yet in the proposal: which Arrow format to append to (the library uses the IPC *stream* format, and also reads the IPC file format of an ended snippet).
- **Single writer:** how to prevent two processes writing to the same snippet.
- **Empty values:** an empty string and no value are currently the same.
- **Several snippets in one file:** each snippet repeats the file configuration, and long tables (`sensor_id, time, value`) can't be described.

Until these are settled, the behaviour of `follow`, `append` on external files, and locking is provisional.

## Telraam

The playground shows months of [Telraam](https://telraam.net/) traffic counts and V85 speeds. The source is a compressed RDF Message Log of TriG (about 14 million messages, one measurement each). [scripts/telraam-log.ts](scripts/telraam-log.ts) reads it as a stream, with the message parser of ldfetch ([n3.js-messages](https://github.com/pietercolpaert/n3.js-messages)), keeps some locations and writes one snippet per location in a binary format, with a column per series. The speed is in km/h, so reading it in m/s or mph is a unit conversion:

```sh
npm run examples:telraam-months -- telraam.trig.gz --out examples/telraam-months --first 12 --kind Parquet,Arrow,CSV
npm run build:site
```

## Development

```sh
npm test                # the writer makes every format, a mock server serves it, the readers read it
npm run build:site      # the examples and the playground, in _site/
npm run test:playground # opens every example in Chrome (needs a build:site first)
npm run examples:telraam [YYYY-MM-DD] [locations]   # takes a new sample from the Telraam LDES
```

The Telraam members in [examples/telraam/members.ttl](examples/telraam/members.ttl) are real: 576 members, three locations, every hour of one day. They are open data of [Telraam](https://telraam.net/).

