# Sample OCR fixture

`sample-ocr.json.gz` contains raw OCR words, coordinates, confidence and visible glyph sizes from a full browser run on the included `assets/sample.pdf`, plus all 17 requirements parsed from the included Word source. It is compressed JSON, read with Node's built-in `gunzipSync`.

The fixture includes enlarged proofs outside the label so tests catch accidental use of those proofs as evidence on the printed label. Expected outcomes were checked against the original PDF at 400 dpi; the per-section review is in `AUDIT_SAMPLE.md`. This fixture tests comparison and measurement logic; it does not replace a fresh browser OCR run.

# Saved runs of three sheets

`run-sjabry.json.gz`, `run-dolce.json.gz` and `run-rose.json.gz` hold what the page read on three production sheets in a real browser run: the requirements parsed from the Word file, the words of both OCR engines with their places, the places that were looked at again (`edgeProbes`), the callouts, the label contour and the scale. They hold no pixels of the artwork. `tests/runs.test.mjs` judges them with `assess`, the same function the page uses, and compares the answer with what the sheets show (`AUDIT_SAMPLE.md`, `AUDIT_SAN_REMINO.md`).

They are written by `node scripts/build-callout-fixture.mjs sheets.json --runs`, which also rebuilds `callout-readings.json`. The `expected` links in that file are written by a person from the sheet and are only carried over by the script; links of a sheet nobody has checked yet are stored as `proposed` and are not tested.

`sample-ocr.json.gz`, `sample-lines-ocr.json.gz` and `sample-paddle.json.gz` are readings of the sample made by earlier versions of the site. They are kept because tests of the comparison logic were written against them; they no longer show what the site reads today.
