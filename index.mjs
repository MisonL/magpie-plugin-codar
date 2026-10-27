// Codar (科搭) for magpie: its models as a provider, its daily check-in, and
// the account's points on the card.
//
// 三件事，三处接口：
//   - 对话：https://api.claw.speedai.com/v1，OpenAI 兼容（claude 系走
//     /v1/messages，Anthropic 兼容）。桌面端自己也是这么调的——侧车把
//     provider.api_base 设成这个地址，请求头只有 Authorization、Content-Type
//     和一个 Go HTTP 客户端的 User-Agent。插件照发同样的请求头（见
//     chat.headers 与 UA 的注释），不做别的事。
//   - 模型目录：GET /v1/codar/models，返回 {catalog:{data:[…]}}，字段见
//     catalog.mjs（那份是桌面端缓存的同一份数据，作为拿不到时的底）。
//   - 签到：POST https://api.kuaipaper.com/v1/daily-sign，body 是
//     {username}，同一把 Bearer 令牌。返回 {code, message, data}：code 200
//     是领到了，code 400「24小时内仅可领取一次」是今天已经领过，
//     data.retry_after 是距离下次可领的秒数。
//   - 点数：POST /v1/gettoken {username, token: 0} → {token, agent_token}。
//
// 令牌是桌面端登录后写进 ~/.codar/config.json 的那把 JWT
// （provider.speedai.token），里面带 username 和 exp（登录后 7 天）。magpie
// 只保存插件交上去的那一份；过期后就报「登录已过期」，由用户重新登录。
// 第二个登录方式「从本机科搭读取」会在登录时读一次那个文件（只读，不写），
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
//   - 对话与模型目录走 Go 侧车 → "Go-http-client/1.1"（实测抓包）
//   - 账号、签到、点数、活动走 Electron 主进程的 fetch → "node"（Node
//     fetch 的默认值，实测同一台机器上的 Node 24 就是它）
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

// appToken reads the token the Codar desktop app keeps, for the "read from
// this machine" sign-in: provider.speedai.token in ~/.codar/config.json
// (%USERPROFILE%\.codar\config.json on Windows, as the app's own docs say;
// on macOS/Linux the home directory is the same place). Read only — the file
// is the app's, and the plugin never writes it. A failure says why in words
// the sign-in dialog can show, since this runs where no card exists yet.
function appToken(file = join(homedir(), ".codar", "config.json")) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return { error: `没找到 ${file}，先在这台机器上登录一次科搭，或改用「Codar 访问令牌」粘贴` }
  }
  let token = ""
  try {
    token = String(JSON.parse(text)?.provider?.speedai?.token ?? "").trim()
  } catch {
    return { error: `${file} 读不出 JSON，可能损坏了；改用「Codar 访问令牌」粘贴` }
  }
  if (!token) return { error: `${file} 里没有 provider.speedai.token；先在这台机器上登录一次科搭，或改用粘贴` }
  if (!tokenOf({ type: "api", key: token })) return { error: `${file} 里的令牌无法识别；改用「Codar 访问令牌」粘贴` }
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
    const text = await res.text()
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
// `agent_token` the agent ones; both are integers the server keeps.
const pointsOf = async (token, username, opts) => {
  const r = await request(`${ACCOUNT}${POINTS_PATH}`, { method: "POST", body: { username, token: 0 }, token, ...opts })
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null)
  return { general: num(r.token), agent: num(r.agent_token) }
}

// modelOf is one catalog record as magpie's provider list has it.
function modelOf(m) {
  const anthropic = m?.protocol === "anthropic_messages"
  const input = Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((k) => [k, (m?.input ?? []).includes(k)]))
  const output = Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((k) => [k, (m?.output ?? []).includes(k)]))
  return {
    id: m.id,
    name: m.name || m.id,
    api: { id: m.id, url: `${API}/v1`, npm: anthropic ? CLAUDE : OPENAI },
    limit: { context: Number(m.context) || 0, output: 0 },
    // The vendor prices in CNY per million tokens; magpie's cost column is
    // US dollars, and inventing an exchange rate here would put a wrong
    // number on the Usage page. Left at 0, which magpie shows as unpriced.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: { temperature: true, toolcall: true, reasoning: Boolean(m.reasoning), input, output },
    headers: {},
  }
}

