# rdf-tss-ts

A TypeScript library to read, follow, write and expand [RDF Time Series Sources](https://knowledgeonwebscale.github.io/rdf-tss/) (RDF-TSS).

It implements the specification, a living document of the [KNoWS team](https://knows.idlab.ugent.be): reading every source class, following a growing source, appending to it and ending it, stored summaries, time grids, value encodings, validation, and the expansion into points as RDF Messages, which follows the spec's RDF Message Stream Profile. Of the names of earlier drafts, `tss:MetaField` and `tss:mutable false` are still read, and `validate()` names the current term; a document with the *Snippets* classes (`tss:EmbeddedRDFSnippet`, …) is refused with a message that names the new class.

**Try the [playground](https://pieter.pm/rdf-tss-ts/)**: pick a publisher, a dataset and a series from the menu (months of Telraam traffic counts and speeds, 95 series of Eurostat for 12 countries and the EU, from inflation and unemployment to weekly deaths and electricity prices, 42 time series of the core datasets on GitHub, from gold and oil prices to CO₂ and sea level, and a day of weather in every format), or open the URL of your own source, see charts (large series are downsampled to an average per day, with a min–max band; drag to zoom in on the raw values), convert units with QUDT, find repeating patterns with the matrix profile and the contextual matrix profile, and see the source expanded into points as an RDF Message Log. The address holds the view, so a link opens the same dataset, tab and choices: `#weather-csv&tab=messages&rows=5&align=sosa`. The Telraam data is read from the [Telraam LDES](https://ldes.telraam-api.net/measurements) as RDF Messages and turned into binary sources, see [Telraam](#telraam).

## What is a source?

A source is a table of readings described in RDF: one time column, and one column per field. Every row has one time; every value of a *value field* is one reading, a *point*. The RDF metadata says, per field, its datatype, where its values are, and what a value field observes (property, unit, sensor, feature of interest). It also states the time window, and whether the source has ended (`tss:immutable true`). A source that has not ended is *growing*: rows are only ever added at its end. The rows themselves are stored in one of five ways, set by the source's class:

| Source class | Where the rows are | Can be appended to |
|---|---|---|
| `tss:EmbeddedRDFSource` | RDF points in the same document | yes |
| `tss:EmbeddedJSONSource` | an `rdf:JSON` literal in the same document | yes |
| `tss:CSVSource` | an external CSV file | yes* |
| `tss:ArrowSource` | an external Arrow file | yes* (IPC streaming format; the IPC file format is read-only, for immutable sources) |
| `tss:ParquetSource` | an external Parquet file | no, written once |

\* Growing is by appending bytes: a CSV row, an Arrow record batch, or a message at the end of an RDF Message Log. An embedded RDF source is an [RDF Message Log](https://w3c-cg.github.io/rsp/spec/messages): the metadata is the first message, every row is a message, and a last message ends the source.

### Fields: value fields, context fields and how points state values

Every field is a `tss:ValueField` (its values are readings) or a `tss:ContextField` (the time field, the step field of a time grid, a field that describes a value field with `tss:describesField`, or another field such as an identifier). A field is never itself the predicate of its values. In RDF, every point states its value field, its time and its reading with the same three properties, and what a reading means is stated once, on its field:

```turtle
ex:source tss:hasPoint [
    tss:field ex:value-field ;
    tss:time "2024-05-12T08:00:00Z"^^xsd:dateTime ;
    tss:value "4810.5"^^xsd:double
] .
```

A point of a source with one value field may leave out `tss:field`. Only a *describing field* has a *field property*: the property that states its value on the points it describes, such as `ex:status "ok"`. That is its `tss:property` or, by default, `<base#columnName>`, as CSVW's default `propertyUrl`, where the base is the data file (external sources) or the metadata document (embedded sources).

The library gives each field's `kind` (`'value'` or `'context'`), and for a describing field its resolved `property` and whether that is the `defaultProperty`, in `source.metadata.fields`. `tss:MetaField`, the name of earlier drafts, is still read as a context field, and `validate()` reports it.

### Times and time grids

A time is an `xsd:dateTime` with a timezone (`Z` or an offset such as `+02:00`), such as `"2024-05-12T08:00:00Z"`; `xsd:dateTimeStamp` is allowed too. The time field states one of the two as its `tss:datatype`, and the library writes `xsd:dateTime`, which the spec recommends. Times are compared as moments, so `08:00:00Z` and `10:00:00+02:00` are the same time.

A data file can leave out the times: on a *time grid*, row n is at `tss:timeBase` + n × `tss:timeStep`, in calendar steps for years and months. The step of a row is in the column of its `tss:stepField`, which lets the file leave out rows; or, without a step field, it is the row's position in the file, from 0 for the first row. The [gold prices](examples/gold-prices/monthly.ttl) of the playground describe a CSV file that someone else publishes this way: one row per month since 1833, on a grid of `P1M`.

[scripts/datahub.ts](scripts/datahub.ts) (`npm run examples:datahub`) describes 41 more CSV files of the [core datasets on GitHub](https://github.com/datasets) in the same way, into [examples/datahub/](examples/datahub/): oil, gas and commodity prices, the S&P 500, bond yields, GDP, consumer prices, house prices, CO₂, temperature anomalies, sea level, COVID-19 and population. Their dates have no time of day and no timezone, so only a file with a row at every step of a calendar grid fits, and only a file with one series: a file with a column such as a country holds a series per country, which one source cannot describe (see [Beyond the specification](#beyond-the-specification)). A daily price on trading days only has gaps, so it does not fit either. The script takes the units from a table, or from the descriptions in the data package, and makes the ones QUDT does not have, such as US dollar per barrel or million pounds sterling, of QUDT units. A column that says something about the reading of another, such as the uncertainty of the CO₂ increase or the error bounds of the EPA sea level, is a describing context field: its value is stated on the point of that reading with `qudt:standardUncertainty`, `qudt:lowerBound` or `qudt:upperBound`, and the playground draws it as a band around the line. The script reads every description back from GitHub before it writes it: it has to conform, and every row has to be at the date in the file.

[scripts/eurostat.ts](scripts/eurostat.ts) (`npm run examples:eurostat`) describes 95 series of [Eurostat](https://ec.europa.eu/eurostat) in [examples/eurostat/](examples/eurostat/): 8 indicators (inflation, unemployment, industrial production, long-term interest rates, GDP growth, electricity prices for households, weekly deaths and population) for 11 countries and the European Union. The data file of each is the series as SDMX-CSV from the dissemination API of Eurostat, a few dozen kilobytes in a fraction of a second, with CORS headers. Its periods (`2025`, `2025-S1`, `2025-Q3`, `2025-10`, `2025-W40`) are no times with a timezone, so a row is at the start of its period, on a time grid of a year, half a year, a quarter, a month or a week (ISO 8601 weeks, from Monday). The country is the feature of interest, as its entity in Wikidata, and the flags of Eurostat (`p` provisional, `b` a break in the series, …) are a describing field of the value. A series with a gap does not fit the grid, and is skipped; every other one is read back from Eurostat before it is written.

The weather has seasons, which statistics such as these rarely show. [scripts/meteoswiss.ts](scripts/meteoswiss.ts) (`npm run examples:meteoswiss`) describes 10 automatic weather stations of [MeteoSwiss](https://www.meteoswiss.admin.ch), from Lugano to the Jungfraujoch: per station, the hourly values since 2020 and the daily values of its whole record, back to 1864 for Zürich, Basel, Bern and Lugano. They are static CSV files on data.geo.admin.ch, with CORS headers and Range requests, and their times (`19.11.2026 23:00`, in UTC) are no `xsd:dateTime`, so they are on a time grid of an hour or a day. The parameters (temperature, humidity, pressure, wind, precipitation, global radiation, sunshine) take their label and unit from the metadata of MeteoSwiss, and the minimum and the maximum of the temperature describe its mean, with `schema:minValue` and `schema:maxValue`: the playground draws them as a band. The files of the current year start anew every January, which a time grid cannot follow, so only the historical files, which only grow, are described. [scripts/geosphere.ts](scripts/geosphere.ts) (`npm run examples:geosphere`) describes the hours of 2025 at 10 stations of [GeoSphere Austria](https://data.hub.geosphere.at), from Vienna to the Sonnblick, from its dataset API, which gives a year of a station in about a second. Both read every series back before they write it. The patterns tab shows the rhythm of the day and the year; with more than 50 000 values, as an hourly series since 2020 has, it compares the most recent 50 000.

Not every open data publisher fits a playground in the browser. A publisher has to send CORS headers, or a browser cannot read its files at all: the Royal Meteorological Institute of Belgium, the Met Office (HadCRUT5) and Open Power System Data do not. And it has to answer quickly, without an export job: the portals of Opendatasoft, such as those of Elia, ODRÉ, Paris, Basel, Gent and Infrabel, build every export when it is asked for, and the whole history of a series of quarter-hours takes from half a minute to two minutes, where Eurostat answers with a whole series in a fraction of a second. The examples leave those out, so as not to put that load on them. Among the seasonal series of [data.europa.eu](https://data.europa.eu), most files are such exports, geodata, or long tables with a row per station or per category at every time, which one source cannot describe: the hourly energy of the French charging points (IRVE) has 16 series in one file, which only holds the last 420 hours. The tide gauges of the Environment Agency in the UK keep four weeks of readings, newest first, and its hydrology API takes a minute to answer.

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
| Parquet sources | `hyparquet` (reading), `hyparquet-writer` (writing), `hyparquet-compressors` (reading files compressed with ZSTD, Gzip, Brotli or LZ4) |
| `unit: 'qudt'`, `unit: <IRI>`, `convertUnit`, `expand({ align })` | `eyemind` (version 0.8.17) |

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

A unit that QUDT does not have can be made in the metadata, as QUDT makes its own units: of QUDT units, with `qudt:hasFactorUnit` (a `qudt:DerivedUnit`) or `qudt:prefix` and `qudt:scalingOf`, or with its own `qudt:conversionMultiplier`, `qudt:conversionOffset` and `qudt:hasDimensionVector`. The library hands its description to eyemind with the conversion, so it is converted like a unit of the catalog: the temperature anomalies of the [core datasets on GitHub](scripts/datahub.ts) are in `<#DEG_C-DIFF>`, a difference of degrees Celsius, which converts 1:1 to kelvin, without the offset of `unit:DEG_C`. A unit with a currency in it is not converted, on purpose: the [gold prices](examples/gold-prices/monthly.ttl) are in `<#USD-PER-OZ_TROY>`, a `qudt:DerivedUnit` with the factor units `unit:CCY_USD` (exponent 1) and `unit:OZ_TROY` (exponent −1) and the `qudt:symbol` `"$/oz{Troy}"`. QUDT gives every currency the conversion multiplier 1, but an exchange rate changes over time, so a price is not converted to another currency as a unit is.

A describing field with the property `qudt:standardUncertainty` holds the standard uncertainty of the value it describes, one standard deviation: it is a difference of values, so it is converted with the scale of its unit, without the offset (±0.5 °C is ±0.5 K).

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
  publish(message);   // the metadata, one message per row, and the ending of an immutable source
}
```

`expand()` follows the spec's *Expanding a source into points*, in the shape of the points of a `tss:EmbeddedRDFSource`:

- The first message is the metadata document, without `tss:points`, plus the default property of each describing field that states no `tss:property` (`ex:status-field tss:property <data.csv#status>`).
- Every next message holds one row: the source `tss:hasPoint` one point per value of a value field. The point states its value field (`tss:field`, always), its time (`tss:time`) and its reading (`tss:value`, the decoded value as published), plus the values of the describing fields that describe its field, with their field properties. The values of other context fields, such as a step or an identifier, are not stated.
- A point is a blank node, the RDF node of the embedded point, or the IRI made by the `tss:aboutUrl` URI template of its field (`'https://example.org/obs/{time}'`).
- The last message of an immutable source is its ending: `tss:immutable true` and the stored summaries, which the first message leaves out. A growing source has none, until it is ended while you follow it.

These are the three kinds of messages of the spec's *RDF Message Stream Profile* (`tss:MessageStreamProfile`, exported as `MESSAGE_STREAM_PROFILE`): a description message for each source, a row message for each row, with the time of its row as timestamp, and an ending message. A row message is read with the description message of its source, which comes first. The log of a growing `tss:EmbeddedRDFSource` that the library writes has the same shape.

It takes `from`, `until`, `follow` and `signal` as `read()` does. To expand rows that you read yourself, use `toRDFMessages(source.read(options))`; the values have to be as published, so a unit conversion throws.

The spec does not map points onto SOSA or SAREF: the TSS vocabulary is aligned with them (`tss:Point` is a `sosa:Observation` and a `saref:Measurement`, `tss:time` a subproperty of `sosa:resultTime`, `tss:value` of `sosa:hasSimpleResult`, and property chains over `tss:field` carry the observed property, sensor, feature of interest and unit), so an OWL 2 RL reasoner derives the observations. Ask for them, and a reasoner derives them while the source is expanded:

```ts
source.expand({ align: 'sosa' });              // or 'saref', or ['sosa', 'saref']
```

The library writes none of the alignment itself. The reasoner is [eyemind](https://github.com/eyereasoner/eyemind) with its OWL 2 RL profile, reasoning over the rows as RDF Messages, with the TSS vocabulary of the specification (`TSS_VOCABULARY`, copied from the spec by `npm run vocabulary`) and the description message of the source as background. Two SHACL shapes, which eyemind trusts, specialize its rules: the shape of the points of a row message, and the observations asked for. So the background is closed once, and then each row takes a few milliseconds, in Node and in the browser. In the browser, pass the modules of eyemind that reason over messages, which its package does not export: `expand({ align, aligner: { eyemind: { loadMessageReasoner, parseRdfMessages, writeRdf } } })`, from `eyemind/src/formats.js`, `messages.js` and `rdf.js`, as the [playground](playground/app.ts) does.

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
    id: `${ex}fields/temperature`,   // a tss:ValueField, unless kind: 'context'
    columnName: 'temp',
    datatype: 'http://www.w3.org/2001/XMLSchema#decimal',
    observedProperty: `${ex}props/airTemperature`,
    unit: 'http://qudt.org/vocab/unit/DEG_C',
    sensor: `${ex}sensors/s1`,
  }, {
    id: `${ex}fields/status`,        // a tss:ContextField, as it describes another field
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

The time field is a `tss:ContextField`. A field with `describesField` is a context field by default, every other field a value field; set `kind` to choose. Give a describing field a `property` to state its values on the points with a property of your own vocabulary (`tss:property`); without it, it gets the default property `<base#columnName>`. Only a describing field takes a `property`: the points of an embedded RDF source state their value field, time and reading with `tss:field` (when there are several value fields), `tss:time` and `tss:value`. For an embedded RDF source, the base of the default property is the metadata document: the library writes these properties as relative IRIs (`<#temp>`) in Turtle and TriG, so the log stays right wherever it is published. Without `file`, pass `baseIRI`, or the source IRI without its fragment is used.

With `file`, the metadata is kept up to date on disk, so followers see every append; without it, call `await source.serialize('text/turtle')` and write the result yourself. The lock is taken on the metadata file (or on the data file when there is no `file`).

Each `append` checks the rows (datatypes, unique increasing times, inside the `from`/`until` window of the source) and then only *adds data at the end*: a CSV row, an Arrow record batch, a message of the log with one point per value. The window is fixed when the source is created, and no summaries are written while it grows. If a row does not conform, nothing is changed and a `ValidationError` is thrown. A CSV source on a time grid with a step of fixed length (not months or years) can be appended to as well: a row's time has to be on the grid, and without a step field the library writes a row of empty values for every step without readings, so that each row stays at the step of its position. An embedded RDF source can only state the values of describing fields, on the points they describe: a value of another context field, or of a describing field whose value field has no value in the row, is refused.

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
| `expand(options?)` | `AsyncIterable<RDFMessage>`: the metadata, the points of each row, and the ending of an immutable source |
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
| `metadata` | `true` | start with the metadata and the default field properties, and end an immutable source with its ending message |
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
  time: string;                          // xsd:dateTime with a timezone, exactly as published
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

A row holds the values of every field but the time and step fields: each value of a value field is one point, the values of context fields give the context of the row or its points. Values are kept as text because the spec preserves exact text: `"2.50"` stays `"2.50"`. Call `toNative()` when you want a JavaScript value.

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

## Beyond the specification

The specification leaves these points to implementations, or does not cover them:

- **One writer at a time:** the spec says what a write appends, not how two writers are kept apart. The library takes a lock on the metadata file (or on the data file), and a second writer gets a `LockError`.
- **Long tables:** the key of a source is its time field, so a table with a row per sensor and time (`sensor_id, time, value`) is a source per sensor, each with its own description.
- **Fields in a message log:** blank node identifiers are scoped to their message, so a row message cannot refer to a field that is a blank node: give fields IRIs.
- **Uncertainty and error bounds:** the spec has no terms of its own for them ([issue #38](https://github.com/KNowledgeOnWebScale/rdf-tss/issues/38)). The core datasets on GitHub use describing fields with `qudt:standardUncertainty`, `qudt:lowerBound` and `qudt:upperBound`, which the library converts with their value and the playground draws as a band.
- **Times without a timezone:** a date such as `1833-01-01` is not a time of the spec ([issue #34](https://github.com/KNowledgeOnWebScale/rdf-tss/issues/34)): such a file is read on a time grid, and its dates are a context field.

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
