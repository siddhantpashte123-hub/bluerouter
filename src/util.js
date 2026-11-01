'use strict';

const os = require('os');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* Time helpers                                                        */
/* ------------------------------------------------------------------ */

const iso = (t = Date.now()) => new Date(t).toISOString();

/** 90_287 -> "1d 1h 4m" */
function humanDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${sec}s`);
  return parts.join(' ');
}

/** 1234 -> "1.2K", 2500000 -> "2.5M" */
function humanNumber(n) {
  if (n == null || !Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

const shortTime = (t = Date.now()) => new Date(t).toISOString().slice(11, 19);

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * "gsk_abcdefghijklmnopqrstuvwxyz" -> "gsk_abcd…wxyz"
 * Never log or return a full upstream key.
 */
function maskKey(key) {
  const k = String(key || '');
  if (!k) return '(none)';
  if (k.length <= 12) return `${k.slice(0, 2)}${'•'.repeat(Math.max(2, k.length - 4))}${k.slice(-2)}`;
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}

function shortId(prefix = 'k') {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function uuid() {
  return crypto.randomUUID();
}

function truncate(str, max = 60) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * The text of the prompt (last user message), used to decide which
 * provider/key can actually serve the request.
 */
function promptText(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.prompt === 'string') return body.prompt;
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i -= 1) {
      const m = body.messages[i] || {};
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join(' ');
      }
    }
  }
  return '';
}

function lastUserMessage(body) {
  if (body && Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i -= 1) {
      if (body.messages[i] && body.messages[i].role === 'user') return body.messages[i];
    }
  }
  return null;
}

/** Rough token estimate when a provider did not send usage. */
function estimateTokens(body) {
  const input = promptText(body);
  const sys = body && Array.isArray(body.messages)
    ? body.messages.filter((m) => m && m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ')
    : '';
  const inTok = Math.ceil((input.length + sys.length) / 4);
  return { prompt_tokens: inTok, completion_tokens: 0, total_tokens: inTok, estimated: true };
}

/** Turn Anthropic-style messages into OpenAI-style ones. */
function normalizeMessages(body) {
  const out = [];
  if (body && typeof body.system === 'string' && body.system.trim()) {
    out.push({ role: 'system', content: body.system });
  }
  const src = body && Array.isArray(body.messages) ? body.messages : [];
  for (const m of src) {
    if (!m || !m.role) continue;
    let content = m.content;
    if (Array.isArray(content)) {
      // Anthropic content blocks -> OpenAI content parts
      content = content
        .map((c) => {
          if (typeof c === 'string') return c;
          if (c && c.type === 'text') return c.text;
          if (c && c.type === 'image_url') return c;
          return '';
        })
        .filter(Boolean);
      if (content.every((c) => typeof c === 'string')) content = content.join('\n');
    }
    const role = m.role === 'assistant' || m.role === 'system' || m.role === 'tool' ? m.role : 'user';
    const msg = { role, content: content == null ? '' : content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    out.push(msg);
  }
  if (!out.length) out.push({ role: 'user', content: '' });
  return out;
}

/* ------------------------------------------------------------------ */
/* Bytes / misc                                                        */
/* ------------------------------------------------------------------ */

function humanBytes(b) {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function lanIp() {
  const nets = os.networkInterfaces();
  const preferred = [];
  const fallback = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.internal) continue;
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (!v4 || net.address.startsWith('169.254.')) continue;
      (name.startsWith('eth') || name.startsWith('en') ? preferred : fallback).push(net.address);
    }
  }
  return preferred[0] || fallback[0] || '127.0.0.1';
}

function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

module.exports = {
  iso,
  humanDuration,
  humanNumber,
  humanBytes,
  shortTime,
  maskKey,
  shortId,
  uuid,
  truncate,
  promptText,
  lastUserMessage,
  estimateTokens,
  normalizeMessages,
  lanIp,
  safeJsonParse,
};
