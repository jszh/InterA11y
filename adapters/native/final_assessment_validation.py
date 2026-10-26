import re
import json
import unicodedata
COMPLETION_POLICY = 'completed-observations-and-grounded-artifacts-v8'

def parse_decision_object(raw):
    text = str(raw or '').strip()
    text = re.sub('^(?:<invoke\\s*/>\\s*)+', '', text)
    fence = re.fullmatch('```(?:json)?\\s*\\n(.*?)\\n```', text, re.S | re.I)
    if fence:
        text = fence.group(1).strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        value, _ = json.JSONDecoder().raw_decode(text)
    if not isinstance(value, dict):
        raise ValueError('Decision must be a JSON object')
    return value
_PLACEHOLDER = re.compile('^placeholder(?:\\s+while gathering evidence|\\s*[—–-]\\s*will be replaced after evidence collection)?[.!\\s]*$', re.I)
_DUMMY = re.compile('^(?:todo|tbd|observations|criterion reasoning|\\.\\.\\.)[.!\\s]*$', re.I)
_PENDING = re.compile('^(?:(?:collecting|gathering|acquiring|reviewing) (?:the )?evidence|(?:I |we )?(?:will|need to|must) (?:first )?(?:now )?(?:resolve|inspect|check|measure|focus|collect|gather|test|identify)\\b[^.!?]*)[.!\\s]*$', re.I)
_BLOCKED = re.compile('\\b(?:cannot|could not|unable|unavailable|failed|failure|inaccessible|not supported)\\b', re.I)
_PENDING_SENTENCE = re.compile('(?:^|[.!?]\\s+)(?:I|we) (?:will|need to|must) (?:(?:first|now) )?(?:resolve|inspect|check|measure|focus|collect|gather|test|identify)\\b', re.I)
_INITIAL_OR_PENDING = re.compile('^(?:initial (?:state|observation)(?: only)?\\s*[;:.—–-]|pending (?:identification|inspection|measurement|evidence collection)\\b|not yet determined\\b)', re.I)
_NO_EVIDENCE_YET = re.compile("\\bno (?:targeted )?(?:evidence|measurements)(?: (?:has|have) been)? (?:collected|taken)(?: (?:yet|so far))?\\b|\\b(?:cannot|can't|unable to) (?:settle|determine|reach) (?:the |a )?verdict yet\\b", re.I)
_ACTUAL_OBSTACLE = re.compile('\\b(?:browser|page|control|element|tool|request|network|session|measurement)\\b[^.!?]{0,100}\\b(?:failed|failure|unavailable|inaccessible|not supported|could not be|cannot be|could not activate|could not load)\\b', re.I)

