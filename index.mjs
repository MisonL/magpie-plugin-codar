// Codar (科搭) for magpie: its models as a provider, its daily check-in, and
// the account's points on the card.
//
// 三件事，三处接口：
//   - 对话：https://api.claw.speedai.com/v1，OpenAI 兼容（claude 系走
//     /v1/messages，Anthropic 兼容）。桌面端自己也是这么调的——侧车把
//     provider.api_base 设成这个地址，请求头只有 Authorization、Content-Type
//     和一个 Go HTTP 客户端的 User-Agent。插件照发同样的请求头（见
//     chat.headers 与 UA 的注释），不做别的事。
//   - 模型目录：GET /v1/codar/models，返回 {object:"list", data:[…]}（也有
//     {catalog:{data:[…]}} 的形状，两种都认），字段见 catalog.mjs（那份是
//     桌面端缓存的同一份数据，作为拿不到时的底）。
//   - 签到：POST https://api.kuaipaper.com/v1/daily-sign，body 是
//     {username}，同一把 Bearer 令牌。返回 {code, message, data}：code 200
//     是领到了，code 400「24小时内仅可领取一次」是今天已经领过，
//     data.retry_after 是距离下次可领的秒数。
//   - 点数：POST /v1/gettoken {username, token: 0} → {token, agent_token}。
//
// 令牌是桌面端登录后写进 ~/.codar/config.json 的那把 JWT
// （provider.speedai.token），里面带 username 和 exp（登录后 7 天）。magpie
// 只保存插件交上去的那一份；过期后就报「登录已过期」，由用户重新登录。
// 另一个登录方式「读取本机科搭令牌」会在登录时读一次那个文件（只读，不写），
// 省掉手工复制。

import { CATALOG } from "./catalog.mjs"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ID = "codar"

// 对话与目录走 claw 网关，账号、签到、点数走 kuaipaper。桌面端也是这么分的：
// main.cjs 里 target "speedai" 走前者，其余 /v1/ 走后者。
const API = "https://api.claw.speedai.com"
const ACCOUNT = "https://api.kuaipaper.com"

const CATALOG_PATH = "/v1/codar/models"
const ACTIVITIES_PATH = "/api/codar/activities/mine"
const SIGN_PATH = "/v1/daily-sign"
const SIGN_STATUS_PATH = "/v1/daily-sign/status"
const POINTS_PATH = "/v1/gettoken"

// 桌面端两条链路各发各的 User-Agent，插件按接口分开对齐：
//   - 对话走 Go 侧车 → "Go-http-client/1.1"（实测抓包）
//   - 模型目录、账号、签到、点数、活动走 Electron 主进程的 fetch → "node"
//     （Node fetch 的默认值；主进程的 auth-request 自己不加 UA）
// 目标是让请求和 App 自己的流量同形，而不是一个陌生的客户端。
const UA_SIDECAR = "Go-http-client/1.1"
const UA_DESKTOP = "node"

const TIMEOUT_MS = 8000
const CHECKIN_BUDGET_MS = 25 * 1000
const USAGE_BUDGET_MS = 18 * 1000

// MAX_TIME_MS is the largest time that survives the whole trip to magpie.
// Two ceilings matter, and the lower one wins: JS's Date.toISOString() throws
// past 8.64e15 ("Invalid time value"), and magpie's own side parses the ISO
// string with Go's RFC3339 layout, which has four year digits — a "+275760-…"
// string parses to zero and the time is dropped in silence. 253402300799999
// is 9999-12-31T23:59:59.999Z, the last instant both accept. A vendor's
// retry_after is a number nothing bounds, so a time past it is clamped here
// rather than dropped downstream.
const MAX_TIME_MS = 253402300799999
const safeTime = (ms) => {
  const n = Number(ms)
  if (!isFinite(n) || n <= 0) return 0
  return Math.min(n, MAX_TIME_MS)
}

// MAX_WAIT_SECS is the longest wait a card can say: a wait past the last
// time magpie can read (year 9999) would be clamped to it anyway, and
// "1.1574074074074072e+303 天后" is not a thing a card says.
const MAX_WAIT_SECS = MAX_TIME_MS / 1000

// numOf is a vendor field as a number, read the way its own client reads one
// (app.asar's B0): a number, or a string that says one. A boolean, an array
// or an object is not one — Number(true) is 1 and Number([3600]) is 3600, and
// a made-up second is a made-up wait. NaN when there is no number.
const numOf = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN)

// plain is a value that is a map: an object, but not an array (an array is
// an object too, and writing a named field on it would be JSON.stringify'd
// away) and not null. What the host builds a config model from, and what a
// vendor record has to be to be read field by field.
const plain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v)

// sayableSecs is a vendor's number of seconds when it is one a card can say:
// finite, positive, and inside the calendar. Anything else is 0 — "not
// stated" — so callers can decide with one check whether they have a time at
// all. The bound is what keeps `secs * 1000` from overflowing to Infinity,
// which safeTime would turn into 0 and a host would draw as 1970-01-01.
const sayableSecs = (v) => {
  const n = numOf(v)
  return Number.isFinite(n) && n > 0 && n <= MAX_WAIT_SECS ? n : 0
}

// MAX_CHECKIN_WAIT_SECS is the longest wait the daily check-in can name.
// Codar's day is a rolling 24 hours (measured retry_after ≈ 23 h), so a wait
// past a week is not a next-claim time that window can produce. Trusting it
// would settle the check-in for as long as the vendor's number says — 1e9
// seconds is 31 years, and magpie would not ask again until 2058 — so such a
// number is treated as one we cannot use, like a missing one.
const MAX_CHECKIN_WAIT_SECS = 7 * 24 * 3600
const checkinWaitSecs = (v) => {
  const n = sayableSecs(v)
  return n > 0 && n <= MAX_CHECKIN_WAIT_SECS ? n : 0
}

// ALREADY_CLAIMED is how the vendor words "this day is already claimed": its
// 400 says 24小时内仅可领取一次, and the same words on an answer that names no
// code mean the same thing.
const ALREADY_CLAIMED = /24\s*小时|仅可领取一次/

// MAX_MODELS is how many models one vendor catalog may bring back. The host
// passes a hook's answer to Go as a single JSON line and kills the whole
// plugin host — every plugin in it — when that line passes 32 MiB
// (host.go's maxWireLine); an unbounded list is a way for a vendor to take
// the host down with data rather than with a bug. Codar lists 17.
const MAX_MODELS = 2000

// MAX_ACTIVITY_WINDOWS is how many free-model activities go on the card.
// The same wire limit applies to the usage answer, and the card has room for
// a handful of rows; Codar has run at most two activities at a time.
const MAX_ACTIVITY_WINDOWS = 20

const CLAUDE = "@ai-sdk/anthropic"
const OPENAI = "@ai-sdk/openai-compatible"

// tokenOf is the key this sign-in carries, or "" when there is none or it is
// not one we can send. A key with anything but visible ASCII in it would put
// the whole value into a fetch error message ("…is an invalid header value"),
// which magpie logs and shows; it is refused here, before it can be echoed.
const tokenOf = (auth) => {
  const token = auth?.type === "api" ? String(auth.key ?? "").trim() : ""
  return token && /^[\x21-\x7e]+$/.test(token) ? token : ""
}
// unusableKey is a key that is there but cannot be sent: a missing one is a
// different answer, and telling the user to "sign in again" for an empty one
// sends them to the wrong place.
const unusableKey = (auth) => Boolean(String(auth?.key ?? "").trim()) && !tokenOf(auth)

