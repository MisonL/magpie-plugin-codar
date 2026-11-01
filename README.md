# magpie-plugin-codar

A [magpie](https://github.com/yetone/magpie) plugin for **Codar (科搭)**, the
research desktop app by SpeedAI: it adds Codar's models to magpie as a
provider, claims the daily check-in for you, and puts the account's points on
the usage card.

## What it does

| Hook | What it does |
|---|---|
| `config` / `provider` | Adds a `codar` provider with Codar's model list (17 models: the `auto` router plus DeepSeek, GLM, GPT and Claude families). The list is embedded from the app's own catalog and refreshed from `GET /v1/codar/models` when signed in. |
| `auth.methods` | Two ways to sign in: "读取本机科搭令牌" (keyless — the plugin reads `~/.codar/config.json` itself, read only) and pasting the "科搭访问令牌". |
| `auth.checkin` | `POST /v1/daily-sign` once a day. The answer says whether it claimed or was already claimed, and how long until the next one — including `until` (magpie ≥ 0.1.1795), so magpie re-asks exactly when Codar's rolling 24 hours open again instead of every 30 minutes before noon. A wait it cannot use — missing, zero, past year 9999, or longer than a week (this day rolls every 24 hours, so 31 years is not a next-claim time) — gets a 30-minute trust floor instead: "done with no `until`" would settle the whole day in magpie, and a rolling window would lose the next claim. |
| `auth.usage` | Points (`/v1/gettoken`: general + agent), today's claim state, and any free-model activity still running, with when it ends. The three reads go out together. The points also go out as a wallet reading, so routing has a figure for the account instead of "what's left not known yet". |
| `chat.headers` | Sends the desktop client's `User-Agent` on Codar's own requests, so the gateway sees the app's traffic shape. The hook runs for every provider's requests, so it filters by provider id and leaves the others alone. |

Chat itself goes straight from magpie to Codar's gateway
(`https://api.claw.speedai.com/v1`): OpenAI-compatible for most models, the
Anthropic Messages API for the Claude ones — the same two protocols the
desktop app uses.

## Where the token comes from

Codar signs in with a JWT and keeps it in its own config file:

- macOS / Linux: `~/.codar/config.json`
- Windows: `%USERPROFILE%\.codar\config.json` (inferred from the app's platform convention; only measured on macOS)
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
magpie plugin add "$PWD"       # not published yet; install from this folder
# magpie plugin add github:MisonL/magpie-plugin-codar   # once it is
magpie plugin login codar     # pick "读取本机科搭令牌", or paste the token
```

Then pick a `codar` model in magpie, and turn on its check-in under
Settings (设置) → 额度 (Quota) → 预热与签到 (warm-up & check-in) → 插件 (Plugins).

## What this plugin does not do

- **It does not claim the free-model activity.** `POST /api/codar/activities/free-model/claim`
  is a one-time campaign claim, not a daily check-in, and the plugin only
  reports the activities that are running.
- **It does not read or write the desktop app's config file**, except for the
  "read from this machine" sign-in, which reads the app's config once
  (read only, `~/.codar/config.json` or `$CODAR_HOME/config.json`) and keeps
  the token in magpie's own `plugin-auth.json`.
- **It does not convert prices.** Codar lists prices in CNY per million
  tokens and magpie's cost column is US dollars, so the plugin hands over no
  price of its own rather than inventing an exchange rate. magpie still
  prices models by what models.dev says their makers charge; a vendor-suffixed
  id such as `claude-opus-5-kiro` is not in models.dev, but magpie prices it
  by the `served` model the vendor's answer names (`claude-opus-5`). Set a
  per-model price in magpie to override any of them.
- **It does not map the vendor's reasoning levels onto magpie's effort
  variants.** The catalog states each model's levels (`reasoning.levels`), but
  a level's meaning is a script of request-body fields (`set`/`omit`) the
  desktop app applies itself; magpie's variants only name levels and pass the
  client's own effort through. A plugin has no way to say what a level does to
  the request, so listing them would promise levels magpie cannot apply the
  vendor's way — the models carry `reasoning: true` and no variants.

## Notes

- The plugin sends the same headers the desktop app sends on each path:
  Node's default `User-Agent` to the account API, the activity API and the
  model catalog (the app's Electron main process reads those, and adds no
  UA of its own), and a Go HTTP client's to chat (that is what the app's Go
  sidecar sends). Nothing else is added.
- magpie runs every plugin's `chat.headers` hook for every provider's
  requests, not just the plugin's own; this one checks the provider id and
  only touches `codar` requests, leaving other providers' traffic alone.
- The provider is named 科搭 Codar only while it has no name of its own, and
  the provider-level `api`/`npm` default to Codar's gateway the same way: the
  `config` hook fills each in only when it is missing and never writes over a
  value you set — a rename, or an `api` pointed at your own proxy, survives
  restarts. A single model's own settings work the same way, field by field
  at every depth: an entry that sets only `provider.api` keeps the catalog's
  `provider.npm`, and one that sets only `limit.output` keeps the context
  window. Keys that are properties of every object (`__proto__`,
  `constructor`, `prototype`) are never merged in — a model has no field by
  those names — and a model *named* one of them is dropped for the same
  reason: writing `models["__proto__"]` would set the model map's prototype
  instead of adding a model. A vendor record whose id names one of them is
  dropped from the live list too (the host's next step on that list is the
  same bracket assignment), so a renamed or planted id never becomes the
  prototype of the model map magpie builds. A provider slot holding an array
  is treated as empty rather than written into (its index keys would land in
  your config). The address you set is written down the same way on both
  paths — the `config` entry and the live list's per-model base alike take
  the surrounding whitespace and the trailing slashes off, and a value that
  is only whitespace is no value (the gateway fills in) — because magpie
  joins a request path onto the base as written, and a base kept as
  `.../v1//` would ask `.../v1//chat/completions`.
  The live list follows the same address: every model the vendor's
  catalog brings back is written at your provider's `api` (or the model's
  own, if you set one), never at Codar's gateway — magpie prefers a model's
  URL over the provider's, so a hard-coded gateway there would send your
  proxy nowhere on the first successful refresh. The vendor's own entries
  follow the vendor on a refresh; per-model names, prices and reasoning tiers
  you set in magpie's UI live in magpie's own settings, outside this plugin's
  list, so they survive it.
- A time that cannot be written down is left out rather than rounded to
  something wrong: a window's `resetsAt` and the "N 后可再领" text are omitted
  when the vendor's number is missing, zero, non-finite (`1e999` reads as
  `Infinity`) or past year 9999 — magpie renders a time of 0 as 1970-01-01,
  not as "not said". The check-in's wait has one more bound of its own: its
  day rolls every 24 hours, so a wait longer than a week is not a next-claim
  time that window can produce, and the check-in treats such a number as
  unsaid; an activity's end is a real date, so it is drawn as far out as the
  calendar allows. A positive wait of under a second is said as one second:
  rounding it said "0 秒后可再领", a window the vendor just opened told as no
  wait at all (a stated zero is still a zero). The check-in's `until` is the
  one thing never omitted: a "done" with no `until` settles the whole day in
  magpie, so an unusable wait falls back to the 30-minute trust floor
  described above.
