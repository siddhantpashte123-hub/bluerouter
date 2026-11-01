# BlueRouter — Hinglish guide

**Ek API, saare accounts.** Aapke paas Groq ke 5 accounts hain (ya Cerebras,
OpenRouter, Claude — kuch bhi). BlueRouter un sabko ek hi API key aur ek hi URL
ke peeche le aata hai. Port **1212**.

```
Aapka app ──► http://VPS_IP:1212/v1 ──► BlueRouter ──┬── Groq account 1
                                                      ├── Groq account 2
                                                      ├── Groq account 3
                                                      ├── Groq account 4
                                                      └── Groq account 5
```

Ek account ka limit khatam (429) hua? BlueRouter turant dusre account se wahi
request dobara bhej deta hai. Aapke app ko kuch pata bhi nahi chalta.

---

## 1. Kya chahiye

- Ek VPS — Ubuntu 22.04 / Debian 12 / Fedora (1 GB RAM bhi kaafi hai)
- VPS ka **root** access (SSH)
- Aapke provider keys (jaise `gsk_...` Groq ke liye)
- Node.js 18+ — install script khud install kar deta hai

Port **1212** use hoga. Agar VPS ke firewall panel me port kholna padta hai to
`1212/tcp` khol dena.

---

## 2. Install (ek command)

VPS me SSH karke:

```bash
curl -fsSL https://raw.githubusercontent.com/siddhantpashte123-hub/bluerouter/main/install.sh | sudo bash
```

Ya repo clone karke:

```bash
git clone https://github.com/siddhantpashte123-hub/bluerouter.git
cd bluerouter
sudo ./install.sh
```

Script ye sab karta hai:
1. Node.js check/install
2. Code clone (`/opt/bluerouter`)
3. systemd service banata hai (`bluerouter`) — **auto restart + boot par start**
4. `blue` command install karta hai (kahin se bhi chalega)
5. Aapko dashboard + API URL + API key dikhata hai

Check karne ke liye:

```bash
blue status
```

Output me `running` dikhna chahiye.

---

## 3. Apne 5 Groq accounts add karo

```bash
blue add groq gsk_key1 gsk_key2 gsk_key3 gsk_key4 gsk_key5
```

- Ek line me jitni keys chaho — sab add ho jayengi
- File se: `blue add groq --file keys.txt` (ek line = ek key)
- Bina key likhe sirf `blue add groq` → paste karne ko bolega (screen par dikhega nahi)

Ab verify karo ki keys sach me chal rahi hain:

```bash
blue check
```

Sab `working` aana chahiye. Phir ek real test:

```bash
blue test
```

Ye BlueRouter se hokar asli chat request bhejta hai aur batata hai kaun sa
account answer de raha hai.

---

## 4. Apna API key aur URL lo

```bash
blue url
```

Output me milega:

```
API base   http://YOUR_VPS_IP:1212/v1
API key    blue_xxxxxxxxxxxxxxxxxxxx
Dashboard  http://YOUR_VPS_IP:1212/#token=...
```

- **`blue_...`** = aapki nayi single API key. Provider keys ki zarurat ab kahin nahi.
- **`/v1`** = base URL. Kisi bhi OpenAI-compatible app me yahi daalna hai.

> Ye `blue_` key rotate kar sakte ho: `blue rotate` (purani turant band ho jayegi).

---

## 5. Use kaise kare

### curl

```bash
curl http://YOUR_VPS_IP:1212/v1/chat/completions \
  -H "Authorization: Bearer blue_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.3-70b-versatile",
    "messages": [{"role": "user", "content": "Namaste!"}]
  }'
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://YOUR_VPS_IP:1212/v1",
    api_key="blue_xxxxxxxx",
)

print(client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "Namaste!"}],
).choices[0].message.content)
```

### Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://YOUR_VPS_IP:1212/v1",
  apiKey: "blue_xxxxxxxx",
});
```

### Streaming

```python
stream = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "Ek kahani sunao"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

### Cursor / Cline / Continue / LibreChat / Open WebUI / n8n / LangChain

Settings me "OpenAI" provider chuno, phir:

- **Base URL**: `http://YOUR_VPS_IP:1212/v1`
- **API key**: `blue_xxxxxxxx`
- **Model**: `llama-3.3-70b-versatile` (ya dashboard ke **Models** tab me se koi bhi)

