# BlueRouter

**One API for all your AI accounts.**

You have five Groq accounts, two Cerebras keys and a free OpenRouter key. Every
one of them is a different API key with its own rate limit, and every app you
use wants a different one. BlueRouter puts them all behind a single
OpenAI-compatible endpoint on your own VPS:

```
                                  ┌── Groq        account 1  ─ healthy
                                  ├── Groq        account 2  ─ 429 → cooled down
your app ──► http://vps:1212/v1 ──┼── Groq        account 3  ─ healthy
                                  ├── Cerebras    account 1  ─ healthy
                                  ├── OpenRouter  account 1  ─ healthy
                                  └── Anthropic   account 1  ─ translated
```

One key, one URL, port **1212**. BlueRouter picks the healthiest account for
every request, rotates across them, and retries on another account the moment
one hits a rate limit. Your code never changes.

- Zero runtime dependencies, single Node.js process, no build step
- Self-hosted: your keys stay on your VPS in a `chmod 600` file
- `blue install` / `blue uninstall` / `blue status` — one command each
- Live dashboard with accounts, providers, playground, models, request log
- Works with every OpenAI SDK and any tool that accepts a custom OpenAI base URL

---

## Install on a VPS

Ubuntu / Debian / Fedora / Rocky, root access, ~80 MB RAM. Node.js 18+ is
installed automatically if missing.

```bash
curl -fsSL https://raw.githubusercontent.com/siddhantpashte123-hub/bluerouter/main/install.sh | sudo bash
```

Or from a clone:

```bash
git clone https://github.com/siddhantpashte123-hub/bluerouter.git
cd bluerouter
sudo ./install.sh            # or: sudo blue install
```

Then add your accounts and test:

```bash
blue add groq gsk_key1 gsk_key2 gsk_key3 gsk_key4 gsk_key5
blue check          # verifies every key against the real provider
blue test           # sends a real chat request through the gateway
blue url            # dashboard link, API base URL, API key
```

That is it. Your gateway is live on `http://<vps-ip>:1212`.

> Open the port in your VPS firewall: `ufw allow 1212/tcp` (and in your
> provider's firewall panel if you have one).

### No systemd? (Docker, Codespaces, WSL, LXC, shared hosting)

`blue install` picks the right mode by itself: **systemd** when it is available
(full auto-restart + boot start), otherwise a **background process** with a PID
file and a log file. Force it either way with `--systemd` / `--background`.

```bash
blue install --background      # no root, no systemd needed
blue status                    # same command, shows "background process"
blue logs -f                   # tails data/logs/bluerouter.log instead of journald
blue stop / start / restart    # work in both modes
sudo blue uninstall --yes      # or without sudo in background mode
```

Background mode does **not** restart by itself after a reboot or a crash — that
is only what systemd gives you. Use it for testing, containers, and short-lived
boxes; use a real VPS (or run the process under your own supervisor) for
anything permanent.

Inside GitHub Codespaces the install output also prints the forwarded public URL
(`https://<codespace>-1212.app.github.dev`) — make the port **Public** in the
Ports tab if you want to call it from other devices.

---

## Use it

```bash
curl http://YOUR_VPS_IP:1212/v1/chat/completions \
  -H "Authorization: Bearer blue_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.3-70b-versatile",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Python:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://YOUR_VPS_IP:1212/v1",
    api_key="blue_xxxxxxxx",          # the BlueRouter key, not a provider key
)

print(client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "Hello!"}],
).choices[0].message.content)
```

Node:

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://YOUR_VPS_IP:1212/v1",
  apiKey: "blue_xxxxxxxx",
});
```

Anywhere a tool asks for an **OpenAI base URL / API key** — Cursor, Cline, Continue,
LibreChat, Open WebUI, LangChain, n8n, SillyTavern, your own scripts — point it at
BlueRouter and paste the `blue_…` key. Streaming works, including SSE.

### Choosing a provider for one request

Usually you let BlueRouter decide. When you want a specific provider:

```bash
# per request
curl ".../v1/chat/completions?provider=groq" ...
curl -H "x-bluerouter-provider: cerebras" ...

# or in the model name, when the model exists on that provider
{"model": "cerebras/llama-3.3-70b"}
```

---

## CLI

Run `blue` with no arguments for the full list.

### Server

| Command | What it does |
| --- | --- |
| `sudo blue install [--port 1212]` | installs the service and starts it (systemd if available, else background) |
| `blue install --background` | same, but never uses systemd and needs no root |
| `sudo blue uninstall` | stops and removes the service (keeps your accounts) |
| `sudo blue uninstall --purge --yes` | removes the service **and deletes all data** |
| `blue status` | service state, accounts, cooldowns, traffic (`--json` for scripting) |
| `blue start` / `stop` / `restart` | service control |
| `blue enable` / `disable` | auto-start on boot on/off |
| `blue logs -f` | live service log (`journalctl -u bluerouter`) |
| `blue update` | git pull + restart |

### Accounts

| Command | What it does |
| --- | --- |
| `blue add groq <key>` | add one account |
| `blue add groq k1 k2 k3` | add many at once |
| `blue add groq --file keys.txt` | one key per line, `#` comments allowed |
| `blue add groq` | paste keys interactively (hidden input) |
| `blue keys` | list accounts, health, usage |
| `blue rm <id>` | remove an account |
| `blue enable <id>` / `blue disable <id>` | take an account in/out of rotation |
| `blue rename <id> <name>` | label an account |
| `blue check [id\|all]` | call the provider and verify the key |
| `blue reset` | clear all cooldowns |

