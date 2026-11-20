# rdf-tss-ts

A TypeScript library to read, follow, write and expand [RDF Time Series Sources](https://knowledgeonwebscale.github.io/rdf-tss/) (RDF-TSS).

> **Status: first implementation of an API draft.** The RDF-TSS spec itself is marked *Not Ready For Implementation*, so names and behaviour may still change. This version follows [pull request #31](https://github.com/KNowledgeOnWebScale/rdf-tss/pull/31), which builds on [#28](https://github.com/KNowledgeOnWebScale/rdf-tss/pull/28) (*Snippets* were renamed to *Sources*) and [#25](https://github.com/KNowledgeOnWebScale/rdf-tss/pull/25) (a source *grows* until it is *ended* with `tss:immutable true`, and followers use plain HTTP: `Range`, `ETag`, `max-age`).

**Try the [playground](https://pieter.pm/rdf-tss-ts/)**: pick a dataset from the drop-down (months of Telraam traffic counts and speeds, and a day of weather in every format), see charts (large series are downsampled to an average per day, with a min–max band; drag to zoom in on the raw values), convert units with QUDT, find repeating patterns with the matrix profile and the contextual matrix profile, and see the source expanded into points as RDF Messages. The Telraam data is read from the [Telraam LDES](https://ldes.telraam-api.net/measurements) as RDF Messages and turned into binary sources, see [Telraam](#telraam).

## What is a source?

A source is a table of readings described in RDF: one time column, and one column per field. Every row has one time; every value of a *value field* is one reading, a *point*. The RDF metadata says, per field, its datatype, where its values are, the RDF property that states them (`tss:property`), and what a value field observes (property, unit, sensor, feature of interest). It also states the time window, and whether the source has ended (`tss:immutable true`). A source that has not ended is *growing*: rows are only ever added at its end. The rows themselves are stored in one of five ways, set by the source's class:

| Source class | Where the rows are | Can be appended to |
|---|---|---|
| `tss:EmbeddedRDFSource` | RDF points in the same document | yes |
| `tss:EmbeddedJSONSource` | an `rdf:JSON` literal in the same document | yes |
| `tss:CSVSource` | an external CSV file | yes* |
| `tss:ArrowSource` | an external Arrow file | yes* (IPC streaming format; the IPC file format is read-only, for immutable sources) |
| `tss:ParquetSource` | an external Parquet file | no, written once |

\* Growing is by appending bytes: a CSV row, an Arrow record batch, or a message at the end of an RDF Message Log. An embedded RDF source is an [RDF Message Log](https://w3c-cg.github.io/rsp/spec/messages): the metadata is the first message and every row is a message. See [Open spec issues](#open-spec-issues).

### Fields: value fields, meta fields and field properties

Every field is a `tss:ValueField` (its values are readings) or a `tss:MetaField` (the time field, the step field of a time grid, a field that describes a value field with `tss:describesField`, or another field such as an identifier). A field is never itself the predicate of its values: its *field property* is. That is its `tss:property` or, by default:

- `tss:time` for the time field;
- `<base#columnName>` for any other field, as CSVW's default `propertyUrl`, where the base is the data file (external sources) or the metadata document (embedded sources).

So an embedded RDF point looks like this, one reading per point:

```turtle
ex:source tss:hasPoint [
    tss:time "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    ex:conductivity "4810.5"^^xsd:double
] .
```

The library gives each field's `kind` (`'value'` or `'meta'`), its resolved `property`, and whether that is the `defaultProperty`, in `source.metadata.fields`. A document of the earlier *Snippets* drafts (`tss:EmbeddedRDFSnippet`, …) is refused with a message that names the new class.

## Install

```sh
npm install rdf-tss
```

The library runs in Node and in the browser. Reading local files, and all writing to files, needs Node. In the browser, read with `Source.fetch` or from an RDF/JS `Dataset`.

Metadata documents are loaded with [ldfetch](https://github.com/pietercolpaert/ldfetch), so they can be in any RDF syntax, also as an RDF Message Log (the messages are merged, and kept for following). Data files (CSV, Arrow, Parquet) are fetched with plain HTTP.

Formats and units need packages that you only install when you use them (optional peer dependencies):

| You use | Install |
|---|---|
| Arrow sources | `apache-arrow` |
| Parquet sources | `hyparquet` (reading), `hyparquet-writer` (writing) |
| `unit: 'qudt'`, `unit: <IRI>`, `convertUnit` | `eyemind` (version 0.8.4) |

## Reading sources

### Read a source

```ts
import { Source } from 'rdf-tss';

const source = await Source.open('./weather-2026-11.ttl');

for await (const row of source.read()) {
  console.log(row.time, row.get('temperature')?.value);
}
```

`read()` gives the rows of the source: a time, and the values of its fields. `Source.open` reads a local file. For a remote source use `Source.fetch`:

```ts
const source = await Source.fetch('https://example.org/weather/2026-11.ttl');
```

Fields are identified by their local name (`temperature`) or by their full IRI (`https://example.org/fields/temperature`). The local name is the part after the last `#` or `/`. If two fields share a local name, using it throws an error; use the IRI then.

If the document contains several sources, pick one:

```ts
const source = await Source.open(file, { source: 'https://example.org/weather/2026-11#source' });
```

When you open an RDF/JS `Dataset`, pass `baseIRI`, the IRI of the metadata document: the default field properties of an embedded source are made from it.

### Read a time range and selected fields

```ts
for await (const r of source.read({
  from: '2026-11-17T00:00:00Z',     // included
  until: '2026-11-18T00:00:00Z',    // excluded
  fields: ['temperature'],
})) { … }
```

### Choose the unit

```ts
source.read();                          // unit: 'source' (default), exact text as published
source.read({ unit: 'qudt' });          // converted to the QUDT normalized unit
source.read({ unit: 'http://qudt.org/vocab/unit/DEG_F' });  // every field with a unit, converted to a unit you choose

// a source has fields of several dimensions: choose per field (local name or IRI);
// fields that are left out stay as published
source.read({ unit: {
  temperature: 'http://qudt.org/vocab/unit/DEG_F',
  windspeed: 'http://qudt.org/vocab/unit/M-PER-SEC',
  pressure: 'qudt',
} });
```

A single unit IRI is for a source whose fields share a dimension: it throws `UnitConversionError` for a field of another dimension (use the per-field form, or `fields` to pick the fields it applies to).

Conversion only applies to fields with a `tss:unit`. Converted values are numbers computed with the [QUDT](https://qudt.org/) unit catalog of [eyemind](https://github.com/eyereasoner/eyemind), so they are `xsd:double`s rounded to 12 significant digits; only `'source'` keeps the published text exactly. Converting to a unit of a different dimension throws `UnitConversionError`, and so does a unit that is not in the catalog.

The conversion of a unit is looked up once, with eyemind, and then applied to every reading with plain arithmetic, so reading stays fast. In the browser, hand the library eyemind's `main` yourself, see the [playground](playground/app.ts).

### Follow a live source

```ts
const controller = new AbortController();

for await (const r of source.read({
  from: '2026-11-17T12:00:00Z',
  follow: true,                      // or { interval: 'PT30S' }
  signal: controller.signal,
})) {
  render(r);
}
```

With `follow: true`, the stream first returns the existing rows and then keeps polling for new ones. It does what a client of any growing file does, and no more:

- **Appended bytes only.** A CSV or Arrow file, and an embedded RDF Message Log, are asked for with `Range: bytes=<length so far>-`. The server answers `206` with the new bytes, `416` when nothing was added, and `200` with the whole file when it does not support ranges (then the library skips what it already has). A file that got shorter is read again from the start. Only complete rows, record batches and messages are used; a half-written one is waited for.
- **The metadata of an external source** is fetched again every round, to see whether the source has ended; HTTP caching (`ETag`, `max-age`) does the rest. The default interval is the `max-age` of the response (at least a second), or 10 seconds.
- **Parquet** is written once and is always immutable: nothing to follow.

It ends when:

- the source has ended (`tss:immutable true`), after the remaining rows,
- you set an `until` and a row at or after it has been seen,
- you call `controller.abort()`, or stop iterating with `break`.

On an immutable source, `follow: true` behaves like a normal read, so you can always pass it.

### Expand a source into points, as RDF Messages

```ts
for await (const message of source.expand()) {
  publish(message);   // first the metadata, then one message per row
}
```

`expand()` follows the spec's *Expanding a source into points*, in the shape of the points of a `tss:EmbeddedRDFSource`:

- The first message is the metadata document, without `tss:points`, plus the default property of each field that states no `tss:property` (`ex:value-field tss:property <data.csv#value>`), and, for a value field, that this property is a subproperty of `tss:value`. A property the publisher states keeps the meaning of its own vocabulary: it is not made a subproperty of anything.
- Every next message holds one row: the source `tss:hasPoint` one point per value of a value field. The point links to its field (`tss:field`), and states the time (the field property of the time field) and its value (the field property of its value field, the decoded value as published), plus the values of the describing fields that describe its field. The values of other meta fields, such as a step or an identifier, are not stated.
- A point is a blank node, the RDF node of the embedded point, or the IRI made by the `tss:aboutUrl` URI template of its field (`'https://example.org/obs/{time}'`).

It takes `from`, `until`, `follow` and `signal` as `read()` does. To expand rows that you read yourself, use `toRDFMessages(source.read(options))`; the values have to be as published, so a unit conversion throws.

The spec does not map points onto SOSA or SAREF: the TSS vocabulary is aligned with them (`tss:Point` is a `sosa:Observation` and a `saref:Measurement`, `tss:time` a subproperty of `sosa:resultTime`, `tss:value` of `sosa:hasSimpleResult`, and property chains over `tss:field` carry the observed property, sensor, feature of interest and unit), so an OWL 2 RL reasoner derives the observations. Without a reasoner, ask the library to write what it would derive:

```ts
source.expand({ align: 'sosa' });              // or 'saref', or ['sosa', 'saref']
```

A value is only a result (`sosa:hasSimpleResult`, `saref:hasValue`) when its field property is aligned: a default property, or one the metadata states to be a subproperty of `tss:value`.

## Writing sources

Writing is more advanced than reading and needs Node.

### Create a new source and write to it

```ts
import { Source } from 'rdf-tss';

const ex = 'https://example.org/';

const source = await Source.create({
  id: `${ex}weather/2026-11#source`,
  kind: 'CSV',
  dataFile: './weather-2026-11.csv',
  file: './weather-2026-11.ttl',     // the metadata: written now, and when the source ends
  csv: { delimiter: ',', encoding: 'utf-8', header: true },
  timeField: { id: `${ex}fields/time`, columnName: 'time' },
  fields: [{
    id: `${ex}fields/temperature`,   // a tss:ValueField, unless kind: 'meta'
    columnName: 'temp',
    datatype: 'http://www.w3.org/2001/XMLSchema#decimal',
    observedProperty: `${ex}props/airTemperature`,
    unit: 'http://qudt.org/vocab/unit/DEG_C',
    sensor: `${ex}sensors/s1`,
  }, {
    id: `${ex}fields/status`,        // a tss:MetaField, as it describes another field
    columnName: 'status',
    datatype: 'http://www.w3.org/2001/XMLSchema#string',
    describesField: `${ex}fields/temperature`,
  }],
});

await source.append({
  time: '2026-11-17T12:00:00Z',
  values: { temperature: '8.4', status: 'ok' },    // local name or full IRI
});

await source.append([   // a batch: either all rows are added, or none
  { time: '2026-11-17T12:10:00Z', values: { temperature: '8.6' } },
  { time: '2026-11-17T12:20:00Z', values: { temperature: '8.5' } },
]);

await source.close();
```

The time field is a `tss:MetaField`. A field with `describesField` is a meta field by default, every other field a value field; set `kind` to choose. Give a field a `property` to state its values with a property of your own vocabulary (`tss:property`); without it, the field gets the default property `<base#columnName>`. For an embedded RDF source, the base is the metadata document: the library writes these properties as relative IRIs (`<#temp>`) in Turtle and TriG, so the log stays right wherever it is published. Without `file`, pass `baseIRI`, or the source IRI without its fragment is used.

With `file`, the metadata is kept up to date on disk, so followers see every append; without it, call `await source.serialize('text/turtle')` and write the result yourself. The lock is taken on the metadata file (or on the data file when there is no `file`).

Each `append` checks the rows (datatypes, unique increasing times, inside the `from`/`until` window of the source) and then only *adds data at the end*: a CSV row, an Arrow record batch, a message of the log with one point per value. The window is fixed when the source is created, and no summaries are written while it grows. If a row does not conform, nothing is changed and a `ValidationError` is thrown. An embedded RDF source can only state the values of describing fields, on the points they describe: a value of another meta field, or of a describing field whose value field has no value in the row, is refused.

### Continue writing to an existing source

```ts
const source = await Source.open('./weather-2026-11.ttl', { write: true });
await source.append(next);
```

The metadata file is rewritten after every `append` of an embedded JSON source (as Turtle; comments and prefixes are not kept).

Opening for writing fails with:

- `NotWritableError` if the source is immutable or its class can't be appended to (Parquet),
- `LockError` if another process is already writing. Only one writer is allowed at a time.

### Finish a source

```ts
await source.close({ freeze: true });   // ends the source: tss:immutable true; followers stop
```

`close()` alone releases the lock and leaves the source growing, so that you can continue later. `close({ freeze: true })` ends it: the metadata gets `tss:immutable true` and, with `summaries` (the default), a stored summary of every field, computed over the whole source; an Arrow stream gets its end-of-stream marker. An embedded RDF source gets a final message.

For Parquet, rows are collected in memory and the file is written on `close()`. Parquet sources are always immutable once written.

## API

`Dataset` is the RDF/JS [`DatasetCore`](https://rdf.js.org/types/) interface.

### Opening and fetching

```ts
// local file (Node) or Dataset
Source.open(location: string | Dataset, options?: {
  source?: string;           // IRI of the source, if the document has several
  write?: boolean;           // default false; true returns a WritableSource
  baseIRI?: string;          // the IRI of the metadata document, for a Dataset
}): Promise<ReadableSource>   // WritableSource when write is true

// remote document, loaded with ldfetch
Source.fetch(url: string | URL, options?: {
  source?: string;           // IRI of the source, if the document has several
  fetch?: typeof fetch;      // custom fetch for the data files and following, e.g. with authentication
  headers?: Record<string, string>;   // headers for every request
  loader?: RdfLoader;        // replace ldfetch for the metadata
  localFiles?: boolean;      // default false: whether the document may refer to local files
  unitConverter?: UnitConverter;   // default: eyemind with QUDT
}): Promise<ReadableSource>
```

In the future, writing could also target a remote location that supports POST (e.g., through the LWS protocol).

### `ReadableSource`

| Member | Description |
|---|---|
| `id` | IRI of the source |
| `kind` | `'EmbeddedRDF' \| 'EmbeddedJSON' \| 'CSV' \| 'Parquet' \| 'Arrow'` |
| `metadata` | time field, fields (with `kind`, `property`, `defaultProperty`, `aboutUrl`, …), `from`, `until`, `immutable`, labels |
| `read(options?)` | `AsyncIterable<Row>`, see below |
| `expand(options?)` | `AsyncIterable<RDFMessage>`: the metadata, then the points of each row |
| `summary(field)` | the summary stored in the source for a field |
| `validate()` | a `Report` listing every rule that fails and where |

`read` options:

| Option | Default | Description |
|---|---|---|
| `from` | source start | included |
| `until` | source end | excluded |
| `fields` | all | fields to include, by local name or IRI |
| `unit` | `'source'` | `'source'`, `'qudt'`, or a unit IRI for every field with a unit; or `{ [field]: 'source' \| 'qudt' \| unitIRI }` per field |
| `follow` | `false` | `true` or `{ interval }` (an `xsd:duration`) |
| `signal` | none | `AbortSignal` to stop |

`expand` takes `from`, `until`, `follow` and `signal`, and:

| Option | Default | Description |
|---|---|---|
| `metadata` | `true` | start with the metadata and the default field properties |
| `align` | none | `'sosa'`, `'saref'` or both: also write what a reasoner derives from the alignment |

### Creating and writing

```ts
Source.create(options: CreateOptions): Promise<WritableSource>
```

| `CreateOptions` | Description |
|---|---|
| `id`, `kind` | IRI of the source; `'EmbeddedRDF' \| 'EmbeddedJSON' \| 'CSV' \| 'Parquet' \| 'Arrow'` |
| `timeField`, `fields` | `{ id, columnName?, property? }` and a list of `{ id, kind?, columnName?, property?, aboutUrl?, datatype?, label?, observedProperty?, unit?, sensor?, featureOfInterest?, describesField?, … }`; the column name defaults to the local name, the datatype to `xsd:decimal` |
| `dataFile` | path of the data file of an external source |
| `file` | path of the metadata file, kept up to date; the lock is taken on it |
| `baseIRI` | the IRI of the metadata document, for the default field properties of an embedded source |
| `csv` | `{ delimiter?, encoding?, header? }` |
| `immutable`, `from`, `until`, `label` | as in the metadata; a new source grows, unless `immutable` |
| `summaries` | store a summary of every field when the source ends, default `true` |
| `prefixes` | prefixes for the Turtle of the metadata |

### `WritableSource` (extends `ReadableSource`)

| Member | Description |
|---|---|
| `append(row \| rows[])` | adds rows; all or nothing |
| `serialize(mediaType?, prefixes?)` | the metadata (and embedded rows) as Turtle, TriG, N-Triples, N-Quads or JSON-LD |
| `close({ freeze? })` | writes outstanding data, releases the lock; `freeze` ends the source (`tss:immutable true`, summaries) |

### `Row`

```ts
interface Row {
  source: ReadableSource;                // the source this row comes from
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

A row holds the values of every field but the time and step fields: each value of a value field is one point, the values of meta fields say something about the row or its points. Values are kept as text because the spec preserves exact text: `"2.50"` stays `"2.50"`. Call `toNative()` when you want a JavaScript value.

### Helpers

```ts
toRDFMessages(rows: AsyncIterable<Row>, options?: {
  metadata?: boolean;                    // the metadata of each source first; default true
  align?: 'sosa' | 'saref' | ('sosa' | 'saref')[];
}): AsyncIterable<RDFMessage>

expandTemplate(template: string, variables: Record<string, string | undefined>): string   // RFC 6570

convertUnit(value: string, from: string, to: string | 'qudt'): Promise<string>
```

### Errors

| Error | When |
|---|---|
| `ValidationError` | the metadata or data does not conform; carries a `Report` |
| `NotWritableError` | writing to an immutable source, or to one whose class can't be appended to |
| `LockError` | another process is writing to the source |
| `UnitConversionError` | no unit, unknown unit, or units of different dimensions |

## Open spec issues

The library depends on these points, which the spec does not define yet:

- **Single writer:** how to prevent two processes writing to the same source.
- **Empty values:** an empty string and no value are currently the same.
- **Several sources in one file:** each source repeats the file configuration, and long tables (`sensor_id, time, value`) can't be described: the key of a source is its time field.
- **Blank node fields in a message log:** the expansion links points to their field with `tss:field`; a field that is a blank node cannot be referred to from another message of an RDF Message Log. Give fields IRIs.
- **Point IRIs from a step:** `tss:aboutUrl` may use the column name of any field; the library fills in the time and the values of a row, but not the step of a time grid.

Until these are settled, the behaviour of `follow`, `append` on external files, and locking is provisional.

## Telraam

The playground shows months of [Telraam](https://telraam.net/) traffic counts and V85 speeds. The data comes from a compressed RDF Message Log of TriG (about 14 million messages, one measurement each). [scripts/telraam-log.ts](scripts/telraam-log.ts) reads it as a stream, with the message parser of ldfetch ([n3.js-messages](https://github.com/pietercolpaert/n3.js-messages)), keeps some locations and writes one source per location in a binary format, with a value field per series. The speed is in km/h, so reading it in m/s or mph is a unit conversion:

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