def _degenerate_repetition(text):
    words = re.findall('\\w+', text.casefold())
    if len(words) < 100:
        return False
    for period in range(3, min(32, len(words) // 8) + 1):
        run = period
        for i in range(period, len(words)):
            run = run + 1 if words[i] == words[i - period] else period
            if run >= max(80, period * 8, len(words) * 0.7):
                return True
    return False

def image_artifact_ids(value):
    from pathlib import Path
    if isinstance(value, dict):
        return {Path(value['imageFile']).stem} if value.get('imageFile') else set().union(*(image_artifact_ids(v) for v in value.values()))
    if isinstance(value, list):
        return set().union(*(image_artifact_ids(v) for v in value))
    return set()

def final_assessment_error(decision, gena11y=False, evidence_ids=None, artifact_ids=None):
    if not isinstance(decision, dict):
        return 'Final assessment must be an object.'
    if gena11y:
        fields = ('summary',)
        verdicts = ('REPRODUCED', 'NOT REPRODUCED', 'PARTIAL')
    else:
        fields = ('evidence', 'justification')
        verdicts = ('PASS', 'FAIL', 'UNDETERMINED')
    if decision.get('verdict') not in verdicts:
        return 'Final assessment has an invalid verdict.'
    for field in fields:
        text = decision.get(field)
        if not isinstance(text, str) or not text.strip():
            return f'Final assessment requires substantive {field}.'
        if not any((c.isalpha() and unicodedata.category(c) != 'Co' for c in text)):
            return f'Final assessment {field} contains no substantive prose.'
        if _degenerate_repetition(text):
            return f'Final assessment {field} contains a repeated decoding loop; provide completed observations and reasoning.'
        if _DUMMY.fullmatch(text.strip()) or _PLACEHOLDER.fullmatch(text.strip()):
            return f'Final assessment {field} is placeholder text. Continue inspecting if needed, or give the actual observations and criterion reasoning. A genuine UNDETERMINED assessment must explain what could not be determined.'
        if _NO_EVIDENCE_YET.search(text) and (not _ACTUAL_OBSTACLE.search(' '.join((str(decision.get(f, '')) for f in fields)))):
            return f'Final assessment {field} describes pending work, not completed observations. Execute the intended action or tool call; inability to decide before inspection is not an observed execution obstacle.'
        if (_PENDING.fullmatch(text.strip()) or _INITIAL_OR_PENDING.search(text.strip()) or (decision.get('verdict') == 'UNDETERMINED' and _PENDING_SENTENCE.search(text))) and (not _BLOCKED.search(text)):
            return f'Final assessment {field} describes pending work, not completed observations. Continue with an action or tool call, or explain the actual obstacle that prevents a determination. Do not submit an interim plan as a final assessment.'
    if evidence_ids is not None:
        citations = re.findall('\\bevidence(?:Id)?\\s*[:=#]?\\s*["\\x27]?([0-9a-f]{8,64})\\b', ' '.join((str(decision.get(f, '')) for f in fields)), re.I)
        for citation in citations:
            matches = [identity for identity in evidence_ids if identity.lower().startswith(citation.lower())]
            if len(matches) != 1:
                return 'Final assessment cites unavailable or ambiguous evidence ID ' + citation + '. Use the actual returned observations; agent-authored notes are not tool results. Continue inspection if the claimed measurement has not been executed.'
    if artifact_ids is not None:
        text = json.dumps(decision, ensure_ascii=False)
        citations = re.findall('\\b(?:image|crop)(?:\\s+(?:artifact|file))?\\s*(?:ID)?\\s*[:=#]?\\s*[\\"\\x27`]?([0-9a-f]{8,64})\\b', text, re.I)
        for citation in citations:
            if sum((str(identity).lower().startswith(citation.lower()) for identity in artifact_ids)) != 1:
                return 'Final assessment cites unavailable or ambiguous image artifact ' + citation + '. Use only completed observations and returned artifacts.'
    if not gena11y:
        return final_reference_structure_error(decision)
    return None

def final_reference_structure_error(decision):
    findings = decision.get('findings', [])
    if not isinstance(findings, list) or any((not isinstance(f, dict) for f in findings)):
        return 'Final assessment findings must be a list of objects.'
    if decision.get('verdict') == 'FAIL' and (not findings):
        return 'A FAIL assessment requires findings identifying observed failing elements.'
    for finding in findings:
        reference = finding.get('element_ref') or finding.get('xpath')
        if not isinstance(reference, str) or not reference.strip():
            return 'Each finding requires a nonempty observed element reference or XPath.'
        resolution = finding.get('referenceResolution')
        if resolution and (not resolution.get('xpath')):
            return 'Final finding has an unresolved or ambiguous observed element reference.'
        expression = reference[6:] if reference.startswith('xpath:') else reference
        if expression.startswith('/'):
            try:
                from lxml import etree
            except ImportError:
                continue
            try:
                for segment in expression.split('>>'):
                    etree.XPath(segment[5:] if segment.startswith('frame/') else segment)
            except (etree.XPathError, ValueError):
                return 'Final finding contains an invalid XPath expression.'
    return None

def has_literal_placeholder(assessment):
    return isinstance(assessment, dict) and any((str(assessment.get(field, '')).strip().rstrip('.!').lower() == 'placeholder' for field in ('evidence', 'justification')))

def has_placeholder_final(assessment):
    return isinstance(assessment, dict) and any((_PLACEHOLDER.fullmatch(str(assessment.get(field, '')).strip()) for field in ('evidence', 'justification')))
