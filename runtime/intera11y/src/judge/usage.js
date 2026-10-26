'use strict';

function addUsage(total, source) {
  if (!source) return;
  for (const k of ['calls', 'requestAttempts', 'unreportedRequestAttempts', 'inputTokens', 'outputTokens', 'costUsd', 'thinkingTokens', 'cachedTokens',
    'cacheWriteTokens', 'apiCostUsd', 'missingApiCostCalls', 'missingThinkingCalls', 'missingCachedTokenCalls']) {
    if (typeof source[k] === 'number') total[k] = (total[k] || 0) + source[k];
  }
  for (const k of ['outputIncludesThinking', 'costSource']) if (source[k] !== undefined) total[k] = source[k];
  if (total.costSource === 'openrouter-api-reported') {
    total.reportedApiCostUsd = total.costUsd;
    if (total.missingApiCostCalls) total.apiCostUsd = null;
    if (total.missingThinkingCalls) total.thinkingTokens = null;
    if (total.missingCachedTokenCalls) total.cachedTokens = null;
  }
}
module.exports = { addUsage };
