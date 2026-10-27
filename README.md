# magpie-plugin-codar

A [magpie](https://github.com/yetone/magpie) plugin for **Codar (科搭)**, the
research desktop app by SpeedAI: it adds Codar's models to magpie as a
provider, claims the daily check-in for you, and puts the account's points on
the usage card.

## What it does

| Hook | What it does |
|---|---|
| `config` / `provider` | Adds a `codar` provider with Codar's model list (16 models: DeepSeek, GLM, GPT and Claude families). The list is embedded from the app's own catalog and refreshed from `GET /v1/codar/models` when signed in. |
| `auth.checkin` | `POST /v1/daily-sign` once a day. The answer says whether it claimed or was already claimed, and how long until the next one. |
| `auth.usage` | Points (`/v1/gettoken`: general + agent), today's claim state, and any free-model activity still running, with when it ends. |
| `chat.headers` | Sends the same `User-Agent` the desktop client sends, so the gateway sees the app's own traffic shape. |

Chat itself goes straight from magpie to Codar's gateway
(`https://api.claw.speedai.com/v1`): OpenAI-compatible for most models, the
Anthropic Messages API for the Claude ones — the same two protocols the
desktop app uses.

## Where the token comes from

Codar signs in with a JWT and keeps it in its own config file:

- macOS / Linux: `~/.codar/config.json`
- Windows: `%USERPROFILE%\.codar\config.json`

The value is `provider.speedai.token`. Copy it and paste it when magpie asks
for the plugin's key:

```bash
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.codar/config.json")))["provider"]["speedai"]["token"])'
```

The token carries the account name and an expiry (7 days after the app's last
login). When it runs out the plugin says so instead of calling the API — open
Codar once to refresh it there, then paste the new one.

## Install

```bash
magpie plugin add github:MisonL/magpie-plugin-codar
printf 'eyJ-your-token\n' | magpie plugin login codar
```

Then pick a `codar` model in magpie, and turn on its check-in under
Settings (设置) → 额度 (Quota) → 预热与签到 (warm-up & check-in) → 插件 (Plugins).

## What this plugin does not do

- **It does not claim the free-model activity.** `POST /api/codar/activities/free-model/claim`
  is a one-time campaign claim, not a daily check-in, and the plugin only
  reports the activities that are running.
- **It does not read or write the desktop app's config file.** The token is
  pasted once and kept in magpie's own `plugin-auth.json`.
- **It does not convert prices.** Codar lists prices in CNY per million
  tokens; magpie's cost column is US dollars, so the models show as unpriced
  rather than with an invented exchange rate. Set a per-model price in
  magpie if you want the Usage page to count it.

## Notes

- The plugin sends the same headers the desktop app sends on each host: a Go
  HTTP client's `User-Agent` to the gateway (that is what the app's Go
  sidecar sends) and Node's default to the account API (that is what the
  app's Electron main process sends). Nothing else is added.
- If `GET /v1/codar/models` cannot be reached, the provider keeps the list
  embedded in `catalog.mjs` and magpie marks the list as fallen back.
- Codar's free models allow 3 requests per model at a time (measured: with
  four in flight, the fourth answers 429 `concurrent_limit_exceeded`, "Too
  many concurrent requests"). The auth hook declares `maxConcurrency: 3`, so
  magpie queues requests past three per account instead of letting them
  reach the vendor's limit; the provider's own setting can raise it.

## Development

```bash
node --test        # the whole suite, no network
```

The tests stub `fetch`; nothing here talks to SpeedAI.

## Licence

MIT.