// payloadOf is a JWT's claims, or null when the string is not one. No
// verification: the vendor is the one that checks the signature; we read it
// for the account name and the expiry the token itself carries.
function payloadOf(token) {
  const parts = String(token ?? "").split(".")
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const json = Buffer.from(b64, "base64").toString("utf8")
    const claims = JSON.parse(json)
    return claims && typeof claims === "object" ? claims : null
  } catch {
    return null
  }
}

const usernameOf = (token) => {
  const u = payloadOf(token)?.username
  return typeof u === "string" ? u : ""
}

// expSeconds is a token's exp as the vendor's client reads it (app.asar's
// ZAe): a number, or a string that says one; NaN when it states none.
const expSeconds = (token) => numOf(payloadOf(token)?.exp)

// expiresAt is when the token says it runs out (ms), or 0 when it says
// nothing. A token past it is not sent: every endpoint would answer 401 and
// the card would say "check-in failed" instead of "sign in again". The exp
// is read the way the vendor's client reads it (app.asar's ZAe): a number,
// or a string that says one — a string exp read as "no expiry" would send a
// token the vendor already counts as expired, and the card would say the
// check-in failed instead of asking to sign in again.
function expiresAt(token) {
  const n = expSeconds(token)
  return Number.isFinite(n) ? n * 1000 : 0
}

// expired says whether the token has run out, as that same client decides:
// a stated exp in the past is expired — the epoch itself included, which the
// 0-means-unsaid reading of expiresAt cannot tell from "says nothing" — while
// a token that states no exp is not declared expired here (that client calls
// it "unknown", and the vendor is the one to answer).
const expired = (token) => {
  const n = expSeconds(token)
  return Number.isFinite(n) && Date.now() >= n * 1000
}

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

const signedOut = (e) => e?.status === 401 || e?.status === 403

// whyOf is the message to show for an error, without the token it might name.
const whyOf = (e) => (e instanceof Error ? e.message : String(e ?? ""))

// controlChars would break a card's line, reorder what follows it, or ride
// along invisibly: a vendor string is shown as one line, never as a control
// sequence. C0 and C1 controls, the zero-width marks, the bidi overrides and
// isolates (a right-to-left override reverses the text after it), the line
// and paragraph separators, a byte-order mark.
const controlChars =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g

// cleanText is a vendor string as a card can show it: control characters
// out, one line (runs of spaces folded), and never longer than a card reads.
const cleanText = (s) => String(s).replace(controlChars, " ").replace(/\s{2,}/g, " ").trim().slice(0, 120)

// jwtShape is a credential as a server might quote it back. Every Codar token
// is a JWT, and every JWT segment is base64url. A server can wrap the token
// at any column or insert whitespace anywhere in the message; the shape must
// match both intact tokens and the same token split with spaces/newlines.
// The pattern matches an eyJ-started segment, then dot-separated segments.
// Whitespace between chunks of base64url inside a segment is allowed, so the
// whole token cuts regardless of where lines were inserted. A real JWT
// requires two dots; we allow 0–2 extra segments for safety. Prose beginning
// with eyJ would also be cut, but that's acceptable in an error message where
// failing closed (removing more rather than less) matters.
const jwtShape = /eyJ[\w-]*(?:\s+[\w-]+)*(?:\s*\.\s*[\w-]+(?:\s+[\w-]+)*){0,2}/g

// configPath is where the Codar app keeps its own config. The app takes
// CODAR_HOME over the home directory when it is set (its sidecar's
// `codar config path` says so), so the file is looked for in the same
// place the app would have written it.
const configPath = () => {
  const home = String(process.env.CODAR_HOME ?? "").trim()
  return join(home || join(homedir(), ".codar"), "config.json")
}

// appToken reads the token the Codar desktop app keeps, for the "read from
// this machine" sign-in: provider.speedai.token in ~/.codar/config.json
// (%USERPROFILE%\.codar\config.json on Windows, as the app's own docs say;
// on macOS/Linux the home directory is the same place). Read only — the file
// is the app's, and the plugin never writes it. A failure says why in words
// the sign-in dialog can show, since this runs where no card exists yet.
function appToken(file = configPath()) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch (e) {
    // 不存在和读不了是两回事：让人「先登录一次科搭」修不好权限问题，指过去
    // 只会白跑一趟。
    if (e?.code === "ENOENT") return { error: `没找到 ${file}，先在这台机器上登录一次科搭，或改用「科搭访问令牌」粘贴` }
    return { error: `读不了 ${file}（${e?.code ?? whyOf(e)}），检查文件权限后重试，或改用「科搭访问令牌」粘贴` }
  }
  let token = ""
  try {
    token = String(JSON.parse(text)?.provider?.speedai?.token ?? "").trim()
  } catch {
    return { error: `${file} 读不出 JSON，可能损坏了；改用「科搭访问令牌」粘贴` }
  }
  if (!token) return { error: `${file} 里没有 provider.speedai.token；先在这台机器上登录一次科搭，或改用粘贴` }
  if (!tokenOf({ type: "api", key: token })) return { error: `${file} 里的令牌无法识别；改用「科搭访问令牌」粘贴` }
  // every call this plugin makes sends the account name from the token's
  // own claims; one without it would be saved and then fail on the card
  if (!usernameOf(token)) return { error: `${file} 里的令牌没有账号名；打开一次科搭重新登录，或改用「科搭访问令牌」粘贴` }
  if (expired(token)) return { error: `${file} 里的令牌已过期；打开一次科搭让它续期，再试一次` }
  return { token }
}

// saidBy is what an answer says in words, read the way the vendor's own client
// reads it (app.asar's Vg): the first non-blank string among the top-level
// message/msg/error/detail and the same four under `data`. Read as `message`
// alone, a refusal the vendor spelled in `msg`, and an "already claimed" note
// under `data`, both came out as no text at all — the check-in then reported a
// failure where the day was simply already claimed, and the card dropped what
// the vendor said about every other refusal.
const saidBy = (body) => {
  if (!body || typeof body !== "object") return ""
  const data = body.data && typeof body.data === "object" ? body.data : null
  for (const said of [body.message, body.msg, body.error, body.detail, data?.message, data?.msg, data?.error, data?.detail]) {
    if (typeof said === "string" && said.trim()) return said
  }
  return ""
}