### Providers & traffic

| Command | What it does |
| --- | --- |
| `blue providers` | catalog, free-tier limits, account counts |
| `blue provider set <id> <field> <value>` | `enabled`, `baseUrl`, `protocol`, `authStyle`, `models` |
| `blue models` | live model list from every provider account |
| `blue test [--provider p] [--model m]` | real end-to-end request |
| `blue stats` | requests, tokens, latency, per provider |
| `blue requests [--errors] [--limit 50]` | recent request log |
| `blue config get/set <path> <value>` | change settings |
| `blue url` / `blue token` / `blue rotate` | URLs, client key, rotate client key |

`add`, `keys` and `check` work even when the service is stopped — they read and
write `data/config.json` directly. Everything else uses the local admin API.

---

## Dashboard

Open `http://<vps-ip>:1212` and paste the admin token (`blue url` prints a
one-click link that includes it).

| Page | What you get |
| --- | --- |
| **Overview** | requests, success rate, tokens, latency, providers, recent requests, your endpoint |
| **Accounts** | add 1–50 keys at once, per-account health, cooldown timer, enable/disable, rename, delete |
| **Providers** | every provider, free-tier notes, docs links, enable/disable, custom base URL |
| **Playground** | send a real streaming request and see which account answered |
| **Models** | live model list pulled from each provider account |
| **Requests** | searchable log with provider, account, model, status, tokens, prompt preview |
| **Settings** | client key + rotate, routing, timeout, port, request log, export/import, clear log |

The dashboard is plain HTML/CSS/JS served by the same process — no build step,
no external assets, no telemetry.

---

## How routing works

For every request BlueRouter:

1. **Finds candidate accounts** — provider enabled, account enabled, not in
   cooldown, capable of the request (audio requests only go to audio providers).
2. **Picks the best one** — in the default `random` mode a healthy account is
   picked at random, which spreads requests across all your accounts and keeps
   every one of them under its per-account rate limit for longer. `sticky` mode
   reuses the account that last worked for that provider (better prompt-cache
   hits). Within sticky mode the tie-breaker is fewest in-flight requests, then
   priority, then least recently used.
3. **Calls the provider**, translating Anthropic's API to OpenAI's when needed.
4. **On failure, retries on the next account** instead of returning an error:

| Upstream response | What BlueRouter does |
| --- | --- |
| `429`, limit mentioned in body | cools that account **for that model only** (Groq limits are per model) and retries |
| `401 / 403` | marks the key `invalid-key`, cools it for 6 h, retries another account |
| `500 / 502 / 503 / 504 / 529` | 30 s cooldown, retries |
| timeout / network error | retries another account |
| `400 / 422` | returns the error immediately (your request is malformed — retrying would fail everywhere) |

Retries are configurable (`routing.maxRetries`, default 3). Cooldowns expire
automatically and can be cleared with `blue reset`.

Token usage is taken from the provider's `usage` field; for streams the last
usage chunk is used, otherwise it is estimated from the text.

---

## Providers

Built in, no configuration needed — just add a key:

| id | Provider | Free tier (approximate, check their docs) |
| --- | --- | --- |
| `groq` | Groq | ~30 RPM and 200K–1M tokens/day **per model, per account** |
| `cerebras` | Cerebras | ~30 RPM, ~1M tokens/day per key |
| `openrouter` | OpenRouter | 20 RPM on `:free` models, daily cap per account |
| `nvidia` | NVIDIA NIM | ~40 RPM, 1000 credits |
| `mistral` | Mistral | 1 RPS, monthly token allowance |
| `gemini` | Google Gemini | 10–15 RPM, 250–1000 requests/day per key |
| `sambanova` | SambaNova | free developer tier |
| `together` | Together AI | free models available |
| `xai` | xAI Grok | paid |
| `deepseek` | DeepSeek | paid (very cheap) |
| `fireworks` | Fireworks AI | paid |
| `openai` | OpenAI | paid |
| `anthropic` | Anthropic Claude | paid — protocol is translated automatically |
| `ollama` | local Ollama | unlimited, runs on your box |
| `custom` | anything OpenAI-compatible | set `baseUrl` |

Custom provider (vLLM, LiteLLM, LM Studio, a company gateway, …):

```bash
blue provider set custom baseUrl https://llm.example.com/v1
blue provider set custom models my-model-1,my-model-2
blue add custom sk-whatever
blue test --provider custom --model my-model-1
```

Any provider's `baseUrl`, `models`, `enabled`, `protocol` and `authStyle` can be
overridden the same way, or from **Settings → Providers** in the dashboard.

Adding five Groq accounts multiplies the per-account free limits while your apps
still see a single `blue_…` key with one URL.

