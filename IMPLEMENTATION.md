# Implementation notes

Working notes for building `rdf-tss`. The API is in [README.md](README.md); the rules are in the [spec](https://knowledgeonwebscale.github.io/rdf-tss/) (RDF Time Series Sources, as in [pull request #31](https://github.com/KNowledgeOnWebScale/rdf-tss/pull/31)). Where the two disagree, the spec wins.

## Principles

- **Read path first.** Readers need little code and no Node-only APIs; writing is a separate module.
- **Core runs in Node and in the browser.** It uses only `fetch`, `ReadableStream`, `TextDecoder` and `AbortSignal`. Anything that touches the file system (local `open`, `create`, locks) sits behind a `Storage` interface and is exported under the `node` condition of `package.json#exports`.
- **Few dependencies, heavy ones optional.** Parquet, Arrow and eyemind are loaded with dynamic `import()` and declared as optional peer dependencies. A user who only reads embedded or CSV sources pays nothing for them.
- **Values stay text.** Every value is a lexical form plus a datatype IRI until the user calls `toNative()` or asks for a unit conversion.
- **Never reason per reading.** Reasoning (eyemind) runs on metadata only; per-reading work is plain arithmetic.

## Architecture

```mermaid
flowchart LR
  A[Dataset / Turtle / JSON-LD] --> B[metadata model]
  B --> C[row reader per class]
  C --> D[time + window + decode + empty]
  D --> E[unit conversion]
  E --> F[Row]
  F --> G[expand / toRDFMessages]
```

1. **Metadata model.** Parse the RDF/JS `Dataset` into a typed `SourceMetadata`: class, fields, time field, window, `immutable`, summaries. Each field gets its kind (`tss:ValueField` or `tss:MetaField`; inferred from its role when it states neither) and its field property: `tss:property`, else `tss:time` for the time field, else `<base#columnName>` with the data file (external) or the metadata document (embedded) as base, as CSVW's `{#_name}`. So parsing needs the IRI of the document. Field lookup by local name (the part after the last `#` or `/`) or IRI is built once; an ambiguous local name throws only when it is used.
2. **Row readers** (`src/formats/`). One interface, `AsyncIterable<RawRow>`, where a `RawRow` maps field to a lexical string or `undefined`. One implementation per class:

   | Class | Rows |
   |---|---|
   | EmbeddedRDF | `tss:hasPoint` nodes, one reading each; the field properties are the predicates; points with the same time form a row; sorted by time (the spec says embedded points are unordered) |
   | EmbeddedJSON | `JSON.parse` the `rdf:JSON` literal; one object per row; keys are `tss:columnName`; `null`, missing and `""` are empty |
   | CSV | own streaming RFC 4180 parser (about 100 lines): custom delimiter, `TextDecoder` for `tss:encoding`, header by name or `tss:columnIndex` |
   | Arrow | `apache-arrow` `RecordBatchReader`, which reads both IPC formats; dictionary columns read as their values |
   | Parquet | `hyparquet` (pure JS, works in browsers, range reads) |

   Arrow and Parquet cells are converted to the lexical forms in the spec tables (§ 6.2, § 6.3), e.g. timestamps to `…Z` in UTC, decimals with exactly `scale` digits.
3. **Pipeline stages**, in order:
   - Resolve the time: a column, or `timeBase + n × timeStep` for a time grid. Duration arithmetic has calendar semantics (`2021-01-31 + P1M` is `2021-02-28`), so write and test it explicitly.
   - Keep rows in `[from, until)`.
   - Decode values: `tss:DeltaFromBaseline` is `baseline + value`, computed on exact decimals (a small `BigInt`-scaled decimal type, or `big.js`), never on floats.
   - Apply the empty-value rules (empty cell, null, missing key, `""`).
   - Convert units if requested.

   Times are compared as moments, not as strings. Parquet and Arrow can hold nanoseconds, so use an `Instant` backed by a `BigInt` of epoch nanoseconds instead of `Date`.
4. **`toNative()`.** Integer types become `number` when safe and `bigint` otherwise; `xsd:decimal` becomes `number` and is documented as lossy; dates become `Date`; booleans accept `true`, `false`, `1`, `0`.
5. **Expansion** (`expand()`, `toRDFMessages`). Implements the spec's *Expanding a source into points*: a first message with the metadata (without `tss:points` and without the embedded points) plus `field tss:property <default>` for each field without a `tss:property`, and `<default> rdfs:subPropertyOf tss:value` for a value field; then one message per row, with a point per value of a value field: `tss:hasPoint`, `tss:field`, the time with the time field's property, the value with the value field's property, and the values of the describing fields of that field.
   - Take the literal from `Value.value` and the field's datatype, never through `toNative()`, which would turn `"2.50"` into `2.5`. A converted value is refused: the point links to its field, whose `tss:unit` would be wrong.
   - A point is the original node of an embedded RDF point when it is an IRI, the IRI of `tss:aboutUrl` (an RFC 6570 template, `src/iri.ts`, resolved against the same base as the default properties), or a blank node.
   - The spec has no SOSA mapping any more: the vocabulary is aligned with SOSA and SAREF. `align: 'sosa' | 'saref'` writes what an OWL 2 RL reasoner would derive, so consumers without a reasoner get observations; a value is only a result when its property is aligned (a default property, or a stated subproperty of `tss:value`).

## Following a live source

The model of [pull request #25](https://github.com/KNowledgeOnWebScale/rdf-tss/pull/25): a source grows by appending at its end, and ends with `tss:immutable true`. There is no `tss:mutable` and no `tss:committedUntil`; a follower uses HTTP only (`src/follow.ts`).

| Source | Change detection |
|---|---|
| CSV | remember the character offset of the last complete row; `Range: bytes=<bytes so far>-`; parse only the new bytes; ignore an incomplete last line |
| Arrow stream | the schema message is kept; the new bytes are walked as flatbuffer messages (`walkArrowMessages`), only complete ones are used; a dictionary batch means a full re-read |
| Embedded RDF (Message Log) | `Range` again; a preamble of the `PREFIX` lines plus the complete new messages are parsed with `n3.js-messages`; the new quads are merged into the metadata store |
| Embedded JSON | the literal is replaced as a whole: refetch the document |
| Local file | the same, with `readFromOffset` (size and offset) instead of HTTP |

`ByteSource` handles the answers: `206` gives the new bytes, `416` means nothing new, `200` means a server without ranges (skip what is already known), a shorter `Content-Length` means the file was replaced (read it again), `404`/`410` end with an error. The poll interval is the `max-age` of the last response (at least a second), else 10 seconds, or the `interval` option. An external source's metadata is loaded again every round (with ldfetch, so its HTTP cache applies) to see `tss:immutable true`.

End conditions: `tss:immutable true` read after the last poll, a point at or after `until` seen, or `AbortSignal`. Back off on errors; honour `interval`. A source that is immutable from the start is read once.

## Writing (Node only)

- **Growing is appending.** `append` validates the new points (datatypes, unique increasing times, inside the fixed `from`/`until`) and then writes data only: CSV rows, an Arrow record batch (no end-of-stream marker), one message per row (with a point per value) for an embedded RDF Message Log. Embedded JSON is one literal, so that metadata file is rewritten. The window is never widened and nothing is summarized while growing, so no existing byte changes.
- **Ending.** `close({ freeze: true })` adds `tss:immutable true` and the stored summaries (computed from running statistics over all points), writes the Parquet file, appends the Arrow end-of-stream marker, and for a message log appends a final message. `close()` without `freeze` leaves the source growing and can be continued with `open(…, { write: true })`.
- **Atomicity.** Validate in memory first. For external files, append the whole batch in one `write`. For metadata, write a temp file and `rename`.
- **Lock.** A lock file created with `O_EXCL` (`wx`) holding pid and timestamp, with stale-lock detection; `LockError` if it exists. Provisional until the spec defines single-writer behaviour.
- **Parquet** is written once on `close()`: `hyparquet-writer`, always immutable.
- **Arrow formats.** The spec (§ 6.3) says the IPC *file* format, which cannot be appended to. For now the library assumes the IPC *streaming* format: it is the only one that can be appended to and followed. The IPC file format is also read, but only when the source is immutable. A growing source with an IPC file throws `ValidationError`, and `open` with `write: true` on an immutable one throws `NotWritableError`. Detect the format from the first bytes: a file starts with `ARROW1`, a stream with the continuation marker `0xFFFFFFFF`. A stream that ends is closed with the end-of-stream marker (`0xFFFFFFFF 0x00000000`); readers also accept streams without one. An issue for the spec is pending.
- **`Storage` interface** (`read`, `append`, `replace`, `lock`) so that a remote target (LWS/POST) can be added later.

## Validation

- One rule per spec requirement, each returning `{ rule, node, message }` entries for the `Report`. `ValidationError` carries the report.
- Cardinality and "required/optional/not allowed per class" come from the spec's property tables (§ 3, § 4). Encode them as a data table with one generic checker rather than as hand-written ifs.
- Lexical-form checks for the datatypes listed in § 4.1 (doubles, integer family, booleans, `xsd:dateTime*`, `xsd:date` including real days).
- Optional: express the structural shapes as SHACL and run them with eyemind's `--shacl` profile (SHACL 1.2 Core), so other implementers can reuse the shapes. Time-window, uniqueness and data-file rules stay in TypeScript.

## eyemind

[eyemind](https://www.npmjs.com/package/eyemind) 0.8.4 is a dependency-free Logic Script reasoner (Node 18 or later, also runs in the browser, MIT). It reads Turtle, TriG, N-Triples, N-Quads and N3 as `rdf(S, P, O, G)` facts, and ships RDF logic profiles: `--qudt` (normalize QUDT quantity values and CDT literals to SI units from an offline catalog adapted from QUDT.org, CC BY 4.0), `--owl2rl` (RDFS and OWL 2 RL, with contradictions reported as `ent:Conflict` records), `--skos` and `--shacl`.

**Risks.** It is young (beta, one maintainer, published within hours of this review, API still moving). Pin the version and hide it behind our own interfaces (`UnitConverter`, `MetadataReasoner`) in an optional adapter module loaded with dynamic `import()`.

### Units (`unit: 'qudt'`, `convertUnit`)

- Never run the reasoner per reading. Derive a conversion `y = factor × x + offset` once per (source unit, target unit) pair, cache it, and apply it with exact decimal arithmetic. The offset matters for `DEG_C` and `DEG_F`.
- Check that the two units have the same dimension; if not, throw `UnitConversionError`.
- `unit: 'qudt'` means the SI-normalized unit. Converting to a chosen unit such as `DEG_F` means normalizing to SI and then applying the inverse of the target's conversion.
- Fallback if eyemind cannot expose the factors: generate a small table of `conversionMultiplier`, `conversionOffset` and dimension vector from the QUDT unit vocabulary at build time, and ship only the units we need.

### OWL 2 RL

- Metadata only, opt-in, e.g. `Source.open(file, { reason: { owl2rl: true, imports: [vocabularyDataset] } })`. Never run it over rows.
- Uses: match fields by `observedProperty` or quantity kind through `rdfs:subClassOf` and `owl:sameAs`; derive the SOSA and SAREF observations of an expansion instead of `align`; surface `ent:Conflict` records in `validate()`.
- Keep inferred triples in a separate graph. They must never end up in `serialize()` output or be written back to a source.

### Spike results (eyemind 0.8.4)

1. The library API (`run`, `loadText`, `loadSources`) cannot enable `--qudt` or `--owl2rl`, and `package.json` exports only `eyemind` and `eyemind/node`. The command line entry `main(argv, io)` of `src/cli.js` can be called in-process, with `io = { readFile, stdin, stdout, stderr }`. In Node the package is found with `createRequire(import.meta.url).resolve('eyemind/package.json')` and `src/cli.js` is imported by file URL; in the browser the bundler aliases `eyemind-cli` to that file (see [scripts/build-playground.ts](scripts/build-playground.ts)). This is the one fragile point: ask the author to export the profiles.
2. `--qudt` does not read `tss:unit`. It normalizes `qudt:QuantityValue` nodes (`qudt:numericValue` and `qudt:unit`) and CDT literals. The converter therefore feeds it a probe: three quantities (values 0, 1000 and 2000) in the unit, as Turtle.
3. It normalizes to the SI unit of the dimension only, as double precision. From the three results the converter derives the affine conversion `SI = scale × x + offset` (and checks it is linear: a dB or pH unit is refused), caches it per unit, and for another target unit applies the inverse of the target's conversion. The SI unit also tells whether two units have the same dimension. Results are rounded to 12 significant digits, to hide the floating point noise (`64.7599999999981` becomes `64.76`).
4. The output is Turtle; it is parsed with `n3`.
5. A call takes about 100 ms in Node, once per unit. In the browser the 480 kB chunk of eyemind is only loaded when a unit is converted. Its catalog is a short list (length, area, volume, time, mass, speed, acceleration, temperature, pressure, energy, power, current, amount and a few dimensionless units): other units give a `UnitConversionError`.

OWL 2 RL is not used yet.

## Packaging and tests

- ESM only, TypeScript, one entry point. The Node parts (local files, locks) are imported dynamically in [src/platform.ts](src/platform.ts), so the same bundle runs in browsers. Types come from `@rdfjs/types`.
- Dependencies: `n3` (parse and write RDF), `jsonld-streaming-parser` and `jsonld-streaming-serializer` (loaded when JSON-LD is used). Optional peers: `hyparquet`, `hyparquet-writer`, `apache-arrow`, `eyemind`.
- Tests (`npm test`): the writer makes a source in every format, a mock web server ([tests/helpers/server.ts](tests/helpers/server.ts), with ETags and `304`) serves it, and the readers read it; the spec examples and their expansion; units; following a live source while a writer appends; and the Telraam sample. [tests/playground-browser.mjs](tests/playground-browser.mjs) opens every example of the playground in Chrome.
- Limits of the first implementation: Parquet and Arrow timestamps are written in milliseconds; Parquet is read through `hyparquet` without the optional compressors (Snappy only); decimals in Parquet are read as numbers; the summaries are recomputed in memory, so a writer reads the existing rows when it opens a source; a time grid can only be written to CSV, with a fixed step.

## Telraam

[scripts/telraam.ts](scripts/telraam.ts) turns the members of the [Telraam LDES](https://ldes.telraam-api.net/measurements) into sources: one source per location, one value field per series (`bike-lft`, `car-rgt`, …), one row per hour. The series IRI of the LDES (`dct:isVersionOf`) becomes the field, `cl-vkt:aantal` its observed property, the location its feature of interest, and the vehicle type and direction of the member are kept as a `tss:fieldDescription`. The test checks that every count is back, as the exact published text, and that the expansion, aligned with SOSA, gives an observation for each LDES member.

The sample ([examples/telraam/members.ttl](examples/telraam/members.ttl)) is 576 real members. One day of one location is 190 kB of Turtle in the LDES (10 kB gzipped) and 11 kB as a source (2 kB gzipped); the metadata is most of that, and it is written once, so a month is about 75 times smaller.

## Status

Done: reading in all five formats, following, writing (create, append, lock, close, freeze), validation, expansion into points as RDF Messages, units, the playground and its tests. Left: OWL 2 RL, a time grid and value encoding for Arrow and Parquet writing, and exporting the profiles in eyemind.
