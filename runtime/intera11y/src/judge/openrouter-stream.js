'use strict';

async function readCompletion(response, onActivity = () => {}) {
  if (!response.body || !String(response.headers?.get('content-type') || '').includes('text/event-stream')) return response.json();
  const result = { choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning: '' }, finish_reason: null }] };
  const message = result.choices[0].message, tools = new Map(), details = new Map();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', completed = false;
  function frame(text) {
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { completed = true; return; }
    const chunk = JSON.parse(data);
    for (const key of ['id', 'model', 'provider', 'usage', 'error']) if (chunk[key] !== undefined) result[key] = chunk[key];
    for (const choice of chunk.choices || []) {
      if ((choice.index || 0) !== 0) continue;
      if (choice.finish_reason) result.choices[0].finish_reason = choice.finish_reason;
      const delta = choice.delta || {};
      for (const key of ['content', 'reasoning']) if (typeof delta[key] === 'string') message[key] += delta[key];
      for (const item of delta.reasoning_details || []) {
        const key = `${item.index ?? 0}:${item.type}`;
        const prior = details.get(key);
        if (!prior) details.set(key, { ...item });
        else {
          for (const field of ['text', 'summary', 'data']) if (typeof item[field] === 'string') prior[field] = (prior[field] || '') + item[field];
          for (const field of ['id', 'format']) if (item[field] !== undefined) prior[field] = item[field];
        }
      }
      for (const deltaTool of delta.tool_calls || []) {
        const index = deltaTool.index ?? 0;
        if (!tools.has(index)) tools.set(index, { id: '', type: 'function', function: { name: '', arguments: '' } });
        const tool = tools.get(index);
        if (deltaTool.id) tool.id = deltaTool.id;
        if (deltaTool.type) tool.type = deltaTool.type;
        for (const key of ['name', 'arguments']) if (typeof deltaTool.function?.[key] === 'string') tool.function[key] += deltaTool.function[key];
      }
    }
  }
  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        frame(event);
      }
    }
    if (!completed) {
      buffer += decoder.decode();
      if (buffer.trim()) frame(buffer);
    }
    if (!completed || !result.choices[0].finish_reason) result.error ||= { message: 'stream-ended-without-complete-response' };
    if (tools.size) message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([index, tool]) => tool);
    if (details.size) message.reasoning_details = [...details.values()];
    return result;
  } finally {
    if (completed) await reader.cancel();
    reader.releaseLock();
  }
}

module.exports = { readCompletion };
