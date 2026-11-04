// The plugin's internal readers, kept out of index.mjs on purpose.
//
// OpenCode 1.x takes every export of the entry module for a plugin and
// refuses the package when one is not — and magpie runs OpenCode's provider
// plugins. The test hooks (the `testables` object) are an export, so they
// live here and index.mjs imports from this file; the entry module exports
// only the plugin function. Nothing here is a plugin entry: magpie never
// loads this file directly.

import { CATALOG } from "./catalog.mjs"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"

export const ID = "codar"

// 对话与目录走 claw 网关，账号、签到、点数走 kuaipaper。桌面端也是这么分的：
// main.cjs 里 target "speedai" 走前者，其余 /v1/ 走后者。
export const API = "https://api.claw.speedai.com"
export const ACCOUNT = "https://api.kuaipaper.com"

export const CATALOG_PATH = "/v1/codar/models"
export const ACTIVITIES_PATH = "/api/codar/activities/mine"
export const SIGN_PATH = "/v1/daily-sign"
export const SIGN_STATUS_PATH = "/v1/daily-sign/status"
export const POINTS_PATH = "/v1/gettoken"
export const AGENT_POINTS_PATH = "/v1/agent/balance"

// 桌面端两条链路各发各的 User-Agent，插件按接口分开对齐：
//   - 对话走 Go 侧车 → "Go-http-client/1.1"（实测抓包）
//   - 模型目录、账号、签到、点数、活动走 Electron 主进程的 fetch → "node"
//     （Node fetch 的默认值；主进程的 auth-request 自己不加 UA）
// 目标是让请求和 App 自己的流量同形，而不是一个陌生的客户端。
export const UA_SIDECAR = "Go-http-client/1.1"
export const UA_DESKTOP = "node"

// 时间：magpie 的 Go 侧给一次用量读取 20 秒（plugin_usage.go 的
// context.WithTimeout），给一次签到 2 分钟（workbuddy_checkin.go）。插件的
// 超时要先到：宿主先掐断的话，卡片上是宿主的超时，而不是插件自己的「请求
// 超时」。
//
// 那 20 秒不止包住这个钩子：宿主在调它之前先跑 fresh() 和 infoOf()，而
// infoOf 在缓存冷的时候会跑一遍 models 钩子（host.js 的 info() 没给 limit
// 时没有时限），插件的用量预算从钩子内部才起算，管不到这一段。所以用量钩子
// 的最坏耗时必须留得下这 8 秒：四条读数（两条余额 + 签到状态 + 活动）在同一
// 瞬间发出，最坏是一个 TIMEOUT_MS，而不是两个。厂商自己的客户端也是这么发
// 的（app.asar 的 S0 用 allSettled 跑 /v1/gettoken、/v1/agent/balance、
// /api/user/self）；串行再补一次会把最坏值翻倍——8 秒前置加 16 秒钩子就顶破
// 了 20 秒，卡片上会是宿主的截止时间而不是插件的话。
//
// 签到三次串行，最坏是三个 TIMEOUT_MS（25 秒预算，宿主的 2 分钟也留得下）。
// 预算是总上限，单次超时取 min(TIMEOUT_MS, 预算剩下的)，预算先用完时后面的
// 请求只剩 1 秒。测试不读这几个常量，而是从 request() 真正设过的定时器上量
// 每个请求拿到的超时值，所以「某条路改用别的数」会被抓住。
//
// 用量那四路是同一瞬间发的（Promise.allSettled 的数组字面量里连着取四次
// opts()，中间没有 await），所以 left() 今天永远取到整个 TIMEOUT_MS——用量这
// 条路上的预算和 1 秒下限都夹不到谁，它们是天花板，不是会被走到的分支（把
// 下限改成 0 也一样全绿，不是漏测）。这条路上真正要钉的是「四路各拿到那个
// cap」，测试从 request() 设过的定时器上量。真正用到「预算剩下的」是签到的
// 串行三问：前一次读得慢，后面的就只剩小的那份，最少 1 秒。
export const TIMEOUT_MS = 8000
export const CHECKIN_BUDGET_MS = 25 * 1000
export const USAGE_BUDGET_MS = 18 * 1000
export const HOST_USAGE_DEADLINE_MS = 20 * 1000
export const HOST_CHECKIN_DEADLINE_MS = 120 * 1000

// MAX_TIME_MS is the largest time that survives the whole trip to magpie.
// Two ceilings matter, and the lower one wins: JS's Date.toISOString() throws
// past 8.64e15 ("Invalid time value"), and magpie's own side parses the ISO
// string with Go's RFC3339 layout, which has four year digits — a "+275760-…"
// string parses to zero and the time is dropped in silence. 253402300799999
// is 9999-12-31T23:59:59.999Z, the last instant both accept.
export const MAX_TIME_MS = 253402300799999

