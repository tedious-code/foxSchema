# Excel and Google Sheets import — plan

Status: proposal. Nothing implemented.

Written after the streaming work in #204 (CSV) and #207 (NDJSON), and it assumes
those readers are the shape new formats plug into.

## These are two different problems

They get asked for together, so they look like one feature. They are not.

| | Excel (.xlsx) | Google Sheets |
| --- | --- | --- |
| what it is | a file format | a remote API |
| hard part | parsing without loading it all | **authentication** |
| needs a dependency | yes (ZIP + XML) | an HTTP client, or nothing |
| data ceiling | 1,048,576 rows × 16,384 cols *per sheet* | **10 million cells per spreadsheet, total** |
| offline | yes | no |
| fits the existing upload flow | yes, unchanged | no — there is no file |

Excel is a natural extension of what exists. Google Sheets is an integration
feature wearing a file-import costume, and most of its work is OAuth, not
parsing.

**Sequence them separately.** Doing Excel first also makes Sheets cheaper,
because "export to xlsx and import that" becomes a real answer for many users.

---

## Part 1 — Excel (.xlsx)

### What the format actually is

A ZIP archive of XML parts:

```
xl/workbook.xml         sheet names + ids
xl/worksheets/sheet1.xml   cells, by row
xl/sharedStrings.xml    the string table
xl/styles.xml           number formats — this is how dates are stored
```

Three consequences that decide the design:

**1. `sharedStrings.xml` is the memory problem, not the sheet.** In a typical
export nearly every text cell is an *index* into one shared string table. A
sheet can be streamed row by row; the string table it points into cannot,
because a row near the end may reference index 3. For a large workbook this
single part can be hundreds of MB, and it lands in memory whatever else is
streamed. Plan for it — it is the ceiling.

*(Inline strings — `t="inlineStr"` — avoid this, but exporters rarely emit them.)*

**2. Dates are numbers.** `45000` is a date only because `styles.xml` says its
format code is a date format. Get this wrong and every date column imports as
an integer. Worse, there are two epochs (1900 on Windows, 1904 on old Mac
files) and the well-known 1900 leap-year bug. This is where naive importers
lose data silently, and it will need explicit tests.

**3. Formulas have two values.** A cell carries the formula *and* its cached
result. Import the cached value; a file saved without cached values (rare, but
it happens) has to degrade to null rather than to the formula text.

Also decide up front, because each is a visible product question:

- **which sheet?** A workbook has many. Import the first, prompt, or import all
  as separate tables?
- **where does the header start?** Real spreadsheets have title rows, blank
  rows, and merged banner cells above the actual header.
- **merged cells** — value belongs to the top-left cell; the rest are empty.
- **.xls (pre-2007)** is a completely different binary format. Recommend
  declaring it out of scope and saying so in the UI, rather than half-supporting it.

### Options

**A. `exceljs` streaming reader** — `stream.xlsx.WorkbookReader` yields rows
without materialising the workbook. Mature, handles styles/dates/shared
strings. Cost: a real dependency tree, and CI runs `npm audit` plus a
backdoor scan on every build.

**B. DuckDB `read_xlsx`** — *already a dependency* (`@duckdb/node-api` 1.5.4,
registered as a dialect). Zero new supply-chain surface, and DuckDB would do
the type inference and batching itself. **Unverified**: I could not test it
here because the native binding is broken in this checkout (see below), and
the `excel` extension may need to be downloadable at runtime, which is a
problem for offline/desktop installs.

**C. Hand-roll** — needs a ZIP reader (Node has zlib but no archive reader)
plus streaming XML. Not worth it; this is the one place a library earns its
keep.

**Recommendation: validate B, fall back to A.** B is strictly better if it
works, because it costs nothing new. That validation is a half-day spike, not
a guess, and it must cover: extension availability offline, date handling,
and memory on a large file.

