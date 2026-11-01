'use strict';

/**
 * Provider catalog + request building helpers.
 *
 * Everything BlueRouter speaks is OpenAI-compatible except Anthropic, which
 * has a small adapter in adapters.js. Any provider can be overridden from
 * data/config.json (baseUrl, protocol, authStyle, models, enabled).
 */

const DEFAULT_PROVIDERS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    keyHint: 'starts with gsk_',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b'],
    quota: { requestsPerMinute: '~30 RPM / org', tokensPerDay: '~100K–500K TPD / org (model wise)', note: 'Free tier counts per ORGANIZATION, per model — extra keys in one account add nothing' },
    docs: 'https://console.groq.com/docs/rate-limits',
    audio: true,
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    keyHint: 'starts with csk-',
    models: ['llama3.1-8b', 'llama-3.3-70b', 'gpt-oss-120b', 'qwen-3-32b'],
    quota: { requestsPerMinute: '~30 RPM / key', tokensPerDay: '~1M TPD / key', note: 'Very fast inference, daily token cap' },
    docs: 'https://inference-docs.cerebras.ai/support/rate-limits',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    keyHint: 'starts with sk-or-v1-',
    models: ['meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat-v3.1:free', 'qwen/qwen3-235b-a22b:free'],
    quota: { requestsPerMinute: '20 RPM (:free models)', tokensPerDay: '50–1000 requests/day', note: 'Free model daily cap depends on account credits' },
    docs: 'https://openrouter.ai/docs/api-reference/limits',
    extraHeaders: { 'HTTP-Referer': 'https://github.com/siddhantpashte123-hub/bluerouter', 'X-Title': 'BlueRouter' },
  },
  nvidia: {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    keyHint: 'starts with nvapi-',
    models: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1', 'qwen/qwen3-235b-a22b'],
    quota: { requestsPerMinute: '~40 RPM / key', tokensPerDay: '1000 credits / account', note: 'Credit based free tier' },
    docs: 'https://docs.api.nvidia.com/nim/reference/llm-apis',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
    quota: { requestsPerMinute: '~1 RPS / key', tokensPerDay: '500K tokens / month free', note: 'Free experiment plan' },
    docs: 'https://docs.mistral.ai/deployment/laplateforme/tier/',
    audio: true,
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai',
    authStyle: 'bearer',
    keyHint: 'starts with AIza',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    quota: { requestsPerMinute: '~10–15 RPM / key', tokensPerDay: '250–1000 requests/day / key', note: 'Limits differ per model' },
    docs: 'https://ai.google.dev/gemini-api/docs/rate-limits',
  },
  xai: {
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    keyHint: 'starts with xai-',
    models: ['grok-3-mini', 'grok-4-fast-non-reasoning'],
    quota: { requestsPerMinute: '—', tokensPerDay: 'paid credits', note: 'Paid API' },
    docs: 'https://docs.x.ai/docs/overview',
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    quota: { requestsPerMinute: '—', tokensPerDay: 'free tier varies', note: 'Free models available' },
    docs: 'https://docs.together.ai/docs/rate-limits',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    keyHint: 'starts with sk-',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    quota: { requestsPerMinute: '—', tokensPerDay: 'paid credits', note: 'Paid API (very cheap)' },
    docs: 'https://api-docs.deepseek.com/quick_start/rate_limit',
  },
  sambanova: {
    label: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    models: ['Meta-Llama-3.3-70B-Instruct', 'DeepSeek-R1-Distill-Llama-70B'],
    quota: { requestsPerMinute: '~10 RPM / key', tokensPerDay: 'free tier', note: 'Free developer tier' },
    docs: 'https://docs.sambanova.ai/cloud/docs/get-started/rate-limits',
  },
  fireworks: {
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/deepseek-v3'],
    quota: { requestsPerMinute: '—', tokensPerDay: 'paid credits', note: 'Paid API' },
    docs: 'https://docs.fireworks.ai/getting-started/quickstart',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    keyHint: 'starts with sk-',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
    quota: { requestsPerMinute: 'tier based', tokensPerDay: 'paid credits', note: 'Paid API' },
    docs: 'https://platform.openai.com/docs/guides/rate-limits',
    audio: true,
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
    authStyle: 'x-api-key',
    keyHint: 'starts with sk-ant-',
    models: ['claude-3-5-haiku-latest', 'claude-sonnet-4-20250514'],
    quota: { requestsPerMinute: 'tier based', tokensPerDay: 'paid credits', note: 'Paid API' },
    docs: 'https://docs.anthropic.com/en/api/rate-limits',
  },
  ollama: {
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'openai',
    authStyle: 'none',
    models: ['llama3.2', 'qwen2.5', 'mistral'],
    quota: { requestsPerMinute: 'unlimited (local)', tokensPerDay: 'unlimited (local)', note: 'Runs on this box, no API key needed' },
    docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    enabled: false,
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    protocol: 'openai',
    authStyle: 'bearer',
    models: [],
    quota: { requestsPerMinute: 'unknown', tokensPerDay: 'unknown', note: 'Set baseUrl with: blue provider set custom baseUrl <url>' },
    docs: '',
  },
};