Bas. Jo bhi tool OpenAI base URL badalne deta hai, wo BlueRouter ke saath chalega.

---

## 6. Dashboard

Browser me kholo:

```
http://YOUR_VPS_IP:1212
```

Admin token daalo (`blue url` wale link me token pehle se hota hai). Andar:

- **Overview** — kitni requests, success rate, tokens, kaun sa provider kitna use hua
- **Accounts** — saari keys, health, cooldown timer; yahin se 5 keys ek saath add kar sakte ho
- **Providers** — free tier limits, docs, enable/disable
- **Playground** — browser se hi test karo, reply ke neeche dikhta hai kaun sa account answer kiya
- **Models** — live model list
- **Requests** — har request ka log (provider, account, model, status, tokens)
- **Settings** — API key rotate, routing, port, backup/export

---

## 7. Kaun sa account kab use hoga?

1. BlueRouter sirf **healthy** accounts chunta hai (enabled, cooldown me nahi)
2. Sabse kam busy account pehle, phir priority, phir jo sabse der se use hua
3. **429** aaya → us account ko **sirf us model ke liye** thodi der cooldown, request dusre account se
4. **401/403** (galat key) → 6 ghante cooldown + dashboard me `invalid key`
5. **5xx / timeout** → 30 second cooldown, dusra account
6. **400** (aapki request galat hai) → turant error, retry nahi

Apna account chhupana ho to:

```bash
blue disable acc_xxxxx     # rotation se bahar
blue enable acc_xxxxx      # wapas andar
blue reset                 # sab cooldowns clear
```

Specific provider se request chahiye:

```bash
curl "http://YOUR_VPS_IP:1212/v1/chat/completions?provider=groq" ...
```

---

## 8. Cheat sheet

```bash
blue status                    # sab kuch ek nazar me
blue keys                      # accounts ki list
blue add groq gsk_1 gsk_2      # keys add
blue check                     # keys verify
blue test                      # ek request bhej ke dekho
blue requests --errors         # kya fail hua
blue providers                 # free tier info
blue models                    # models ki list
blue reset                     # cooldowns clear
blue rotate                    # nayi client API key
blue logs -f                   # live server log
blue update                    # update + restart
sudo blue uninstall            # service hatao (data safe rehta hai)
sudo blue uninstall --purge --yes   # sab kuch delete
```

Port change:

```bash
blue config set port 8080
sudo blue restart
```

Purani key disable:

```bash
blue rm acc_xxxxxxxx
```

---

## 9. Problem aaye to

| Problem | Solution |
| --- | --- |
| Dashboard nahi khul raha | `blue status` chalao; firewall me `ufw allow 1212/tcp`; VPS panel me bhi port kholo |
| `blue install` bola "sudo" | `sudo blue install` ya `sudo ./install.sh` |
| Sab accounts `rate limited` | `blue reset` karo; ya doosre provider ki key add karo (`blue providers`) |
| `invalid key` | Provider dashboard se key check karo — galat/expired hai |
| `No accounts configured` | `blue add groq <key>` |
| `502` / `upstream` | Provider down hai — `blue requests --errors` dekho, dusra provider add karo |
| Port already in use | `blue config set port 1213 && sudo blue restart` |
| Sab kuch reset karna hai | `sudo blue uninstall --purge --yes` phir dobara install |

Server ka log:

```bash
blue logs            # last 60 lines
blue logs -f         # live
```

---

## 10. Security (zaroor padho)

- Provider keys VPS par `data/config.json` me rehti hain — file permission `600`
  hai, sirf root padh sakta hai. Kisi bahar wale server par nahi jati.
- BlueRouter plain **HTTP** chalata hai. Internet par khol rahe ho to Caddy/nginx
  se HTTPS lagao, ya WireGuard/private network use karo.
- `blue_` key kisi ko de rahe ho to alag kar do — `blue rotate` se turant badal sakte ho.
- 5 accounts banane se provider ke terms break ho sakte hain — ye decision aapka
  hai. BlueRouter bas aapki di hui keys ko rotate karta hai aur har 429 ko respect
  karta hai.

---

Kuch aur chahiye? `blue help` chalao — saare commands wahin hain.
