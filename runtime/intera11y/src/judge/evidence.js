'use strict';

function evidenceProblem(answer, tools, observations, candidate) {
  if (!['PASS', 'FAIL'].includes(answer.verdict)) return null;

  const placeholder = value => /^(?:\s*|\.{3}|…|placeholder|<[^>]+>)$/i.test(String(value ?? '').trim());
  if (placeholder(answer.evidence) || placeholder(answer.reason))
    return 'PASS and FAIL require actual evidence and reasoning, not empty fields or answer-template placeholders';
  if (typeof answer.path === 'string' && /^\s*<[^>]+>\s*$/.test(answer.path))
    return 'the finding path is an answer-template placeholder, not an observed XPath';
  const text = `${answer.evidence || ''}\n${answer.reason || ''}`;
  for (const name of tools || []) {

    let claims = text.replace(new RegExp(`\\b${name}\\s+(?:was|is)\\s+not\\s+(?:needed|required|called|executed|used)\\b`, 'gi'), 'tool not executed');

    const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const o of observations.filter(o => o.name === name && o.result?.error)) {
      const error = String(o.result.error);
      claims = claims.replace(new RegExp(`\\b${name}\\b[^\\n.!?]{0,180}(?:returned|reported|failed with|gave)[^\\n.!?]{0,100}${escape(error)}`, 'gi'), 'recorded tool failure');
    }
    if (new RegExp(`\\b${name}\\b`).test(claims) && !observations.some(o => o.name === name && !o.result?.error))
      return `${name} is cited but has no successful recorded execution`;

  }
  for (const requirement of candidate?.requiredEvidence || []) {
    const found = observations.some(o => o.name === requirement.tool &&
      (requirement.paths || []).every(p => (o.args.iframeXpaths || []).includes(p) &&
        (o.result?.iframes || []).some(f => f.iframeXpath === p && f.found && typeof f.title === 'string' && typeof f.visibleText === 'string')));
    if (!found) return `${candidate.id}: ${requirement.tool} must observe the same-named iframe set before deciding its purpose equivalence`;
  }
  return null;
}

const terminalProviderError = error => /(?:^http-|\bHTTP\s+)(401|402|403)\b/i.test(String(error || ''));
module.exports = { evidenceProblem, terminalProviderError };