- The state and balance reads follow the vendor's own client: the check-in
  status is read from a boolean `data` or any of `isSigned`/`signed`/
  `hasSigned`/`has_signed` (each only as a real boolean), the balances from
  `token`/`remaining_points`/`points`/`balance` and `agent_token`/`agentToken`/
  `agent_points`/`agentPoints`, and a negative reading is treated as not
  stated (the host clamps a wallet figure to 0, so passing one on would put
  two answers on the card). An answer whose body `code` is a number other
  than 200 is a refusal, as that client reads it: the points read fails with
  the code instead of reporting a balance of 0, a refused claim state draws
  no row rather than "you can claim now", and a refused activity list draws
  nothing even when it still carries a `data` array. The other side of that
  gate: an answer that names no code is not a refusal — the vendor's client
  passes it (its activity API already answers without one), so a claim answer
  without a code counts as the claim it says it is, unless the answer itself
  says `success: false` — and on the claim answer `success: false` is
  consulted however the code sits, a `code: 200` body that says the flag
  included: that is an HTTP layer saying yes and the vendor saying no, so the
  flag decides. That flag is read on the claim answer only: the claim-state
  and activity reads follow that client's own gate, which looks at the code
  alone, so a `success: false` there without a refusing code is drawn as its
  data says — as the app itself draws it. The one thing the
  flag does not override is the vendor's own note that the day is already
  claimed: a `400` naming "24小时内仅可领取一次" beside `success: false` is
  that client's "today is in", and reading it as a failure would have magpie
  retry the rest of the day every 30 minutes while the card said the check-in
  failed. A refusal's words print a code only where the vendor stated one:
  with no code in the body there is no code in the sentence (it used to read
  "签到失败（code ?）", a question mark the user cannot act on). The check-in's
  words — including that "already claimed" note that tells a claim from a
  repeat — are read from the first of `message`/`msg`/`error`/`detail` and the
  same four under `data`, as that client reads them. The balances also come
  from `data` when the vendor wraps them in one, as that client unwraps it;
  and a points refusal is said in those same words. The check-in's credit is
  the sum of both balances' increases between its two reads — the vendor says
  a claim grants "点数奖励" without saying which balance holds it — and a
  balance that fell (the app spending) is not subtracted from it.
