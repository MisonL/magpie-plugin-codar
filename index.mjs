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

// expiredAt is when the token says it runs out (ms), or 0 when it says
// nothing. A token past it is not sent: every endpoint would answer 401 and
// the card would say "check-in failed" instead of "sign in again".
function expiresAt(token) {
  const exp = payloadOf(token)?.exp
  return typeof exp === "number" && isFinite(exp) ? exp * 1000 : 0
}

const expired = (token) => {
  const at = expiresAt(token)
  return at > 0 && Date.now() >= at
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

// controlChars would break a card's line or ride along invisibly: a vendor
// string is shown as one line, never as a control sequence.
const controlChars = /[\u0000-\u001f\u007f]/g

// cleanText is a vendor string as a card can show it: control characters
// out, one line (runs of spaces folded), and never longer than a card reads.
const cleanText = (s) => String(s).replace(controlChars, " ").replace(/\s{2,}/g, " ").trim().slice(0, 120)

// jwtShape is a credential as a server might quote it back: three
// dot-joined base64url runs, as every Codar token is. Matched by shape, so
// it is cut from a message even when no token is in hand (a getAuth that
// threw leaves nothing to cut by).
const jwtShape = /eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g

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
  } catch {
    return { error: `没找到 ${file}，先在这台机器上登录一次科搭，或改用「科搭访问令牌」粘贴` }
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
    if (!res.ok) throw new ApiError(data?.message || data?.detail || `HTTP ${res.status}`, res.status)
    if (data === null) throw new ApiError("接口返回的不是 JSON")
    return data
  } catch (e) {
    if (e?.name === "AbortError") throw new ApiError("请求超时", 0)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// humanSecs says a number of seconds the way a card wants it.
function humanSecs(secs) {
  const n = Math.max(0, Math.round(Number(secs) || 0))
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
  const code = Number(r?.code)
  if (Number.isFinite(code) && code >= 400) {
    const said = typeof r?.message === "string" ? r.message.trim() : ""
    throw new ApiError(code === 401 || code === 403 ? "登录已过期，请重新登录" : said || `点数查询失败（code ${code}）`, code)
  }
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null)
  return { general: num(r.token), agent: num(r.agent_token) }
}

// modelOf is one catalog record as magpie's provider list has it.
function modelOf(m) {
  const anthropic = m?.protocol === "anthropic_messages"
  const npm = anthropic ? CLAUDE : OPENAI
  const reasons = Boolean(m?.reasoning)
  const input = ["text", "image", "audio", "video", "pdf"].filter((k) => (m?.input ?? []).includes(k))
  const output = ["text", "image", "audio", "video", "pdf"].filter((k) => (m?.output ?? []).includes(k))
  const takes = (list) => Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((k) => [k, list.includes(k)]))
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
    api: { id: m.id, url: `${API}/v1`, npm },
    limit: { context: Number(m.context) || 0, output: 0 },
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

const modelsOf = (list) => Object.fromEntries(list.map((m) => [m.id, modelOf(m)]))

// catalogOf is the vendor's answer as our catalog records: the same fields
// catalog.mjs keeps, so both paths build the same entries. Vendor text is
// cleaned: a control character would break the card it lands on, and an id
// that has to be cleaned is not an id a request can ask for, so that record
// is left out rather than renamed.
function catalogOf(body) {
  const list = body?.catalog?.data ?? body?.data ?? null
  if (!Array.isArray(list)) return null
  const out = []
  for (const m of list) {
    const rawId = typeof m?.id === "string" ? m.id.trim() : ""
    const id = cleanText(rawId)
    if (!id || id !== rawId) continue
    const said = typeof m.display_name === "string" ? cleanText(m.display_name) : ""
    out.push({
      id,
      name: said || id,
      context: Number(m.context_window) || 0,
      input: Array.isArray(m.input_modalities) ? m.input_modalities : ["text"],
      output: Array.isArray(m.output_modalities) ? m.output_modalities : ["text"],
      protocol: m.protocol?.type === "anthropic_messages" ? "anthropic_messages" : "openai_chat_completions",
      reasoning: Boolean(m.reasoning),
    })
  }
  return out.length ? out : null
}

