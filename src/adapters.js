'use strict';

/**
 * Wire-format adapters.
 *
 *  - `StreamMeter`      passes SSE through untouched while learning usage/TTFT
 *  - `AnthropicStream`  converts Anthropic SSE -> OpenAI SSE
 *  - `toAnthropic` / `fromAnthropic` convert a single request/response
 *
 * Everything else is OpenAI-compatible and needs no adaptation.
 */

const { Transform } = require('stream');
const { normalizeMessages, estimateTokens } = require('./util');

/* ------------------------------------------------------------------ */
/* Usage meter for pass-through OpenAI streams                         */
/* ------------------------------------------------------------------ */

class StreamMeter extends Transform {
  constructor(opts = {}) {
    super(opts);
    this.buf = '';
    this.usage = null;
    this.textChars = 0;
    this.firstTokenMs = null;
    this.startedAt = Date.now();
    this.bytes = 0;
    this.sawDone = false;
    this.upstreamError = null;
  }

  _transform(chunk, enc, cb) {
    this.bytes += chunk.length;
    const text = chunk.toString('utf8');
    this.buf += text;
    this._consume(false);
    cb(null, chunk);
  }

  _flush(cb) {
    this._consume(true);
    cb();
  }

  _consume(final) {
    const lines = this.buf.split('\n');
    this.buf = final ? '' : lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        this.sawDone = true;
        continue;
      }
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt && evt.error) {
        this.upstreamError = evt.error.message || JSON.stringify(evt.error);
      }
      if (evt && evt.usage) this.usage = evt.usage;
      const delta = evt && evt.choices && evt.choices[0] && evt.choices[0].delta;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content.length) {
          if (this.firstTokenMs == null) this.firstTokenMs = Date.now() - this.startedAt;
          this.textChars += delta.content.length;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (tc && tc.function && typeof tc.function.arguments === 'string') this.textChars += tc.function.arguments.length;
          }
        }
      }
    }
  }

  /** Normalised usage — real numbers when the provider sends them. */
  getUsage(body) {
    if (this.usage && (this.usage.total_tokens || this.usage.completion_tokens)) {
      return {
        prompt_tokens: this.usage.prompt_tokens || 0,
        completion_tokens: this.usage.completion_tokens || 0,
        total_tokens: this.usage.total_tokens || (this.usage.prompt_tokens || 0) + (this.usage.completion_tokens || 0),
      };
    }
    const base = estimateTokens(body);
    const out = Math.ceil(this.textChars / 4);
    return { prompt_tokens: base.prompt_tokens, completion_tokens: out, total_tokens: base.prompt_tokens + out, estimated: true };
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic request / response                                        */
/* ------------------------------------------------------------------ */

const FINISH_MAP = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  pause_turn: 'stop',
  refusal: 'content_filter',
};

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c && c.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function toAnthropic(body, model) {
  const msgs = normalizeMessages(body);
  const system = msgs.filter((m) => m.role === 'system').map((m) => contentToText(m.content)).join('\n\n');
  const messages = [];

  const push = (role, blocks) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id || 'tool_call',
        content: contentToText(m.content),
      }]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const text = contentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || tc;
          let input = {};
          try { input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {}); } catch { input = {}; }
          blocks.push({ type: 'tool_use', id: tc.id || 'tool_call', name: fn.name, input });
        }
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' });
      push('assistant', blocks);
      continue;
    }
    push('user', [{ type: 'text', text: contentToText(m.content) }]);
  }

  if (!messages.length) messages.push({ role: 'user', content: [{ type: 'text', text: '' }] });
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });

  const out = {
    model,
    messages,
    max_tokens: Number(body.max_completion_tokens || body.max_tokens || 1024),
    stream: !!body.stream,
  };
  if (system) out.system = system;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) => {
      const fn = t.function || t;
      return { name: fn.name, description: fn.description, input_schema: fn.parameters || { type: 'object', properties: {} } };
    });
  }
  return out;
}