async function request(url, { method = "GET", body, token, timeoutMs = TIMEOUT_MS, fetchImpl = fetch, ua = UA_DESKTOP } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": ua,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    })
    // A leading BOM would make JSON.parse refuse the whole body. Node's and
    // Bun's network fetch drop it from text(), but the fetch the host hands
    // in need not, so it is dropped here too: one line, one guarantee less
    // that depends on which fetch answered.
    const text = (await res.text()).replace(/^\uFEFF/, "")
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) throw new ApiError(saidBy(data) || `HTTP ${res.status}`, res.status)
    if (data === null) throw new ApiError("接口返回的不是 JSON")
    return data
  } catch (e) {
    if (e?.name === "AbortError") throw new ApiError("请求超时", 0)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// humanSecs says a number of seconds the way a card wants it. A number no
// calendar can say (a vendor's Infinity, a NaN, a wait past year 9999) is
// said as nothing rather than as "Infinity 天" or "1.15e+303 天": the caller
// leaves it out. Neither is a value that is not a number at all (see numOf):
// Number(true) would be said as "1 秒", and the vendor said no such thing.
function humanSecs(secs) {
  const raw = numOf(secs)
  if (!isFinite(raw) || raw > MAX_WAIT_SECS) return ""
  const n = Math.max(0, Math.round(raw))
  if (n < 60) return `${n} 秒`
  const m = Math.round(n / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h < 24) return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d} 天 ${rh} 小时` : `${d} 天`
}

// pointsOf reads the account's two balances. `token` is the general points,
// `agent_token` the agent ones; both are integers the server keeps. A refusal
// comes back as HTTP 200 with a body code (measured 2026-10-27: {"code":401,
// "message":"Invalid token"}); left as "two fields we cannot read", the card
// came out blank with no error and no expired mark.
const pointsOf = async (token, username, opts) => {
  const r = await request(`${ACCOUNT}${POINTS_PATH}`, { method: "POST", body: { username, token: 0 }, token, ...opts })
  // the vendor's own client (app.asar's Jo) refuses any answer whose code is
  // a number other than 200 — Number(e.code) as it reads it — and only then
  // reads the balances. Only `>= 400` was refused here, so a refusal spelled
  // with a smaller code ({code: 1, token: 0}) read as a balance of 0 and the
  // card said the account was spent.
  const code = Number(r?.code)
  if (Number.isFinite(code) && code !== 200) {
    // 拒绝的话按厂商客户端的读法（app.asar 的 Vg）取：message/msg/error/detail
    // 与 data 下同样四个字段里第一个有字的——只读 message 会丢掉 msg 或 data 里
    // 厂商的话，卡片于是只报一个干巴巴的码。
    const said = saidBy(r).trim()
    throw new ApiError(code === 401 || code === 403 ? "登录已过期，请重新登录" : said || `点数查询失败（code ${code}）`, code)
  }
  // …and the balances come from `data` when that is an object, as its client
  // unwraps it (Fc): the live body is flat ({code, token, agent_token,
  // rewrite_token}), and a wrapped one is what that client prefers if the
  // vendor starts sending it.
  const body = r?.data && typeof r.data === "object" ? r.data : r
  const balance = (v) => {
    // a number, or a string that says one (numOf): a made-up 0 is a balance
    // the account does not have — routing would read the account as spent.
    // A negative is not a balance either: the host clamps a wallet reading
    // to 0, so passing one on would put "-5 点" on the card beside a routing
    // figure of 0.
    const n = numOf(v)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  // the vendor's own client reads each balance by trying these names in this
  // order (app.asar's Xbt → hd(n, […])); the live body says `token` and
  // `agent_token`, and the rest are the spellings that client hedges on.
  const pick = (names) => {
    for (const name of names) {
      const n = balance(body?.[name])
      if (n != null) return n
    }
    return null
  }
  const general = pick(["token", "remaining_points", "points", "balance"])
  const agent = pick(["agent_token", "agentToken", "agent_points", "agentPoints"])
  // a 200 whose body names no balance at all is a read we cannot use: said
  // as an error, the card says why, instead of drawing nothing
  if (general == null && agent == null) throw new ApiError("点数查询没有返回余额", 0)
  return { general, agent }
}

// tokensOf is a vendor's token count — a context window, a reply ceiling —
// as a non-negative whole number. A negative or an infinite one is not a
// size anyone can plan with, and it would reach magpie's list as written, so
// it becomes "not stated" (0). Neither is a value that is not a number at
// all (see numOf).
function tokensOf(v) {
  const n = numOf(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

// baseURL is an address as it is written down: the surrounding whitespace
// and the trailing slashes off, the vendor's gateway when nothing is said.
// magpie joins a request path onto the base as written, so a base kept as
// ".../v1//" would ask ".../v1//chat/completions" — and one with a newline
// in it is a URL no client can send. One rule for both places an address is
// written: the config entry (which magpie reads as cfg.api), and the base a
// live refresh writes on each model.
const baseURL = (v) => {
  const said = typeof v === "string" ? v.trim().replace(/\/+$/, "") : ""
  return said || `${API}/v1`
}

// apiBase is where this provider's requests go: the address the host already
// resolved for it — the user's own setting when they made one, else the
// vendor's gateway. host.js builds a config model's api.url as
// `m.provider?.api ?? cfg.api ?? …`, so a provider handed to the models hook
// already carries the user's choice on its own api and on each model's; the
// hook has to keep it, because magpie picks the base as
// `firstOf(o.BaseURL, m.URL, pp.API, …)` — a model-level URL wins over the
// provider's, so a hard-coded gateway on every model sends a user's own
// proxy nowhere the moment a live refresh succeeds.
const apiBase = (provider, id) => {
  const perModel = id ? provider?.models?.[id]?.api?.url : ""
  const said = typeof perModel === "string" && perModel.trim() ? perModel : provider?.api
  return baseURL(said)
}

// KINDS are the modalities magpie knows, in the order a card lists them.
const KINDS = ["text", "image", "audio", "video", "pdf"]

// kindsOf is a vendor modality list as the kinds we know. An answer that
// names none of them — an empty list, or names this host does not know
// (a rename, a case change) — is read as "text alone", not as "takes
// nothing": every model here is a chat model, and a model that takes no
// text at all would be asserted onto magpie's catalog (host.js's imageSaid
// turns a stated `image: false` into a fact), taking every input away over
// a name we merely failed to translate. A missing field reads the same way,
// so "not said" has one meaning everywhere.
const kindsOf = (v) => {
  const known = Array.isArray(v) ? KINDS.filter((k) => v.includes(k)) : []
  return known.length ? known : ["text"]
}

// modelOf is one catalog record as magpie's provider list has it. `base` is
// where its requests go (apiBase), the vendor's gateway when nothing else
// says otherwise.
function modelOf(m, base = `${API}/v1`) {
  const anthropic = m?.protocol === "anthropic_messages"
  const npm = anthropic ? CLAUDE : OPENAI
  const reasons = Boolean(m?.reasoning)
  const input = kindsOf(m?.input)
  const output = kindsOf(m?.output)
  const takes = (list) => Object.fromEntries(KINDS.map((k) => [k, list.includes(k)]))
  return {
    id: m.id,
    name: m.name || m.id,
    // host.js resolves a config model's SDK as m.provider?.npm ?? cfg.npm ??
    // … (the `m.provider?.npm ?? cfg.npm ?? was?.api.npm` line): api.npm is
    // not read on that path. Without provider.npm the fallback list gave
    // every model the provider-level openai-compatible, so Claude models
    // lost the anthropic protocol whenever the vendor's catalog could not
    // be fetched.
    provider: { npm },
    api: { id: m.id, url: base, npm },
    limit: { context: tokensOf(m.context), output: tokensOf(m.maxOutput) },
    // The vendor prices in CNY per million tokens; magpie's cost column is
    // US dollars, and inventing an exchange rate here would put a wrong
    // number on the Usage page. Left at 0, which magpie shows as unpriced
    // where no catalog knows the model's maker price.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // The model's abilities are read from two places, and only together do
    // they cover both paths a model takes into magpie: the config hook's
    // list is merged from these top-level fields (`m.reasoning`,
    // `m.attachment`, `m.tool_call`, `m.modalities`), while the list the
    // models hook returns is read through `capabilities` (`m.capabilities?
    // .reasoning`, `kinds(m.capabilities?.input)`). The config path alone
    // had neither reasoning nor image.
    reasoning: reasons,
    tool_call: true,
    attachment: input.includes("image"),
    modalities: { input, output },
    capabilities: { temperature: true, toolcall: true, reasoning: reasons, input: takes(input), output: takes(output) },
    headers: {},
  }
}

