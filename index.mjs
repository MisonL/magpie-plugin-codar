// Codar (科搭) for magpie: its models as a provider, its daily check-in, and
// the account's points on the card.
//
// Three things, three endpoints:
//   - Chat: https://api.claw.speedai.com/v1, OpenAI-compatible (the claude
//     family goes through /v1/messages, Anthropic-compatible). The desktop
//     app calls it the same way: the sidecar sets provider.api_base to this
//     address, and the only headers are Authorization, Content-Type and one
//     Go HTTP client User-Agent. The plugin sends the same headers (see the
//     comments on chat.headers and the UA) and does nothing else.
//   - Model catalog: GET /v1/codar/models, returns {object:"list", data:[…]}
//     (there is also the {catalog:{data:[…]}} shape; both are accepted),
//     fields in catalog.mjs (that file is the same data the desktop app
//     caches, kept as a fallback when the endpoint is unreachable).
//   - Check-in: POST https://api.kuaipaper.com/v1/daily-sign, body is
//     {username}, same Bearer token. Returns {code, message, data}: code 200
//     means claimed, code 400 with the once-per-24-hours wording means
//     already claimed today, data.retry_after is the seconds until the next
//     claim.
//   - Points: POST /v1/gettoken {username, token: 0} → {token, agent_token}.
//
// The token is the JWT the desktop app writes into ~/.codar/config.json
// after login (provider.speedai.token); it carries username and exp (7 days
// after login). magpie only stores the copy the plugin hands over; once
// expired it reports 「登录已过期」and the user logs in again. The token
// sign-in method reads that file once at login time when its optional field is
// left empty (read-only, never written), saving the manual copy.


import { CATALOG } from "./lib/catalog.mjs"
import { guardedFetch } from "./lib/guarded.mjs"
import { ACCOUNT, ACTIVITIES_PATH, ALREADY_CLAIMED, API, CATALOG_PATH, CHECKIN_BUDGET_MS, HOST_CHECKIN_DEADLINE_MS, HOST_USAGE_DEADLINE_MS, ID, MAGIC_KEYS, MAX_ACTIVITY_WINDOWS, MAX_ANSWER_BYTES, MAX_MODELS, MAX_SCRUB_CHARS, OPENAI, SIGN_PATH, SIGN_STATUS_PATH, TIMEOUT_MS, UA_SIDECAR, USAGE_BUDGET_MS, agentPointsOf, apiBase, appToken, balanceOf, baseURL, catalogOf, checkinWaitSecs, claimFreeModel, cleanText, chatFetchOf, codeOf, verifyIp, wechatQrOf, wechatStatusOf, WECHAT_QR_PATH, WECHAT_STATUS_PATH, configPath, cut, cutKey, decodedCarriesKey, echoesIn, echoesKey, errorCodeOf, expired, expiresAt, headerWaitOf, humanSecs, login, mergeModel, modelOf, modelsOf, noMagicKeys, numOf, payloadOf, pickOf, pointsOf, protocolOf, publishedConcurrency, readAnswer, refusedCode, refreshToken, request, restricted, runningActivities, safeTime, saidBy, saidNo, scrub, scrubLine, scrubShapes, splitAcross, splitFields, secsOf, shownPath, signMessage, signStateOf, signedOut, tokenOf, unusableKey, unwrapped, usernameOf, whyOf } from "./lib/internal.mjs"

// signInResult is a token handed to the host in the shape whose expiry it
// renews: a result that carries `refresh` is kept as an oauth sign-in
// (host.js's save), with expires from the token's own exp. A token that
// states no exp keeps 0, which the host reads as "no renewal due". Without
// this the sign-in is kept as a bare api key and nothing renews it.
const signInResult = (token) => ({ type: "success", refresh: token, access: token, expires: expiresAt(token) || 0 })

// signInFailure says why a password sign-in did not finish, in the user's
// words. The two vendor answers worth telling apart: a 4xx whose body code is
// 201 or a status of ip_verify_required wants an SMS check no plugin can
// pass for the user, and every other refusal is the vendor's own sentence
// (「用户名或密码错误」). The account and password never go into the text: the
// host shows this line, and it must not echo what the user typed.
const signInFailure = (e) => {
  const body = e?.body
  const status = String(body?.status ?? unwrapped(body)?.status ?? "").toLowerCase()
  if (Number(body?.code) === 201 || status === "ip_verify_required") {
    return "该账号当前需要短信安全验证，请重新发起「科搭OAuth登录」：页面会直接打开安全验证这一步"
  }
  const said = saidBy(body).trim()
  if (said) return said
  return whyOf(e) || "登录失败"
}

// verifyPending remembers a sign-in the vendor's IP check stopped, so the
// sign-in page can finish that check instead of starting a fresh login: the temp
// token the refusal handed over (the only credential /v1/user/verify_ip takes),
// the account name, and the phone number the vendor showed with it. It lives
// in this module and nowhere else — never saved, never printed.
//
// It is good for PENDING_VERIFY_MS and no longer: a temp token the vendor
// handed out for one check must not be picked up later by a sign-in for
// another account or another day. Every other sign-in path clears it, and it
// is taken (not peeked) so one handover completes at most one sign-in.
const PENDING_VERIFY_MS = 10 * 60 * 1000
let pendingVerify = null

// takePendingVerify answers the handover once, if it is still good. An entry
// past its window is dropped rather than used — the vendor would refuse its
// token anyway, and the page would be verifying an account the person no
// longer has in front of them.
const takePendingVerify = () => {
  const got = pendingVerify
  pendingVerify = null
  if (!got || !(Date.now() - got.at <= PENDING_VERIFY_MS)) return null
  return got
}

// verifyPendingOf reads a refused login's answer for that handover. The
// vendor's refusal is {code:201, status:"ip_verify_required", token,
// username, phone} (measured shape in the web app's own flow); a body that
// says the same thing another way still has to name a temp token to be usable,
// because it is the only credential the verification call has.
const verifyPendingOf = (e, username) => {
  const body = unwrapped(e?.body)
  if (!body || typeof body !== "object") return null
  const status = String(body.status ?? "").toLowerCase()
  const wants = Number(body.code) === 201 || status === "ip_verify_required"
  if (!wants) return null
  const tempToken = typeof body.token === "string" ? body.token.trim() : typeof body.tempToken === "string" ? body.tempToken.trim() : ""
  if (!tempToken) return null
  return {
    tempToken,
    username: typeof body.username === "string" && body.username.trim() ? body.username.trim() : username,
    phone: typeof body.phone === "string" ? body.phone.trim() : "",
    at: Date.now(),
  }
}

// chatTransport is the fetch the host is handed for chat. magpie runs a
// loader's fetch in place of its own (host.js: `typeof o.fetch === "function"
// ? o.fetch : fetch`), so answering one here sends the conversation through
// the same Go proxy the card's requests use — the desktop's TLS and HTTP shape
// instead of Bun's — and hands the answer back as a stream while it arrives.
// A platform without the binary, or a module that cannot load, ends at the
// ordinary fetch: chat must not fail because the native path is missing, and
// native.mjs's chatFetch already falls back on its own for the cases it can
// see. This is the second chance, not a second transport. Both agree on the
// redirect rule: the proxy, or guarded.mjs's fetch in its place (guarded.mjs
// says why the conversation's credential must not follow a Location).
const chatTransport = async (url, init) => {
  const send = await chatFetchOf()
  return send ? send(url, init) : guardedFetch(url, init)
}

// claimedCampaigns and claimingCampaign hold the free-model claim down to one
// write per campaign per process: the key is the account and the activity the
// vendor named, and an in-flight claim is shared rather than repeated. Memory
// only — a restarted magpie asks the vendor again and follows its answer.
const claimedCampaigns = new Set()
const claimingCampaign = new Map()

// claimFreeModelsOnce is claimFreeModel with that guard around it. The
// campaign is named by the vendor's own answer, so the record is asked about
// that activity once it is known; only the in-flight claim is keyed on the
// account, because two check-ins at once must not both write.
const claimFreeModelsOnce = (token, username, opts) => {
  const key = (id) => `${username}\u0000${id}`
  const inFlight = claimingCampaign.get(username)
  if (inFlight) return inFlight
  const run = (async () => {
    const got = await claimFreeModel(token, { ...opts, claimed: (id) => claimedCampaigns.has(key(id)) })
    if (got?.activityId) claimedCampaigns.add(key(got.activityId))
    return got
  })().finally(() => claimingCampaign.delete(username))
  claimingCampaign.set(username, run)
  return run
}

// WECHAT_POLL_MS bounds one QR status poll. The vendor's endpoint is a long
// poll — measured 2026-11-11: a "pending" answer held the request about 15
// seconds before replying — so TIMEOUT_MS (8s) would turn every poll into a
// timeout. 35 seconds leaves the vendor's own wait room without letting a dead
// connection hold the page forever.
const WECHAT_POLL_MS = 35 * 1000

// rawHasOnlyRecords says every entry of the host's table is a record: a null
// or a string one is dropped by the normalizer, and the host's own objects
// check would not throw on it either, but handing such a table back would.
const rawHasOnlyRecords = (raw) => Object.values(raw).every((v) => v && typeof v === "object" && !Array.isArray(v))

// markFallback is a table the host may read as a fallback: the very object
// with the marker on it when it can take a property, else a copy carrying
// the same entries and the marker (a table frozen over the RPC still reads
// as the fallback by the marker alone).
const fallBack = Symbol.for("magpie.fellBack")
const markFallback = (table) => {
  const out = table && typeof table === "object" ? table : {}
  if (Object.isExtensible(out)) return Object.assign(out, { [fallBack]: true })
  return Object.assign({ ...out }, { [fallBack]: true })
}

// sameTable says the normalized table holds what the host gave, entry for
// entry: the same model objects, and ids that were already the keys.
const sameTable = (raw, normalized) => {
  const keys = Object.keys(normalized)
  if (keys.length !== Object.keys(raw).length) return false
  return keys.every((k) => normalized[k] === raw[k])
}

// normalizeModels is the model table a hook received, as a list this plugin
// may hand back: plain records only (a null or string entry would make the
// host's Promise.all throw and take every provider down), no id-named
// property (__proto__ and friends, see noMagicKeys), and every entry
// carrying the id its key names.
const normalizeModels = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return noMagicKeys(Object.fromEntries(
    Object.entries(raw)
      .filter(([, v]) => v && typeof v === "object" && !Array.isArray(v))
      // An entry that already carries its own id is kept as it is, not
      // spread: sameTable below asks whether the normalized table holds the
      // host's own records, and spreading every one of them made that answer
      // "no" for every table — the branch that hands the host its own object
      // back (the identity a failed fetch is read by) was dead.
      .map(([id, m]) => [id, typeof m.id === "string" && m.id.trim() ? m : { ...m, id }]),
  ))
}