// safeTime is a stated number of milliseconds when it is a time magpie can
// read (see MAX_TIME_MS), and 0 — "not stated" — when it is not: not a
// number, not positive, or past the last instant both ends accept. A time
// past the calendar is not clamped to it: 9999-12-31 is not a moment the
// vendor stated, and rounding an unwritable time to a wrong one is what
// every other field here refuses to do. 0 is what makes the caller leave the
// field out — and what keeps the host's `new Date(ms).toISOString()` from
// throwing RangeError on a "+275760-…". Each caller bounds the wait first
// (secsOf and the per-window caps), so this is the last gate, not the first.
export const safeTime = (ms) => {
  const n = Number(ms)
  return isFinite(n) && n > 0 && n <= MAX_TIME_MS ? n : 0
}

// MAX_WAIT_SECS is the longest wait a card can say: a wait past the last time
// magpie can read (year 9999). humanSecs says one past it as nothing —
// "1.1574074074074072e+303 天后" is not a thing a card says — and the seconds
// the plugin hands it are already bounded by that window's own cap.
export const MAX_WAIT_SECS = MAX_TIME_MS / 1000

// numOf is a vendor field as a number, read the way its own client reads one
// (app.asar's Po): a number, or a string that says one. A boolean, an array
// or an object is not one — Number(true) is 1 and Number([3600]) is 3600, and
// a made-up second is a made-up wait. NaN when there is no number.
export const numOf = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN)

// plain is a value that is a map: an object, but not an array (an array is
// an object too, and writing a named field on it would be JSON.stringify'd
// away) and not null. What the host builds a config model from, and what a
// vendor record has to be to be read field by field.
export const plain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v)