> **Blocker found while checking:** `@duckdb/node-bindings-darwin-arm64` is
> missing `libduckdb.dylib` in this checkout, so `require('@duckdb/node-bindings')`
> throws `ERR_DLOPEN_FAILED`. That breaks the **DuckDB dialect at runtime**,
> independently of Excel. Worth fixing or confirming it is local-only before
> building anything on DuckDB.

### Work, in order

1. **Spike DuckDB** (half day): can it read a real .xlsx offline, with correct
   dates, without loading the whole file? Decide B vs A on the result.
2. **Reader** behind the same seam as `CsvStreamReader` — emit rows in
   batches, feed the existing batched writer.
3. **Sheet + header selection** in the import UI.
4. **Date/number/boolean coercion**, with tests for both epochs, the 1900 leap
   bug, and format-code detection.
5. **Capacity**: extend `importCapacity()` — xlsx compresses ~10:1, so a
   40 MB upload can be a 400 MB sheet. The current byte-based estimate will
   be wrong for it, and the message should say so.

---

## Part 2 — Google Sheets

### The scale conversation is different

Google caps a spreadsheet at **10 million cells**. A maxed-out sheet is a few
hundred MB of JSON, not 1 GB, and the API is the bottleneck long before the
parser is. Nothing here needs the streaming work.

### Two paths, an order of magnitude apart in cost

**Path A — export URL (recommended first).** A published sheet exposes a CSV
endpoint:

```
https://docs.google.com/spreadsheets/d/<id>/gviz/tq?tqx=out:csv&sheet=<name>
```

The user pastes a link; the server fetches it and runs it through the **CSV
path that already exists**. No OAuth, no tokens, no consent screen, and it
works today with a URL field and a fetch.

Limits worth stating plainly in the UI: the sheet must be shared
("anyone with the link" or published), and it is a snapshot, not a live
connection.

**Path B — Sheets API v4 with OAuth.** Needed only for private sheets or
scheduled refresh:

- register an OAuth client, ship a client id, host a redirect
- consent screen; Google **verification** if distributed publicly, which is a
  process with a review, not a checkbox
- refresh-token storage — the secrets vault already exists for this
- quotas: 300 req/min/project, 60/min/user; paging by A1 range
- desktop vs web need different OAuth flows (loopback vs hosted redirect)

That is a feature with an ongoing compliance surface, not an afternoon.

**Recommendation: ship Path A, and only build Path B if users actually ask for
private or scheduled access.** Path A covers "I have a sheet, get it into my
database" — which is the request most people mean.

### SSRF, if Path A is built

Fetching a user-supplied URL server-side is a classic SSRF vector, and this
server holds decrypted database credentials. Any implementation must:

- allow **only** `https://docs.google.com/…` — an allowlist, not a denylist
- refuse redirects off that host
- cap response size using `importCapacity()`
- set a timeout, and never surface the raw response body on error

This is the part to get right; the parsing is free.

---

## What to settle first

Both formats inherit two open questions from the streaming work, and each new
format multiplies the cost of getting them wrong:

1. **Type inference sample size.** Inference currently reads a whole column.
   Streaming must sample — and a column that looks INTEGER for 1,000 rows but
   holds text at row 900,000 will be typed wrong.
2. **Headerless column naming.** Columns are named from the widest row, which
   is only known at the end.

Answer those, wire CSV and NDJSON through the streaming path, and Excel plugs
into a proven seam instead of a hypothetical one.

## Suggested order

| # | Step | Why here |
| --- | --- | --- |
| 1 | Settle inference sampling + headerless naming | Everything downstream inherits it |
| 2 | Wire CSV/NDJSON streaming into the write path | Proves the seam end to end |
| 3 | Google Sheets via export URL | Cheapest real win; reuses the CSV path |
| 4 | DuckDB xlsx spike → pick B or A | Decides the dependency question with evidence |
| 5 | Excel reader on the streaming seam | The actual format work |
| 6 | Sheets OAuth | Only if private/scheduled access is genuinely wanted |
