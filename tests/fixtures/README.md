# Sample OCR fixture

`sample-ocr.json.gz` contains raw OCR words, coordinates, confidence and visible glyph sizes from a full browser run on the included `assets/sample.pdf`, plus all 17 requirements parsed from the included Word source. It is compressed JSON, read with Node's built-in `gunzipSync`.

The fixture includes enlarged proofs outside the label so tests catch accidental use of those proofs as evidence on the printed label. Expected outcomes were checked against the original PDF at 400 dpi; the per-section review is in `AUDIT_SAMPLE.md`. This fixture tests comparison and measurement logic; it does not replace a fresh browser OCR run.
