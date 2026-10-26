def normalize_response(response):
    raw = response.get('usage') or {}
    prompt = raw.get('prompt_tokens_details') or {}
    output = raw.get('completion_tokens_details') or {}
    reasoning = output.get('reasoning_tokens')
    completion = raw.get('completion_tokens')
    inconsistent = completion is not None and reasoning is not None and (reasoning > completion)
    return {'input_tokens': raw.get('prompt_tokens'), 'output_tokens': completion, 'reasoning_tokens': reasoning, 'thoughts_tokens': reasoning, 'visible_output_tokens': completion - reasoning if completion is not None and reasoning is not None and (not inconsistent) else None, 'inconsistentReasoningTokens': inconsistent, 'cache_read_input_tokens': prompt.get('cached_tokens'), 'cache_creation_input_tokens': prompt.get('cache_write_tokens'), 'costUsd': raw.get('cost'), 'apiCostUsd': raw.get('cost'), 'upstreamInferenceCostUsd': (raw.get('cost_details') or {}).get('upstream_inference_cost'), 'generationId': response.get('id'), 'provider': response.get('provider'), 'model': response.get('model'), 'rawUsage': raw, 'outputIncludesThinking': True, 'costSource': raw.get('cost_source', 'openrouter-api-reported')}

def summarize(records):
    pairs = {'inputTokens': 'input_tokens', 'outputTokens': 'output_tokens', 'thinkingTokens': 'reasoning_tokens', 'cachedTokens': 'cache_read_input_tokens', 'cacheWriteTokens': 'cache_creation_input_tokens', 'apiCostUsd': 'apiCostUsd'}
    return {**{out: sum((r[key] for r in records)) if all((r.get(key) is not None for r in records)) else None for out, key in pairs.items()}, 'calls': len(records), 'reportedApiCostUsd': sum((r.get('apiCostUsd') or 0 for r in records)), 'missingApiCostCalls': sum((r.get('apiCostUsd') is None for r in records)), 'missingThinkingCalls': sum((r.get('reasoning_tokens') is None for r in records)), 'missingCachedTokenCalls': sum((r.get('cache_read_input_tokens') is None for r in records)), 'inconsistentReasoningCalls': sum((bool(r.get('inconsistentReasoningTokens')) for r in records)), 'outputIncludesThinking': True, 'costSource': next((r.get('costSource') for r in records if r.get('costSource')), 'openrouter-api-reported')}

def summarize_ledger(records):
    requests = [r for r in records if r.get('kind') == 'llm']
    usage = [r.get('usage') or normalize_response({}) for r in requests]
    return {**summarize(usage), 'requestAttempts': len(requests), 'unreportedRequestAttempts': sum((not r.get('usage') for r in requests))}
