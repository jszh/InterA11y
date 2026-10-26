import math
import os

def gemini_call_timeout(default_seconds):
    seconds = float(os.environ.get('A11Y_GEMINI_CALL_TIMEOUT_SECONDS', default_seconds))
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError('Gemini call timeout must be finite and positive')
    return seconds

def gemini_http_timeout_ms(remaining_seconds=float('inf')):
    seconds = gemini_call_timeout(120)
    if math.isfinite(remaining_seconds):
        seconds = min(seconds, max(1, remaining_seconds - 10))
    return max(1000, int(seconds * 1000))
