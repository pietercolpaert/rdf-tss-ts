# rdf-tss-ts

A TypeScript library to read, follow and write [RDF Time Series Snippets](https://knowledgeonwebscale.github.io/rdf-timeseriessnippets/) (RDF-TSS).

> **Status: API draft.** This README describes the planned interface. The RDF-TSS spec itself is marked *Not Ready For Implementation*, so names and behaviour may still change.

## What is a snippet?

A snippet is a table of readings described in RDF: one time column, and one column per field. The RDF metadata says what each field observes (property, unit, sensor, feature of interest), the time window, and whether points can still be added. The points themselves are stored in one of five ways, set by the snippet's class:

| Snippet class | Where the points are | Can be appended to |
|---|---|---|
| `tss:EmbeddedRDFSnippet` | RDF nodes in the same document | yes |
| `tss:EmbeddedJSONSnippet` | an `rdf:JSON` literal in the same document | yes |
| `tss:CSVSnippet` | an external CSV file | yes* |
| `tss:ArrowSnippet` | an external Arrow file | yes* (IPC stream format) |
| `tss:ParquetSnippet` | an external Parquet file | no, written once |

\* Appending to external files is not yet defined in the spec; see [Open spec issues](#open-spec-issues).

## Install

```sh
npm install rdf-tss
```

The library runs in Node and in the browser. Reading local files, and all writing to files, needs Node. In the browser, read with `Snippet.fetch` or from an RDF/JS `Dataset`.

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

Conversion only applies to fields with a `tss:unit`. Converted values are decimals; only `'source'` keeps the published text exactly. Converting to a unit of a different dimension throws `UnitConversionError`.

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

With `follow: true`, the stream first returns the existing points and then keeps polling for new ones. It ends when:

- the snippet becomes immutable (`tss:mutable false`), after the remaining points,
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

The default mapping uses SOSA, QUDT and Dublin Core, as in the informative section of the spec. Pass `{ mapping: myMapper }` to use another vocabulary. Fields without `tss:observedProperty` produce no observations.

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
  csv: { delimiter: ',', encoding: 'utf-8', header: true },
  mutable: true,
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

await writeFile('./weather-2026-11.ttl', await snippet.serialize('text/turtle'));
await snippet.close();
```

Each `append` checks the readings (datatypes, unique times, time order), adds them, widens the window, and recomputes the summaries. If the snippet would no longer conform, nothing is changed and a `ValidationError` is thrown.

### Continue writing to an existing snippet

```ts
const snippet = await Snippet.open('./weather-2026-11.ttl', { write: true });
await snippet.append(next);
```

Opening for writing fails with:

- `NotWritableError` if the snippet is immutable or its class can't be appended to (Parquet),
- `LockError` if another process is already writing. Only one writer is allowed at a time.

### Finish a snippet

```ts
await snippet.close({ freeze: true });   // sets tss:mutable false; followers stop
```

For Parquet, rows are collected in memory and the file is written on `close()`. Parquet snippets are always written frozen.

## API

`Dataset` is the RDF/JS [`DatasetCore`](https://rdf.js.org/types/) interface.

### Opening and fetching

```ts
// local file (Node) or Dataset
Snippet.open(source: string | Dataset, options?: {
  snippet?: string;          // IRI of the snippet, if the document has several
  write?: boolean;           // default false; true returns a WritableSnippet
}): Promise<ReadableSnippet>   // WritableSnippet when write is true

// remote document
Snippet.fetch(source: string | URL, options?: {
  snippet?: string;          // IRI of the snippet, if the document has several
  fetch?: typeof fetch;      // custom fetch, e.g. with authentication
  localFiles?: boolean;      // default false: whether the document may refer to local files
}): Promise<ReadableSnippet>
```

In the future, writing could also target a remote location that supports POST (e.g., through the LWS protocol).

### `ReadableSnippet`

| Member | Description |
|---|---|
| `id` | IRI of the snippet |
| `kind` | `'EmbeddedRDF' \| 'EmbeddedJSON' \| 'CSV' \| 'Parquet' \| 'Arrow'` |
| `metadata` | time field, fields, `from`, `until`, `mutable`, labels |
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

### `WritableSnippet` (extends `ReadableSnippet`)

| Member | Description |
|---|---|
| `append(reading \| readings[])` | adds readings; all or nothing |
| `serialize(mediaType)` | the metadata (and embedded points) as Turtle, JSON-LD, … |
| `close({ freeze? })` | writes outstanding data, releases the lock; `freeze` sets `mutable false` |

### `Reading`

```ts
interface Reading {
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
toRDFMessages(readings: AsyncIterable<Reading>, options?: { mapping?: 'sosa' | ObservationMapper })
  : AsyncIterable<RDFMessage>

convertUnit(value: string, from: string, to: string): string
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

- **Following a stream:** how consumers detect updates, and how CSV and Arrow files are appended to. `tss:committedUntil` is proposed for removal ([issue #20](https://github.com/KNowledgeOnWebScale/rdf-timeseriessnippets/issues/20)), so the library does not rely on it.
- **Single writer:** how to prevent two processes writing to the same snippet.
- **Empty values:** an empty string and no value are currently the same.
- **Several snippets in one file:** each snippet repeats the file configuration, and long tables (`sensor_id, time, value`) can't be described.

Until these are settled, the behaviour of `follow`, `append` on external files, and locking is provisional.