function fromAnthropic(json, fallbackModel) {
  if (json && json.object === 'chat.completion') return json;
  const blocks = Array.isArray(json.content) ? json.content : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b, i) => ({
      id: b.id || `call_${i}`,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
    }));
  const usage = json.usage || {};
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: json.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json.model || fallbackModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? 'tool_calls' : FINISH_MAP[json.stop_reason] || 'stop',
      },
    ],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic SSE -> OpenAI SSE                                          */
/* ------------------------------------------------------------------ */

class AnthropicStream extends Transform {
  constructor(opts = {}) {
    super(opts);
    this.buf = '';
    this.id = `chatcmpl-${Date.now()}`;
    this.created = Math.floor(Date.now() / 1000);
    this.model = opts.model || 'claude';
    this.startedAt = Date.now();
    this.firstTokenMs = null;
    this.textChars = 0;
    this.usage = { prompt_tokens: 0, completion_tokens: 0 };
    this.finishReason = null;
    this.toolIndex = -1;
    this.bytes = 0;
    this.sawDone = false;
  }

  _send(obj) {
    this.push(`data: ${JSON.stringify(obj)}\n\n`);
  }

  _delta(delta, finish = null) {
    this._send({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  }

  _transform(chunk, enc, cb) {
    this.bytes += chunk.length;
    this.buf += chunk.toString('utf8');
    let idx = this.buf.indexOf('\n\n');
    while (idx !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this._event(raw);
      idx = this.buf.indexOf('\n\n');
    }
    cb();
  }

  _flush(cb) {
    if (this.buf.trim()) this._event(this.buf);
    const u = this.usage;
    this._send({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: {}, finish_reason: this.finishReason || 'stop' }],
      usage: { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.prompt_tokens + u.completion_tokens },
    });
    this.push('data: [DONE]\n\n');
    this.sawDone = true;
    cb();
  }

  _event(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let json;
    try {
      json = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (json.type === 'error' || json.error) {
      this._send({ error: { message: (json.error && json.error.message) || 'Upstream error', type: 'upstream_error' } });
      return;
    }
    const type = json.type || event;
    switch (type) {
      case 'message_start': {
        if (json.message) {
          this.id = json.message.id || this.id;
          this.model = json.message.model || this.model;
          if (json.message.usage) this.usage.prompt_tokens = json.message.usage.input_tokens || 0;
        }
        this._delta({ role: 'assistant', content: '' });
        break;
      }
      case 'content_block_start': {
        const block = json.content_block || {};
        if (block.type === 'tool_use') {
          this.toolIndex += 1;
          this._delta({
            tool_calls: [{ index: this.toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }],
          });
        }
        break;
      }
      case 'content_block_delta': {
        const d = json.delta || {};
        if (d.type === 'text_delta' && d.text) {
          if (this.firstTokenMs == null) this.firstTokenMs = Date.now() - this.startedAt;
          this.textChars += d.text.length;
          this._delta({ content: d.text });
        } else if (d.type === 'input_json_delta' && this.toolIndex >= 0) {
          this._delta({ tool_calls: [{ index: this.toolIndex, function: { arguments: d.partial_json || '' } }] });
        }
        break;
      }
      case 'message_delta': {
        if (json.delta && json.delta.stop_reason) this.finishReason = FINISH_MAP[json.delta.stop_reason] || 'stop';
        if (json.usage && json.usage.output_tokens != null) this.usage.completion_tokens = json.usage.output_tokens;
        break;
      }
      case 'message_stop':
        // final chunk + [DONE] are written in _flush
        break;
      default:
        break;
    }
  }

  getUsage(body) {
    if (this.usage.prompt_tokens || this.usage.completion_tokens) {
      return {
        prompt_tokens: this.usage.prompt_tokens,
        completion_tokens: this.usage.completion_tokens,
        total_tokens: this.usage.prompt_tokens + this.usage.completion_tokens,
      };
    }
    const base = estimateTokens(body);
    const out = Math.ceil(this.textChars / 4);
    return { prompt_tokens: base.prompt_tokens, completion_tokens: out, total_tokens: base.prompt_tokens + out, estimated: true };
  }
}

module.exports = {
  StreamMeter,
  AnthropicStream,
  toAnthropic,
  fromAnthropic,
  contentToText,
  FINISH_MAP,
};
