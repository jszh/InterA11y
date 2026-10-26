"""OpenRouter transport for the native GenA11y judgment interface."""
import os
import time
from intera11y_benchmark.providers import OpenRouterClient
from openrouter_usage import normalize_response


def install(detector, model, effort='high', api_key=None):
    if not model or '/' not in model:
        raise ValueError('Use an explicit OpenRouter model ID (provider/model).')
    detector.MODEL = model
    detector.EFFORT = effort

    def dispatch(blocks, system=detector.SYSTEM_MESSAGE):
        text, images = detector._prepare_inline(blocks)
        content = [{'type': 'text', 'text': text}]
        content += [{'type': 'image_url', 'image_url': {
            'url': 'data:' + mime + ';base64,' + data}} for mime, data in images]
        messages = ([{'role': 'system', 'content': system}] if system else [])
        messages.append({'role': 'user', 'content': content})
        ledger = detector.timing_ledger()
        with ledger.acquire(detector._LLM_SEM, 'llm-slot'):
            with ledger.span('llm', 'openrouter-chat-completions') as span:
                detector._CTX.http_attempts = getattr(detector._CTX, 'http_attempts', []) + [span]
                reply = OpenRouterClient(api_key=api_key or os.environ.get('OPENROUTER_API_KEY'),
                    model=model, max_retries=0).chat(messages, model=model,
                    temperature=0, reasoning={'effort': effort}, usage={'include': True})
                usage = normalize_response(reply)
                choice = reply.get('choices', [{}])[0]
                usage['finishReason'] = choice.get('finish_reason')
                span['usage'] = usage
                ledger.write({'event': 'usage', 'id': span['id'], 'usage': usage})
                message = choice.get('message') or {}
                if reply.get('error') or choice.get('finish_reason') == 'error':
                    ledger.exclude(span, 'provider-error')
                    raise RuntimeError(str(reply.get('error') or 'Provider completion error'))
                if choice.get('finish_reason') != 'stop':
                    ledger.exclude(span, 'incomplete-provider-response')
                    usage['error'] = 'Incomplete provider response: ' + str(choice.get('finish_reason'))
                    return text, '', usage, message.get('reasoning') or '', 'openrouter'
                detector._stat_add(usage.get('input_tokens', 0) or 0,
                    usage.get('output_tokens', 0) or 0,
                    cache_read=usage.get('cache_read_input_tokens', 0) or 0,
                    cost=usage.get('apiCostUsd', 0) or 0,
                    done=bool(message.get('content')),
                    thinking=usage.get('reasoning_tokens', 0) or 0)
                return text, message.get('content') or '', usage, message.get('reasoning') or '', 'openrouter'

    detector.dispatch = dispatch
    detector._provider = lambda: 'openrouter'
