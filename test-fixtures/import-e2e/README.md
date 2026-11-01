# import-e2e fixtures

These files are synthetic, checked-in fixtures for the local import/extraction tests.
They contain no user data, real keys, or copied textbook content.

| File | Purpose |
| --- | --- |
| `geography.txt` | Plain UTF-8 text with Chinese punctuation. |
| `geography.md` | Markdown heading + paragraph; source wording/punctuation preserved. |
| `geography.html` | Valid HTML with `<head><title>`, heading, and paragraph. The title must not appear in extracted body text. |
| `geography.docx` | Minimal existing one-paragraph DOCX. |
| `geography-structure.docx` | Synthetic DOCX with ordered paragraphs, a tab, a manual `<w:br/>`, a 2×2 table, an OMML equation marker, and a drawing marker. It exercises table cell order, table/image/equation/break warnings, and the fact that raw-text extraction does not group table rows. |
| `geography.pdf` | Minimal valid PDF with a real ASCII text layer (not a scan). Used for real `pdf-parse` page extraction. |

The structured DOCX and PDF were generated locally from literal XML/content streams.
`desktop/test/importer.test.cjs` also builds a temporary oversized PDF at test time to
exercise the 500,000-character per-page clip without storing a large fixture.
