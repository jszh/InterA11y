# Saved Results

`conformance-predictions.csv` supports Evaluation of Current Checkers and InterA11y Ablations. `expert-predictions.csv` supports Expert Evaluation and comparison of general-purpose agents with and without InterA11y tools.

Each record identifies a case, system, condition, model, detection (`flagged`), and saved output state. Rule-based checkers use `model=none` and are stored once. Unsupported or unsuccessful outcomes remain in the denominator as unflagged. `metrics.csv` contains the resulting confusion counts, precision, recall, false discovery rate, false positive rate, and F1. Model means are computed from per-model metrics.

`native-rule-findings.csv` contains SC-specific native violation signals. `rule-ensemble.json` is the frozen ensemble fitted on the conformance set and applied to the expert set. Its clauses are combined with OR; rules inside each clause are combined with AND.

The deterministic ablations reuse saved InterA11y decisions: a deterministic violation is positive; an entirely deterministic, conclusive nonviolation is negative; remaining cases retain the GenA11y or rubrics-only output. They are offline recombinations, without additional model calls.

`resources.csv` records amortized input/output tokens and productive execution time per expert case. Input includes cached tokens once; output includes thinking once. Acquisitions shared by cases are divided equally among those cases. Repeated identical GenA11y HTML-context requests are excluded. Time separates LLM service, tools, and browser/harness processing; resource waits, failed calls, and superseded attempts are excluded, and parallel work contributes its longest retained branch. Empty fields indicate unavailable measurements. The execution-time comparison uses Gemini, GLM, and Luna.
