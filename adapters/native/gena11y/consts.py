import os
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EVAL_DIR = os.path.normpath(os.path.join(BASE_DIR, '..', 'act-augmented'))
TEMP_FILE_FOLDER = os.path.join(BASE_DIR, 'tmp_images')
os.makedirs(TEMP_FILE_FOLDER, exist_ok=True)
COVERED_SCS = {'1.1.1', '1.3.1', '1.3.2', '1.4.1', '1.4.3', '1.4.5', '1.4.10', '2.4.2', '2.4.4', '2.4.6', '2.4.10', '3.3.1', '3.3.2', '3.3.3', '4.1.2'}
UNCOVERED_SCS = {'1.4.11', '1.4.13', '2.1.1', '2.1.2', '2.4.3', '2.4.7', '4.1.3'}
ALL_CATEGORIES_SCS = COVERED_SCS | UNCOVERED_SCS
CLAUDE_MODEL = None
SYSTEM_MESSAGE = 'You are an Accessibility Expert (WCAG Specialist) detecting WCAG 2.2 violations on web pages. Analyze the provided HTML elements and screenshots for compliance with the specified success criterion. Be precise and avoid false positives — only flag clear violations, not ambiguous cases.\n\nEach element in the input may be prefixed with a [path: /html/...] label giving its XPath. Include that XPath verbatim in your output for any violated element.\n\nRespond with ONLY a JSON object in this exact format (no markdown, no prose):\n{\n  "verdict": "REPRODUCED" | "NOT REPRODUCED" | "PARTIAL",\n  "confidence": "high" | "medium" | "low",\n  "violations": [\n    {\n      "xpath": "<value from [path: ...] label, or null if page-level>",\n      "outerHTML": "<opening tag only, no children>",\n      "reason": "<why it violates the criterion>",\n      "recommendation": "<how to fix>"\n    }\n  ],\n  "summary": "<1-2 sentence summary of findings>"\n}\n\nUse "REPRODUCED" when violations are found, "NOT REPRODUCED" when none are found, "PARTIAL" when some elements pass and others fail or evidence is incomplete.'