const modelsOf = (list, base) => Object.fromEntries(list.map((m) => [m.id, modelOf(m, typeof base === "function" ? base(m.id) : base)]))

// mergeModel is the user's own model entry folded onto the catalog's, field by
// field at every depth: what the user set wins, and the fields they did not
// touch stay. A plain spread kept the catalog's fields only at the top level —
// a user who set just `provider.api` lost `provider.npm` with it, and the
// host, reading m.provider?.npm ?? cfg.npm, built a Claude model on the
// provider-level openai-compatible: it went out over the chat protocol. The
// same loss hit `limit` (an entry saying only `{ output: 4096 }` dropped the
// context window). Values that are not maps (a name, a number, a list such as
// variants or modalities.input) are taken as the user wrote them.
//
// Keys that name properties of every object (`__proto__`, `constructor`,
// `prototype`) are never folded in: writing out["__proto__"] = … sets the
// merged entry's prototype instead of a field, so a hand-written entry could
// put inherited getters under m.name/m.provider; the rest would ride along
// as own keys the host copies into the model it builds. No model has a field
// by those names, so dropping them loses nothing.
const MAGIC_KEYS = new Set(["__proto__", "constructor", "prototype"])

// noMagicKeys drops the keys that name properties of every object from a map
// about to be handed to the host as a model list. `Object.fromEntries` and
// object spread both create own data properties — a record whose id is
// `__proto__` becomes an own key without touching the prototype — but the
// host's next step on that list is `out.models[key] = { … }`, a bracket
// assignment, and that one sets the prototype: the model would vanish from
// `Object.keys` and its fields would answer for the map itself. No model is
// named any of these, so dropping them costs nothing.
const noMagicKeys = (map) => {
  for (const k of MAGIC_KEYS) if (Object.hasOwn(map, k)) delete map[k]
  return map
}
const mergeModel = (ours, theirs) => {
  if (!plain(ours) || !plain(theirs)) return theirs
  const out = { ...ours }
  for (const [k, v] of Object.entries(theirs)) {
    if (MAGIC_KEYS.has(k)) continue
    out[k] = Object.hasOwn(ours, k) ? mergeModel(ours[k], v) : v
  }
  return out
}

// catalogOf is the vendor's answer as our catalog records: the same fields
// catalog.mjs keeps, so both paths build the same entries. Vendor text is
// cleaned: a control character would break the card it lands on, and an id
// that has to be cleaned is not an id a request can ask for, so that record
// is left out rather than renamed. A record that is not a plain object is
// left out too.
function catalogOf(body) {
  const list = body?.catalog?.data ?? body?.data ?? null
  if (!Array.isArray(list)) return null
  const out = []
  for (const m of list) {
    if (out.length >= MAX_MODELS) break
    // a record that is not a plain object (the list held a null, a boolean,
    // a bare number, an array) is left out: it has no id to serve, and the
    // host reads the list this hook answers with while it builds every
    // provider's row in one Promise.all — one such record would throw there
    // and take the whole provider list down, not just that row.
    if (!m || typeof m !== "object" || Array.isArray(m)) continue
    const rawId = typeof m.id === "string" ? m.id.trim() : ""
    const id = cleanText(rawId)
    if (!id || id !== rawId) continue
    const said = typeof m.display_name === "string" ? cleanText(m.display_name) : ""
    out.push({
      id,
      name: said || id,
      context: tokensOf(m.context_window),
      // the most tokens a reply may hold, as the vendor's own request schema
      // states it (request_schema.properties.max_tokens.maximum): magpie
      // lowers a request asking for more to it (gateway's maxoutput.go),
      // which is what keeps a client's over-asking from reaching the vendor
      // as a refusal. 0 where the vendor states none (gpt-5.6-sol states
      // none today; gpt-6-sol and gpt-6-astra state 128000).
      maxOutput: tokensOf(m.request_schema?.properties?.max_tokens?.maximum),
      input: Array.isArray(m.input_modalities) ? m.input_modalities : ["text"],
      output: Array.isArray(m.output_modalities) ? m.output_modalities : ["text"],
      protocol: m.protocol?.type === "anthropic_messages" ? "anthropic_messages" : "openai_chat_completions",
      reasoning: Boolean(m.reasoning),
    })
  }
  // an empty list is the vendor's answer too — "this account is served no
  // models" — while a list whose every record we had to drop is a list we
  // could not read. Only the latter is "no answer": read as an empty list it
  // would take every model off the provider over records we merely failed to
  // parse, and read as an answer an empty one keeps the card honest.
  if (!out.length && list.length) return null
  return out
}

// runningActivities are the free-model activities on right now, as the
// vendor's own clients say (free_until in the future, and not exhausted):
// one whose quota was spent is not free anymore. We follow the vendor app's
// own filter: ignore status, use only free_until and remaining_quota (the
// live data shows status "active" and ended_at null; the catalog shows
// status "active" too).
const runningActivities = (body) => {
  // 应答码先过厂商客户端那一关（app.asar 的 Hbt 调 Jo 再读列表）：数字码不是
  // 200 的应答是拒绝，哪怕它还带着一份 data——照画就会把根本不在跑的活动
  // 报成免费。今天的应答体没有 code，只有 {data,message,success}，这道关
  // 对它无事可做；厂商哪天带上 code 的拒绝，这里也跟它的客户端一样挡住。
  const code = Number(body?.code)
  if (Number.isFinite(code) && code !== 200) return []
  const list = Array.isArray(body?.data) ? body.data : []
  const now = Date.now() / 1000
  return list.filter((a) => {
    if (!a || typeof a !== "object") return false
    if (typeof a.free_until !== "number" || a.free_until <= now) return false
    // a quota that says it's exhausted means these models aren't free
    if (a.remaining_quota != null && (typeof a.remaining_quota !== "number" || a.remaining_quota <= 0)) return false
    return true
  })
}

