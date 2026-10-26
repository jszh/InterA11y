import csv
import json
import os
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
AXE_JS_PATH = os.environ['AXE_JS_PATH']
with open(os.path.join(DATA_DIR, 'mapping_dict_file.json')) as f:
    _MAP_RAW = json.load(f)

def _sc_num(s):
    return s.strip().split(' ', 1)[0]
VIOLATION_TO_SCS = {vid: {_sc_num(x) for x in scs} for vid, scs in _MAP_RAW.items()}
with open(os.path.join(DATA_DIR, 'violations_short_description.json')) as f:
    VIOLATION_DESC = json.load(f)
SEMANTIC_VIOLATIONS = []
with open(os.path.join(DATA_DIR, 'violation_taxonomy.csv')) as f:
    for row in csv.DictReader(f):
        if (row.get('Category') or '').strip().lower() == 'semantic':
            name = (row.get('violationnumberID') or '').strip()
            if name:
                SEMANTIC_VIOLATIONS.append(name)
_EXTRA_DESC = {'video-captions-not-descriptive': 'Captions/subtitles are present but do not accurately convey the audio content.', 'landmark-structural-violation': 'Landmark regions (header/nav/main/footer) are missing or structured incorrectly.', 'landmark-purpose-mismatch': 'A landmark role does not match the actual purpose/content of the region.'}

def _taxonomy_block():
    lines = ['Semantic Violation Taxonomy (violation-name: description):']
    for name in SEMANTIC_VIOLATIONS:
        desc = VIOLATION_DESC.get(name) or _EXTRA_DESC.get(name, '')
        lines.append(f'- {name}: {desc}' if desc else f'- {name}')
    return '\n'.join(lines)
SEMANTIC_TAXONOMY_STR = _taxonomy_block()
SEMANTIC_SCS = set()
for _v in SEMANTIC_VIOLATIONS:
    SEMANTIC_SCS |= VIOLATION_TO_SCS.get(_v, set())
AG_SYSTEM = 'You are a web accessibility expert.'
SEMANTIC_PROMPT_TEMPLATE = ' You are a web accessibility expert. Your task is to detect semantic accessibility violations in the given HTML Web page. These violations are often not detectable by standard automated tools and require interpretation of the content meaning and user context.\n\nA semantic violation occurs when:\n- Attributes like alt text, language, or link/button labels are present but do not provide meaningful or accurate information,\n- Visual or multimedia content is not described in a way that conveys its purpose to users with disabilities.\n\nUse the information below to guide your analysis, you are operating on:\n- The domain of the web page: {DOMAIN}\n- The URL of the web page: {URL}\n\nYou are provided with:\n- The HTML code of the web page to analyze,\n- The full semantic violation taxonomy. This taxonomy defines specific types of semantic violations, their descriptions,\n- A screenshot of the rendered view of the web page.\n\n{TAXONOMY}\n\nHTML:\n{HTML}\n\n(Screenshot attached below.)\n\nNow, review the HTML and supplementary data. List all semantic violations you detect, and for each:\n1. Identify the affected HTML element. Enclose the exact HTML snippet using the markers [START] and [END].\n2. Specify the violation name (use the exact violation-name from the taxonomy).\n'