---

## Configuration

Everything lives in `data/config.json` (created with mode `600`):

```jsonc
{
  "port": 1212,
  "host": "0.0.0.0",
  "clientKey": "blue_…",           // what your apps use
  "adminToken": "blueadmin_…",     // dashboard / admin API
  "routing": {
    "mode": "random",              // random | sticky
    "cooldownSeconds": 300,
    "maxRetries": 3,
    "timeoutMs": 180000,
    "forceModel": ""               // force one model for all requests
  },
  "requestLog": { "enabled": true, "maxEntries": 2000 },
  "providers": { "groq": { "enabled": true, "baseUrl": "…", "models": ["…"] } },
  "keys": [ { "id": "acc_…", "provider": "groq", "key": "gsk_…", "enabled": true } ]
}
```

Change values with `blue config set <path> <value>` (e.g.
`blue config set routing.maxRetries 5`), from the dashboard, or by editing the
file while the service is stopped.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `1212` | listen port (also stored in config) |
| `BLUEROUTER_DATA` | `<repo>/data` | data directory |
| `NO_COLOR` | — | disable CLI colours |

Config backups are written to `data/backups/` (last 10, every 5 minutes max).
Export/import the whole thing from **Settings → Backup**.

---

## Security

- Provider keys and the admin token never leave the machine. The admin API only
  returns masked keys (`gsk_abcd…wxyz`); full keys are only in `data/config.json`.
- `data/` is created `700`, `config.json` is `600`.
- `clientKey` can be rotated at any time (`blue rotate`) without touching your
  provider keys.
- Admin endpoints accept the admin token or the client key; `/v1/*` accepts only
  the client key. Failed admin logins are rate limited.
- BlueRouter speaks plain HTTP. If you expose it to the internet, put Caddy or
  nginx in front for TLS — or keep it on a private network / WireGuard and point
  apps at the private IP.

---

## Day-to-day

```bash
blue status                     # is it up? who is cooling down?
blue requests --errors          # what failed and why
blue check                      # re-verify every key
blue logs -f                    # server log
blue update                     # pull + restart
sudo blue uninstall             # service gone, accounts kept
```

Change the port:

```bash
blue config set port 8080
sudo blue restart
```

Move to a new VPS: **Settings → Export**, copy the JSON, install on the new box,
**Settings → Import**.

---

## Development

Requires Node.js 18+. Node 22 is what CI uses.

```bash
git clone https://github.com/siddhantpashte123-hub/bluerouter.git
cd bluerouter
npm test              # 26 end-to-end routing tests against a fake provider
npm run test:cli      # 26 CLI tests, real binary + live server
npm run test:service  # 14 background-mode install/stop/start/uninstall tests
npm install --no-save jsdom && npm run test:ui   # 14 dashboard tests in jsdom
npm run demo          # fake provider + seeded dashboard on http://127.0.0.1:1212
PORT=1212 BLUEROUTER_DATA=./data node src/server.js
```

```
src/
  server.js       HTTP server, client API, admin API, static dashboard
  proxy.js        routing, failover, cooldowns, streaming, logging
  providers.js    provider catalog, URLs, auth styles
  adapters.js     SSE meter, Anthropic ⇄ OpenAI translation
  store.js        config, accounts, stats, request log
  service.js      systemd install/uninstall/status
  dashboard/      index.html, styles.css, app.js, favicon.svg
bin/blue          CLI
install.sh        fresh-VPS bootstrap
docs/             API reference, Hinglish walkthrough
```

Design notes:

- Zero runtime dependencies — `fetch` built into Node 18+ is the HTTP client.
- Stats are persisted with a debounced write; data survives restarts and crashes.
- Streams are piped, not buffered: first token latency is the provider's.
- One process, one port. No Redis, no database, no Docker required.

---

## FAQ

**Do I still need provider keys?** Yes. BlueRouter doesn't create accounts, it
pools the ones you already have behind one endpoint.

**Will I get banned for adding 5 accounts?** BlueRouter only rotates between
accounts *you* own and respects every 429 it receives. Creating multiple free
accounts to bypass limits may violate a provider's terms — that risk is yours.
By default it never pretends to be a different client.

**Does it work with streaming?** Yes, SSE is piped through untouched (and
translated for Anthropic keys).

**Does it support function calling, vision, JSON mode?** Anything the provider
supports passes through. Provider-specific fields (`tools`, `response_format`,
image content parts, `reasoning_format`, …) are not stripped.

**Audio?** `/v1/audio/transcriptions` (multipart) and `/v1/audio/speech`
(binary) are proxied to audio-capable providers such as Groq Whisper or OpenAI.

**What happens to my in-flight request if an account dies?** It is retried on
another account automatically, up to `maxRetries`.

**Can I run several BlueRouters?** Yes, one per VPS. They don't talk to each
other.

**Does it work in Docker / Codespaces / WSL?** Yes — run `blue install
--background` (or just `node src/server.js`). No systemd required.

**Is there a Docker image?** Not needed — `node src/server.js` is the whole app.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Groq, OpenAI, Anthropic, Google or any other provider.
