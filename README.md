# magpie-plugin-codar

A [magpie](https://github.com/yetone/magpie) plugin for **Codar (科搭)**, the
research desktop app by SpeedAI: it adds Codar's models to magpie as a
provider, claims the daily check-in for you, and puts the account's points on
the usage card.

## What it does

| Hook | What it does |
|---|---|
| `config` / `provider` | Adds a `codar` provider with Codar's model list (16 models: DeepSeek, GLM, GPT and Claude families). The list is embedded from the app's own catalog and refreshed from `GET /v1/codar/models` when signed in. |
| `auth.methods` | Two ways to sign in: "读取本机科搭令牌" (keyless — the plugin reads `~/.codar/config.json` itself, read only) and pasting the "科搭访问令牌". |
| `auth.checkin` | `POST /v1/daily-sign` once a day. The answer says whether it claimed or was already claimed, and how long until the next one. |
| `auth.usage` | Points (`/v1/gettoken`: general + agent), today's claim state, and any free-model activity still running, with when it ends. The three reads go out together. The points also go out as a wallet reading, so routing has a figure for the account instead of "what's left not known yet". |
| `chat.headers` | Sends the desktop client's `User-Agent` on Codar's own requests, so the gateway sees the app's traffic shape. The hook runs for every provider's requests, so it filters by provider id and leaves the others alone. |

Chat itself goes straight from magpie to Codar's gateway
(`https://api.claw.speedai.com/v1`): OpenAI-compatible for most models, the
Anthropic Messages API for the Claude ones — the same two protocols the
desktop app uses.

## Where the token comes from

Codar signs in with a JWT and keeps it in its own config file:

- macOS / Linux: `~/.codar/config.json`
- Windows: `%USERPROFILE%\.codar\config.json`
- or `$CODAR_HOME/config.json`, when `CODAR_HOME` is set: the app honours it
  (`codar config path` says where its file is), and so does this plugin

The value is `provider.speedai.token`. Copy it and paste it when magpie asks
for the plugin's key:

```bash
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.codar/config.json")))["provider"]["speedai"]["token"])'
```

Or let the plugin do it: the sign-in offers **"读取本机科搭令牌"** (read this
machine's Codar token), which reads that file itself — read only, never
written — and checks the token has an account name and has not run out before
handing it over, so a broken file says why instead of saving an unusable key.

The token carries the account name and an expiry (7 days after the app's last
login). When it runs out the plugin says so instead of calling the API — open
Codar once to refresh it there, then sign in again.

## Install

```bash
magpie plugin add github:MisonL/magpie-plugin-codar
magpie plugin login codar     # pick "读取本机科搭令牌", or paste the token
```

Then pick a `codar` model in magpie, and turn on its check-in under
Settings (设置) → 额度 (Quota) → 预热与签到 (warm-up & check-in) → 插件 (Plugins).

## What this plugin does not do

- **It does not claim the free-model activity.** `POST /api/codar/activities/free-model/claim`
  is a one-time campaign claim, not a daily check-in, and the plugin only
  reports the activities that are running.
- **It does not read or write the desktop app's config file**, except for the
  "read from this machine" sign-in, which reads `~/.codar/config.json` once
  (read only) and keeps the token in magpie's own `plugin-auth.json`.
- **It does not convert prices.** Codar lists prices in CNY per million
  tokens and magpie's cost column is US dollars, so the plugin hands over no
  price of its own rather than inventing an exchange rate. magpie still
  prices some models by what models.dev says their makers charge; vendor-
  suffixed ids such as `claude-opus-5-kiro` do not. Set a per-model price
  in magpie to override any of them.

## Notes

- The plugin sends the same headers the desktop app sends on each path:
  Node's default `User-Agent` to the account API, the activity API and the
  model catalog (the app's Electron main process reads those, and adds no
  UA of its own), and a Go HTTP client's to chat (that is what the app's Go
  sidecar sends). Nothing else is added.
- magpie runs every plugin's `chat.headers` hook for every provider's
  requests, not just the plugin's own; this one checks the provider id and
  only touches `codar` requests, leaving other providers' traffic alone.
- The provider is named 科搭 Codar only while it has no name of its own: the
  `config` hook fills that name in when it is missing and never writes it over
  one you set in magpie, so a rename survives restarts.
- If `GET /v1/codar/models` cannot be reached, the provider keeps the list
  embedded in `catalog.mjs` and magpie marks the list as fallen back. Claude
  models keep the Anthropic protocol on that list too: each model carries its
  own SDK, not just the provider's default.
- Models you add to this provider yourself (ids the embedded catalog does not
  have) are kept when the vendor's list refreshes; the vendor's own entries
  follow the vendor.
- Codar's free models allow 3 requests per model at a time (measured: with
  four in flight, the fourth answers 429 `concurrent_limit_exceeded`, "Too
  many concurrent requests"). The auth hook declares 3, so magpie queues
  requests past three per account instead of letting them reach the
  vendor's limit; the provider's own setting can raise it.
  The vendor publishes no concurrency number anywhere today — not in
  `/v1/codar/models`, not in `/api/pricing`, and the 429's own body carries
  only `retry-after` — so 3 is what was measured. If the catalog ever
  carries a `max_concurrency`, the models hook picks it up and the declared
  value follows on the next provider build, without a plugin release.
- The points are also reported as one window with a `balance` (magpie #3950):
  a card with only `aside` rows tells routing nothing, so magpie wrote
  "what's left not known yet" beside the account. A wallet reading makes it
  known, with the figure left and no share invented. magpie versions before
  the one that reads a window's `balance` show this row as plain text and
  keep saying the account is unknown; the plugin is safe either way.
- A free-model activity is drawn only while the vendor says it is running
  (`status: "active"` and `free_until` in the future). It is `aside` — using
  it up only sends those models back to points, it doesn't stop the account —
  and carries `amount`/`limit` only when the vendor states a total
  (`user_quota_limit`); an unlimited activity shows as its text.
- The daily check-in is a text row, not a percentage: a check-in is not an
  allowance that runs out, so the plugin sends no `used` and magpie shows
  what the row says.
- The "read from this machine" sign-in follows `CODAR_HOME` when it is set:
  the app honours it (`codar config path` answers `$CODAR_HOME/config.json`),
  so the plugin reads the same file the app writes. Without it, the home
  directory above is used.
- Codar's own gateway has had short outages (its catalog answered 500 to
  every client, the desktop app included); when that happens the plugin
  keeps the points on the card and drops only what could not be read.

## Development

```bash
node --test        # the whole suite, no network
bun test           # the runtime magpie actually loads plugins on
```

The tests stub `fetch`; nothing here talks to SpeedAI. CI runs the suite on
Node 18–24, on Bun across Linux/macOS/Windows, and on Node on Windows and
macOS — the plugin reads a file under the home directory, and that is where
per-platform differences show up.

## Licence

MIT.
