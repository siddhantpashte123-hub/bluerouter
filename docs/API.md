# API reference

Default port **1212**. All examples assume `http://YOUR_VPS:1212`.

Two credentials:

| Credential | Used for |
| --- | --- |
| `clientKey` (`blue_…`) | `/v1/*` — what your apps use |
| `adminToken` (`blueadmin_…`) | `/admin/*` — dashboard and CLI |

Get both with `blue url` or `/admin/config`.

---

## Public

### `GET /health`

No auth. Liveness probe.

```json
{
  "status": "ok",
  "name": "bluerouter",
  "instanceId": "9f2c…",
  "version": "1.0.0",
  "uptime": 842,
  "accounts": 5,
  "providers": 1,
  "port": 1212,
  "time": "2026-11-01T05:30:50.477Z"
}
```

### `GET /api/meta`

No auth. Counts only, useful for a status page: `{ name, version, accounts,
activeAccounts, providers, port }`.

---

## Client API — OpenAI compatible

Base URL: `http://YOUR_VPS:1212/v1`

```
Authorization: Bearer blue_xxxxxxxx
```

CORS is open (`*`) so browser clients can call it directly. `OPTIONS` is handled.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/models` | union of models from providers that have accounts |
| `GET` | `/v1/models/:id` | one model or 404 |
| `POST` | `/v1/chat/completions` | streaming + non-streaming |
| `POST` | `/v1/completions` | legacy completions, passed through |
| `POST` | `/v1/embeddings` | passed through |
| `POST` | `/v1/audio/transcriptions` | multipart, proxied to audio providers |
| `POST` | `/v1/audio/speech` | binary audio returned untouched |
| `POST` | `/v1/*` | any other path is proxied to the provider |

`/openai/v1/*` is an alias for `/v1/*` (for tools that insist on that prefix).

### Targeting a provider

```bash
# query string
curl ".../v1/chat/completions?provider=groq" ...

# header
-H "x-bluerouter-provider: cerebras"

# model prefix (only when that provider lists the model)
{"model": "groq/llama-3.3-70b-versatile"}
```

Without a target, BlueRouter chooses across all enabled providers.

### Which account answered

Every proxied response carries:

```
x-bluerouter-provider: groq
x-bluerouter-account: Groq #2
```

### Chat completions

```bash
curl http://YOUR_VPS:1212/v1/chat/completions \
  -H "Authorization: Bearer blue_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.3-70b-versatile",
    "messages": [
      {"role": "system", "content": "You are terse."},
      {"role": "user", "content": "What is 2+2?"}
    ],
    "temperature": 0.2,
    "max_tokens": 100
  }'
```

Response is the provider's OpenAI-shaped JSON, unchanged:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "model": "llama-3.3-70b-versatile",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "4" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 21, "completion_tokens": 1, "total_tokens": 22 }
}
```

Streaming: send `"stream": true`, receive standard SSE
(`data: {chunk}` … `data: [DONE]`). The stream is piped, not buffered.

Anthropic keys are translated both ways: OpenAI request → `/v1/messages`,
Anthropic response/SSE → OpenAI JSON/chunks.

### Errors

OpenAI-style, with what was tried:

```json
{
  "error": {
    "message": "All 3 attempt(s) failed. Last error: Rate limit reached for model `llama-3.3-70b-versatile`…",
    "type": "upstream_error",
    "code": "attempts_exhausted",
    "tried": [
      { "provider": "groq", "account": "Groq #1", "accountId": "acc_…" }
    ]
  }
}
```

| Status | `code` | Meaning |
| --- | --- | --- |
| `401` | `invalid_api_key` | wrong/missing `blue_…` key |
| `400` | `bad_request` / `configuration_error` | malformed request or unknown provider |
| `404` | `model_not_found` | model not in `/v1/models` |
| `429` | `accounts_exhausted` | every account is cooling down |
| `502/503` | `upstream_error` / `no_accounts` | provider down or nothing configured |

`Retry-After` is not invented by BlueRouter — retry when accounts cool down
(`blue status` shows the timers).

---

## Admin API

Base: `http://YOUR_VPS:1212/admin`

```
Authorization: Bearer blueadmin_xxxxxxxx
```

The client key is also accepted here (handy for scripts).

### Config

| Method | Path | Body / notes |
| --- | --- | --- |
| `GET` | `/admin/config` | public config + `clientKey`, `adminToken`, `dataDir`, `configPath`, `node`, `platform` |
| `PATCH` | `/admin/config` | `{ routing?: {...}, requestLog?: {...}, port?: 1212 }` |
| `POST` | `/admin/rotate-client-key` | returns the new `clientKey` |
| `GET` | `/admin/urls` | local/LAN URLs, dashboard link with token |
| `GET` | `/admin/export` | full config download (contains keys) |
| `POST` | `/admin/import` | `{ config }` replaces the whole config |

`routing` fields: `mode` (`sticky`/`random`), `cooldownSeconds`, `maxRetries`,
`timeoutMs`, `exposeUpstreamErrors`, `forceModel`.

### Accounts

| Method | Path | Body / notes |
| --- | --- | --- |
| `GET` | `/admin/keys` | all accounts, keys masked |
| `POST` | `/admin/keys` | `{ provider, key, name?, priority?, tpm? }` → `201` |
| `POST` | `/admin/keys/bulk` | `{ provider, keys: string[], name? }` |
| `GET` | `/admin/keys/:id` | one account |
| `PATCH` | `/admin/keys/:id` | `{ name?, enabled?, priority?, tpm?, audio? }` |
| `DELETE` | `/admin/keys/:id` | remove |
| `POST` | `/admin/keys/:id/check` | live health check against the provider |
| `POST` | `/admin/keys/:id/enable` \| `/disable` | toggle rotation |
| `POST` | `/admin/keys/:id/rename` | `{ name }` |
| `POST` | `/admin/check-all` | checks every account sequentially (slow) |
| `POST` | `/admin/cooldowns/clear` | `blue reset` |

Account object:

```json
{
  "id": "acc_1a2b3c4d5e",
  "provider": "groq",
  "name": "Groq #1",
  "masked": "gsk_abc…wxyz",
  "enabled": true,
  "priority": 0,
  "health": { "status": "ok", "latencyMs": 182, "checkedAt": "…", "detail": "Working" },
  "cooldownMs": 0,
  "stats": { "requests": 42, "success": 42, "fail": 0, "tokensIn": 8123, "tokensOut": 4410 },
  "daily": { "date": "2026-11-01", "requests": 42 },
  "inflight": 0
}
```

`health.status`: `ok`, `unknown`, `error`, `invalid-key`, `rate-limited`.

### Providers

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/providers` | catalog + account counts + daily usage + quota info |
| `PATCH` | `/admin/providers/:id` | `{ enabled?, baseUrl?, protocol?, authStyle?, models? }` |
| `GET` | `/admin/models?fresh=1` | live `/models` call per provider with an account |

A provider id outside the built-in catalog works if you give it a `baseUrl`
(that is how `custom` providers are added).

### Traffic

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/stats` | totals, per-provider, last hour, memory, uptime |
| `GET` | `/admin/logs?limit=100&provider=groq&errors=1` | newest first |
| `DELETE` | `/admin/logs` | clear the log |
| `POST` | `/admin/test` | `{ provider?, model?, prompt?, max_tokens? }` — real end-to-end request |

`/admin/test` response:

```json
{
  "data": {
    "ok": true,
    "status": 200,
    "ms": 342,
    "provider": "groq",
    "account": "Groq #2",
    "model": "llama-3.3-70b-versatile",
    "reply": "BlueRouter is live",
    "usage": { "prompt_tokens": 24, "completion_tokens": 5, "total_tokens": 29 }
  }
}
```

Log entry:

```json
{
  "ts": "2026-11-01T05:31:09.221Z",
  "provider": "groq",
  "accountId": "acc_…",
  "account": "Groq #2",
  "model": "llama-3.3-70b-versatile",
  "path": "/v1/chat/completions",
  "status": 200,
  "ok": true,
  "stream": false,
  "ms": 342,
  "tokensIn": 24,
  "tokensOut": 5,
  "retries": 1,
  "prompt": "What is 2+2?",
  "error": null
}
```

---

## Data on disk

```
data/
  config.json          settings + accounts (0600)
  requests.log         JSONL request log (rotated, size capped by maxEntries)
  backups/             last 10 config backups
```

Nothing else is written. No database, no cache directory, no telemetry.
