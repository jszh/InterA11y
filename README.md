# InterA11y

Replication materials for *InterA11y: Interactive Web Accessibility Error Detection with LLM Agents*.

## Contents

- **Conformance test set** — [`datasets/conformance/`](datasets/conformance/): 682 labeled cases, fixture pages, and assets.
- **Expert-labeled set** — [`datasets/expert/`](datasets/expert/): 197 cases, element locators, labels, saved webpages, and resources.
- **Saved results** — [`results/`](results/): case-level predictions, resource measurements, and the frozen rule ensemble.
- **InterA11y and ablations** — [`runtime/`](runtime/): rubrics, scan tools, agentic tools, and deterministic decisions.
- **Baseline adapters** — [`adapters/`](adapters/): accessibility checkers and general-purpose browser agents.
- **Experiment runners and analysis** — [`intera11y_benchmark/`](intera11y_benchmark/): experiment configurations, execution, result parsing, and OpenRouter model adapters.
- **Command-line interface** — [`intera11y.py`](intera11y.py).

Each dataset has an `elements.csv`. A label of `1` means an accessibility violation; `0` means no violation. See [dataset fields](datasets/DATASETS.md) and [saved results](results/README.md).

## Setup

Requires Python 3.11+, Node.js 20+, and Google Chrome. Java and Maven are required for the Java tools.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm ci --ignore-scripts
node adapters/build-aslint.cjs
cp .env.example .env
```

Fill `OPENROUTER_API_KEY` in `.env`. All four model adapters use OpenRouter only. Model IDs are explicit and configurable; unavailable models are not silently replaced. Set `CHROME_PATH` if Chrome is not found automatically.

| CLI alias | Model |
|---|---|
| `gemini` | Gemini 3.7 Flash |
| `luna` | OpenAI GPT-6 Luna |
| `claude` | Claude Haiku 5.5 |
| `glm` | GLM 5.3 Flash |

See the [OpenRouter API documentation](https://openrouter.ai/docs/api/reference/overview) for the shared backend.

[Tool setup](THIRD_PARTY.md) lists upstream links, pinned package versions, licenses, and the separate Browser Use, AgentLab, Editoria11y, and LYNX installation steps.

## Usage

```sh
python intera11y.py list
python intera11y.py doctor
python intera11y.py datasets validate
```

### Recompute the paper results

These commands use the included predictions and make no model calls:

```sh
python intera11y.py parse --experiment conformance-evaluation
python intera11y.py parse --experiment ablation-study
python intera11y.py parse --experiment expert-evaluation
python intera11y.py parse --experiment tool-contribution
```

They write confusion counts, precision, recall, FDR, FPR, F1, category and SC breakdowns, and model means and ranges under `outputs/`. Expert analyses also summarize recorded tokens and execution time. FDR is `FP/(TP+FP)`; FPR is `FP/(FP+TN)`. Model-independent checkers are counted once. Failed or unsupported evaluations remain unflagged in the denominator.

### Run the checkers

```sh
python intera11y.py run --experiment conformance-evaluation --systems axe --limit 1
python intera11y.py run --experiment ablation-study --systems intera11y --condition full --models gemini --limit 1
python intera11y.py run --experiment expert-evaluation --systems gena11y,accessguru,intera11y --models gemini
python intera11y.py run --experiment tool-contribution --systems agentlab,browser-use --models gemini
```

Omit `--systems` to run the experiment's systems, and omit `--models` to use all four models. `--cases`, `--limit`, `--workers`, and `--output` control selection, concurrency, and output location. Browser agents have up to 100 turns. Reasoning is set to high. Labels are used only for scoring, not passed to the checkers.

Existing successful outputs are reused. Failed cases are attempted again only when the command is explicitly rerun; attempts are retained. New results can be analyzed with `parse --predictions outputs/<experiment>/predictions.csv`.

### Expert pages

The saved Expert webpages and their resource directories are included in `datasets/expert/pages/`. To replace them with another local copy:

```sh
python intera11y.py datasets import-expert --source /path/to/saved-pages
```

Alternatively, pass `--page-root /path/to/saved-pages` to `run`.

## Ablations

| Condition | Configuration |
|---|---|
| GenA11y | Original extraction and judgment |
| `deterministic` | GenA11y + deterministic decisions |
| `rubrics` | GenA11y extraction + InterA11y rubrics |
| `deterministic-rubrics` | Rubrics + deterministic decisions |
| `full` | InterA11y with rubrics and agentic tools |

The deterministic tiers are computed from saved baseline and InterA11y outputs: a conclusive deterministic decision takes precedence; otherwise the baseline decision is retained. Their recombination makes no extra model calls. Shared dependencies are executed once and reused.

The rule ensemble is fitted on the conformance set by maximizing F1 over SC-specific AND/OR combinations of native violation rules, then frozen for Expert Evaluation. To reproduce the fit:

```sh
pip install -r requirements-ensemble.txt
python intera11y.py ensemble fit
```

For Browser Use and AgentLab, `general-tools` and `intera11y-tools` select the two tool conditions. Their native action loops are retained. The tools condition registers InterA11y's tools and relevant instructions.

## Attribution

See [third-party notices](THIRD_PARTY.md). ACT fixtures retain W3C attribution. The included BAGEL code is an independent implementation of the published method, not the original authors' withheld implementation.