/** Providers whose endpoint really understands audio/transcription. */
const AUDIO_PROVIDERS = new Set(['groq', 'openai', 'mistral', 'together', 'custom', 'ollama']);

/** Accept arrays or comma separated strings from config/CLI. */
function normalizeModels(value) {
  if (Array.isArray(value)) return value.map((m) => String(m).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((m) => m.trim()).filter(Boolean);
  return [];
}

function providerMeta(id) {
  return DEFAULT_PROVIDERS[id] || null;
}

/** Full provider config: built-in defaults merged with user overrides. */
function getProvider(id, config) {
  const meta = DEFAULT_PROVIDERS[id];
  const override = (config && config.providers && config.providers[id]) || {};
  if (!meta && !override.baseUrl) return null;
  const merged = {
    id,
    label: meta ? meta.label : id,
    baseUrl: override.baseUrl || (meta ? meta.baseUrl : ''),
    protocol: override.protocol || (meta ? meta.protocol : 'openai'),
    authStyle: override.authStyle || (meta ? meta.authStyle : 'bearer'),
    models: normalizeModels(override.models !== undefined ? override.models : (meta ? meta.models : [])),
    quota: override.quota || (meta ? meta.quota : {}),
    docs: meta ? meta.docs : '',
    extraHeaders: meta ? meta.extraHeaders : undefined,
    audio: meta ? !!meta.audio : true,
    enabled: override.enabled !== undefined ? override.enabled !== false : !(meta && meta.enabled === false),
  };
  return merged;
}

function allProviders(config) {
  const ids = new Set([...Object.keys(DEFAULT_PROVIDERS), ...Object.keys((config && config.providers) || {})]);
  return [...ids].map((id) => getProvider(id, config)).filter(Boolean);
}

/**
 * Build the upstream URL for an OpenAI-style path.
 *   /v1/chat/completions -> {baseUrl}/chat/completions
 *   /v1/models           -> {baseUrl}/models
 */
function upstreamUrl(provider, openaiPath) {
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  let suffix = openaiPath.replace(/^\/v1/, '');
  // Anthropic speaks the same shape except chat lives at /messages
  if (provider.protocol === 'anthropic' && suffix === '/chat/completions') suffix = '/messages';
  return `${base}${suffix}`;
}

function buildHeaders(provider, key, body, clientHeaders) {
  const headers = {
    'content-type': 'application/json',
    accept: body && body.stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'BlueRouter/1.0',
  };
  const style = provider.authStyle || 'bearer';
  if (style === 'bearer' && key) headers.authorization = `Bearer ${key}`;
  else if (style === 'x-api-key' && key) {
    headers['x-api-key'] = key;
    if (provider.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  } else if (style === 'basic' && key) headers.authorization = `Basic ${key}`;
  if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders);

  // Pass-through of a few harmless client headers (e.g. OpenRouter attribution)
  if (clientHeaders) {
    for (const h of ['http-referer', 'x-title', 'x-openrouter-title']) {
      if (clientHeaders[h]) headers[h] = clientHeaders[h];
    }
  }
  return headers;
}

/** true when the request needs an audio-capable provider */
function needsAudio(openaiPath, body) {
  if (openaiPath.includes('/audio')) return true;
  const model = body && body.model;
  return typeof model === 'string' && /whisper|transcribe|tts/i.test(model);
}

function supportsAudio(provider) {
  return AUDIO_PROVIDERS.has(provider.id) || provider.audio === true;
}

function normalizeModel(provider, model) {
  const m = String(model || '').trim();
  if (!m) return m;
  // OpenRouter wants vendor/model — leave as-is. Just strip a provider prefix
  // such as "groq/llama-3.3-70b-versatile" when it is used for targeting.
  const slash = m.indexOf('/');
  if (slash > 0) {
    const maybeProvider = m.slice(0, slash);
    if (DEFAULT_PROVIDERS[maybeProvider] && provider.id !== 'openrouter' && provider.id !== 'custom') {
      const rest = m.slice(slash + 1);
      // Groq/OpenAI also use vendor/model (openai/gpt-oss-120b), so only strip
      // when the remainder matches a known model.
      if ((provider.models || []).includes(rest)) return rest;
      if (maybeProvider === provider.id) return rest;
    }
  }
  return m;
}

/** Minimal per-provider request tweaks. */
function adaptBody(provider, body, model) {
  const out = { ...body, model };
  // Groq reasoning models reject `reasoning_format` but tolerate it — keep clean:
  if (provider.id === 'cerebras' && out.stream) out.stream_options = { include_usage: true };
  return out;
}

module.exports = {
  DEFAULT_PROVIDERS,
  AUDIO_PROVIDERS,
  providerMeta,
  normalizeModels,
  getProvider,
  allProviders,
  upstreamUrl,
  buildHeaders,
  needsAudio,
  supportsAudio,
  normalizeModel,
  adaptBody,
};