// publishedConcurrency is the concurrency a vendor's catalog states, when it
// states one: a max_concurrency on the catalog or on any of its models, the
// smallest it names. 0 when it says nothing — which is every reading so far
// (measured 2026-10-27: no such field in /v1/codar/models, none in
// /api/pricing, and the 429's own body carries only retry-after).
//
// The walk goes over the vendor's whole list (catalogOf's MAX_MODELS cap is
// about the answer we hand the host, not this reading), so the minimum is
// folded as it comes instead of Math.min(...nums): a spread passes one
// argument per entry, and a catalog of ~125k entries throws "Maximum call
// stack size exceeded" inside the models hook — where the catch turns it into
// a fallback, so a perfectly good live list would be dropped for its size.
const publishedConcurrency = (body) => {
  let min = 0
  const take = (v) => {
    // a number, or a string that says one (numOf): a boolean or an array is
    // not a count, and a vendor field of the wrong type would otherwise
    // silently pin the whole account to one request at a time.
    const n = numOf(v)
    if (Number.isInteger(n) && n > 0 && n <= 1000 && (min === 0 || n < min)) min = n
  }
  const list = body?.catalog?.data ?? body?.data
  take(body?.max_concurrency)
  take(body?.catalog?.max_concurrency)
  if (Array.isArray(list)) for (const m of list) take(m?.max_concurrency)
  return min
}

// signedIn is whether the account has claimed today, read the way the
// vendor's own client reads it (app.asar's ayt): the answer's data is either
// the state itself (a boolean) or an object naming it, and the client accepts
// any of four spellings, each only as a real boolean. A string "false" is not
// one: Boolean("false") is true, and a card that claims the day when it is
// not costs the user a claim. Anything else is "not signed", as that client
// reads it — the card then offers the claim instead of hiding the row.
const signedIn = (data) => {
  if (typeof data === "boolean") return data
  if (!data || typeof data !== "object" || Array.isArray(data)) return false
  for (const name of ["isSigned", "signed", "hasSigned", "has_signed"]) if (typeof data[name] === "boolean") return data[name]
  return false
}

// gain is how much one balance grew between the claim's two reads: the
// difference when both are known and it did not fall — a fall is the app
// spending, not this claim — else 0.
const gain = (was, now) => (was != null && now != null && now >= was ? now - was : 0)

// scrubLine is said as one line with no credential in it: the key itself
// where it is known, then anything credential-shaped where it is not (a
// getAuth that threw leaves no key to cut by). A token a server spliced a
// space or newline into is still cut — jwtShape lets whitespace fall anywhere
// inside a segment, and every Codar token is a JWT.
const scrubLine = (said, key) => {
  let text = typeof said === "string" ? said : ""
  if (key) text = text.split(key).join("…")
  return text
    .replace(controlChars, " ")
    .replace(jwtShape, "…")
    .replace(/\s{2,}/g, " ")
    .trim()
}

// signMessage says what the check-in answered, in the user's words, with the
// token scrubbed: a server that quotes the credential back would otherwise
// put it on the card and in magpie's log. The token itself is cut where it
// is known; a credential-shaped string is cut by its shape, which covers the
// path where the sign-in threw and there is no token to cut by.
const scrub = (said, token) => scrubLine(said, String(token ?? "")).slice(0, 400)
const signMessage = (r, token) => scrub(saidBy(r), token)

