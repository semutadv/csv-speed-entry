# Fast CSV reader — csv-reader-speed-01

![competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)
![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/semutadv/csv-speed-entry/rank.svg)
![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/semutadv/csv-speed-entry/reward.svg)

An entry for the make.fun bounty
[csv-reader-speed-01-run-20261121](https://make.fun/bounties/csv-reader-speed-01-run-20261121):
a drop-in replacement for csv-reader 1.0.0 that returns bit-exact answers —
`{columns, rows, errors}` for an input `{text, header}` — and reads them
faster.

## What it does

`solve.js` exports `run(input)`, a dependency-free ES module function that
reads a CSV text once, left to right, under csv-reader's broken-row policy:

- one leading U+FEFF is dropped; records end at LF or CRLF; a line with no
  characters is no record;
- a lone CR outside quotes is dropped (`stray_cr`);
- a field that opens with a quote runs to the next undoubled quote — `""`
  is one quote, CR and CRLF inside read as one LF — and whatever follows
  the closing quote is appended as it stands (`quote_junk`); a quote that
  never closes is a literal character and the rest is re-read unquoted
  (`unterminated_quote`);
- a quote inside an unquoted field is a literal character; fields are
  never trimmed or converted;
- the first record is the header when `header` is true; every row is
  padded (`short_row`) or cut (`long_row`) to the first record's width;
- errors are `{code, line, row}` in the order met, with `line` the
  1-based line the record starts on (line breaks inside quotes count)
  and `row` the record's index in `rows`, null for the header.

`main.ts` is the driver the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json` (`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand
in for `/input` and `/output` outside a container). It turns V8's
incremental marking off before `solve.js` is imported, as the house
driver does.

## How it is fast

- Fields are never built character by character: plain stretches of text
  are cut out whole with `slice()`, and delimiter hunts run through the
  engine's `indexOf`.
- A quote-free, CR-free line is recognised up front (two forward-only
  watermarks track the next quote and the next CR) and split on its
  commas in one go — the common case for well-formed data.
- Inside quotes, the next quote is found with `indexOf`; line breaks in
  the stretch before it are counted, not copied, unless a CR forces the
  stretch to be rebuilt with CRs read as LFs.
- A shared result slot means the field scanners allocate no result
  object per field.

Correctness was checked against csv-reader 1.0.0 itself: all 6 practice
answers identical, and a fuzzer comparing both readers on hundreds of
deliberately broken CSVs (random quotes, doubled quotes, CRLF, lone CRs,
BOM, unterminated quotes, junk after closing quotes, empty lines and
fields, unicode) found no difference.

## Licence

MIT — see [LICENSE](LICENSE).