const modelsOf = (list) => Object.fromEntries(list.map((m) => [m.id, modelOf(m)]))

// catalogOf is the vendor's answer as our catalog records: the same fields
// catalog.mjs keeps, so both paths build the same entries.
function catalogOf(body) {
  const list = body?.catalog?.data ?? body?.data ?? null
  if (!Array.isArray(list)) return null
  const out = []
  for (const m of list) {
    if (!m || typeof m.id !== "string" || !m.id) continue
    out.push({
      id: m.id,
      name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id,
      context: Number(m.context_window) || 0,
      input: Array.isArray(m.input_modalities) ? m.input_modalities : ["text"],
      output: Array.isArray(m.output_modalities) ? m.output_modalities : ["text"],
      protocol: m.protocol?.type === "anthropic_messages" ? "anthropic_messages" : "openai_chat_completions",
      reasoning: Boolean(m.reasoning),
    })
  }
  return out.length ? out : null
}

// signMessage says what the check-in answered, in the user's words, with the
// token scrubbed: a server that quotes the credential back would otherwise
// put it on the card and in magpie's log.
const scrub = (said, token) => {
  const text = typeof said === "string" ? said : ""
  const key = String(token ?? "")
  return key ? text.split(key).join("…") : text
}
const signMessage = (r, token) => scrub(typeof r?.message === "string" ? r.message : "", token)