- When the token has run out the plugin asks the vendor nothing: the model
  list stays as it is (`catalog.mjs`'s), and is **not** marked as fallen
  back — magpie marks that only after it really tried and failed. The card
  says to sign in again. An `exp` is read the way the vendor's client reads
  it, a number or a string that says one; a token whose claims state no `exp`
  is not called expired by the plugin — that client calls such a token
  "unknown" and lets the vendor answer.
- If `GET /v1/codar/models` cannot be reached, the provider keeps the list
  embedded in `catalog.mjs` and magpie marks the list as fallen back. Claude
  models keep the Anthropic protocol on that list too: each model carries its
  own SDK, not just the provider's default. A list the vendor actually
  answered is not a fallback even when it is empty: an account the vendor
  serves no models gets no list, while one whose every record the plugin had
  to leave out (no usable id) is a list it could not read and still falls
  back.
- Models you add to this provider yourself (ids the embedded catalog does not
  have) are kept when the vendor's list refreshes; the vendor's own entries
  follow the vendor. A config model entry that is not a plain object (a null,
  a string, an array) is dropped rather than passed on: the host builds every
  provider's row from that map in one Promise.all, and one such entry throws —
  taking the whole provider list down, not just that entry.
- A model's reply ceiling is the vendor's own: the catalog states
  `max_tokens.maximum` per model (16 of 17 today; `gpt-5.6-sol` states none,
  and 0 means "not stated"), and it goes out as
  the model's `limit.output`. magpie lowers a request that asks for more to it
  (its gateway's `maxoutput.go`), so an agent asking past the ceiling gets a
  lowered request instead of the vendor's refusal. The list embedded in
  `catalog.mjs` is the vendor's answer as of the last time it was generated —
  the fallback for an account whose gateway cannot be reached — so its sizes
  can trail the live list; the live list wins whenever it can be fetched.
- Codar's free models allow 3 requests per model at a time (measured: with
  four in flight, the fourth answers 429 `concurrent_limit_exceeded`, "Too
  many concurrent requests"). The auth hook declares 3, so magpie queues
  requests past three per account instead of letting them reach the
  vendor's limit; the provider's own setting can raise it.
  The vendor publishes no concurrency number anywhere today — not in
  `/v1/codar/models`, not in `/api/pricing`, and the 429's own body carries
  only `retry-after` — so 3 is what was measured. If the catalog ever
  carries a `max_concurrency` (an integer; a fractional one is ignored), the
  models hook picks it up and the declared value follows on the next provider
  build, without a plugin release.
- The points are also reported as one window with a `balance` (magpie #3950):
  a card with only `aside` rows tells routing nothing, so magpie wrote
  "what's left not known yet" beside the account. A wallet reading makes it
  known, with the figure left and no share invented. magpie versions before
  the one that reads a window's `balance` show this row as plain text and
  keep saying the account is unknown; the plugin is safe either way. The
  wallet carries the general points; an account whose answer names only
  `agent_token` (today's names both) shows the agent figure in the card's
  text, but has no wallet reading for routing to go on.
- A free-model activity is drawn by the vendor app's own rule — `free_until`
  in the future, and a `remaining_quota` that isn't spent — not by its
  `status` field, which the app doesn't read. It is `aside` — using it up
  only sends those models back to points, it doesn't stop the account — and
  carries `amount`/`limit` when the vendor states a total
  (`user_quota_limit`) *and* what is left of it: only then is the share a
  real pair of numbers. A stated total without a readable remainder says the
  total ("免费使用中，共 N") rather than calling the activity unlimited, a
  remainder past the total is said as it is, and only an activity with
  neither number shows as "不限量".
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
node --test              # the whole suite, no network
bun test                 # the runtime magpie actually loads plugins on
node scripts/catalog.mjs --check   # is catalog.mjs still what the vendor says?
node scripts/catalog.mjs           # regenerate it from the signed-in app
```

The tests stub `fetch`; nothing here talks to SpeedAI. CI runs the suite on
Node 18–24, on Bun across Linux/macOS/Windows, and on Node on Windows and
macOS — the plugin reads a file under the home directory, and that is where
per-platform differences show up.

`catalog.mjs` is the fallback list, generated from the vendor's own catalog
and committed; nothing at runtime can tell it has gone stale, so run
`--check` when a card shows a size the live gateway contradicts, and
regenerate when Codar adds models. It reads the app's token the way the
sign-in does and never prints it.

The generator writes its records with the plugin's own `catalogOf`, so the
fallback file and the live list are read the same way (a size the vendor
spells as a string is a size on both paths; a name is a cleaned card line on
both). `--check` compares the records field by field, so a reordered key or a
reworded comment is not drift. Its exit codes keep the two failures apart: 0
is "nothing moved", 1 means a record moved and the file wants regenerating,
and 2 is "the vendor or the file could not be read" — a run that fails to
fetch writes nothing rather than emptying the fallback, and an answer naming
zero models is refused rather than committed. It needs a signed-in app, so it
is a local command, not a CI step.

## Licence

MIT.