// secsOf is a vendor field as a number of seconds, or 0 — "not stated" — when
// it is not one: a value that is not a number (numOf), a zero, or a negative.
// A zero reads as "not stated" because a window with no wait is drawn in its
// own words ("现在可以领"), not as a time. What a particular window will trust
// is not this function's business: the check-in caps a wait at a week
// (checkinWaitSecs), and every time goes through safeTime before a card sees
// it — a number past the calendar comes out of there as 0, not as year 9999.
export const secsOf = (v) => {
  const n = numOf(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// MAX_CHECKIN_WAIT_SECS is the longest wait the daily check-in can name.
// Codar's day is a rolling 24 hours (measured retry_after ≈ 23 h), so a wait
// past a week is not a next-claim time that window can produce. Trusting it
// would settle the check-in for as long as the vendor's number says — 1e9
// seconds is 31 years, and magpie would not ask again until 2058 — so such a
// number is treated as one we cannot use, like a missing one.
export const MAX_CHECKIN_WAIT_SECS = 7 * 24 * 3600
export const checkinWaitSecs = (v) => {
  const n = secsOf(v)
  return n > 0 && n <= MAX_CHECKIN_WAIT_SECS ? n : 0
}

// ALREADY_CLAIMED is how the vendor words "this day is already claimed": its
// 400 says 24小时内仅可领取一次, and the same words on an answer that names no
// code mean the same thing. Its answers come back in English too (the status
// endpoint's "Already signed" is one), so both languages are read here, and
// the pairing in the check-in (a 400 beside a readable retry_after) covers a
// wording this list has never seen.
export const ALREADY_CLAIMED = /24\s*小时|仅可领取一次|once\s+(?:every|in|per)\s+(?:a\s+)?(?:24\s*(?:hours?|h)|day)|already\s+(?:claimed|signed|checked)/i

// MAX_SCRUB_CHARS is how much of a vendor's string the cleaners look at.
// cleanText and scrubLine both run global regexes over vendor text, and V8's
// engine recurses while matching them: measured 2026-11-03, an 8 MB run of
// "eyJ"+"a " (or of one long word, or of a bare HS256 signature) throws
// RangeError "Maximum call stack size exceeded" out of the usage hook, and an
// 8 MB name of newlines or control characters took 2.5 s to fold. The same
// text clipped to 8k runs in about a millisecond. A card shows 120 characters
// and a 400-character message; 8k leaves room for a vendor that pads its
// prose, and a credential a server quotes back sits where its message is.
export const MAX_SCRUB_CHARS = 8192

// MAX_MODELS is how many models one vendor catalog may bring back. The host
// passes a hook's answer to Go as a single JSON line and kills the whole
// plugin host — every plugin in it — when that line passes 32 MiB
// (host.go's maxWireLine); an unbounded list is a way for a vendor to take
// the host down with data rather than with a bug. Codar lists 17.
//
// The same number bounds the entries catalogOf looks at, not just the ones it
// keeps: with the cap on kept records only, a list whose every record is
// malformed — a shape the vendor could send by accident — was walked to the
// end, entry by entry, for nothing. Every real catalog is far below this.
export const MAX_MODELS = 2000

// MAX_ACTIVITY_WINDOWS is how many free-model activities go on the card.
// The same wire limit applies to the usage answer, and the card has room for
// a handful of rows; Codar has run at most two activities at a time.
export const MAX_ACTIVITY_WINDOWS = 20

export const CLAUDE = "@ai-sdk/anthropic"
export const OPENAI = "@ai-sdk/openai-compatible"

// tokenOf is the key this sign-in carries, or "" when there is none or it is
// not one we can send. A key with anything but visible ASCII in it would put
// the whole value into a fetch error message ("…is an invalid header value"),
// which magpie logs and shows; it is refused here, before it can be echoed.
export const tokenOf = (auth) => {
  const token = auth?.type === "api" ? String(auth.key ?? "").trim() : ""
  return token && /^[\x21-\x7e]+$/.test(token) ? token : ""
}
// unusableKey is a key that is there but cannot be sent: a missing one is a
// different answer, and telling the user to "sign in again" for an empty one
// sends them to the wrong place.
export const unusableKey = (auth) => Boolean(String(auth?.key ?? "").trim()) && !tokenOf(auth)

// payloadOf is a JWT's claims, or null when the string is not one. No
// verification: the vendor is the one that checks the signature; we read it
// for the account name and the expiry the token itself carries.
export function payloadOf(token) {
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

export const usernameOf = (token) => {
  const u = payloadOf(token)?.username
  return typeof u === "string" ? u : ""
}

// expSeconds is a token's exp as the vendor's client reads it (app.asar's
// Zh): a number, or a string that says one; NaN when it states none.
export const expSeconds = (token) => numOf(payloadOf(token)?.exp)

// expiresAt is when the token says it runs out (ms), or 0 when it says
// nothing. A token past it is not sent: every endpoint would answer 401 and
// the card would say "check-in failed" instead of "sign in again". The exp
// is read the way the vendor's client reads it (app.asar's Po): a number,
// or a string that says one — a string exp read as "no expiry" would send a
// token the vendor already counts as expired, and the card would say the
// check-in failed instead of asking to sign in again.
// A stated exp of 0 is the epoch, not "says nothing": it is a time that has
// passed, so it is handed back as a time (and read as expired). That is why
// the reading is "> 0" and not ">= 0" — 0 is both a real instant and the
// value expiresAt uses for "not stated", and only the sign tells them apart.
export function expiresAt(token) {
  const n = expSeconds(token)
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

// expired says whether the token has run out, as that same client decides
// (app.asar's Zh: `i*1e3 - t <= 0 ? "expired"`): a stated exp in the past is
// expired — the instant itself included, hence `>=` — while a token that
// states no exp is not declared expired here (that client calls it "unknown",
// and the vendor is the one to answer). A stated exp of 0 is the epoch, so it
// is expired; that is the one case the "0 means not stated" reading of
// expiresAt could not tell apart, which is why this function reads the claims
// itself rather than asking expiresAt.
export const expired = (token) => {
  const n = expSeconds(token)
  return Number.isFinite(n) && Date.now() >= n * 1000
}

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

export const signedOut = (e) => e?.status === 401 || e?.status === 403

// whyOf is the message to show for an error, without the token it might name.
export const whyOf = (e) => (e instanceof Error ? e.message : String(e ?? ""))

// controlChars would break a card's line, reorder what follows it, or ride
// along invisibly: a vendor string is shown as one line, never as a control
// sequence. C0 and C1 controls, the zero-width marks, the bidi overrides and
// isolates (a right-to-left override reverses the text after it), the line
// and paragraph separators, a byte-order mark.
export const controlChars =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g

// cut is a string clipped to at most n code points: never longer than the card
// reads, and never ending in half a character. The length check is the UTF-16
// one first — when that already fits, no cut is needed and the array work is
// skipped — then the clip walks code points, so a string that ends on an emoji
// is not broken into a lone surrogate (JSON.stringify writes one as \ud83d and
// the host's decoder reads it as U+FFFD). A vendor name and a vendor message
// both come through here, so they break at the same place.
//
// The walk is over s.slice(0, 2 * n), not the whole string: n code points take
// at most 2n UTF-16 units, so nothing that belongs in the answer is past 2n,
// and a vendor's 8 MB sentence costs a 2n-unit array rather than an 8M-entry
// one (measured before this: 156 ms and 76 MB of heap for 8 MB). A surrogate
// pair straddling the 2n boundary becomes a lone surrogate — always after the
// n code points taken, so it never reaches the answer.
export const cut = (s, n) => (s.length <= n ? s : Array.from(s.slice(0, 2 * n)).slice(0, n).join(""))

// cleanText is a vendor string as a card can show it: control characters
// out, one line (runs of spaces folded), and never longer than a card reads.
// Only the first MAX_SCRUB_CHARS characters are cleaned: a card shows 120,
// and folding the runs of a multi-megabyte name cost seconds in a host every
// plugin shares (measured 2026-11-03: 2.5 s for an 8 MB name of newlines and
// control characters). The cut below drops the rest anyway, so the tail is
// never read — a 120-character answer needs at most 120 characters of input
// plus whatever folding removes, and 8k leaves room for a vendor that pads.
export const cleanText = (s) => cut(String(s).slice(0, MAX_SCRUB_CHARS).replace(controlChars, " ").replace(/\s{2,}/g, " ").trim(), 120)

// jwtShape is a credential as a server might quote it back. Every Codar token
// is a JWT, and every JWT segment is base64url. A server can wrap the token
// at any column or insert whitespace anywhere in the message; the shape must
// match both intact tokens and the same token split with spaces/newlines.
//
// The first alternative is the token itself: an eyJ-started segment, then
// dot-separated segments, whitespace allowed inside either (so the whole
// token cuts regardless of where lines were inserted). The second is the same
// token with its eyJ head eaten — a message that swallowed the first letter
// ("…ror: bGciOiJIUzI1NiJ9.eyJzdWIi…") still leaves a usable credential, and
// it is dot-separated base64url just the same; the 16-character floor on both
// segments keeps host names and file names out of it. The third is a
// signature segment quoted on its own: 40+ base64url characters (a HS256
// signature is 43) carrying an upper case, a lower case and a digit, which
// words and all-lowercase hex hashes do not. A real JWT requires two dots; we
// allow 1–2 extra segments for safety, and prose that happens to fit these
// shapes will be cut too — acceptable in an error message, where failing
// closed (removing more rather than less) matters.
export const jwtShape =
  /eyJ[\w-]*(?:\s+[\w-]+)*(?:\s*\.\s*[\w-]+(?:\s+[\w-]+)*){0,2}|(?<![\w-])[\w-]{16,}(?:\s*\.\s*[\w-]{16,}){1,2}(?![\w-])|(?<![\w-])(?=[\w-]{40})(?=[\w-]{0,39}\d)(?=[\w-]{0,39}[A-Z])(?=[\w-]{0,39}[a-z])[\w-]{40,}(?![\w-])/g

// configPath is where the Codar app keeps its own config. The app takes
// CODAR_HOME over the home directory when it is set (its sidecar's
// `codar config path` says so), so the file is looked for in the same
// place the app would have written it — value verbatim, not trimmed:
// `CODAR_HOME="  /tmp/x  "` answers `  /tmp/x  /config.json` from the
// sidecar (measured against the installed app), so a plugin that trimmed
// would read a file the app never wrote. An empty value is the app's
// "not set" and falls back to ~/.codar.
export const configPath = () => {
  const home = String(process.env.CODAR_HOME ?? "")
  return join(home || join(homedir(), ".codar"), "config.json")
}

// shownPath is a local path as a sign-in message may say it: under the home
// directory the home part is written ~, so a dialog read off a screenshot or
// pasted into an issue carries no account name. Any other path is the user's
// own choice (CODAR_HOME, a test's temp dir) and is said as it is.
export const shownPath = (file) => {
  const home = homedir()
  if (!home) return file
  const rel = relative(home, file)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `~${sep}${rel}` : file
}

// appToken reads the token the Codar desktop app keeps, for the "read from
// this machine" sign-in: provider.speedai.token in ~/.codar/config.json
// (%USERPROFILE%\.codar\config.json on Windows, as the app's own docs say;
// on macOS/Linux the home directory is the same place). Read only — the file
// is the app's, and the plugin never writes it. A failure says why in words
// the sign-in dialog can show, since this runs where no card exists yet.
export function appToken(file = configPath()) {
  // 错误文案里写 ~/.codar/config.json 而不是本机完整路径：登录对话框会出现在
  // 截图、录屏和 issue 里，主目录那一段带着用户名。
  const shown = shownPath(file)
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch (e) {
    // 不存在和读不了是两回事：让人「先登录一次科搭」修不好权限问题，指过去
    // 只会白跑一趟。
    if (e?.code === "ENOENT") return { error: `没找到 ${shown}，先在这台机器上登录一次科搭，或改用「科搭访问令牌」粘贴` }
    return { error: `读不了 ${shown}（${e?.code ?? whyOf(e)}），检查文件权限后重试，或改用「科搭访问令牌」粘贴` }
  }
  let token = ""
  try {
    token = String(JSON.parse(text)?.provider?.speedai?.token ?? "").trim()
  } catch {
    return { error: `${shown} 读不出 JSON，可能损坏了；改用「科搭访问令牌」粘贴` }
  }
  if (!token) return { error: `${shown} 里没有 provider.speedai.token；先在这台机器上登录一次科搭，或改用粘贴` }
  if (!tokenOf({ type: "api", key: token })) return { error: `${shown} 里的令牌无法识别；改用「科搭访问令牌」粘贴` }
  // every call this plugin makes sends the account name from the token's
  // own claims; one without it would be saved and then fail on the card
  if (!usernameOf(token)) return { error: `${shown} 里的令牌没有账号名；打开一次科搭重新登录，或改用「科搭访问令牌」粘贴` }
  if (expired(token)) return { error: `${shown} 里的令牌已过期；打开一次科搭让它续期，再试一次` }
  return { token }
}

// saidBy is what an answer says in words, read the way the vendor's own client
// reads it (app.asar's vo): the first non-blank string among the top-level
// message/msg/error/detail and the same four under `data`. Read as `message`
// alone, a refusal the vendor spelled in `msg`, and an "already claimed" note
// under `data`, both came out as no text at all — the check-in then reported a
// failure where the day was simply already claimed, and the card dropped what
// the vendor said about every other refusal.
export const saidBy = (body) => {
  if (!body || typeof body !== "object") return ""
  const data = body.data && typeof body.data === "object" ? body.data : null
  for (const said of [body.message, body.msg, body.error, body.detail, data?.message, data?.msg, data?.error, data?.detail]) {
    if (typeof said === "string" && said.trim()) return said
  }
  return ""
}

// MAX_ANSWER_BYTES is how much of a vendor's answer request() reads before it
// gives up. Every endpoint this plugin calls answers in kilobytes (the whole
// catalog is tens of them); a body past this is not an answer we could use,
// and holding it costs the host — one process shared by every plugin — memory
// in the size of whatever the vendor sends. 8 MiB is ~200× the catalog.
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024

// readAnswer is a Response's body as text, refusing one larger than
// MAX_ANSWER_BYTES. The read goes through the body stream so the limit is
// applied while reading rather than after: res.text() holds the whole answer
// first, whatever its size. A Response that offers no stream (a stub in a
// test) falls back to text().
export const readAnswer = async (res) => {
  const stream = res.body
  if (!stream || typeof stream.getReader !== "function") return { text: await res.text() }
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_ANSWER_BYTES) {
      // telling the server to stop; an implementation that cannot is not a
      // reason to fail differently
      try {
        await reader.cancel()
      } catch {}
      throw new ApiError(`厂商应答超过 ${MAX_ANSWER_BYTES / 1024 / 1024} MB，已放弃`, 0)
    }
    chunks.push(value)
  }
  // decoded once, at the end: a chunk boundary can fall inside a multi-byte
  // character, and per-chunk decoding would turn it into U+FFFD
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return { text: new TextDecoder().decode(all) }
}

export async function request(url, { method = "GET", body, token, timeoutMs = TIMEOUT_MS, fetchImpl = fetch, ua = UA_DESKTOP } = {}) {
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
    const text = (await readAnswer(res)).text.replace(/^\uFEFF/, "")
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
export function humanSecs(secs) {
  const raw = numOf(secs)
  if (!isFinite(raw) || raw > MAX_WAIT_SECS) return ""
  // A positive wait under half a second rounds to 0, and the card read
  // "0 秒后可再领" — a window the vendor opened almost now, said as no wait
  // at all. Rounded up instead: retry_after 0.4 is said as "1 秒".
  const n = raw > 0 ? Math.max(1, Math.round(raw)) : 0
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

// balanceOf is a vendor field as a balance: a number, or a string that says
// one (numOf). A made-up 0 is a balance the account does not have — routing
// would read the account as spent. A negative is not a balance either: the
// host clamps a wallet reading to 0, so passing one on would put "-5 点" on
// the card beside a routing figure of 0.
export const balanceOf = (v) => {
  const n = numOf(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// pickOf reads each field by trying the vendor's own names in the order its
// client does (app.asar's Dn), and takes the first that says a balance.
export const pickOf = (body, names) => {
  for (const name of names) {
    const n = balanceOf(body?.[name])
    if (n != null) return n
  }
  return null
}

// unwrapped is the body the vendor's client reads: `data` when that is an
// object, the answer itself otherwise (app.asar's Gt). The live points body
// is flat ({code, token, agent_token, rewrite_token}); a wrapped one is what
// that client prefers if the vendor starts sending it.
export const unwrapped = (r) => (r?.data && typeof r.data === "object" ? r.data : r)

// GENERAL_POINTS_NAMES / AGENT_POINTS_NAMES are the names the vendor's own
// client reads each balance by (app.asar's am → Dn(n, […])); the live body
// says `token` and `agent_token`, and the rest are the spellings it hedges on.
export const GENERAL_POINTS_NAMES = ["token", "remaining_points", "points", "balance"]
export const AGENT_POINTS_NAMES = ["agent_token", "agentToken", "agent_points", "agentPoints"]

// pointsOf reads the account's two balances. `token` is the general points,
// `agent_token` the agent ones; both are integers the server keeps. A refusal
// comes back as HTTP 200 with a body code (measured 2026-10-27: {"code":401,
// "message":"Invalid token"}); left as "two fields we cannot read", the card
// came out blank with no error and no expired mark.
export const pointsOf = async (token, username, opts) => {
  const r = await request(`${ACCOUNT}${POINTS_PATH}`, { method: "POST", body: { username, token: 0 }, token, ...opts })
  // the vendor's own client (app.asar's ft) refuses any answer whose code is
  // a number other than 200 — Number(e.code) as it reads it — and only then
  // reads the balances. Only `>= 400` was refused here, so a refusal spelled
  // with a smaller code ({code: 1, token: 0}) read as a balance of 0 and the
  // card said the account was spent.
  //
  // numOf, not Number: Number({toString:1}) calls the object's toString and
  // Number({valueOf:…}) calls valueOf, so a vendor answering {"code":{…}}
  // threw out of the hook — no card, no message, just a failed read. numOf
  // reads only numbers and non-blank strings, and answers NaN for everything
  // else, which the isFinite guard below treats as "no code", as the vendor's
  // own client does when the field is missing.
  const code = numOf(r?.code)
  if (Number.isFinite(code) && code !== 200) {
    // 拒绝的话按厂商客户端的读法（app.asar 的 vo）取：message/msg/error/detail
    // 与 data 下同样四个字段里第一个有字的——只读 message 会丢掉 msg 或 data 里
    // 厂商的话，卡片于是只报一个干巴巴的码。
    const said = saidBy(r).trim()
    throw new ApiError(code === 401 || code === 403 ? "登录已过期，请重新登录" : said || `点数查询失败（code ${code}）`, code)
  }
  const body = unwrapped(r)
  const general = pickOf(body, GENERAL_POINTS_NAMES)
  const agent = pickOf(body, AGENT_POINTS_NAMES)
  // a 200 whose body names no balance at all is a read we cannot use: said
  // as an error, the card says why, instead of drawing nothing
  if (general == null && agent == null) throw new ApiError("点数查询没有返回余额", 0)
  return { general, agent }
}

// AGENT_BALANCE_NAMES is the vendor's own list for the second endpoint
// (app.asar's cm → Dn(n, […])) plus the name today's answer actually uses:
// measured 2026-11-02 it answers {data:{"username":…,"agent_balance":N}}, and
// neither that client's list nor ours named `agent_balance` — so neither of
// us could read it. `balance`/`points` keep their place at the front, as that
// client has them.
export const AGENT_BALANCE_NAMES = ["balance", "points", "agent_balance", "agent_token", "agentToken", "agent_points", "agentPoints", "remaining_points"]

// agentPointsOf reads the account's agent points from the vendor's second
// balance endpoint. Its own client keeps this read beside the one above and
// falls back across the two (app.asar's S0: allSettled over /v1/gettoken,
// /v1/agent/balance and /api/user/self), so a dead /v1/gettoken still leaves
// the agent figure readable.
//
// It does not read /api/user/self, the third path: that one answers a
// different pot (measured the same day: its quota is 0 while the points are
// 2348). Reported as this account's wallet it would put "0 点" on the card
// and route a funded account as spent — the one thing every read here
// refuses to do.
export const agentPointsOf = async (token, username, opts) => {
  const r = await request(`${ACCOUNT}${AGENT_POINTS_PATH}`, { method: "POST", body: { username }, token, ...opts })
  const code = numOf(r?.code) // an object code must not throw (see pointsOf)
  if (Number.isFinite(code) && code !== 200) {
    const said = saidBy(r).trim()
    throw new ApiError(code === 401 || code === 403 ? "登录已过期，请重新登录" : said || `点数查询失败（code ${code}）`, code)
  }
  return pickOf(unwrapped(r), AGENT_BALANCE_NAMES)
}

// tokensOf is a vendor's token count — a context window, a reply ceiling —
// as a non-negative whole number. A negative or an infinite one is not a
// size anyone can plan with, and it would reach magpie's list as written, so
// it becomes "not stated" (0). Neither is a value that is not a number at
// all (see numOf).
export function tokensOf(v) {
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
export const baseURL = (v) => {
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
export const apiBase = (provider, id) => {
  const perModel = id ? provider?.models?.[id]?.api?.url : ""
  const said = typeof perModel === "string" && perModel.trim() ? perModel : provider?.api
  return baseURL(said)
}

// KINDS are the modalities magpie knows, in the order a card lists them.
export const KINDS = ["text", "image", "audio", "video", "pdf"]

// kindsOf is a vendor modality list as the kinds we know. An answer that
// names none of them — an empty list, or names this host does not know
// (a rename, a case change) — is read as "text alone", not as "takes
// nothing": every model here is a chat model, and a model that takes no
// text at all would be asserted onto magpie's catalog (host.js's imageSaid
// turns a stated `image: false` into a fact), taking every input away over
// a name we merely failed to translate. A missing field reads the same way,
// so "not said" has one meaning everywhere.
export const kindsOf = (v) => {
  const known = Array.isArray(v) ? KINDS.filter((k) => v.includes(k)) : []
  return known.length ? known : ["text"]
}

// protocolOf is a vendor record's protocol as its own catalogue names it. The
// vendor's schema has three (its sidecar's protocol.type enum:
// openai_chat_completions | openai_responses | anthropic_messages, the last
// two posted to /v1/responses and /v1/messages). A record keeps the vendor's
// own word: flattened to the chat one, the fallback list would say a protocol
// we cannot serve is one we can, and a regeneration would write that lie into
// catalog.mjs.
export const PROTOCOLS = new Set(["openai_chat_completions", "openai_responses", "anthropic_messages"])
export const protocolOf = (m) => {
  const said = m?.protocol?.type
  return typeof said === "string" && PROTOCOLS.has(said) ? said : "openai_chat_completions"
}

// modelOf is one catalog record as magpie's provider list has it. `base` is
// where its requests go (apiBase), the vendor's gateway when nothing else
// says otherwise.
export function modelOf(m, base = `${API}/v1`) {
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

export const modelsOf = (list, base) => Object.fromEntries(list.map((m) => [m.id, modelOf(m, typeof base === "function" ? base(m.id) : base)]))

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
export const MAGIC_KEYS = new Set(["__proto__", "constructor", "prototype"])

// noMagicKeys drops the keys that name properties of every object from a map
// about to be handed to the host as a model list. `Object.fromEntries` and
// object spread both create own data properties — a record whose id is
// `__proto__` becomes an own key without touching the prototype — but the
// host's next step on that list is `out.models[key] = { … }`, a bracket
// assignment, and that one sets the prototype: the model would vanish from
// `Object.keys` and its fields would answer for the map itself. No model is
// named any of these, so dropping them costs nothing.
export const noMagicKeys = (map) => {
  for (const k of MAGIC_KEYS) if (Object.hasOwn(map, k)) delete map[k]
  return map
}
export const mergeModel = (ours, theirs) => {
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
export function catalogOf(body) {
  const list = body?.catalog?.data ?? body?.data ?? null
  if (!Array.isArray(list)) return null
  const out = []
  let examined = 0
  // examined counts every record looked at, kept or dropped; out.length alone
  // never reaches the cap on a list of records that all fail the checks below,
  // and the walk would run to the end of whatever the vendor sent.
  for (const m of list) {
    if (out.length >= MAX_MODELS || ++examined > MAX_MODELS) break
    // a record that is not a plain object (the list held a null, a boolean,
    // a bare number, an array) is left out: it has no id to serve, and the
    // host reads the list this hook answers with while it builds every
    // provider's row in one Promise.all — one such record would throw there
    // and take the whole provider list down, not just that row.
    if (!m || typeof m !== "object" || Array.isArray(m)) continue
    const rawId = typeof m.id === "string" ? m.id.trim() : ""
    const id = cleanText(rawId)
    if (!id || id !== rawId) continue
    // a record on a protocol this provider cannot carry is left out, as an id
    // a request could not ask for is: the vendor posts `openai_responses` to
    // /v1/responses, and the only OpenAI wire this plugin has is the chat one
    // (provider.npm = @ai-sdk/openai-compatible). Listed as chat it would be
    // a model whose every request goes out in the wrong shape. Nothing in
    // today's catalog says it (the vendor's 17 are chat or anthropic).
    const protocol = protocolOf(m)
    if (protocol === "openai_responses") continue
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
      protocol,
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
export const runningActivities = (body) => {
  // 应答码先过厂商客户端那一关（app.asar 的 EI 调 ft 再读列表）：数字码不是
  // 200 的应答是拒绝，哪怕它还带着一份 data——照画就会把根本不在跑的活动
  // 报成免费。今天的应答体没有 code，只有 {data,message,success}，这道关
  // 对它无事可做；厂商哪天带上 code 的拒绝，这里也跟它的客户端一样挡住。
  const code = numOf(body?.code) // an object code must not throw (see pointsOf)
  if (Number.isFinite(code) && code !== 200) return []
  const list = Array.isArray(body?.data) ? body.data : []
  const now = Date.now() / 1000
  return list.filter((a) => {
    if (!a || typeof a !== "object") return false
    // the same reading every other number here gets (numOf): a time the
    // vendor spells as a string is a time, not a missing one, and one no
    // calendar can state (1e999 reads as Infinity) is still a running
    // activity — the window below draws it without an end rather than
    // dropping a campaign over a number it cannot write down. Read as "not a
    // number" the activity vanished from the card without a word.
    const until = numOf(a.free_until)
    // `>` is false for a value that says no number at all (NaN) and for an
    // end already past, and true for an end past the calendar: 1e999 reads
    // as Infinity, and Infinity is in the future. The vendor's own client
    // rejects only a non-number, and a future it cannot write down is still
    // a future — the window below draws it without a time rather than
    // dropping a campaign over a number nobody can spell.
    if (!(until > now)) return false
    // a quota that says it's exhausted means these models aren't free; one
    // that says nothing readable is not an exhausted one (the window below
    // reads the same field with numOf, so both stages agree on what "said" is)
    const quotaLeft = numOf(a.remaining_quota)
    if (a.remaining_quota != null && Number.isFinite(quotaLeft) && quotaLeft <= 0) return false
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
export const publishedConcurrency = (body) => {
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
// vendor's own client reads it (app.asar's um): the answer's data is either
// the state itself (a boolean) or an object naming it, and the client accepts
// any of four spellings, each only as a real boolean. A string "false" is not
// one: Boolean("false") is true, and a card that claims the day when it is
// not costs the user a claim. Anything else is "not signed", as that client
// reads it — the card then offers the claim instead of hiding the row.
export const signedIn = (data) => {
  if (typeof data === "boolean") return data
  if (!data || typeof data !== "object" || Array.isArray(data)) return false
  for (const name of ["isSigned", "signed", "hasSigned", "has_signed"]) if (typeof data[name] === "boolean") return data[name]
  return false
}

// gain is how much one balance grew between the claim's two reads: the
// difference when both are known and it did not fall — a fall is the app
// spending, not this claim — else 0.
export const gain = (was, now) => (was != null && now != null && now >= was ? now - was : 0)

// scrubLine is said as one line with no credential in it: the key itself
// where it is known, then anything credential-shaped where it is not (a
// getAuth that threw leaves no key to cut by). A token a server spliced a
// space or newline into is still cut — jwtShape lets whitespace fall anywhere
// inside a segment, and every Codar token is a JWT. Only the first
// MAX_SCRUB_CHARS characters are cleaned (see the constant); nothing past
// them could reach a card or a log line, and cleaning them would cost
// seconds on a multi-megabyte sentence. The key is cut over the whole string
// first, so a token the vendor split around the boundary is still removed
// where its parts are.
export const scrubLine = (said, key) => {
  let text = typeof said === "string" ? said : ""
  if (key) text = text.split(key).join("…")
  return text.slice(0, MAX_SCRUB_CHARS)
    .replace(controlChars, " ")
    .replace(jwtShape, "…")
    .replace(/\s{2,}/g, " ")
    .trim()
}

// signMessage says what the check-in answered, in the user's words, with the
// token scrubbed: a server that quotes the credential back would otherwise
// put it on the card and in magpie's log. The token itself is cut where it
// is known; a credential-shaped string is cut by its shape, which covers the
// path where the sign-in threw and there is no token to cut by. The cut is by
// code point (see cut): a message full of emoji does not end in half of one.
export const scrub = (said, token) => cut(scrubLine(said, String(token ?? "")), 400)
export const signMessage = (r, token) => scrub(saidBy(r), token)

export const testables = { tokenOf, usernameOf, payloadOf, expiresAt, expired, modelOf, catalogOf, protocolOf, mergeModel, agentPointsOf, pickOf, balanceOf, unwrapped, publishedConcurrency, humanSecs, safeTime, secsOf, checkinWaitSecs, saidBy, signedIn, runningActivities, scrubLine, scrub, cut, request, readAnswer, appToken, configPath, shownPath, cleanText, magicKeys: MAGIC_KEYS, MAX_MODELS, MAX_ANSWER_BYTES, MAX_SCRUB_CHARS, timing: { TIMEOUT_MS, CHECKIN_BUDGET_MS, USAGE_BUDGET_MS, HOST_USAGE_DEADLINE_MS, HOST_CHECKIN_DEADLINE_MS } }
