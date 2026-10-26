# Third-party tools

Versions are pinned in `package-lock.json`, the requirements files, and `tools.json`.
Tool-specific licenses remain in force. Installed packages retain their upstream notices.

| Tool | Source | Version | License |
|---|---|---|---|
| Alfa | [Siteimprove/alfa](https://github.com/Siteimprove/alfa) | 0.117.0; Puppeteer integration 0.84.0 | MIT |
| ASLint | [essentialaccessibility/aslint](https://github.com/essentialaccessibility/aslint) | 0.0.58 | MPL-2.0 |
| axe-core | [dequelabs/axe-core](https://github.com/dequelabs/axe-core) | 4.12.1 | MPL-2.0 |
| BAGEL | [CHI paper](https://doi.org/10.1145/3544548.3580749) | Included independent implementation | No package license assigned |
| Editoria11y | [itmaybejj/editoria11y](https://github.com/itmaybejj/editoria11y) | 3.0.2 | GPL-2.0 |
| HTML_CodeSniffer | [squizlabs/HTML_CodeSniffer](https://github.com/squizlabs/HTML_CodeSniffer) | 2.5.1 | BSD-3-Clause |
| IBM Equal Access | [IBMa/equal-access](https://github.com/IBMa/equal-access) | 4.0.26 | Apache-2.0 |
| LYNX | [USC-SQL/NavigationDetection](https://github.com/USC-SQL/NavigationDetection) | `648b263e0bc4009e378bab52955b021c6c295933` | No redistribution license identified; external checkout |
| Nu Html Checker | [validator/validator](https://github.com/validator/validator) | 26.10.12 | MIT |
| QualWeb | [qualweb/qualweb](https://github.com/qualweb/qualweb) | Core 0.8.11; ACT rules 0.8.0; WCAG techniques 0.4.7 | ISC |
| Testaro | [cvs-health/testaro](https://github.com/cvs-health/testaro) | 58.0.6 | MIT |
| GenA11y | [seal-hub/GenA11y](https://github.com/seal-hub/GenA11y) | Adapted extraction and judgments | GPL-3.0-only |
| AccessGuru | [NadeenAhmad/AccessGuruLLM](https://github.com/NadeenAhmad/AccessGuruLLM) | Adapted detector and taxonomy | MIT |
| López-Gil and Pereira | [Replication study](https://doi.org/10.1016/j.infsof.2026.108215) | Published Query 110 | Included upstream license |
| Browser Use | [browser-use/browser-use](https://github.com/browser-use/browser-use) | 0.12.6 | MIT |
| AgentLab | [ServiceNow/AgentLab](https://github.com/ServiceNow/AgentLab) | 0.4.2 | Apache-2.0 |

## Installation

Run `npm ci --ignore-scripts`, then `node adapters/build-aslint.cjs`.
Nu Html Checker uses Java and the `vnu-jar` package. The adapter starts a local validator;
it does not upload saved HTML to the public validation service.

Install `requirements.txt` for GenA11y and AccessGuru. Use separate environments for
`requirements-browser-use.txt` and `requirements-agentlab.txt`. In the AgentLab
environment, first run `pip install --no-deps agentlab==0.4.2`, then install
`requirements-agentlab.txt`; only open-ended BrowserGym tasks are needed. Set `BROWSER_USE_PYTHON`
and `AGENTLAB_PYTHON` to those environments' Python executables. Set `CHROME_PATH` to
an installed Chrome executable when needed. AgentLab also needs `python -m playwright install chromium`.

Editoria11y is installed separately:

```sh
git clone https://github.com/itmaybejj/editoria11y.git external/editoria11y
git -C external/editoria11y checkout 4e45492166d641a920d9caa8c550eb303ab7b1e0
export EDITORIA11Y_HOME="$PWD/external/editoria11y"
```

LYNX requires Java 17 or newer and Maven:

```sh
git clone https://github.com/USC-SQL/NavigationDetection.git external/NavigationDetection
git -C external/NavigationDetection checkout 648b263e0bc4009e378bab52955b021c6c295933
export LYNX_HOME="$PWD/external/NavigationDetection"
```

Only our portable acquisition wrapper is included for LYNX. It invokes the upstream
feature extraction, context-tree construction, affinity functions, and native rules.

## Included sources

- `adapters/native/gena11y/`: adapted GenA11y extraction and judgment functions;
  [GPL-3.0 notice](adapters/native/gena11y/LICENSE).
- `adapters/native/accessguru/`: adapted AccessGuru detector, prompt, taxonomy, and mappings;
  [MIT notice](adapters/native/accessguru/LICENSE.txt).
- `adapters/checkers/upstream/`: Testaro native rules and required utilities, Copyright
  CVS Health and affiliates; [MIT notice](adapters/checkers/upstream/LICENSE).
- `adapters/checkers/metadata/testilo-issues.js`: CVS Health Testilo rule metadata,
  retaining its included MIT notice.
- `adapters/lopez/`: published zero-shot templates and [upstream notice](adapters/lopez/LICENSE).
- `adapters/bagel/`: our independent paper-based focus and navigation implementation.
  Its source documents the implemented predicates; it is not the authors' withheld code.

The GenA11y adapter retains HTML extraction, screenshots, chunk splitting, prompts,
and output parsing. The Rubrics Only ablation applies the released InterA11y rubrics
to the same six-extractor evidence bundle. Browser Use and AgentLab retain their native
browser observations and actions; the tools condition adds the InterA11y tool bridge.
All model calls use OpenRouter. No subscription or alternate-provider fallback is included.

ACT fixtures retain their [W3C Software and Document notice](datasets/conformance/ACT-LICENSE.md).
