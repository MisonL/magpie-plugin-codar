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
import { ACCOUNT, ACTIVITIES_PATH, ALREADY_CLAIMED, API, CATALOG_PATH, CHECKIN_BUDGET_MS, HOST_CHECKIN_DEADLINE_MS, HOST_USAGE_DEADLINE_MS, ID, MAGIC_KEYS, MAX_ACTIVITY_WINDOWS, MAX_ANSWER_BYTES, MAX_MODELS, MAX_SCRUB_CHARS, OPENAI, SIGN_PATH, SIGN_STATUS_PATH, TIMEOUT_MS, UA_SIDECAR, USAGE_BUDGET_MS, agentPointsOf, apiBase, appToken, balanceOf, baseURL, catalogOf, checkinWaitSecs, cleanText, configPath, cut, expired, expiresAt, gain, humanSecs, mergeModel, modelOf, modelsOf, noMagicKeys, numOf, payloadOf, pickOf, plain, pointsOf, protocolOf, publishedConcurrency, readAnswer, request, runningActivities, safeTime, saidBy, scrub, scrubLine, secsOf, shownPath, signMessage, signedIn, signedOut, tokenOf, unusableKey, unwrapped, usernameOf, whyOf } from "./internal.mjs"

export async function CodarPlugin(input) {
  // 每次调用现取，而不是建插件时抓一个：测试会在这之后换掉全局那个。宿主
  // 不往 input 里放 fetch——host.js 的 loadPlugins 交过来的是 client/project/
  // directory/worktree/experimental_workspace/serverUrl/$/magpie——所以读的
  // 就是 globalThis.fetch，没有第二条路。
  const fetchImpl = (...args) => globalThis.fetch(...args)

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

      // What a request for this account carries: the stored key. magpie falls
      // back to it without a loader, but the contract for a provider served
      // through config is `{ provider, loader, methods }` — the loader is the
      // one place a request's credential is read, and without it the host's
      // other entry points (OpenCode's own) have no key to send. An account
      // with no usable key answers {} rather than a made-up one.
      async loader(getAuth) {
        const token = tokenOf(await getAuth())
        return token ? { apiKey: token } : {}
      },

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

        const code = numOf(r?.code) // an object code must not throw (see pointsOf)
        // 成功的判据与厂商客户端一致（app.asar 的 k0 只调 ft）：数字码不是
        // 200 才算拒绝，没带 code 的应答算领到了——今天的成功应答带 code:200，
        // 但这个厂商的活动接口就是不带 code 的（只有 {data,message,success}），
        // 签到哪天也这样省掉，只认 200 会把「领到了」报成失败。
        //
        // 「今天已领过」：厂商用这句话说这一天已经领了。它说的是「今天」，
        // 不是「这一次」，所以未必带 code：带 400 是它今天的写法，不带 code
        //（活动接口就是这种形状）也是同一句话。文案按客户端的读法（saidBy，
        // 8 拼写）取。这句要先算：它是对「这一天」的陈述，比下面任何一个
        // 「这一次」的旗标都更能决定 outcome（见 success:false 那段）。
        //
        // 两种读法，任一成立就算这一天已领：文案认得出（中英文都认，见
        // ALREADY_CLAIMED），或者「400 加一个读得懂的 retry_after」这一对——
        // 滚动 24 小时的窗口里，400 还给得出下次可领的秒数，几乎只可能是今天
        // 已经领了。文案认不出（换了语言、换了措辞，或 400 之前垫了长噪声）时，
        // 这一对数还在。文案判在没被截断的 words 上：said 是给卡片看的 400 字
        // 以内版本，厂商那句话排在后面时整句就没了。
        const words = saidBy(r)
        const said = scrub(words, token)
        const earlySecs = checkinWaitSecs(r?.data?.retry_after)
        const refused = code === 400 || !Number.isFinite(code)
        // The words say the day is claimed on the codes that can carry that
        // statement: 200 (it already went through), 400 (today's wording),
        // or no code at all. They do not on a 500/503 — that is a server
        // failure that happened to repeat the sentence, and reading it as
        // `done` would settle the day off an error. 401/403 keep meaning
        // "sign in again", never a claim. A 200 beside the words is the one
        // shape that used to fall through to "just claimed" with a credit of
        // 0 over a day that was already settled.
        const wordsSaid = ALREADY_CLAIMED.test(words) && (code === 400 || code === 200 || !Number.isFinite(code))
        const already = wordsSaid || (refused && Boolean(earlySecs))
        // 只有一处不听客户端的：应答自己说 `success: false`（厂商在活动接口
        // 上用的就是这个旗标）时算失败，无论带没带 code——code:200 配
        // success:false 正是「HTTP 层说好、业务层说不」。**但不压过「已领
        // 过」**：厂商带 400、文案写着「24小时内仅可领取一次」、又顺手带个
        // success:false 时，这一天确实是领到了，这一次调用也确实「没成」，
        // 两句都对。读成 failed 的代价在这一侧更大——magpie 会把失败当天
        // 每 30 分钟重问一遍（workbuddy_checkin.go 的 wbCheckinRetry），
        // 卡片还一直写「签到失败」；而读成 done 只是把厂商说出的那个时刻
        // 记下来。拒绝时不读余额算 credit——那是给一次真领到算的。
        if (r?.success === false && !already) return { outcome: "failed", message: said || (Number.isFinite(code) ? `签到失败（code ${code}）` : "签到失败") }
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
          // 秒数先说得出、再说信多久：滚动 24 小时窗口产不出的数（1e9 秒是
          // 31 年）和日历写不出的数都不是「可信的时刻」，和厂商没说一样落到
          // 30 分钟的保质期；照单全收会把这一天结清到 2058 年。见
          // checkinWaitSecs（一周）与 safeTime（年 9999）。
          const secs = earlySecs
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

        // 四条读取互不依赖，一起发（厂商自己的客户端也是这么发的：app.asar 的
        // S0 用 allSettled 跑 /v1/gettoken、/v1/agent/balance、/api/user/self）：
        // 卡片等最慢的那个，而不是四个之和，最坏也只是一个 TIMEOUT_MS——插件的
        // 用量预算管不到宿主在钩子之前跑的那一段（见文件头的时间注释），钩子越
        // 慢，留给它的就越少。点数读不到整张卡就是错的（余额是主项）；另两个是
        // 附加信息，读不到就不报。
        const [pointsR, agentR, statusR, actsR] = await Promise.allSettled([
          pointsOf(token, username, opts()),
          agentPointsOf(token, username, opts()),
          request(`${ACCOUNT}${SIGN_STATUS_PATH}`, { method: "POST", body: { username }, token, ...opts() }),
          request(`${API}${ACTIVITIES_PATH}`, { method: "GET", token, ...opts() }),
        ])

        // pointsError 是「卡片有一项没读成」的理由。magpie 的卡片一看到
        // error 就只画那一行、不再画 windows（assets/kernel.js 的 pqLine /
        // quotaWindows），所以它不是「部分读到了」的标记：部分读到就照画读到
        // 的部分，只有什么点数都没读到才让整张卡变成一句错误。
        let points
        if (pointsR.status === "fulfilled") {
          points = pointsR.value
          // 通用点数与 Agent 点数是两条读数：gettoken 给的就用它，没给才用
          // /v1/agent/balance（S0 里 i.agentPoints ?? cm 那个值）。另一条读不
          // 到就当一个没说，不影响 gettoken 自己答出的东西。
          if (points.agent == null && agentR.status === "fulfilled") points.agent = agentR.value
        } else {
          const e = pointsR.reason
          // 登录过期是整张卡的答案：另两处也会这么说，换谁重试都没用，用户
          // 要做的只有重新登录。这一条是原来那一句，别改成码。
          if (signedOut(e)) return { error: "登录已过期，请重新登录", signIn: "expired" }
          // 通用点数这一处没读到：另一条余额接口若答出了 Agent 数就照画签到
          // 行、活动和 Agent 点数——钱包那一行不画，通用点数这一回没说，编一
          // 个 0 会让路由把一个有钱的账号排到最后。两条都读不到，才是整张卡的
          // 一句错误。
          const agent = agentR.status === "fulfilled" ? agentR.value : null
          if (agent == null) return { error: scrub(whyOf(e), token) || "点数查询失败", signIn: "" }
          points = { general: null, agent }
        }

        const windows = []

        // 今日签到：明天这个时候能再领一次。等待结束时（retry_after 0）这
        // 一行也要在——那正是"现在可以领"的时刻，旧写法 secs > 0 会让它消失。
        // 不带 used：签到不是一份会用完的额度，magpie 的 plugin_usage.go 把
        // 没有份额的 aside 行标成 Text（它自己的注释也拿「每日签到」当例子），
        // 不会画成一个 100% 的进度条。
        //
        // 状态按厂商 App 自己的读法（app.asar 的 um）：data 可以是那个布尔，
        // 也可以是写着它的对象（四种写法）；两种形状都画这一行，其余形状不画。
        // 先过它的 code 关：厂商调状态接口时也是先 ft（数字码不是 200 就当
        // 失败），再 um 读应答。只认 data 的话，{code: 500, data:{isSigned:
        // false}} 会被画成「现在可以领」——厂商自己这时只会说查询失败。
        // 这一行是附加信息，画不出来就不画，卡片照报点数。
        const status = statusR.status === "fulfilled" ? statusR.value : null
        const statusCode = numOf(status?.code) // an object code must not throw (see pointsOf)
        const data = Number.isFinite(statusCode) && statusCode !== 200 ? undefined : status?.data
        // a boolean or a plain object, as the vendor's client reads it: an
        // array is an object too, and drawing a row over one says "今天还没
        // 领，现在可以领" about data the vendor never meant as a state.
        if (typeof data === "boolean" || plain(data)) {
          const signed = signedIn(data)
          // 秒数先说得出、再在签到说得出的范围内：说不出的（没给、给了 0、
          // 大到日历写不出）就没有可报的时刻，文案和 resetsAt 一起省掉。
          // 宿主的 when(0) 会把 0 画成 1970-01-01，而不是当成「没说」。见
          // checkinWaitSecs 与 safeTime。
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
            const ids = Array.isArray(a.model_ids) ? a.model_ids.filter((x) => typeof x === "string").map(cleanText).filter(Boolean) : []
            // 两个数都要有限：1e999 是合法的 JSON，读出来却是 Infinity，
            // 拿去算份额会得到 NaN，卡片上就写「已用 Infinity / Infinity」。
            const capSaid = numOf(a.user_quota_limit)
            const cap = Number.isFinite(capSaid) && capSaid > 0 ? capSaid : null
            // named for what it is: `left` would shadow the usage hook's own
            // left() budget function two scopes up, and the next caller of
            // opts() in here would get a TypeError instead of a timeout
            const leftSaid = numOf(a.remaining_quota)
            const quotaLeft = Number.isFinite(leftSaid) ? leftSaid : null
            // 「已用」只在两个数都在、且互相说得通时才算得出来：剩下比总额还多，
            // 是两个数在说两件事（厂商报的是池子，不是这次活动），相减只会造出
            // 一个 0，卡片写「已用 0 / 100」而厂商说还剩 150——不如把剩下的照说。
            const used = cap != null && quotaLeft != null && quotaLeft <= cap ? cap - quotaLeft : null
            // used 是份额（0–100），宿主按字面读它；算不出份额的窗口就不报这个
            // 字段，而不是报 0%——宿主的契约把两者分得很清楚（"left out: the
            // plugin didn't say, which is no share and not 0%"），报 0 等于说
            // 「已用 0%」，而这里要说的恰恰是「没有份额可说」。不报的时候这一
            // 行和签到那行一样画成文字。
            const share = used != null && cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : null
            // 活动的结束时间（也是秒数）读不出来就不带 resetsAt：活动
            // 本身照报——它确实在跑，只是没说何时结束（safeTime 给 0）。
            const freeUntil = safeTime(secsOf(a.free_until) * 1000)
            windows.push({
              name: ids.length ? `免费模型 · ${ids.slice(0, 2).join("、")}${ids.length > 2 ? ` 等 ${ids.length} 个` : ""}` : "免费模型",
              ...(share != null ? { used: share } : {}),
              ...(freeUntil ? { resetsAt: freeUntil } : {}),
              // 说得出总额就说总额：remaining_quota 没给，不代表活动「不限量」
              // ——厂商的 user_quota_limit 白纸黑字写了多少。只有两个数都没有
              // 时才是「不限量」（今天的线上形状）。
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
          // 厂商哪天在目录里说了并发数，就按它排队（见上面 vendorConcurrency）。
          // 只在目录真的说了个数时才改：publishedConcurrency 对「没说」的目录
          // 答 0，无条件赋值会把它抹回默认的 3，于是一个已经给出过 7 的厂商
          // 只要某次目录里少了这个字段（代理拼的目录、厂商灰度），限额就被
          // 悄悄降回 3。说了 0 个字段不等于说了「1」或「3」。
          const statedConcurrency = publishedConcurrency(body)
          if (statedConcurrency) vendorConcurrency = statedConcurrency
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
      // host.js hands in `{headers: {}}`, but the hook is the one place a
      // missing bag would throw inside another provider's request path; make
      // one instead of assuming it.
      if (!out || typeof out !== "object") return
      if (!out.headers || typeof out.headers !== "object") out.headers = {}
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
        // 用户手写的条目可以不带 id——键就是 id。宿主建这一行时读 m.id，一个
        // undefined 的 id 就是一条没有名字的模型；补上键而不是丢掉这条，因为
        // 他写的是自己要的模型。
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


export default CodarPlugin
