# Datasets

`conformance/elements.csv` contains the 682 conformance cases: 223 ACT cases and 459 generated cases; 316 violations and 366 nonviolations. The evaluation unit is a fixture page, so its XPath is blank. All 682 fixture HTML files are directly in `conformance/pages/`. Supporting images, styles, scripts, audio, linked pages, and iframe documents are in `conformance/assets/`.

`expert/elements.csv` contains the 197 expert-labeled cases: 107 violations and 90 nonviolations. Each row identifies the evaluated page, success criterion, assessment scope, element XPath, and final label. Each case contributes one final label.

## CSV fields

| Field | Meaning |
|---|---|
| `case_id` | Stable identifier |
| `sc` | WCAG success criterion |
| `page` | Package-relative fixture or snapshot location |
| `scope` | `page` or `element` |
| `xpath` | Annotated target; blank for page assessments |
| `label` | `1`: violation; `0`: no violation |
| `source` | ACT, InterA11y, or Expert |
| `source_url` | Original public URL when available |
| `html` | Optional element excerpt; unused in these manifests |

`pages.csv` lists the saved pages and public source URLs. Expert URL query strings are omitted. Conformance fixtures omit comments that reveal labels.

The evaluated expert website snapshots are included in `expert/pages/`. Live websites can differ from these saved versions. Personal account information, private previews, and captured authentication values are replaced with `[REDACTED]`; preview placeholders are in `expert/assets/`.

ACT materials are attributed to the [W3C Accessibility Conformance Testing project](https://www.w3.org/WAI/standards-guidelines/act/rules/); see the [ACT Rules license](https://act-rules.github.io/pages/license/).

Run `python3 datasets/validate.py` from the package root to verify saved pages, case counts, labels, and prediction coverage.