export async function CodarPlugin(input) {
  // 每次调用现取，而不是建插件时抓一个：宿主给不给 fetch 都可能，测试也会
  // 在这之后换掉全局的那个。
  const fetchImpl = (...args) => (input?.fetch ?? globalThis.fetch)(...args)

  return {
    auth: {
      provider: ID,

      // 科搭按模型限 3 个并发（实测：同时发 4 个，第 4 个收到 429
      // concurrent_limit_exceeded）。按账号限 3，让 magpie 排队而不是撞限流；
      // 用户在供应商设置里可以调高。
      maxConcurrency: 3,

      // 两种登录：粘贴令牌，或让插件在这台机器上读科搭自己的登录信息。
      // 后者是 keyless + authorize（magpie 的契约，host.js 的 apiKey()）：
      // 不弹输入框，由插件把令牌交上去，存进 magpie 的 plugin-auth.json。
      // 令牌过期后重新登录一次即可，不用手工复制。
      methods: [
        {
          type: "api",
          keyless: true,
          label: "从本机科搭读取",
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
          label: "Codar 访问令牌",
          placeholder: "eyJ…（~/.codar/config.json 的 provider.speedai.token）",
        },
      ],

      // 签到：POST /v1/daily-sign。服务端用业务码区分「领到了」与「今天已领
      // 过」——HTTP 状态都是 200，所以看 body 的 code。
      async checkin(getAuth) {
        let auth, token
        try {
          auth = await getAuth()
          token = tokenOf(auth)
        } catch (e) {
          return { outcome: "failed", message: scrub(whyOf(e), auth?.key) || "签到失败", ...(signedOut(e) ? { signIn: "expired" } : {}) }
        }
        if (!token)
          return {
            outcome: "failed",
            message: unusableKey(auth) ? "令牌内容无法识别（含空格、换行或非 ASCII 字符），请重新登录" : "没有登录信息，请先登录",
          }
        const username = usernameOf(token)
        if (!username) return { outcome: "failed", message: "令牌里没有账号名，请粘贴 Codar 登录后的完整令牌" }
        if (expired(token)) return { outcome: "failed", message: "登录已过期，请重新登录", signIn: "expired" }

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
          if (signedOut(e)) return { outcome: "failed", message: "登录已过期，请重新登录", signIn: "expired" }
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
        if (code === 401 || code === 403) return { outcome: "failed", message: "登录已过期，请重新登录", signIn: "expired" }
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
        if (!token) return { error: "没有登录信息，请先登录" }
        const username = usernameOf(token)
        if (!username) return { error: "令牌里没有账号名，请重新登录" }
        if (expired(token)) return { error: "登录已过期，请重新登录", signIn: "expired" }

        const deadline = Date.now() + USAGE_BUDGET_MS
        const left = () => Math.max(1000, deadline - Date.now())
        const opts = () => ({ fetchImpl, timeoutMs: Math.min(TIMEOUT_MS, left()) })

        let points
        try {
          points = await pointsOf(token, username, opts())
        } catch (e) {
          return { error: scrub(whyOf(e), token) || "点数查询失败", signIn: signedOut(e) ? "expired" : "" }
        }

        const windows = []

        // 今日签到：明天这个时候能再领一次。
        try {
          const st = await request(`${ACCOUNT}${SIGN_STATUS_PATH}`, { method: "POST", body: { username }, token, ...opts() })
          const signed = Boolean(st?.data?.isSigned)
          const retry = Number(st?.data?.retry_after)
          if (Number.isFinite(retry) && retry > 0) {
            windows.push({
              name: "每日签到",
              used: signed ? 100 : 0,
              resetsAt: Date.now() + retry * 1000,
              display: signed ? `今天已领，${humanSecs(retry)}后可再领` : `今天还没领，${humanSecs(retry)}后可以领`,
              aside: true,
            })
          }
        } catch {
          // 状态读不到就不放这个窗口
        }

        // 免费模型活动：免费到什么时候。remaining_quota 是 null 时表示不限量，
        // 有数时它才是这个活动还剩多少。列表拿不到就整段跳过。
        try {
          const r = await request(`${API}${ACTIVITIES_PATH}`, { method: "GET", token, ...opts() })
          const list = Array.isArray(r?.data) ? r.data : []
          const now = Date.now() / 1000
          for (const a of list) {
            if (!a || typeof a !== "object") continue
            if (typeof a.free_until !== "number" || a.free_until <= now) continue
            const ids = Array.isArray(a.model_ids) ? a.model_ids.filter((x) => typeof x === "string") : []
            const left = typeof a.remaining_quota === "number" ? a.remaining_quota : null
            windows.push({
              name: ids.length ? `免费模型 · ${ids.slice(0, 2).join("、")}${ids.length > 2 ? ` 等 ${ids.length} 个` : ""}` : "免费模型",
              used: 0,
              resetsAt: a.free_until * 1000,
              display: left == null ? "免费使用中（不限量）" : `免费使用中，剩 ${left}`,
              ...(left == null ? {} : { amount: 0, limit: left, unit: "次" }),
              aside: true,
              ...(ids.length ? { models: ids } : {}),
            })
          }
        } catch {
          // 活动接口挂了（2026-10-27 实测过整段 500）不影响余额
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
    provider: {
      id: ID,
      async models(given, { auth } = {}) {
        const token = tokenOf(auth)
        if (!token || expired(token)) return given
        try {
          const body = await request(`${API}${CATALOG_PATH}`, { method: "GET", token, fetchImpl, ua: UA_SIDECAR })
          const list = catalogOf(body)
          if (!list) return Object.assign(given, { [Symbol.for("magpie.fellBack")]: true })
          return modelsOf(list)
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

    async config(config) {
      config.provider ??= {}
      const models = modelsOf(CATALOG)
      config.provider[ID] = {
        ...(config.provider[ID] ?? {}),
        name: "Codar 科搭",
        npm: OPENAI,
        api: `${API}/v1`,
        models: { ...models, ...(config.provider[ID]?.models ?? {}) },
      }
    },
  }
}

export const testables = { tokenOf, usernameOf, payloadOf, expiresAt, modelOf, catalogOf, humanSecs, request, appToken }

export default CodarPlugin