export async function CodarPlugin(input) {
  // 每次调用现取，而不是建插件时抓一个：宿主给不给 fetch 都可能，测试也会
  // 在这之后换掉全局的那个。
  const fetchImpl = (...args) => (input?.fetch ?? globalThis.fetch)(...args)

  // 并发数：厂商目前哪个接口都不说（实测 2026-10-27 的目录、pricing、429
  // 响应里都没有这个数），默认值 3 是量出来的——同时发 4 个，第 4 个收到
  // 429 concurrent_limit_exceeded。目录里一旦出现 max_concurrency，下面
  // 的目录刷新会把它记下来，auth 的 getter 下次被读时就用它。宿主在建
  // provider 信息时才读一次这个值（host.js 的 concurrencyOf），而模型钩子
  // 在那之前跑，所以刷新后的第一个请求就按新数排队。
  let vendorConcurrency = 0

  return {
    auth: {
      provider: ID,

      // 科搭按模型限 3 个并发（实测：同时发 4 个，第 4 个收到 429
      // concurrent_limit_exceeded）。按账号限 3，让 magpie 排队而不是撞限流；
      // 用户在供应商设置里可以调高。getter：目录说了个数时用它（见上），
      // 没说就是量出来的 3。
      get maxConcurrency() {
        return vendorConcurrency || 3
      },

      // 两种登录：粘贴令牌，或让插件在这台机器上读科搭自己的登录信息。
      // 后者是 keyless + authorize（magpie 的契约，host.js 的 apiKey()）：
      // 不弹输入框，由插件把令牌交上去，存进 magpie 的 plugin-auth.json。
      // 令牌过期后重新登录一次即可，不用手工复制。
      methods: [
        {
          type: "api",
          keyless: true,
          label: "读取本机科搭令牌",
          // magpie calls this with no prompts and no inputs (host.js's apiKey
          // passes `inputs ?? {}`), so the file is always the app's own — one
          // path, taken from CODAR_HOME or the home directory. It takes no
          // path from the caller: magpie's local sign-in API is reachable by
          // anything that can reach magpie, and reading an arbitrary JSON
          // file for its token is not a thing that API should be able to do.
          async authorize() {
            const got = appToken()
            if (got.error) return { type: "failed", error: got.error }
            return { type: "success", key: got.token }
          },
        },
        {
          type: "api",
          label: "科搭访问令牌",
          placeholder: "eyJ…（~/.codar/config.json 的 provider.speedai.token）",
        },
      ],

      // 签到：POST /v1/daily-sign。服务端用业务码区分「领到了」与「今天已领
      // 过」——HTTP 状态都是 200，所以看 body 的 code。返回里不带 signIn：
      // 宿主只把 outcome/credit/streak/message/until 交给 magpie（host.js 的
      // checkinOf），标账号过期是 usage 的活（usage 的 signIn 会被读走）。
      async checkin(getAuth) {
        let auth, token
        try {
          auth = await getAuth()
          token = tokenOf(auth)
        } catch (e) {
          return { outcome: "failed", message: scrub(whyOf(e), auth?.key) || "签到失败" }
        }
        if (!token)
          return {
            outcome: "failed",
            message: unusableKey(auth) ? "令牌内容无法识别（含空格、换行或非 ASCII 字符），请重新登录" : "没有登录信息，请先登录",
          }
        const username = usernameOf(token)
        if (!username) return { outcome: "failed", message: "令牌里没有账号名，请粘贴科搭登录后的完整令牌" }
        if (expired(token)) return { outcome: "failed", message: "登录已过期，请重新登录" }

        const deadline = Date.now() + CHECKIN_BUDGET_MS
        const left = () => Math.max(1000, deadline - Date.now())

        // 领之前的点数：服务端的成功应答只说「领到了」，不说领到多少；
        // 差额是唯一能如实报出来的数。读不到就不报 credit，而不是报 0。
        let before = null
        try {
          before = await pointsOf(token, username, { fetchImpl, timeoutMs: Math.min(TIMEOUT_MS, left()) })
        } catch {
          before = null
        }

        let r
        try {
          r = await request(`${ACCOUNT}${SIGN_PATH}`, {
            method: "POST",
            body: { username },
            token,
            fetchImpl,
            timeoutMs: Math.min(TIMEOUT_MS, left()),
          })
        } catch (e) {
          if (signedOut(e)) return { outcome: "failed", message: "登录已过期，请重新登录" }
          return { outcome: "failed", message: scrub(whyOf(e), token) || "签到失败" }
        }

        const code = Number(r?.code)
        // 成功的判据与厂商客户端一致（app.asar 的 nRe 只调 Jo）：数字码不是
        // 200 才算拒绝，没带 code 的应答算领到了——今天的成功应答带 code:200，
        // 但这个厂商的活动接口就是不带 code 的（只有 {data,message,success}），
        // 签到哪天也这样省掉，只认 200 会把「领到了」报成失败。
        //
        // 「今天已领过」：厂商用这句话说这一天已经领了。它说的是「今天」，
        // 不是「这一次」，所以未必带 code：带 400 是它今天的写法，不带 code
        //（活动接口就是这种形状）也是同一句话。文案按客户端的读法（saidBy，
        // 8 拼写）取。这句要先算：它是对「这一天」的陈述，比下面任何一个
        // 「这一次」的旗标都更能决定 outcome（见 success:false 那段）。
        const said = signMessage(r, token)
        const already = ALREADY_CLAIMED.test(said) && (code === 400 || !Number.isFinite(code))
        // 只有一处不听客户端的：应答自己说 `success: false`（厂商在活动接口
        // 上用的就是这个旗标）时算失败，无论带没带 code——code:200 配
        // success:false 正是「HTTP 层说好、业务层说不」。**但不压过「已领
        // 过」**：厂商带 400、文案写着「24小时内仅可领取一次」、又顺手带个
        // success:false 时，这一天确实是领到了，这一次调用也确实「没成」，
        // 两句都对。读成 failed 的代价在这一侧更大——magpie 会把失败当天
        // 每 30 分钟重问一遍（workbuddy_checkin.go 的 wbCheckinRetry），
        // 卡片还一直写「签到失败」；而读成 done 只是把厂商说出的那个时刻
        // 记下来。拒绝时不读余额算 credit——那是给一次真领到算的。
        if (r?.success === false && !already) return { outcome: "failed", message: said || `签到失败（code ${code || "?"}）` }
        // 401/403 是登录过期，说给用户看的是「重新登录」，而不是一个码。
        if (code === 401 || code === 403) return { outcome: "failed", message: "登录已过期，请重新登录" }
        // 码说的拒绝，且消息不是「已领过」：厂商客户端只把非 200 的数当失败。
        if (Number.isFinite(code) && code !== 200 && !already) return { outcome: "failed", message: said || `签到失败（code ${code}）` }
        if (already) {
          // until 是 magpie 0.1.1795 起的契约（"a plugin's until is when its
          // answer stops holding"，v0.1.1795 首发；README 里早先写的 0.1.1862
          // 是首次核对时看错的版本）：签到答案什么时候失效、下次何时该再问。
          // 科搭是滚动 24 小时，retry_after 正好就是那一刻；报上去以后 magpie
          // 不会在中午前每 30 分钟重问一遍（每次都是一次签到 + 两次点数读取）。
          // 厂商没给秒数（或给了 0）时不能不给 until：宿主把「done 且没有
          // until」当成当天已结算，一整天不再问——滚动 24 小时的窗口就会
          // 漏掉下一次可领。给一个 30 分钟的保质期：这只是「这个答案我们
          // 信多久」，不是替厂商编一个可领时刻；最坏也就是回到 until 之前
          // 的每 30 分钟问一次。
          // 秒数先说得出、再说信多久：日历写不出的数（1e308 乘 1000 溢出成
          // Infinity）和滚动 24 小时窗口产不出的数（1e9 秒是 31 年）都不是
          // 「可信的时刻」，和厂商没说一样落到 30 分钟的保质期；照单全收会
          // 把这一天结清到 2058 年。见 checkinWaitSecs。
          const secs = checkinWaitSecs(r?.data?.retry_after)
          const wait = secs ? humanSecs(secs) : ""
          const waitSecs = secs || 30 * 60
          const hold = safeTime(Date.now() + waitSecs * 1000)
          return {
            outcome: "done",
            message: `今天已领过${wait ? `，${wait}后可再领` : ""}`,
            // hold 恒为非零（上面已夹过），留着这个条件是给读的人看：这条
            // 路径上「没有 until」是不可接受的，真出现就不带，而不是报 0
            // 让宿主画成 1970 年。
            ...(hold ? { until: hold } : {}),
          }
        }
        // 到这里只有两种形状：code:200，或干脆没给 code（厂商的客户端把后者
        // 也算成功）。两者都是一次真领到：读余额算 credit（两处之差，只算不减
        // 的部分）。活着读到多少报多少，读不到就不报，不要编 0。
        let credit = 0
        try {
          const after = await pointsOf(token, username, { fetchImpl, timeoutMs: Math.min(TIMEOUT_MS, left()) })
          // 两处余额都算：厂商只说过「签到领取点数奖励」，没说奖励落在通用
          // 点数还是 Agent 点数——只算前者会把落在后者上的奖励报成 0。每一
          // 处只在不减时计入（减少是花掉，不是这次领到），两处之和才是这次
          // 签到真给账号加上的数。任一处读不到就不报，credit 留 0。
          credit = gain(before?.general, after?.general) + gain(before?.agent, after?.agent)
        } catch {
          // 差额读不到就不报，credit 留 0
        }
        return { outcome: "claimed", credit, message: signMessage(r, token) || "签到成功" }
      },

      // 用量：点数余额 + 今日签到状态 + 免费模型活动（拿不到就不报）。
      async usage(getAuth) {
        let auth, token
        try {
          auth = await getAuth()
          token = tokenOf(auth)
        } catch (e) {
          return { error: scrub(whyOf(e), token) || "用量查询失败", signIn: signedOut(e) ? "expired" : "" }
        }
        if (!token)
          return { error: unusableKey(auth) ? "令牌内容无法识别（含空格、换行或非 ASCII 字符），请重新登录" : "没有登录信息，请先登录" }
        const username = usernameOf(token)
        if (!username) return { error: "令牌里没有账号名，请重新登录" }
        if (expired(token)) return { error: "登录已过期，请重新登录", signIn: "expired" }

        const deadline = Date.now() + USAGE_BUDGET_MS
        const left = () => Math.max(1000, deadline - Date.now())
        const opts = () => ({ fetchImpl, timeoutMs: Math.min(TIMEOUT_MS, left()) })

        // 三处读取互不依赖，一起发：卡片等最慢的那个，而不是三个之和。点数
        // 读不到整张卡就是错的（余额是主项）；另两个是附加信息，读不到就不报。
        const [pointsR, statusR, actsR] = await Promise.allSettled([
          pointsOf(token, username, opts()),
          request(`${ACCOUNT}${SIGN_STATUS_PATH}`, { method: "POST", body: { username }, token, ...opts() }),
          request(`${API}${ACTIVITIES_PATH}`, { method: "GET", token, ...opts() }),
        ])

        if (pointsR.status === "rejected") {
          const e = pointsR.reason
          return { error: scrub(whyOf(e), token) || "点数查询失败", signIn: signedOut(e) ? "expired" : "" }
        }
        const points = pointsR.value

        const windows = []

        // 今日签到：明天这个时候能再领一次。等待结束时（retry_after 0）这
        // 一行也要在——那正是"现在可以领"的时刻，旧写法 retry > 0 会让它消失。
        // 不带 used：签到不是一份会用完的额度，magpie 的 plugin_usage.go 把
        // 没有份额的 aside 行标成 Text（它自己的注释也拿「每日签到」当例子），
        // 不会画成一个 100% 的进度条。
        //
        // 状态按厂商 App 自己的读法（app.asar 的 ayt）：data 可以是那个布尔，
        // 也可以是写着它的对象（四种写法）；两种形状都画这一行，其余形状不画。
        // 先过它的 code 关：厂商调状态接口时也是先 Jo（数字码不是 200 就当
        // 失败），再 ayt 读应答。只认 data 的话，{code: 500, data:{isSigned:
        // false}} 会被画成「现在可以领」——厂商自己这时只会说查询失败。
        // 这一行是附加信息，画不出来就不画，卡片照报点数。
        const status = statusR.status === "fulfilled" ? statusR.value : null
        const statusCode = Number(status?.code)
        const data = Number.isFinite(statusCode) && statusCode !== 200 ? undefined : status?.data
        if (typeof data === "boolean" || (data && typeof data === "object")) {
          const signed = signedIn(data)
          // 秒数先说得出、再在签到说得出的范围内：说不出的（没给、给了 0、
          // 大到日历写不出——1e308 乘 1000 溢出成 Infinity，safeTime 给 0）
          // 就没有可报的时刻，文案和 resetsAt 一起省掉。宿主的 when(0) 会把
          // 0 画成 1970-01-01，而不是当成「没说」。见 checkinWaitSecs。
          const secs = checkinWaitSecs(typeof data === "object" ? data.retry_after : undefined)
          const wait = secs ? humanSecs(secs) : ""
          windows.push({
            name: "每日签到",
            ...(secs ? { resetsAt: safeTime(Date.now() + secs * 1000) } : {}),
            display: signed ? (wait ? `今天已领，${wait}后可再领` : "今天已领") : wait ? `今天还没领，${wait}后可以领` : "今天还没领，现在可以领",
            aside: true,
          })
        }

        // 点数余额：账号真正会花掉的东西。它是一个预付钱包，没有「总额」可
        // 以取份额，所以按钱包读数（balance，magpie 的 #3950）报，而不是编
        // 一个百分比。magpie 靠它把这个账号从「剩余额度未知」变成已知：路由
        // 页会直接说还剩多少点，而不是把账号排到已知的之后。它不按模型划范围
        // ——活动期的免费模型眼下不花点数，活动一结束就花，而点数归零时
        // magpie 只是把账号排到最后（spent），不是拒绝它。
        // 窗口上的 balance 要宿主和 magpie 都认（magpie 0.1.1790 起，issue
        // #3950；早期注释里的 0.1.1822 是核对时记错的版本）；旧版（如
        // 0.1.1788）只把它当文字行显示，读数不丢，路由暂仍未知。
        if (points.general != null) {
          windows.push({
            name: "点数余额",
            balance: points.general,
            unit: "点",
            display: `${points.general} 点`,
          })
        }

        // 免费模型活动：免费到什么时候，以及厂商给了总额时的用量。
        // remaining_quota 是 null 表示不限量——用不完，也就没有一个能如实
        // 报出的份额，宿主会把它当文字行显示。user_quota_limit 是这次活动给
        // 的总额，有总额时 amount/limit 才是「已用 / 总额」两个真数，而不是
        // 拿剩余数当总额报。aside 表示「用完了也不停账号」：活动用完只是回到
        // 按点数计费，账号照常可用。
        //
        // 窗口上不发 models：aside 窗口不进路由（magpie 的 allowanceOf 先跳过
        // aside/text），GUI 也没有这个字段可画；而宿主一旦在任一窗口上看到
        // models，就把整张卡排除在 quotas.json 之外（quota_last.go 的
        // keepLast，"a pool that can't be written down isn't kept"），账号就
        // 失去了跨重启的「上次读数」。模型名已经在窗口名里了。
        if (actsR.status === "fulfilled") {
          const running = runningActivities(actsR.value)
          // 卡片只画得下几行，而这段答案要变成宿主的一行 JSON：厂商一次
          // 报太多活动时只取前几个，不能让数据把宿主的 32 MiB 行撑爆。
          for (const a of running.slice(0, MAX_ACTIVITY_WINDOWS)) {
            const ids = Array.isArray(a.model_ids) ? a.model_ids.filter((x) => typeof x === "string" && x).map(cleanText) : []
            // 两个数都要有限：1e999 是合法的 JSON，读出来却是 Infinity，
            // 拿去算份额会得到 NaN，卡片上就写「已用 Infinity / Infinity」。
            const cap = typeof a.user_quota_limit === "number" && isFinite(a.user_quota_limit) && a.user_quota_limit > 0 ? a.user_quota_limit : null
            const left = typeof a.remaining_quota === "number" && isFinite(a.remaining_quota) ? a.remaining_quota : null
            // 「已用」只在两个数都在、且互相说得通时才算得出来：剩下比总额还多，
            // 是两个数在说两件事（厂商报的是池子，不是这次活动），相减只会造出
            // 一个 0，卡片写「已用 0 / 100」而厂商说还剩 150——不如把剩下的照说。
            const used = cap != null && left != null && left <= cap ? cap - left : null
            const share = used != null && cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0
            // 活动的结束时间（也是秒数）读不出来就不带 resetsAt：活动
            // 本身照报——它确实在跑，只是没说何时结束。见 sayableSecs。
            const freeUntil = safeTime(sayableSecs(a.free_until) * 1000)
            windows.push({
              name: ids.length ? `免费模型 · ${ids.slice(0, 2).join("、")}${ids.length > 2 ? ` 等 ${ids.length} 个` : ""}` : "免费模型",
              used: share,
              ...(freeUntil ? { resetsAt: freeUntil } : {}),
              // 说得出总额就说总额：remaining_quota 没给，不代表活动「不限量」
              // ——厂商的 user_quota_limit 白纸黑字写了多少。只有两个数都没有
              // 时才是「不限量」（今天的线上形状）。
              display: left == null ? (cap == null ? "免费使用中（不限量）" : `免费使用中，共 ${cap}`) : used == null ? `免费使用中，还剩 ${left}` : `免费使用中，已用 ${used} / ${cap}`,
              ...(used != null ? { amount: used, limit: cap } : {}),
              aside: true,
            })
          }
        }

        const parts = []
        if (points.general != null) parts.push(`${points.general} 点`)
        if (points.agent != null) parts.push(`Agent ${points.agent} 点`)
        return {
          user: cleanText(username),
          balance: parts.length ? `${parts.join(" · ")} 可用` : "",
          windows,
        }
      },
    },

    // provider: 目录随账号刷新。拿不到就用 config 里那份（catalog.mjs）。
    //
    // 宿主给的是整个 provider（模型表在它的 .models 下），要回去的也只是那张
    // 表：host.js 把钩子的返回值直接当 models 用，拿整个 provider 回去，它会
    // 把 id/name/api 这些字段当成模型列出来（实测：过期令牌下 16 个变 26 个，
    // 多出 searches、models 两个）。
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const given = provider?.models ?? {}
        const token = tokenOf(auth)
        if (!token || expired(token)) return given
        try {
          // 目录是 App 的 Electron 主进程去读的（main.cjs 的 auth-request
          // 白名单里有 /v1/codar/models），走 Node 的默认 UA；Go UA 只用在
          // 对话上（侧车发的）。
          const body = await request(`${API}${CATALOG_PATH}`, { method: "GET", token, fetchImpl })
          const list = catalogOf(body)
          if (!list) return Object.assign(given, { [Symbol.for("magpie.fellBack")]: true })
          // 厂商哪天在目录里说了并发数，就按它排队（见上面 vendorConcurrency）
          vendorConcurrency = publishedConcurrency(body)
          // 厂商的目录对自家的模型说了算；用户自己往这个供应商里加的条目
          // （内嵌目录里没有的 id）在刷新后留着，config 钩子也是这么合并的。
          // 每个模型去哪发，沿用宿主已经解析好的地址（用户设过的 api，可能是
          // 自建代理），见 apiBase。
          const known = new Set(CATALOG.map((m) => m.id))
          const own = Object.fromEntries(Object.entries(given).filter(([id]) => !known.has(id)))
          // 厂商目录里若有 id 叫 `__proto__` 的记录，它在 fromEntries/spread 之后
          // 是自有键（不污染这张表本身），但宿主拿到这份列表的下一步是
          // `out.models[key] = …` 的方括号赋值——那句写的是原型。没有这种模型，
          // 丢掉不损失什么（见 noMagicKeys）。
          return noMagicKeys({ ...own, ...modelsOf(list, (id) => apiBase(provider, id)) })
        } catch {
          return Object.assign(given, { [Symbol.for("magpie.fellBack")]: true })
        }
      },
    },

    // 聊天请求的请求头：桌面端侧车是 Go 客户端，只多一个 UA。这里补上同一个，
    // 让网关看到的客户端与 App 自己一致。
    //
    // 这个钩子会被用在**每个**供应商的请求上（host.js 只按「是不是函数」筛，
    // 不按供应商；qoder 插件的注释也说 "Every plugin's hook sees every
    // provider's requests"）。不改自己供应商的，就别动别人的头。
    "chat.headers": async (input, out) => {
      const owner = input?.model?.providerID ?? input?.provider?.info?.id
      if (owner !== ID) return
      out.headers["User-Agent"] = UA_SIDECAR
    },

    // 用户自己改过的名字留着：magpie 把 provider 的名字存在 providers.json
    // 里，而 config 钩子在每次启动时都跑——无条件写回默认值会把 UI 里的改名
    // 悄悄撤销。供应商级的 npm/api 同理：用户可能把它们指向自己的代理，覆盖
    // 掉等于每次启动都把人家的设置改回去。值不是对象时当作没有，其余字段照旧
    // 原样带过。
    //
    // models 按 id 逐条合并，不是整条替换：用户只改一个模型的某个字段时，
    // 剩下的字段（尤其是 provider.npm）还得在——少了它，宿主给这个模型解析
    // 出供应商级的 openai-compatible，Claude 模型就按 Chat 协议发了。合并
    // 深入到嵌套对象（见 mergeModel）：只设 provider.api 也不会带走 npm。
    async config(config) {
      // 宿主给的 config 本该是 {provider:{…}}，但配错的文件里 provider 可能是
      // 字符串或数字：往字符串上写属性会抛 TypeError，整个钩子失败、这个供应
      // 商在启动时就不存在了。不是对象（含数组——数组上写具名属性
      // JSON.stringify 会丢掉）就换一个空的，别的钩子照常拿到它们那份。
      if (!config.provider || typeof config.provider !== "object" || Array.isArray(config.provider)) config.provider = {}
      // 供应商条目同理：数组也是「对象」，但具名字段写上去会被 JSON.stringify 丢掉，
      // 索引键（"0"、"1"）反而会留在用户的配置文件里。
      const was = config.provider[ID] && typeof config.provider[ID] === "object" && !Array.isArray(config.provider[ID]) ? config.provider[ID] : {}
      // 每条的 api.url 写用户设过的那个地址（他自己可能指着自建代理），
      // 否则写厂商网关：写进 config 的就是真话——宿主在那条路径上本来
      // 也取 cfg.api（见 apiBase 的注释），这里只是不让文件里留一个与
      // 供应商级 api 不一致的地址。地址按 baseURL 正规化，和 live 路径同一条
      // 规则：宿主在 config 路径上拼请求用的就是这份 cfg.api（models 钩子
      // 不刷新时——没登录、令牌过期——它原样返回，这张表就是请求用的那份），
      // 留着 ".../v1//" 或首尾空白，拼出来的就是 ".../v1//chat/completions"。
      const api = baseURL(was.api)
      const models = modelsOf(CATALOG, api)
      // models 本身不是对象（数组也是「对象」，但按 id 读不出模型）时当作没有。
      const own = was.models && typeof was.models === "object" && !Array.isArray(was.models) ? was.models : {}
      // 展开会把目录里同名的自有键（`__proto__`）一并带过来——spread 用的是
      // CreateDataProperty，键是自有键、原型不动，于是 `merged` 上就多了一条
      // 名叫 `__proto__` 的模型。宿主读这张表时走 `out.models[key] = …` 的方括号
      // 赋值，那一句写的才是原型（见 mergeModel 的注释、models 钩子的兄弟入口）。
      // 目录是我们自己的文件，今天没有这种 id；留着这一道是重新生成目录的那天
      // 也不会有。
      const merged = noMagicKeys({ ...models })
      for (const [id, m] of Object.entries(own)) {
        // 不是对象的条目不是模型：宿主建供应商信息时把所有模型逐条展开
        // （host.js 的 info，读 m.id/m.provider），其中一个 null 就抛异常，
        // 整个 RPC 失败——所有供应商都从列表里消失，而不只是丢掉这一条。
        // 数组也是对象，但同样不是模型，一并丢掉。
        if (!m || typeof m !== "object" || Array.isArray(m)) continue
        // id 是 JSON 里手写的键，也可能是 `__proto__`：`merged["__proto__"] = m`
        // 写的是这张模型表的原型，不是一条模型——第七轮在 mergeModel 里挡住了
        // 模型字段同名的键，这里是它的兄弟入口（合并发生在模型的上一层）。
        // 没有模型叫这些名字，丢掉不损失什么。
        if (MAGIC_KEYS.has(id)) continue
        merged[id] = models[id] ? mergeModel(models[id], m) : m
      }
      config.provider[ID] = {
        ...was,
        name: typeof was.name === "string" && was.name ? was.name : "科搭 Codar",
        npm: typeof was.npm === "string" && was.npm ? was.npm : OPENAI,
        api,
        models: merged,
      }
    },
  }
}

export const testables = { tokenOf, usernameOf, payloadOf, expiresAt, modelOf, catalogOf, mergeModel, publishedConcurrency, humanSecs, request, appToken, configPath, cleanText, magicKeys: MAGIC_KEYS }

export default CodarPlugin