export async function CodarPlugin(input) {
  // Read fresh on every call instead of capturing one at plugin build time:
  // tests swap the global one after this point. The host does not put fetch
  // on input — host.js's loadPlugins hands over client/project/directory/
  // worktree/experimental_workspace/serverUrl/$/magpie — so this reads
  // globalThis.fetch, and there is no second path.
  const fetchImpl = (...args) => globalThis.fetch(...args)

  // Concurrency: the vendor states it on no endpoint today (measured on
  // 2026-10-27: not in the catalog, pricing, or the 429 response), and the
  // default of 3 is measured — fire 4 at once and the 4th gets 429
  // concurrent_limit_exceeded. Once the catalog carries max_concurrency, the
  // catalog refresh below records it, and auth's getter uses it the next
  // time it is read. The host reads this value once when building provider
  // info (host.js's concurrencyOf), and the models hook runs before that, so
  // the first request after a refresh already queues under the new number.
  let vendorConcurrency = 0
  // The loader's baseURL: the provider's address as it is written down, "/v1"
  // included (the config hook sets it, the loader's comment says why). Until
  // then it is the vendor's gateway; a provider served through config always
  // has a config hook run first.
  let loaderBase = `${API}/v1`

  return {
    auth: {
      provider: ID,

      // Codar limits to 3 concurrent requests per model (measured: fire 4 at
      // once and the 4th gets 429 concurrent_limit_exceeded). Limit to 3 per
      // account so magpie queues instead of hitting the rate limit; users
      // can raise it in the provider settings. Getter: use the catalog's
      // number when it states one (see above), otherwise the measured 3.
      get maxConcurrency() {
        return vendorConcurrency || 3
      },

      // Three sign-in methods: a token (the Codar desktop's own login on this
      // machine, or one pasted from anywhere), one 「科搭OAuth登录」 page carrying
      // the vendor's own two ways in — the phone-and-SMS sign-in and the WeChat
      // QR scan — as tabs, the same tabs the vendor's web app puts in its login
      // dialog (扫码登录 / 手机号登录, measured 2026-11-13), and the account's own
      // name and password. The page is one entry because the host shows one
      // button per method and has no way to group them; the person picks the
      // way in on the page. The password sits beside it rather than on it: it
      // is typed into magpie's own dialog, where no browser password manager
      // is asked to save a Codar password against a random 127.0.0.1 port, and
      // it is the method the vendor's IP check hands on to the page's own
      // security-check step.
      //
      // Each hands the host a token and, with it, the token's own exp
      // (signInResult): the host keeps the sign-in as an oauth one, whose
      // expiry it renews through auth.refresh below before the token runs
      // out. A token past its exp cannot be renewed — the vendor answers
      // /v1/token/refresh with 401 for it (measured 2026-11-11) — so the
      // renewal only ever happens ahead of the expiry, and a sign-in whose
      // exp has already passed asks to sign in again.
      methods: [
        {
          // One token entry point with two sources: the desktop app's own
          // login on this machine, or a token pasted from anywhere. The field
          // is optional, so signing in from the desktop needs nothing typed.
          // The method is not keyless: magpie calls a keyless one with no
          // prompts at all (host.js's apiKey passes `inputs ?? {}`), and the
          // optional field is exactly what a merged entry has to show. An
          // empty answer still reads only the app's own file — one path,
          // taken from CODAR_HOME or the home directory. It takes no path
          // from the caller: magpie's local sign-in API is reachable by
          // anything that can reach magpie, and reading an arbitrary JSON
          // file for its token is not a thing that API should be able to do.
          type: "api",
          label: "科搭令牌（留空读本机）",
          prompts: [
            {
              key: "token",
              type: "password",
              message: "科搭访问令牌（留空则读取本机科搭令牌）",
              // empty is a choice, not an omission: it asks for this
              // machine's own login state
              validate: () => null,
            },
          ],
          async authorize(inputs = {}) {
            // A sign-in in its own right, as the page is: whatever an
            // IP-checked password attempt left behind is not this attempt's,
            // and a later page must not finish it for the other account.
            pendingVerify = null
            const typed = typeof inputs.token === "string" ? inputs.token.trim() : ""
            if (!typed) {
              const got = appToken()
              if (got.error) return { type: "failed", error: got.error }
              return signInResult(got.token)
            }
            // A pasted token is read the way the app's own file is: visible
            // ASCII only, an account name inside, and not past its exp. One
            // that fails here would be saved and then fail on the card, where
            // the fix is the same sentence said earlier.
            if (!tokenOf({ type: "api", key: typed })) return { type: "failed", error: "令牌内容无法识别（含空格、换行或非 ASCII 字符），请重新粘贴" }
            if (!usernameOf(typed)) return { type: "failed", error: "令牌里没有账号名，请粘贴科搭OAuth登录后的完整令牌" }
            if (expired(typed)) return { type: "failed", error: "登录已过期，请重新登录" }
            return signInResult(typed)
          },
        },
        {
          // One page for the vendor's own two ways in (signinpage.mjs).
          //
          // SMS: the vendor refuses to send a code without a solved Aliyun
          // captcha (measured 2026-11-11), and that captcha is a person's
          // puzzle in a browser, so the page asks for the number, the captcha
          // and the code. QR: the vendor's POST /v1/wechat/login/qrcode
          // answers a scene and the image it drew, and the page polls
          // /v1/wechat/login/status until the phone confirms.
          //
          // The page is served on 127.0.0.1 behind a random path, every vendor
          // call is made here, and the page never sees the token. The listener
          // answers for ten minutes at most.
          //
          // When a password sign-in was stopped by the vendor's IP check
          // (verifyPendingOf), the page opens as that check instead of the
          // tabs: the code is asked for with the vendor's own type
          // ("ip_verify", carrying the account name) and posted to
          // /v1/user/verify_ip, as the vendor's web app does in that state.
          type: "oauth",
          label: "科搭OAuth登录",
          instructions: "在打开的页面里选择扫码登录或手机号登录，完成后回到 magpie",
          async authorize(_inputs, { signal } = {}) {
            if (signal?.aborted) return { type: "failed", error: "登录已取消" }
            const pending = takePendingVerify()
            // Both vendor calls of a side are wrapped here: a refusal that
            // quotes what was sent must not print it on the page. The SMS code
            // goes out as the password field, and the verification call's
            // only credential is the temp token; the card's own cutting (scrub)
            // is used, so a vendor echo of either is cut, and no other number.
            const smsSide = (send, verify) => ({
              sendCode: send,
              verifyCode: (phone, code) => verify(phone, code).catch((e) => {
                throw new Error(scrub(scrub(whyOf(e), code), pending?.tempToken ?? "") || (pending ? "安全验证失败" : "登录失败"))
              }),
            })
            const signIn = smsSide(
              (phone, captcha) =>
                request(`${ACCOUNT}/v1/verification-code`, {
                  method: "POST",
                  body: { phone, name: "user", type: "login", ...captcha },
                  businessCodes: true,
                }),
              (phone, code) => login(phone, code),
            )
            const verify = pending
              ? {
                  ...smsSide(
                    (phone, captcha) =>
                      request(`${ACCOUNT}/v1/verification-code`, {
                        method: "POST",
                        body: { phone, name: pending.username, type: "ip_verify", ...captcha },
                        businessCodes: true,
                      }),
                    (phone, code) => verifyIp({ username: pending.username, phone, code, tempToken: pending.tempToken }),
                  ),
                  // the account being verified is named: the person may have
                  // several, and this page completes whichever one the password
                  // step left behind
                  hint: `账号 ${pending.username} 当前网络需要短信安全验证：请在下方完成人机验证并填写收到的验证码。`,
                  // the vendor's own number, when it showed a full one, so the
                  // person can tell which phone the code goes to; the page
                  // still asks for the number itself when it is masked
                  phone: /^1[3-9]\d{9}$/.test(pending.phone) ? pending.phone : "",
                }
              : undefined
            // Neither side carries a credential until it answers one: the code
            // request and the QR one are anonymous, as the vendor's web client
            // makes them. An IP-check page has no QR tab at all.
            const qr = verify
              ? undefined
              : {
                  // the vendor's own helper posts (web index-*.js: ft's default
                  // method is POST), and its route answers a GET with "Method
                  // Not Allowed"
                  qrcode: async () => wechatQrOf(await request(`${ACCOUNT}${WECHAT_QR_PATH}`, { method: "POST" })),
                  // the vendor's status endpoint is a long poll: it holds the
                  // request until the code's state changes, and measured 15
                  // seconds before answering "pending". The plugin's usual
                  // 8-second bound would report every one of those as a
                  // timeout, so this one call is given room past the vendor's
                  // own wait. An answer the vendor states with an HTTP status
                  // instead of a business code (404/410 for a scene that is
                  // gone) is the same expiry, not a page that stopped working.
                  status: async (scene) => {
                    try {
                      return wechatStatusOf(await request(`${ACCOUNT}${WECHAT_STATUS_PATH}`, { method: "POST", body: { scene }, timeoutMs: WECHAT_POLL_MS }))
                    } catch (e) {
                      if (e?.status === 404 || e?.status === 410) return { state: "expired" }
                      throw e
                    }
                  },
                }
            let page
            try {
              // Loaded here, not at module load: the catalog generator's
              // fixture copies the modules it needs into a temp directory,
              // and a top-level import of this one would make that fixture
              // fail to load. Only this method needs a page at all.
              const { startSignIn } = await import("./lib/signinpage.mjs")
              page = await startSignIn({
                ...(verify ?? signIn),
                ...(qr ?? {}),
                verify,
                copy: verify ? { title: "科搭短信安全验证", button: "完成验证" } : {},
              })
            } catch (e) {
              // The page never opened, so the handover was not spent: put it
              // back for the next attempt (it keeps its own timestamp, so it
              // still expires on its original schedule).
              if (pending) pendingVerify = pending
              return { type: "failed", error: `无法打开登录页：${whyOf(e)}` }
            }
            // A sign-in cancelled while the page was being set up must not
            // leave a listener running for its whole TTL: addEventListener on
            // an already-aborted signal never fires, so the check is here.
            if (signal?.aborted) {
              page.close()
              return { type: "failed", error: "登录已取消" }
            }
            const onAbort = () => page.close()
            signal?.addEventListener?.("abort", onAbort, { once: true })
            return {
              url: page.url,
              instructions: verify
                ? "在打开的页面里完成人机验证并填写短信验证码，以通过安全验证"
                : "在打开的页面里扫码或使用手机号登录，完成后回到 magpie",
              async callback() {
                try {
                  const got = await page.wait(signal)
                  // a state the vendor will not finish arrives as the page's
                  // own answer, not as a cancellation, and not after the
                  // listener's whole TTL
                  if (got?.error) return { type: "failed", error: got.error }
                  if (!got) return { type: "failed", error: "登录已取消" }
                  return signInResult(got.token)
                } finally {
                  signal?.removeEventListener?.("abort", onAbort)
                  page.close()
                }
              },
            }
          },
        },
        {
          // The account's own name and password, as the desktop client's
          // sign-in sends them (POST /v1/login on api.kuaipaper.com, read
          // off the web app's bundle). The password goes to the vendor in
          // that one request and is kept nowhere: what reaches the host is
          // the token. The result carries `refresh`, so the host takes the
          // oauth branch of its save() — which keeps access/refresh/expires
          // and not the answers these prompts collected — and it asks no key
          // of its own beside them (host.js's keyAsked). A vendor that
          // answers code 201 or ip_verify_required wants an SMS check this
          // plugin cannot pass for the user, so the answer names the way
          // that works instead of asking for a code that would then be sent
          // from a different machine. It comes after the sign-in page for that
          // reason: the hand-off opens that page as its security-check step,
          // which is usually where this sign-in ends.
          type: "api",
          label: "科搭账号密码登录",
          prompts: [
            {
              key: "username",
              type: "text",
              message: "科搭账号（手机号或账号名）",
              validate: (v) => (String(v ?? "").trim() ? null : "请填写科搭账号"),
            },
            { key: "password", type: "password", message: "科搭密码", validate: (v) => (String(v ?? "") ? null : "请填写科搭密码") },
          ],
          async authorize(inputs = {}) {
            const username = String(inputs.username ?? "").trim()
            const password = String(inputs.password ?? "")
            if (!username || !password) return { type: "failed", error: "请填写科搭账号和密码" }
            // A new attempt is a new flow: whatever an earlier one left behind
            // is not this sign-in's to finish, and must not be offered to the
            // SMS page as if it were.
            pendingVerify = null
            try {
              const got = await login(username, password)
              return signInResult(got.token)
            } catch (e) {
              // The card shows this line: neither the account nor the password
              // goes into it, whatever the vendor quoted back.
              // A refusal that names the IP check is also remembered, with the
              // temp token it handed over: the SMS method completes that check
              // through the vendor's own /v1/user/verify_ip instead of asking
              // for the password a second time. The token is a credential, so
              // it is held in this module and nowhere else — not in the host's
              // saved account, not in a message.
              const pending = verifyPendingOf(e, username)
              if (pending) pendingVerify = pending
              return { type: "failed", error: scrubLine(scrubLine(signInFailure(e), username), password) }
            }
          },
        },
      ],

      // refresh renews a sign-in the host kept as oauth (signInResult) before
      // its exp: POST /v1/token/refresh with the current token as a bearer
      // answers the next one. It gives back the fields to keep over the old;
      // a sign-in the vendor will no longer renew throws with signIn
      // "expired", so the host marks the account rather than retry it.
      async refresh(auth) {
        const token = tokenOf(auth)
        if (!token) {
          const e = new Error("没有可续期的登录信息")
          e.signIn = "expired"
          throw e
        }
        if (expired(token)) {
          // Renewal is ahead of the expiry, never after it: the vendor refuses
          // an expired token (code 401), and asking would only log a failure.
          const e = new Error("登录已过期，请重新登录")
          e.signIn = "expired"
          throw e
        }
        let next
        try {
          next = await refreshToken(token)
        } catch (e) {
          // The host may keep this sentence (it writes failed renewals to its
          // own file), and the request it came from carried the token: cut it
          // here as every card line is cut, so nothing that echoes it back is
          // ever stored.
          if (typeof e?.message === "string") e.message = scrub(e.message, token) || "续期失败"
          throw e
        }
        return signInResult(next)
      },

      // refreshLead is how long before exp the host renews: 12 hours. A
      // desktop sign-in lives 7 days, so a magpie left running renews it
      // well before the day it would have run out; the vendor's own client
      // renews on a similar schedule.
      refreshLead: 12 * 60 * 60 * 1000,

      // What a request for this account carries: the stored key. magpie falls
      // back to it without a loader, but the contract for a provider served
      // through config is `{ provider, loader, methods }` — the loader is the
      // one place a request's credential is read, and without it the host's
      // other entry points (OpenCode's own) have no key to send. An account
      // with no usable key answers {} rather than a made-up one. tokenOf
      // reads both shapes: the key a pasted sign-in keeps, and the access
      // token a sign-in signInResult handed over (which the host keeps as
      // oauth, so it does not fall back to `key` by itself).
      async loader(getAuth) {
        // A reader that throws (a damaged plugin-auth.json, a host answering
        // nothing) is "no key to send", not an exception out of the host's
        // request path: checkin and usage already read it that way.
        let got
        try {
          got = await getAuth()
        } catch {
          return {}
        }
        const token = tokenOf(got)
        if (!token) return {}
        return { apiKey: token, ...(loaderBase ? { baseURL: loaderBase } : {}), fetch: chatTransport }
      },

      // Check-in: POST /v1/daily-sign. The server distinguishes "claimed"
      // from "already claimed today" by business code — both are HTTP 200,
      // so read body's code. The return carries no signIn: the host only
      // passes outcome/credit/streak/message/until to magpie (host.js's
      // checkinOf), and flagging an expired account is usage's job (usage's
      // signIn is what gets read).
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
        if (!username) return { outcome: "failed", message: "令牌里没有账号名，请粘贴科搭OAuth登录后的完整令牌" }
        if (expired(token)) return { outcome: "failed", message: "登录已过期，请重新登录" }

        const deadline = Date.now() + CHECKIN_BUDGET_MS
        const left = () => Math.max(1000, deadline - Date.now())

        // How a claimed day answers: done, plus until. until is the contract
        // since magpie 0.1.1795 ("a plugin's until is when its answer stops
        // holding"): when the check-in answer stops holding, and when to ask
        // again. Codar uses a rolling 24 hours, and retry_after is exactly
        // that moment; once reported, magpie does not re-ask every 30 minutes
        // before noon. When the vendor gives no seconds (or gives 0), use a
        // 30-minute shelf life: that is only "how long we trust this answer",
        // not a made-up claimable moment on the vendor's behalf. Seconds must
        // first be statable, then trusted: numbers a rolling window cannot
        // produce (1e9 seconds is 31 years) and numbers the calendar cannot
        // write both fall back to the shelf life — taking them at face value
        // would settle this day into 2058 (see checkinWaitSecs and safeTime).
        // HTTP 400 can say the same thing (see the catch below), so this sits
        // here, one copy for each path.
        // Positive and negative signals in the wording, shared by both paths.
        // Failure words must override success words: vendor failure text says
        // 成功 inside a negation (不成功, 未成功) — the same characters that spell
        // an affirmation; a few words between a negator and success ("not been
        // successful", "did not succeed", "no success yet") count too — when
        // one sentence has both a success word and a failure word, read it as
        // failure; the cost is one more ask at the deadline, while reading it
        // as claimed settles the day at 0 points. A negator can also follow
        // the success word ("签到成功？否"), and that pair reads as failure. The
        // English pre-negation runs inside one sentence and stops at a comma
        // ("No errors, check-in successful" is a success); the Chinese
        // negations sit immediately before the success word, as a Chinese
        // comma joins one sentence's clauses, and a negation in one language
        // vetoes a success word in the other ("check-in not <success>").
        // Error words are the exception, because the vendor's success note
        // often carries one ("签到成功，无异常"), and so do the English
        // "no errors" / "without errors" / "with no errors". They are removed
        // before the word list is read, so the failure word inside a denial
        // does not veto the claim. Only error-shaped nouns: "no points were
        // added" is a different statement and must stay readable.
        const noErrors = /(?:没有|无|未|没)(?:发现|检测到|遇到|出现)?\s*(?:任何)?\s*(?:错误|异常|故障|报错)|\b(?:with\s+no|without|no|zero)\s+(?:any\s+)?(?:errors?|exceptions?|issues?)\b/gi
        const failedWords = (words) => /失败|不成功|(?:不|未|没|无|未能|不可)(?:[^。，；;！？!?]{0,3})?成功|成功[^。，；;：:！？!?\n]{0,6}(?:[不未没无]|失败)|\b(?:\w+n['\u2019]t|not|never|no|without|unable|cannot)\b[^.!?;！？。,，\u2013\u2014\n-]{0,24}?succe(?:ss(?:ful(?:ly)?)?|ed(?:ed|ing|s)?)|succe(?:ss(?:ful(?:ly)?)?|ed(?:ed|ing|s)?)\b[^.!?;！？。,，\u2013\u2014\n-]{0,32}?\b(?:\w+n['\u2019]t|not|never|no|without|unable|cannot)\b|unsuccess|\bfail(?:s|ed|ure)?\b|\b(?:\w+n['\u2019]t|not|never|no|without|unable|cannot)\b[^.!?;！？。,，\u2013\u2014\n-]{0,24}?成功|成功[^。，；;：:！？!?\n]{0,6}\b(?:\w+n['\u2019]t|not|never|no|without|unable|cannot)\b|风控|频繁|限流|频率|维护|系统繁忙|不可用|错误|异常|拒绝|无效|稍后再试|稍后重试|请求超时|服务器错误|故障|超时|稍后再来|系统开小差|\b(?:too many|rate[\s-]?limits?(?:ed)?|busy|maintenance|unavailable|not available|system error|internal server error|bad gateway|gateway timeout|service unavailable|temporarily unavailable|throttl(?:ed|ing)?|retry later|please retry|try later|please wait|wait a moment|daily limit|try again later|please try again(?!\s+(?:tomorrow|next time|the next day|then)))\b/i.test(head(words).replace(noErrors, ""))


        // Success words are the vendor's own landing verbs: the Chinese 成功
        // beside a sign-in or claim verb ("签到成功", "领取成功"; 到账/发放 name
        // points landed), or succeed/succeeded/successful/success (but not
        // "success rate"/"success ratio"). Bare "available" is not one of
        // them, so "service unavailable" beside a 200 is read as the outage it
        // is — the failure words carry it, and a success word there would have
        // settled the day.
        // Every word rule reads at most this much of the vendor's sentence:
        // the rules are regexes, the project's rule is that regexes see the
        // first 8 KiB, and saidBy's answer can be an 8 MB body. The opening
        // words of a message are where a vendor states its outcome.
        const head = (words) => String(words ?? "").slice(0, MAX_SCRUB_CHARS)
        const successWord = (words) => /成功(?!率)|\bsucce(?:ss(?:ful(?:ly)?)?|ed(?:ed|ing|s)?)\b(?!\s+(?:rate|ratio)\b)/i.test(head(words))
        // negatedAt says the word at index at is negated: a Chinese negator
        // just before it, or an English one in the same sentence ("has not
        // clicked in successfully"; "already signed today? no, not yet").

        // next says the negation may also be the next sentence's opening.
        // That is the shape a day's statement takes as a question —
        // "Already signed today? No, not yet" — and only there: a note after
        // a full stop ("Check-in successful. No points were added") does not
        // negate the success word before it. The next sentence has to deny the
        // state itself: "Not yet credited" (signed, points pending) and
        // the vendor's words (no other problem) are not denials of it.
        const negatedAt = (words, at, next = false) => {
          const before = words.slice(Math.max(0, at - 64), at)
          if (/(?:不|未|没|无|勿|别)[^。，；;！？!?]{0,3}$/.test(before)) return true
          const sentence = (before.split(/[.!?;！？。]/).pop() ?? "").replace(noErrors, "").replace(/\bno\s+(?:need|needed)\b/gi, "")
          if (/\b(?:\w+n['\u2019]t|not|never|no|without|unable|cannot)\b/i.test(sentence)) return true
          if (!next) return false
          const after = words.slice(at, at + 48).replace(noErrors, "")
          return /[.!?;！？。]\s*(?:(?:no[,\u2019，]*\s+)?not\s+yet(?!\s+(?:credited|added|applied|reflected|received|arrived|processed|updated|counted|recorded|granted|到账|发放|计入))|nope|尚未(?!\s*(?:到账|发放|计入|入账|到帐|收到|入包))|还没有(?!\s*(?:到账|发放|计入|入账|到帐|收到|入包))|没有(?:领取|签到|领过|领到|签过)?(?=[，,。.!?！？]|$)|否\b)/i.test(after)
        }


        // how long until the next attempt.
        const claimedWord = (words) => {
          const m = ALREADY_CLAIMED.exec(words)
          return Boolean(m) && !negatedAt(words, m.index, true) && !failedWords(words)
        }
        // The day's statement when the answer names both: whichever comes
        // first speaks for the day — "Already signed successfully today" is
        // the window's statement with the outcome appended (already claimed),
        // while the vendor's words is this attempt's claim with the
        // rule appended (claimed, and the credit is real).
        const alreadyFirst = (words) => {
          const a = ALREADY_CLAIMED.exec(words)
          if (!a) return false
          const s = new RegExp("成功(?!率)|\\bsucce(?:ss(?:ful(?:ly)?)?|ed(?:ed|ing|s)?)\\b(?!\\s+(?:rate|ratio)\\b)", "gi").exec(words)
          return !s || a.index < s.index
        }
        // successSaidIn is the vendor saying this attempt landed: a success
        // word, no failure word, and not negated. Shared by the 2xx and the
        // HTTP-error branches — the second used to read the 400-beside-a-wait
        // pair over this attempt's own claim, and a day that just landed
        // said `done` with no credit.
        // The negation may also open the next sentence: "Already signed
        // successfully today? No, not yet" is a denial of this attempt, the
        // same way "Already signed today? No, not yet" is of the day.
        const successSaidIn = (words) => successWord(words) && !failedWords(words) && !negatedAt(words, words.search(/成功(?!率)|\bsucce(?:ss(?:ful(?:ly)?)?|ed(?:ed|ing|s)?)\b/i), true)
        // deepRefusal is a refusal nested in the answer's data: {code:200,
        // message:"签到成功", data:{code:200, data:{code:500, …}}} or
        // {code:200, data:{data:{success:false}}}. A gateway wraps the
        // vendor's refusal and the outer layer repeats the success wording;
        // read off the outer words and code alone, the day settled at 0
        // points. The wrappers are read three levels deep, as the 2xx path
        // reads them, on every path.
        const deepRefusal = (body) => {
          let deep = body && typeof body === "object" && !Array.isArray(body) ? body : null
          for (let i = 0; i < 4 && deep; i++) {
            const inner = deep.data && typeof deep.data === "object" && !Array.isArray(deep.data) ? deep.data : null
            if (!inner) return null
            const innerCode = codeOf(inner.code)
            // `already_claimed` is the day's own statement, not a refusal:
            // read as one, a wrapped "Already signed today" was a failure
            // where the day was settled. The wording path judges it.
            const wordCode = errorCodeOf(inner)
            if (saidNo(inner.success) || refusedCode(innerCode) || (wordCode && wordCode !== "already_claimed")) return inner
            deep = inner
          }
          return null
        }
        // The refusal inside says what the outer layer could not: an expired
        // sign-in or an account restriction is the fix the user needs.
        const deepAnswer = (inner, fallback) => {
          const innerCode = codeOf(inner?.code)
          if (innerCode === 401 || innerCode === 403 || /^(?:invalid_token|token_expired|token_invalid|unauthorized)$/.test(errorCodeOf(inner) ?? "")) return { outcome: "failed", message: "登录已过期，请重新登录" }
          if (errorCodeOf(inner) === "account_restricted") return { outcome: "failed", message: "账号 API 访问受限（account_restricted），请联系科搭支持" }
          // the refusal's own words, not the outer layer's success sentence
          const saidInner = typeof inner?.message === "string" ? scrub(inner.message, token) : ""
          return { outcome: "failed", message: saidInner || fallback }
        }
        // A success word the sentence then denies ("…successful? No, not
        // yet") is no claim: the bare code:200 beside it used to settle the
        // day anyway, and the 2xx branch read it as a claim.
        const successDenied = (words) => successWord(words) && !failedWords(words) && negatedAt(words, words.search(/成功(?!率)|\bsucce(?:ss(?:ful(?:ly)?)?|ed(?:ed|ing|s)?)\b/i), true)

        // claimDenied is the day's statement said and then denied: the
        // "already claimed" wording appears, but a negation turns it into
        // "not claimed" ("You have not already claimed today", "Already
        // signed today? No, not yet"). Every road to a settled day has to
        // respect it — the wording (claimedWord), the 400-beside-a-wait pair
        // on both the 2xx and the HTTP-error path, and a bare code:200 —
        // because the pair alone settles a day the vendor said was not
        // claimed, and the card then reports a claim that never happened.
        const claimDenied = (words) => {
          const m = ALREADY_CLAIMED.exec(words)
          return Boolean(m) && negatedAt(words, m.index, true)
        }
        // waitIn says how long a refusal lasts, without saying it twice: request()
        // already wrote the header's Retry-After into the message it threw, and the
        // body's own retry_after would otherwise be appended beside it.
        // The card reads at most 400 code points (see scrub). A message that
        // appends its tail — the wait — after the cut pushed the whole line
        // past the cap, so the tail's room is reserved before the vendor's
        // words are cut.
        const capped = (said, tail) => cut(said, Math.max(0, 400 - [...tail].length)) + tail
        const waitIn = (said, secs) => capped(said, said.includes("后可重试") ? "" : `（约 ${humanSecs(secs)}后可重试）`)


        // alreadyAnswer reports a settled day: done, with the moment to come
        // back (until). The wait is the answer's own seconds, capped by what
        // checkinWaitSecs accepts, and the 30-minute trust floor when it gave
        // none: a rolling 24-hour window never names no wait at all, so an
        // answer of "done" without a wait is a vendor that did not say one.
        const alreadyAnswer = (secs) => {
          const wait = secs ? humanSecs(secs) : ""
          const hold = safeTime(Date.now() + (secs || 30 * 60) * 1000)
          return withFreeModels({
            outcome: "done",
            message: `今天已领过${wait ? `，${wait}后可再领` : ""}`,
            // hold is always non-zero; the condition is kept to be explicit:
            // "no until" is unacceptable on this path, and if it ever
            // happens it is omitted rather than reported as 0 and drawn as 1970.
            ...(hold ? { until: hold } : {}),
          })
        }

        // withFreeModels claims the vendor's one-time free-model campaign
        // beside the check-in. The check-in is the one moment this plugin acts
        // on the account on the user's behalf, and the campaign is the same
        // kind of act — its own page offers it as a button, and the claim
        // starts a usage window the user would otherwise have to remember to
        // open. It is best-effort: a campaign already claimed, none open, or
        // a refused call leaves the check-in's own answer exactly as it was,
        // because the check-in must never fail over an extra.
        //
        // A claim is a write, so it happens at most once per campaign per
        // process: the host can ask for the check-in twice at once, and a
        // campaign the vendor keeps reporting as available after a successful
        // claim would otherwise be posted again on every ask. The guard is
        // memory only — a new process simply asks the vendor again, which is
        // what its own answer is for.
        const withFreeModels = async (answer) => {
          let got = null
          try {
            got = await claimFreeModelsOnce(token, username, { fetchImpl, timeoutMs: Math.min(TIMEOUT_MS, left()) })
          } catch {
            got = null
          }
          if (!got) return answer
          // The card reads at most 400 code points (see scrub), so the
          // suffix's room is reserved before the vendor's words are cut —
          // otherwise a long sentence pushed the whole suffix off the line.
          const tail = "；已领取免费模型"
          return { ...answer, message: cut(String(answer.message ?? ""), Math.max(0, 400 - [...tail].length)) + tail }
        }

        // Points before claiming: the server's success answer carries no
        // points figure, and the credit this attempt lands is the difference
        // the balance read shows. The read happens before the claim so the
        // delta is this attempt's own; the card reports a number that can be
        // reported honestly. If unreadable, omit credit rather than report 0.
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
          // Account restriction and an expired sign-in both answer 403, but
          // the fix is completely different: the former means contacting the
          // vendor, only the latter means signing in again. Recognize the
          // vendor's account_restricted first, then the re-login case.
          if (restricted(e)) return { outcome: "failed", message: "账号 API 访问受限（account_restricted），请联系科搭支持" }
          if (signedOut(e)) return { outcome: "failed", message: "登录已过期，请重新登录" }
          // HTTP 400 can also mean "already claimed today": request() throws
          // on non-2xx first, and without handling this step a 400 with an
          // English message ("Already signed today") is read as a failure with
          // no until, and the host asks again every 30 minutes. The decision
          // is the same as the 200 branch below: the wording is recognized,
          // or business code 400 pairs with a readable retry_after — but when
          // the words name a failure (a rate limit, maintenance) neither
          // counts; that is "retry later", and reading
          // it as already claimed reports a failure as success and pushes the
          // next ask past those seconds.
          // The already-claimed pair is not tied to one HTTP status: a gateway or
          // proxy rewrites the vendor's 400 into a 409/422/429/500/503 and keeps
          // the body, and the body's own business code and words still say the
          // day was claimed. Reading only HTTP 400 there reported a failure,
          // dropped the wait, and sent magpie back every 30 minutes over a day
          // that was settled.
          const body = e?.body && typeof e.body === "object" ? e.body : null
          if (body) {
            // Both waits are read: the body's data.retry_after is what the
            // business layer said, the header's Retry-After is what the gateway
            // said. Without the header one, a claimed day fell back to the
            // 30-minute trust floor.
            const deepBody = unwrapped(body)
            const secs = checkinWaitSecs(body.data?.retry_after) || checkinWaitSecs(deepBody?.retry_after) || checkinWaitSecs(body.retry_after) || checkinWaitSecs(e.retryAfter)
            const words = saidBy(body) || saidBy(deepBody)
            const bc = codeOf(body.code)
            // The same success-first rule as the 2xx path below: an error body
            // whose success word comes first is this attempt's claim with the
            // rule appended, not the day already claimed — the pair
            // alone used to settle it as `done` over the vendor's own words,
            // dropping the credit. The success word (with the failure veto)
            // decides.
            // The explicit refusals come first, as they do on the 2xx path:
            // a success word beside success:false or a wrapped refusal is
            // how a rewritten answer looks, not a claim. An expiry or an
            // account restriction is the fix the user needs, whatever the
            // words say. A business code in words ({"code":"invalid_token"},
            // the vendor's own refusal spelling) is a refusal too: read as
            // "no code" it let a success word in the same body settle the day.
            const w = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : null
            const wCode = codeOf(w?.code)
            const wWord = errorCodeOf(w)
            const wRefused = Boolean(w) && (saidNo(w.success) || refusedCode(wCode) || Boolean(wWord && wWord !== "already_claimed"))
            const wordCode = errorCodeOf(body)
            const deniedFlat = saidNo(body.success) || wRefused || Boolean(wordCode && wordCode !== "already_claimed")
            const successSaid = successSaidIn(words)
            const deep = deepRefusal(body)
            if (deep) return deepAnswer(deep, (secs ? waitIn(scrub(whyOf(e), token), secs) : scrub(whyOf(e), token)) || "签到失败")
            // On the error branch a success word is this attempt's claim only
            // when the body also states a business code that can carry one:
            // 200 (the business layer said yes, whatever the hop in front of it
            // answered) or 400 (the layer refused while the body said the claim
            // landed, with the window's rule appended). A bare success word
            // beside an HTTP error is not a claim — a gateway shell that
            // happens to contain it, or a server that repeated the word while
            // failing, would otherwise settle the day and stop magpie asking.
            const claimFirst = successSaid && !alreadyFirst(words) && (bc === 200 || bc === 400)
            if (bc === 401 || bc === 403 || /^(?:invalid_token|token_expired|token_invalid|unauthorized)$/.test(wordCode)) return { outcome: "failed", message: "登录已过期，请重新登录" }
            if (wordCode === "account_restricted") return { outcome: "failed", message: "账号 API 访问受限（account_restricted），请联系科搭支持" }
            // The 400-beside-a-wait pair: the vendor's "already claimed" in its
            // usual shape. A failure word still vetoes it (risk control and
            // rate limits answer 400 with seconds too), and so does a success
            // word that comes first (that is this attempt's claim, below).
            // success:false, a wrapped refusal and a code in words veto it too.
            // successDenied is successSaidIn's exact complement (same word,
            // same veto, same negation), so claimFirst already says the
            // sentence was not denied; the denial is read here only for the
            // branch below, which answers the paths that do not claim.
            const deniedSaid = successDenied(words)
            const pair = bc === 400 && secs && !failedWords(words) && !claimFirst && !claimDenied(words) && !deniedFlat
            if (claimFirst && !claimDenied(words) && !deniedFlat) return withFreeModels({ outcome: "claimed", ...(secs ? { until: safeTime(Date.now() + secs * 1000) } : {}), message: scrub(words, token) || "签到成功" })
            if (pair) return alreadyAnswer(secs)
            if (deniedSaid) return { outcome: "failed", message: (secs ? waitIn(scrub(whyOf(e), token), secs) : scrub(whyOf(e), token)) || "签到失败" }
            // The words that name the day ("24小时内仅可领取一次") are the day's
            // statement on the codes that can carry it: 200 (it already went
            // through), 400 (today's wording), or no code. A flat
            // success:false beside them is the same flag the 2xx branch lets
            // the day's words win over (the vendor's activity flag says "this
            // call", the sentence says "this day"); a refusal wrapped in
            // `data` or a code in words still vetoes, as it does there.
            const claimStated = claimedWord(words) && !wRefused && !(wordCode && wordCode !== "already_claimed") && (bc === 400 || bc === 200 || Number.isNaN(bc))
            if (claimStated) return alreadyAnswer(secs)
            if (deniedFlat) return { outcome: "failed", message: (secs ? waitIn(scrub(whyOf(e), token), secs) : scrub(whyOf(e), token)) || "签到失败" }
            if (secs) return { outcome: "failed", message: waitIn(scrub(whyOf(e), token), secs) }
          }
          return { outcome: "failed", message: scrub(whyOf(e), token) || "签到失败" }
        }

        const code = codeOf(r?.code) // an object code must not throw (see pointsOf)
        // The success criterion matches the vendor client (app.asar's k0 only
        // calls ft): a numeric code other than 200 is a refusal, and a
        // response without a code counts as claimed — today's success
        // response carries code:200, but this vendor's activity endpoint
        // carries no code at all (only {data,message,success}), and someday
        // check-in may omit it too; recognizing only 200 would report a
        // claimed day as a failure.
        //
        // No models on the window: aside windows do not enter routing
        // (magpie's allowanceOf skips aside/text first), and the GUI has no
        // such field to draw; and once the host sees models on any window it
        // leaves the whole card out of quotas.json (quota_last.go's keepLast,
        // "a pool that can't be written down isn't kept"), so the account
        // loses its last reading across restarts. The model names are in the
        // window's name already.
        // claimed. It says "today", not "this attempt", so it may or may not
        // carry a code: 400 is today's spelling, but no code (the activity
        // endpoint's shape) says the same thing. The wording is read the way
        // the client reads it (saidBy, 8 spellings). This must be checked
        // first: it is a statement about "the day", and overrides any
        // per-attempt flag below (see the success:false section).
        //
        // Either test counts as the day already claimed: the wording is
        // recognized (Chinese and English, see ALREADY_CLAIMED), or the "400
        // plus a readable retry_after" pair — in a rolling 24-hour window,
        // a 400 that also gives seconds until the next claim is almost
        // certainly the day already claimed. When the wording is not
        // recognized (different language, different phrasing, or long noise
        // before the 400 line), the pair still works. The wording check
        // runs on un-truncated text: said is the card-safe 400-character
        // version, and if the vendor's statement is at the end, the full
        // sentence is lost.
        // The wrappers are read as deep as deepRefusal reads them: a body
        // that carries the day's sentence two `data` levels in said it just
        // the same, and reading only the outer envelope read it as a claim.
        const deepWords = saidBy(unwrapped(r))
        const words = saidBy(r) || deepWords
        const said = scrub(words, token)
        // The vendor wraps a refusal in `data` on every other reader (points,
        // the status row, activities, the catalog): {code:200, data:{code:500}}
        // or {code:200, data:{success:false}} is HTTP yes, business no. The
        // check-in answer is flat today ({code, message, data}), but reading
        // only the envelope would settle such a refusal as a claim — the day
        // is recorded, credit is read off a balance that never grew, and the
        // host stops asking. A wrapped refusal is a refusal here too: an inner
        // 401/403 is an expired sign-in, any other non-200 code or a
        // success:false is a check-in failure. The inner wrapper is only read when it
        // is an object and not the answer's own data list (the sign-in may
        // carry data the plugin does not read, like today's retry_after).
        const wrapped = r?.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : null
        const wrappedCode = codeOf(wrapped?.code)
        // `already_claimed` is the day's own statement, not a refusal (the
        // wording path below decides what it means); every other word code
        // under `data` is a refusal.
        const wrappedWord = errorCodeOf(wrapped)
        const wrappedRefused = wrapped && (saidNo(wrapped.success) || refusedCode(wrappedCode) || Boolean(wrappedWord && wrappedWord !== "already_claimed"))
        // The card line: the vendor's words cut to leave the wait's room.
        const saidCard = (tail) => capped(said, tail)
        // Both waits: the body's data.retry_after is what the business layer
        // said, and a 2xx answer's Retry-After header is what the gateway said
        // (request() keeps it beside the body — see headerWaitOf). Without the
        // header one, a refusal the body spells without seconds lost the wait
        // the gateway stated.
        const earlySecs = checkinWaitSecs(r?.data?.retry_after) || checkinWaitSecs(unwrapped(r)?.retry_after) || checkinWaitSecs(r?.retry_after) || checkinWaitSecs(headerWaitOf(r))
        // If a failure answer still gives seconds until the next try
        // (business codes 429/503 often do), the card states them — the user
        // need not wait for magpie's next ask. The HTTP-layer Retry-After is
        // already in the message via request(); this fills in the half where
        // HTTP is 200 and the business code refuses in the body. A vendor that
        // already wrote a concrete wait into its own words ("please retry in
        // 10 minutes") gets no second copy: wroteWait sees that wording and
        // waitSaid stays empty, so the card keeps the vendor's own sentence
        // with its own wait, and never states the same wait twice.
        const wroteWait = /(?:retry|try)\s+(?:again|later)|[0-9]+\s*(?:分钟|小时|秒)后/i.test(words)
        const waitSaid = earlySecs ? (wroteWait ? "" : `（约 ${humanSecs(earlySecs)}后可重试）`) : ""
        // The "400 plus a readable retry_after" pair only counts on 400, and
        // only when the wording does not say failure: the vendor's risk
        // control and rate limits also answer 400 with seconds, and that is
        // "retry later", not "already claimed today". A 200 answer with no
        // code that carries seconds proves nothing (gateway shells and
        // announcements elsewhere can look like that). Recognized wording is
        // counted separately (see wordsSaid).
        // success:false is the vendor's explicit refusal; the 400-beside-a-wait
        // pair is weaker evidence and does not override it (words that name the
        // claim itself do — see wordsSaid).
        const refused = code === 400 && !failedWords(words) && !saidNo(r?.success) && !claimDenied(words)
        // The words say the day is claimed on the codes that can carry that
        // statement: 200 (it already went through), 400 (today's wording),
        // or no code at all. They do not on a 500/503 — that is a server
        // failure that happened to repeat the sentence, and reading it as
        // `done` would settle the day off an error. 401/403 keep meaning
        // "sign in again", never a claim. A 200 beside the words is the one
        // shape that used to fall through to "just claimed" with a credit of
        // 0 over a day that was already settled.
        // Same veto as the HTTP branch above: a sentence that also says the

        // statement, however clearly it names the window — reading it as
        // `done` settles a day that was never claimed.
// A sentence that says both the vendor's words and the window rule is this
        // attempt's claim with the rule appended; reading it as the day already
        // claimed threw away the credit and the vendor's own words. The success
        // word (with the failure veto) decides that, so it is read first.
        const successSaid = successSaidIn(words)
        const wordsSaid = claimedWord(words) && alreadyFirst(words) && (code === 400 || code === 200 || Number.isNaN(code))
        // The 400-beside-a-wait pair counts as "already claimed" only when the
        // words do not name this attempt's success: a vendor that answers
        // "Already signed today" beside this attempt's own "签到成功" is
        // telling two things at once, and the success word is this attempt's
        // claim and appending the rule, and reading the pair
        // over the words turned a real claim into `done`, dropped the credit,
        // and replaced the vendor's own sentence. The ordering check cannot see
        // it — ALREADY_CLAIMED does not match the 24-hour phrasing — so the
        // success word (with the failure veto, the same one the code gate
        // below exempts) has to veto the pair here too.
        const claimFirst = successSaid && !alreadyFirst(words)
        const already = wordsSaid || (refused && Boolean(earlySecs) && !claimFirst)
        // When the answer states the vendor's business code
        // account_restricted in the body, say this first: it is not tied to
        // an HTTP status — a gateway answers 403 today, and may one day put
        // this word beside 200. This is not expiry; re-login does not fix it
        // (the same decision as in the catch above).
        if (errorCodeOf(r) === "account_restricted") return { outcome: "failed", message: "账号 API 访问受限（account_restricted），请联系科搭支持" }
        // …and when a gateway stripped the code but left the vendor's sentence
        // in a 2xx body, that sentence is still the restriction: read as a claim
        // the card says the day was claimed while chat is refused.
        if (restricted({ message: words })) return { outcome: "failed", message: "账号 API 访问受限（account_restricted），请联系科搭支持" }
        // A business code in words is a refusal, as in the catch above: read
        // as "no code" it let the answer's success word settle the day.
        const wordCode = errorCodeOf(r)
        if (wordCode && wordCode !== "already_claimed") {
          if (/^(?:invalid_token|token_expired|token_invalid|unauthorized)$/.test(wordCode) || code === 401 || code === 403) return { outcome: "failed", message: "登录已过期，请重新登录" }
          if (wordCode === "account_restricted") return { outcome: "failed", message: "账号 API 访问受限（account_restricted），请联系科搭支持" }
          return { outcome: "failed", message: saidCard(waitSaid) || "签到失败" }
        }
        // A refusal one wrapper deeper than `data` ({data:{data:{code:500,
        // success:false}}}): the envelope says 200 and the refusal is two
        // levels in; read as a claim it settled the day at 0 points.
        const deep = deepRefusal(r)
        if (deep) return deepAnswer(deep, saidCard(waitSaid) || "签到失败")
        // 401/403 is an expired sign-in (or an account restriction), and what
        // the user sees is the fix, not a code — also read before
        // success:false: in `{code:401, success:false}` the success:false is
        // a flag the expiry answer carries along, and it must not override
        // the re-login sentence with the vendor's wording. Account restriction and
        // expiry both answer 403 but have different fixes (see the catch
        // above).
        if (code === 401 || code === 403) return { outcome: "failed", message: "登录已过期，请重新登录" }
        // A refusal wrapped in `data` (see wrappedRefused above): an inner
        // 401/403 is an expired sign-in, anything else a check-in failure. Read after
        // the envelope's own 401/403 so the fix the user sees is the envelope's,
        // and before success:false so a wrapped success:false is reported the
        // same way as the flat one.
        if (wrappedRefused) {
          if (wrappedCode === 401 || wrappedCode === 403) return { outcome: "failed", message: "登录已过期，请重新登录" }
          if (errorCodeOf(wrapped) === "account_restricted") return { outcome: "failed", message: "账号 API 访问受限（account_restricted），请联系科搭支持" }
          return { outcome: "failed", message: saidCard(waitSaid) || (Number.isFinite(wrappedCode) ? `签到失败（code ${wrappedCode}）` : "签到失败") }
        }
        // One place does not follow the client: when the answer itself says
        // `success: false` (the flag the vendor uses on its activity
        // endpoint), it is a failure whether or not a code is present —
        // code:200 beside success:false is exactly "the HTTP layer says yes,
        // the business layer says no".
        //
        // The exception is the already-claimed answer: when its words name
        // the day and it also carries success:false, the day really was
        // claimed and this call really did not land — both are true. Reading
        // it as failed costs more on this side: magpie re-asks a failed day
        // every 30 minutes (workbuddy_checkin.go's wbCheckinRetry) while the
        // claimed answer is kept until the moment the vendor stated. No
        // balance read for credit on a refusal — credit is for a claim that
        // actually landed.
        if (saidNo(r?.success) && !already) return { outcome: "failed", message: saidCard(waitSaid) || (Number.isFinite(code) ? `签到失败（code ${code}）` : "签到失败") }

        // The code gate follows the vendor's client, which only treats a
        // non-200 number as failure. A 400 that spells this attempt's success
        // (a success word, then the window rule)
        // is this attempt's claim, not a refusal: the success word decides, as
        // the order rule above says. Other codes keep refusing — a 500 that
        // happens to carry a success word is still a server failure.
        if (refusedCode(code) && !already && !(code === 400 && successSaid)) return { outcome: "failed", message: saidCard(waitSaid) || `签到失败（code ${code}）` }
        if (already) return alreadyAnswer(earlySecs)
        // At this point, only two shapes can still be a real claim: code:200,
        // or a code-less answer with success:true (the vendor's activity
        // endpoint has this shape). The gap between them: a 200 answer that
        // carries neither code 200 nor success, with no "success" in the
        // wording either — that says nothing at all; a gateway shell or a
        // maintenance announcement can look like that. Reading it as claimed
        // settles the day at 0 points and the host stops asking; so a claim
        // must have a definite positive signal, and everything else is truthfully
        // reported as failure so the host asks again later.
        // Success words must override negations (see failedWords above): a
        // message with both a success word and a failure word in natural
        // language is read as failure.
        // A code-200 body is not exempt from the failure words an HTTP 400 body
// is: the client reads 200 as success, but the vendor's words beside
        // code 200 is still a refusal this attempt did not land, and reading it
        // as claimed settles the day at zero points. The code and the flag stop
        // being enough the moment the words say otherwise.
        // The success flag is a road to a settled day like code:200, so the
        // denial gates it too (see claimDenied): a success flag beside "You
        // have not already claimed today" used to settle the day as claimed.
        const positive = ((code === 200 || r?.success === true) && !claimDenied(words) && !successDenied(words)) && !failedWords(words)
        if (!(positive || successSaid))
          return { outcome: "failed", message: saidCard(waitSaid) || "签到失败（应答没有说明结果）" }
        // Read balance for credit (the difference at two points, counting only
        // non-decreases). Report whatever was read, omit if unreadable; do
        // not fabricate 0.
        // credit is the balance growth across the claim, and it exists only
        // when both reads were readable: reporting 0 for an unreadable side
        // says the claim gained nothing, which is not what we know. When it
        // cannot be computed, credit stays absent and the card reports the
        // claim with no number, which is the truth.
        let credit = null
        try {
          const after = await pointsOf(token, username, { fetchImpl, timeoutMs: Math.min(TIMEOUT_MS, left()) })
          const grew = (was, now) => (was == null || now == null ? null : Math.max(0, now - was))
          const general = grew(before?.general, after?.general)
          const agent = grew(before?.agent, after?.agent)
          // Both halves are finite non-negative JSON numbers; their sum can
          // still leave the double range (1e308 + 1e308 is Infinity), and a
          // credit the host cannot carry is JSON.stringify(Infinity) → null on
          // the wire. An unstatable sum is an unread credit, not 0.
          const sum = general != null && agent != null ? general + agent : null
          if (Number.isFinite(sum) && sum >= 0) credit = sum
        } catch {
          // If the difference is unreadable, don't report credit
        }
        // The claim answer carries until too, when the vendor stated the next
        // window beside the success: the README promises "the answer reports
        // the claim ... and carries until", and without it magpie fell back to
        // its own 30-minute cadence until the next answer said otherwise.
        return withFreeModels({
          outcome: "claimed",
          ...(credit != null ? { credit } : {}),
          ...(earlySecs ? { until: safeTime(Date.now() + earlySecs * 1000) } : {}),
          message: signMessage(r, token) || "签到成功",
        })
      },

      // Usage: point balance + today's check-in state + free model activities
      // (omit what can't be fetched).
      async usage(getAuth) {
        let auth, token
        try {
          auth = await getAuth()
          token = tokenOf(auth)
        } catch (e) {
          // token is not read yet on this path (getAuth failed): the key the
          // auth callback did answer with, as the check-in's catch cuts by.
          const why = restricted(e) ? "账号 API 访问受限（account_restricted），请联系科搭支持" : scrub(whyOf(e), token ?? auth?.key) || "用量查询失败"
          return { error: why, signIn: restricted(e) ? "" : signedOut(e) ? "expired" : "" }
        }
        if (!token)
          return { error: unusableKey(auth) ? "令牌内容无法识别（含空格、换行或非 ASCII 字符），请重新登录" : "没有登录信息，请先登录", signIn: "" }
        const username = usernameOf(token)
        if (!username) return { error: "令牌里没有账号名，请重新登录", signIn: "" }
        if (expired(token)) return { error: "登录已过期，请重新登录", signIn: "expired" }

        const deadline = Date.now() + USAGE_BUDGET_MS
        const left = () => Math.max(1000, deadline - Date.now())
        const opts = () => ({ fetchImpl, timeoutMs: Math.min(TIMEOUT_MS, left()) })

        // Four reads are independent, fire them together (the vendor's own
        // client does the same: app.asar's S0 uses allSettled on
        // /v1/gettoken, /v1/agent/balance, /api/user/self): the card waits
        // for the slowest, not the sum of all four, and the worst case is
        // one TIMEOUT_MS — the plugin's usage budget does not cover the host's
        // time before the hook (see the time comment at file header), so the
        // slower the hook, the less left for it. Points being unreadable means
        // the whole card is wrong (balance is the primary item); the other two
        // are additional info and omitted when unreadable.
        const [pointsR, agentR, statusR, actsR] = await Promise.allSettled([
          pointsOf(token, username, opts()),
          agentPointsOf(token, username, opts()),
          request(`${ACCOUNT}${SIGN_STATUS_PATH}`, { method: "POST", body: { username }, token, ...opts() }),
          request(`${API}${ACTIVITIES_PATH}`, { method: "GET", token, ...opts() }),
        ])

        // pointsError is the reason "one card item could not be read". When
        // magpie's card sees error, it draws only that line and no windows
        // (assets/kernel.js's pqLine / quotaWindows), so it is not a "partly
        // read" marker: when part is read, draw the part that was read; only
        // when no points at all were read does the whole card become one
        // error line.
        let points
        if (pointsR.status === "fulfilled") {
          points = pointsR.value
          // General points and Agent points are two reads: use what gettoken
          // gives, fall back to /v1/agent/balance only when it does not (the
          // i.agentPoints ?? cm value in S0). If the other read fails, treat
          // it as unspecified; it does not affect what gettoken answered.
          if (points.agent == null && agentR.status === "fulfilled") points.agent = agentR.value
          // a restriction on the second read is the account's answer even when
          // the first read worked; an expiry there is not (the token was just
          // accepted), so the agent figure is simply left unspecified.
          if (agentR.status === "rejected" && restricted(agentR.reason))
            return { error: "账号 API 访问受限（account_restricted），请联系科搭支持", signIn: "" }
        } else {
          const e = pointsR.reason
          // An expired sign-in is the whole card's answer: the other two reads
          // would say the same, retrying elsewhere does not help, and the only
          // thing the user can do is sign in again. Keep this the original
          // sentence; do not turn it into a code. Account restriction (403
          // account_restricted) is not expiry and re-login does not fix it;
          // say it the way the vendor does.
          if (restricted(e)) return { error: "账号 API 访问受限（account_restricted），请联系科搭支持", signIn: "" }
          if (signedOut(e)) return { error: "登录已过期，请重新登录", signIn: "expired" }
          // The general-points read failed: if the other balance endpoint
          // answered an Agent number, still draw the check-in row, activities
          // and Agent points — skip the wallet row, since general points are
          // unspecified this time; inventing a 0 would make routing rank a
          // funded account last. Only when both reads fail is the whole card
          // one error line.
          // the second balance read is the other half of the same account:
          // its restriction or expiry is the account's answer, not one row's.
          // Swallowed before, the card reported the first read's 500 while
          // the account was actually restricted or signed out.
          if (agentR.status === "rejected" && restricted(agentR.reason))
            return { error: "账号 API 访问受限（account_restricted），请联系科搭支持", signIn: "" }
          if (agentR.status === "rejected" && signedOut(agentR.reason))
            return { error: "登录已过期，请重新登录", signIn: "expired" }
          const agent = agentR.status === "fulfilled" ? agentR.value : null
          if (agent == null) return { error: scrub(whyOf(e), token) || "点数查询失败", signIn: "" }
          points = { general: null, agent }
        }

        const windows = []

        // Today's check-in: claimable again at this time tomorrow. When the
        // wait is over (retry_after 0) this row must still be there — that is
        // exactly the "claimable now" moment, and the old secs > 0 form made
        // it disappear. No used: check-in is not a quota that gets used up;
        // magpie's plugin_usage.go marks an aside row without a share as Text

        // as a 100% progress bar.
        //
        // The state is read the way the vendor's app does (app.asar's um):
        // data can be that boolean, or an object naming it (four spellings);
        // both shapes draw this row, all other shapes draw nothing. Its code
        // gate comes first: the vendor also calls ft first when it calls the
        // status endpoint (a numeric code other than 200 counts as failure),
        // then um reads the answer. Recognizing data alone would draw a
        // signed row out of an answer the vendor counts as a failure, at a
        // moment the vendor itself would only say the query failed. This row
        // is supplementary: if it cannot be drawn, skip it and the card still
        // reports points.
        // An explicit success:false is no answer about the state, whatever
        // its data echoes: the row is supplementary, so it is skipped.
        const status = statusR.status === "fulfilled" ? statusR.value : null
        // The gates read the envelope and every wrapper the vendor put around
        // it: a refusal arrives in the same wrapper as a success
        // ({data:{code:500,…}}, {data:{success:false,…}}) and the state fields
        // sit beside it — read without the wrapped gates, a failed answer drew
        // a signed row. A {data:{data:{code:500, isSigned:true}}} passed a
        // first-level gate and was drawn as a signed day, so the walk goes as
        // deep as the check-in's.
        const refusedInChain = (node) => {
          for (let i = 0; node && typeof node === "object" && !Array.isArray(node) && i < 4; i++) {
            if (saidNo(node.success) || refusedCode(codeOf(node.code)) || Boolean(errorCodeOf(node))) return true
            node = node.data
          }
          return false
        }
        const statusRefused = refusedInChain(status)
        // The state may sit one or more `data` wrappers down; the deepest
        // object that still is one is the state's own body (a boolean data
        // is the state itself and is not descended into).
        const data = statusRefused ? undefined : status?.data && typeof status.data === "object" && !Array.isArray(status.data) ? unwrapped(status) : status?.data
        // The state itself has to be said: a boolean, or an object naming one
        // of the four spellings the vendor's client reads. A plain `{}` names
// nothing, and drawing the vendor's words over it offered a claim
        // the account may not have. An array is "an object" too, and is not a
        // state either.
        const signed = signStateOf(data)
        if (signed !== null) {
          // Seconds must first be statable, and within what check-in can
          // state: when not (absent, 0, or too large for the calendar to
          // write), there is no moment to report, and the wording and
          // resetsAt are both omitted. The host's when(0) draws 0 as
          // 1970-01-01 rather than treating it as "not said". See
          // checkinWaitSecs and safeTime.
          // The first wait that can be stated: the wrapped body's, the
          // answer's own, the gateway's Retry-After header. One unreadable
          // value does not hide a readable one behind it.
          const secs = checkinWaitSecs(data && typeof data === "object" ? data.retry_after : undefined) ||
            checkinWaitSecs(status?.retry_after) ||
            checkinWaitSecs(headerWaitOf(status))
          const wait = secs ? humanSecs(secs) : ""
          windows.push({
            name: "每日签到",
            ...(secs ? { resetsAt: safeTime(Date.now() + secs * 1000) } : {}),
            display: signed ? (wait ? `今天已领，${wait}后可再领` : "今天已领") : wait ? `今天还没领，${wait}后可以领` : "今天还没领，现在可以领",
            aside: true,
          })
        }

        // Points balance: what the account actually spends. It is a prepaid
        // wallet with no "total" to take a share of, so report it as a wallet
        // reading (balance, magpie's #3950) instead of inventing a
        // percentage. magpie uses it to turn this account from "remaining
        // quota unknown" into known: the routing page says exactly how many
        // points remain instead of ranking the account after known ones. It
        // is not scoped per model — free models during an activity do not
        // spend points now but do once it ends, and at zero points magpie
        // only ranks the account last (spent), it does not refuse it.
        // The window's balance must be understood by both the host and magpie
        // (since magpie 0.1.1790, issue #3950; the 0.1.1822 in an early
        // comment was a version misremembered during review); older versions
        // (such as 0.1.1788) only show it as a text row — the reading is not
        // lost, routing just stays unknown for now.
        if (points.general != null) {
          windows.push({
            name: "点数余额",
            balance: points.general,
            unit: "点",
            display: `${points.general} 点`,
          })
        }

        // Free model activities: until when it is free, and usage when the
        // vendor gave a total. A null remaining_quota means unlimited — it
        // never runs out, so there is no share that can be reported honestly,
        // and the host shows it as a text row. user_quota_limit is the total
        // this activity grants; only with a total are amount/limit the two
        // real numbers "used / total", rather than reporting the remaining
        // as the total. aside means "running out does not stop the account":
        // running out only returns to points billing, and the account keeps
        // working.
        //
        // No models on the window: aside windows do not enter routing
        // (magpie's allowanceOf skips aside/text first), and the GUI has no
        // field to draw; and once the host sees models on any window, it
        // excludes the whole card from quotas.json (quota_last.go's
        // keepLast, "a pool that can't be written down isn't kept"), so the
        // account loses its cross-restart "last reading". The model names are
        // already in the window name.
        if (actsR.status === "fulfilled") {
          const running = runningActivities(actsR.value)
          // The card only fits a few rows, and this answer becomes one JSON
          // line in the host: when the vendor reports too many activities at
          // once, take only the first few — the data must not blow past the
          // host's 32 MiB line.
          for (const a of running.slice(0, MAX_ACTIVITY_WINDOWS)) {
            // The token is cut out of the raw id before cleanText truncates
            // it (a 134-character token became 120 characters on the card when
            // the order was reversed), and only the two the name shows are
            // cleaned: an activity can carry a huge model_ids array, and the
            // rest is only counted.
            const rawIds = Array.isArray(a.model_ids) ? a.model_ids.filter((x) => typeof x === "string" && x.trim()) : []
            // a piece of the token is not a model name: the whole-token cut
            // sees nothing in a split, and the two ids the name joins are
            // exactly where a split echo lands. A hit becomes "…" rather than
            // a fragment on the card — for the ids the name shows, and for
            // every id the activity lists: pieces spread over ids past the
            // two shown spell the token too, and this card is the only place
            // they would reach a reader.
            // A whole copy in one id is cut below ("…"); what this reads is
            // the pieces. An id holding a run of the token is left out of the
            // join rather than falling on it: it is cut whichever way this
            // goes, and read in the join its long run would hide the split
            // (LABEL_CHARS is the gap between pieces, not a field's length).
            // The split is the first few hundred ids at most: the token has
            // ~130 characters, and an encoding of it is at most three times
            // that long, so no split reaches past 512 fields in list order.
            const pieces = rawIds.slice(0, 512).filter((x) => !echoesKey(x, token))
            if (token && pieces.length > 1 && (splitAcross(pieces.join(""), token) || splitFields(pieces, token))) continue
            const ids = rawIds.slice(0, 2).map((x) => {
              const cutId = cutKey(x, token)
              return echoesKey(x, token) || decodedCarriesKey(x, token) || scrubShapes(cutId, token) !== cutId ? "…" : cleanText(cutId)
            })
            const idCount = rawIds.length
            // Both numbers must be finite: 1e999 is valid JSON but reads as
            // Infinity, and using it for a share yields NaN, making the card

            const capSaid = numOf(a.user_quota_limit)
            const cap = Number.isFinite(capSaid) && capSaid > 0 ? capSaid : null
            // named for what it is: `left` would shadow the usage hook's own
            // left() budget function two scopes up, and the next caller of
            // opts() in here would get a TypeError instead of a timeout
            const leftSaid = numOf(a.remaining_quota)
            const quotaLeft = Number.isFinite(leftSaid) ? leftSaid : null

            // used is computed only when both numbers are there and agree:
            // when the remaining exceeds the total, the two numbers describe
            // two different things (the vendor reported the pool, not this
            // activity), and subtracting only produces a 0 — the card would
            // say "used 0 / 100" while the vendor says 150 left. Better to
            // state the remaining as given.
            const used = cap != null && quotaLeft != null && quotaLeft <= cap ? cap - quotaLeft : null
            // used is a share (0–100), read literally by the host; a window
            // where no share can be computed omits this field instead of
            // reporting 0% — the host's contract separates the two clearly
            // ("left out: the plugin didn't say, which is no share and not
            // 0%"), and a 0 there says "0% used" when what is true is
            // precisely "there is no share to state". When omitted, this row
            // is drawn as text like the check-in row.
            const share = used != null && cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : null
            // If the activity's end time (also seconds) is unreadable, omit
            // resetsAt: still report the activity — it is running, it just
            // did not say when it ends (safeTime yields 0).
            const freeUntil = safeTime(secsOf(a.free_until) * 1000)
            windows.push({
              name: ids.length ? `免费模型 · ${ids.join("、")}${idCount > 2 ? ` 等 ${idCount} 个` : ""}` : "免费模型",
              ...(share != null ? { used: share } : {}),
              ...(freeUntil ? { resetsAt: freeUntil } : {}),
              // State the total when it is statable: a missing
              // remaining_quota does not mean the activity is "unlimited" —
              // the vendor's user_quota_limit says exactly how much in black
              // and white. Only when both numbers are absent is it
              // "unlimited" (today's shape in production).
              display: quotaLeft == null ? (cap == null ? "免费使用中（不限量）" : `免费使用中，共 ${cap}`) : used == null ? `免费使用中，还剩 ${quotaLeft}` : `免费使用中，已用 ${used} / ${cap}`,
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

    // provider: the catalog refreshes with the account. If unavailable, use
    // the copy in config (catalog.mjs).
    //
    // The host hands over the whole provider (the model table is under its
    // .models), and only that table should go back: host.js uses the hook's
    // return value directly as models, so returning the whole provider makes
    // it list id/name/api as models (measured: with an expired token, 16
    // became 26, with two extra entries, searches and models).
    provider: {
      id: ID,
      async models(provider, options = {}) {
        // `{ auth } = {}` throws on an explicit null, and a provider whose
        // models table came back as an array (the shape the host persists) has
        // no entries to hand back: both are read as "nothing given" rather
        // than throwing out of the hook, which would take the whole provider
        // list down.
        const raw = provider?.models
        // Only model records are handed on: one null or string entry in the
        // user's table would make the host's Promise.all over the model maps
        // throw and take every provider down, and the config hook already
        // drops the same entries.
        // One shape for every road out of this hook, the early returns
        // included: id-named properties dropped (the host's next step on the
        // list is a bracket assignment), and each surviving entry carrying
        // its id, which the host builds the row from and an older save (or a
        // hand-written file) may lack.
        // A clean table is a fresh map (every entry carries its id, no
        // id-named key). A table that is already clean and unfrozen is handed
        // back as the very object the host gave — the host reads a failed
        // fetch by identity (the list it gave back unchanged) — with the
        // fallback marker on it. That is one map the host asked for, edited,
        // and it arrives frozen over an RPC: markTable gives back a copy then.
        const normalized = normalizeModels(raw)
        let given = normalized
        if (raw && typeof raw === "object" && !Array.isArray(raw) && sameTable(raw, normalized)) given = raw
        // What the fallback hands back: the host's own table when it carried
        // nothing a model must not have, else the clean copy — a null entry
        // in the host's table would still throw where the host reads it.
        const safeGiven = given === raw && rawHasOnlyRecords(raw) ? raw : normalized
        // What the host handed in, as it handed it (see the catch below).
        const we = { given: raw }
        const token = tokenOf(options && typeof options === "object" ? options.auth : undefined)
        if (!token || expired(token)) return given
        try {
          // The app's Electron main process reads the catalog (main.cjs's
          // auth-request allowlist includes /v1/codar/models), using Node's
          // default UA; the Go UA is only used for chat (sent by the sidecar).
          const body = await request(`${API}${CATALOG_PATH}`, { method: "GET", token, fetchImpl })
          // The key goes to catalogOf so the token is cut out of the raw
          // strings, before their 120-character clean: a record whose id
          // echoes the token is dropped there (an id that has to be renamed
          // is not an id a request can ask for), and a name is cut and kept.
          const list = catalogOf(body, token)
          if (!list) throw new Error("the vendor's catalog was not a list")
          // If the vendor one day states a concurrency in the catalog, queue
          // by it (see vendorConcurrency above). Only change it when the
          // catalog really states a number: publishedConcurrency answers 0
          // for a catalog that says nothing, and assigning unconditionally
          // would wipe it back to the default 3 — so a vendor that once gave
          // 7 and later omits the field once (a proxy-built catalog, a vendor
          // canary) would quietly drop the limit back to 3. A missing field
          // does not say "1" or "3".
          const statedConcurrency = publishedConcurrency(body)
          if (statedConcurrency) vendorConcurrency = statedConcurrency
          // The vendor's catalog has the final say on its own models; entries
          // the user added to this provider themselves (ids not in the
          // embedded catalog) survive the refresh, and the config hook merges
          // the same way. Where each model is sent keeps the address the host
          // already resolved (the api the user may have set, possibly a
          // self-hosted proxy), see apiBase.
          const known = new Set(CATALOG.map((m) => m.id))
          // Each surviving user entry carries its id, as the config hook writes
          // it: the host builds a row from m.id, and an entry saved by an older
          // version (or written by hand) may lack it.
          const own = Object.fromEntries(Object.entries(given).filter(([id]) => !known.has(id)))
          // If the vendor catalog has a record with id `__proto__`, it is an
          // own key after fromEntries/spread (it does not pollute this table),
          // but the host's next step with this list is bracket assignment
          // `out.models[key] = …` — and that writes the prototype. No model is
          // named that, so dropping it costs nothing (see noMagicKeys).
          // The host reads maxConcurrency once, when it starts; a catalog
          // that comes back this run asks for fewer than what is in use. It
          // is recorded, for the next start (the README says so).
          // What a live record states beyond the catalog file's fields (the
          // vendor's rate) reaches the host here: modelOf carries it, and
          // only this hook's answer is read for it (host.js's config-model
          // path copies its own key list, which has no rate).
          const merged = noMagicKeys({ ...own, ...modelsOf(list, (id) => apiBase(provider, id)) })
          // The records read together: a token split into pieces narrower
          // than a window, each with a label of its own, leaves no record
          // carrying a run — but the pieces in order are the token, and it
          // takes three of its runs from different parts to say so (see
          // splitAcross). Dropping every name (they fall back to their ids)
          // is the cost of finding one.
          if (echoesIn(Object.values(merged).map((m) => String(m?.name ?? "")), token)) {
            for (const m of Object.values(merged)) if (m && typeof m === "object") m.name = m.id
          }
          return merged
        } catch {
          // The host asks the same question its own way: the table it handed
          // in is a JSON copy (`given !== we.given`), so a hook that gave it
          // back after a failed fetch would not read as a fallback. Hand back
          // the copy the host gave and it does — magpie then keeps the list
          // it had instead of replacing the account's models with the
          // embedded catalog over an outage. The marker says why for a host
          // that reads it; the identity is what keeps the fallback a fallback.
          return markFallback(safeGiven)
        }
      },
    },

    // Chat request headers: the desktop sidecar is a Go client, so the only
    // extra is a UA. Add the same one here so the gateway sees the same
    // client the app itself presents.
    //
    // This hook runs on **every** provider's requests (host.js filters only
    // on "is it a function", not on provider; the qoder plugin's comment
    // also says "Every plugin's hook sees every provider's requests"). If
    // the request is not for your own provider, do not touch other headers.
    "chat.headers": async (input, out) => {
      // The owner is read inside a try: these are getters over another
      // plugin's provider object, and one that throws would throw out of the
      // provider's request path (the host logs it and keeps the request).
      let owner = ""
      try {
        owner = input?.model?.providerID ?? input?.provider?.info?.id
      } catch {
        return
      }
      if (owner !== ID || typeof owner !== "string") return
      // host.js hands in `{headers: {}}`, but the hook is the one place a
      // missing bag would throw inside another provider's request path; make
      // one instead of assuming it.
      if (!out || typeof out !== "object") return
      if (Object.isFrozen(out) || (out.headers && Object.isFrozen(out.headers))) return
      if (!out.headers || typeof out.headers !== "object") out.headers = {}
      out.headers["User-Agent"] = UA_SIDECAR
    },

    // Keep names the user changed: magpie stores the provider's name in
    // providers.json, and the config hook runs on every start — writing the
    // default back unconditionally would silently undo the rename in the UI.
    // The same goes for provider-level npm/api: the user may point them at
    // their own proxy, and overwriting them means reverting their settings on
    // every start. A value that is not an object is treated as absent; the
    // remaining fields are passed through as they are.
    //
    // models merge entry by entry by id, not by whole replacement: when the
    // user changes one field of one model, the remaining fields (especially
    // provider.npm) must stay — without it, the host resolves the
    // provider-level openai-compatible for this model, and a Claude model is
    // sent over the Chat protocol. The merge reaches into nested objects (see
    // mergeModel): setting only provider.api does not carry npm away.
    async config(config) {
      // The config the host hands over should be {provider:{…}}, but in a
      // misconfigured file provider can be a string or number: assigning a
      // property on a string throws a TypeError, the whole hook fails, and
      // this provider does not exist at startup. If it is not an object
      // (including an array — named properties on an array are dropped by
      // JSON.stringify), replace it with an empty one; the other hooks still
      // get their own copies.
      // The host may hand over no config at all (an explicit undefined), and
      // a loader has a baseURL only when its provider said where to send
      // requests: the address must be read from this config, not from what
      // the host passes the loader.
      if (!input || typeof input !== "object" || Array.isArray(input)) input = {}
      if (!config || typeof config !== "object" || Array.isArray(config)) config = {}
      if (!config.provider || typeof config.provider !== "object" || Array.isArray(config.provider)) config.provider = {}
      // Same for the provider entry: an array is also an "object", but named
      // fields written onto it are dropped by JSON.stringify, while index
      // keys ("0", "1") would stay in the user's config file.
      const was = config.provider[ID] && typeof config.provider[ID] === "object" && !Array.isArray(config.provider[ID]) ? config.provider[ID] : {}
      // Each entry's api.url is the address the user set (they may point at a
      // self-hosted proxy), otherwise the vendor gateway: what is written to
      // config is the truth — the host on that path already takes cfg.api
      // anyway (see apiBase's comment); this only avoids leaving an address
      // in the file that disagrees with the provider-level api. The address
      // is normalized by baseURL under the same rule as the live path: the
      // host composes requests on the config path with this cfg.api (when
      // the models hook does not refresh — not signed in, expired token — it
      // returns as-is, and this table is what requests use), and leaving
      // ".../v1//" or surrounding whitespace composes
      // ".../v1//chat/completions".
      const api = baseURL(was.api)
      const models = modelsOf(CATALOG, api)
      // The loader's address, as magpie's pluginRequestBase reads it
      // (plugins.go): the loader's baseURL, else the model's own URL, else
      // the provider's api — and then pluginFetch joins the SDK's request
      // path with magpie's "/v1" taken off it, so "/v1/chat/completions"
      // and "/v1/messages" both go under the base as "/chat/completions" and
      // "/messages". The loader answers the provider's address as it is
      // written down, "/v1" included: an OpenAI client joins
      // "/chat/completions" onto it and asks ".../v1/chat/completions", and
      // an Anthropic one's "/v1" is taken off the same way, so both arrive
      // at ".../v1/..." rather than ".../v1/v1/...". Answering the bare base
      // put the OpenAI client's request at "/chat/completions", which nginx
      // answers with a 405 page (issue #3, measured 2026-11-16). Read it in
      // magpie's internal/provider/plugins.go (pluginRequestBase, pluginFetch).
      loaderBase = api
      // If models itself is not an object (an array is also an "object" but
      // yields no model by id), treat it as absent.
      const own = was.models && typeof was.models === "object" && !Array.isArray(was.models) ? was.models : {}
      // Spreading brings along same-named own keys from the catalog
      // (`__proto__`) — spread uses CreateDataProperty, the key stays own and
      // the prototype is untouched, so `merged` ends up with an extra model
      // named `__proto__`. The host reads this table via bracket assignment
      // `out.models[key] = …`, and that is what writes the prototype (see
      // mergeModel's comment and the models hook's sibling entry). The
      // catalog is our own file and has no such id today; this check stays so
      // that the day the catalog is regenerated will not either.
      const merged = noMagicKeys({ ...models })
      for (const [id, m] of Object.entries(own)) {
        // A non-object entry is not a model: when building provider info the
        // host spreads every model one by one (host.js's info, reads
        // m.id/m.provider), and one null throws, failing the whole RPC — all
        // providers disappear from the list, not just this entry. An array is
        // also an object but likewise not a model; drop it too.
        if (!m || typeof m !== "object" || Array.isArray(m)) continue
        // id is a hand-written key in JSON and could be `__proto__` too:
        // `merged["__proto__"] = m` writes this model table's prototype, not
        // a model — round seven blocked keys of the same name as model
        // fields in mergeModel, and this is its sibling entry (the merge
        // happens one level above the models). No model is named any of
        // these, so dropping them costs nothing.
        if (MAGIC_KEYS.has(id)) continue
        // A hand-written entry can omit id — the key is the id. The host
        // reads m.id when building the row, and an undefined id is a model
        // with no name; fill in the key rather than dropping the entry,
        // because the user wrote the model they wanted.
        const entry = models[id] ? mergeModel(models[id], m) : m
        merged[id] = typeof entry?.id === "string" && entry.id.trim() ? entry : { ...entry, id }
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