// runningActivities are the free-model activities on right now, as the
// vendor's own clients say (free_until in the future, and not exhausted):
// one whose quota was spent is not free anymore. We follow the vendor app's
// own filter: ignore status, use only free_until and remaining_quota (the
// live data shows status "active" and ended_at null; the catalog shows
// status "active" too).
const runningActivities = (body) => {
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
const publishedConcurrency = (body) => {
  const nums = []
  const take = (v) => {
    const n = Number(v)
    if (Number.isInteger(n) && n > 0 && n <= 1000) nums.push(n)
  }
  const list = body?.catalog?.data ?? body?.data
  take(body?.max_concurrency)
  take(body?.catalog?.max_concurrency)
  if (Array.isArray(list)) for (const m of list) take(m?.max_concurrency)
  return nums.length ? Math.min(...nums) : 0
}

// signMessage says what the check-in answered, in the user's words, with the
// token scrubbed: a server that quotes the credential back would otherwise
// put it on the card and in magpie's log. The token itself is cut where it
// is known; a credential-shaped string is cut by its shape, which covers the
// path where the sign-in threw and there is no token to cut by.
const scrub = (said, token) => {
  let text = typeof said === "string" ? said.replace(controlChars, " ") : ""
  const key = String(token ?? "")
  if (key) text = text.split(key).join("…")
  return text.replace(jwtShape, "…").replace(/\s{2,}/g, " ").trim().slice(0, 400)
}
const signMessage = (r, token) => scrub(typeof r?.message === "string" ? r.message : "", token)

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
          // inputs.file is not a magpie prompt (this method asks nothing); it
          // lets a test name the file instead of reading the real one, which
          // Bun's os.homedir() would not redirect through $HOME.
          async authorize(inputs = {}) {
            const got = appToken(inputs?.file)
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
      // 宿主只把 outcome/credit/streak/message 交给 magpie（host.js 的
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
        if (code === 200) {
          let credit = 0
          try {
            const after = await pointsOf(token, username, { fetchImpl, timeoutMs: Math.min(TIMEOUT_MS, left()) })
            if (before?.general != null && after?.general != null && after.general >= before.general) credit = after.general - before.general
          } catch {
            // 差额读不到就不报，credit 留 0
          }
          return { outcome: "claimed", credit, message: signMessage(r, token) || "签到成功" }
        }
        if (code === 400 && /24\s*小时|仅可领取一次/.test(signMessage(r, token))) {
          const wait = humanSecs(r?.data?.retry_after)
          return { outcome: "done", message: `今天已领过${r?.data?.retry_after ? `，${wait}后可再领` : ""}` }
        }
        if (code === 401 || code === 403) return { outcome: "failed", message: "登录已过期，请重新登录" }
        return { outcome: "failed", message: signMessage(r, token) || `签到失败（code ${code || "?"}）` }
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
        // 不带 used：签到不是一份会用完的额度，宿主把没有份额的 aside 行当
        // 文字行显示（host.js 的 Text，magpie 自己的注释也拿「每日签到」当
        // 例子），不会画成一个 100% 的进度条。
        if (statusR.status === "fulfilled" && statusR.value?.data && typeof statusR.value.data === "object") {
          const st = statusR.value
          const signed = Boolean(st.data.isSigned)
          const retry = Number(st.data.retry_after)
          const wait = Number.isFinite(retry) && retry > 0 ? humanSecs(retry) : ""
          windows.push({
            name: "每日签到",
            ...(wait ? { resetsAt: Date.now() + retry * 1000 } : {}),
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
        // 窗口上的 balance 要宿主和 magpie 都认（0.1.1822 起，magpie #3950）；
        // 旧版（如 0.1.1788）只把它当文字行显示，读数不丢，路由暂仍未知。
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
        if (actsR.status === "fulfilled") {
          for (const a of runningActivities(actsR.value)) {
            const ids = Array.isArray(a.model_ids) ? a.model_ids.filter((x) => typeof x === "string" && x).map(cleanText) : []
            const cap = typeof a.user_quota_limit === "number" && a.user_quota_limit > 0 ? a.user_quota_limit : null
            const left = typeof a.remaining_quota === "number" && isFinite(a.remaining_quota) ? a.remaining_quota : null
            const used = cap != null && left != null ? Math.max(0, cap - left) : null
            const share = used != null ? Math.min(100, Math.round((used / cap) * 100)) : 0
            windows.push({
              name: ids.length ? `免费模型 · ${ids.slice(0, 2).join("、")}${ids.length > 2 ? ` 等 ${ids.length} 个` : ""}` : "免费模型",
              used: share,
              resetsAt: a.free_until * 1000,
              display: left == null ? "免费使用中（不限量）" : cap == null ? `免费使用中，还剩 ${left}` : `免费使用中，已用 ${used} / ${cap}`,
              ...(used != null ? { amount: used, limit: cap } : {}),
              aside: true,
              ...(ids.length ? { models: ids } : {}),
            })
          }
        }

        const parts = []
        if (points.general != null) parts.push(`${points.general} 点`)
        if (points.agent != null) parts.push(`Agent ${points.agent} 点`)
        return {
          user: username,
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
          const known = new Set(CATALOG.map((m) => m.id))
          const own = Object.fromEntries(Object.entries(given).filter(([id]) => !known.has(id)))
          return { ...own, ...modelsOf(list) }
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
    // 悄悄撤销。值不是对象时当作没有，其余字段照旧原样带过。
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] && typeof config.provider[ID] === "object" ? config.provider[ID] : {}
      const models = modelsOf(CATALOG)
      config.provider[ID] = {
        ...was,
        name: typeof was.name === "string" && was.name ? was.name : "科搭 Codar",
        npm: OPENAI,
        api: `${API}/v1`,
        models: { ...models, ...(was.models ?? {}) },
      }
    },
  }
}

export const testables = { tokenOf, usernameOf, payloadOf, expiresAt, modelOf, catalogOf, humanSecs, request, appToken, configPath }

export default CodarPlugin
