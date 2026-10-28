# magpie-plugin-codar

给 [magpie](https://github.com/yetone/magpie) 用的 **Codar（科搭）** 插件——把科搭的模型接进 magpie 当供应商用，替你每天签到，并在账号卡片上显示点数。

## 做了什么

| 钩子 | 作用 |
|---|---|
| `config` / `provider` | 增加一个 `codar` 供应商，带科搭的模型表（16 个：DeepSeek、GLM、GPT、Claude 各系）。表是从 App 自己的目录里取的，登录后还会从 `GET /v1/codar/models` 刷新。 |
| `auth.methods` | 两种登录：「读取本机科搭令牌」（keyless，插件自己去读 `~/.codar/config.json`，只读）和「科搭访问令牌」粘贴。 |
| `auth.checkin` | 每天 `POST /v1/daily-sign` 一次。返回能区分「本次领到」和「今天已经领过」，并给出距下次可领的时间——含 `until`（magpie ≥ 0.1.1862）：科搭是滚动 24 小时，magpie 便正好到点再问，而不是中午前每 30 分钟重问一遍。 |
| `auth.usage` | 点数（`/v1/gettoken`：通用点数 + Agent 点数）、今天签到状态、还在进行中的免费模型活动及其到期时间。三处读取并行发出。点数同时作为钱包读数报出，路由页便有这个账号的数目可看，而不是「剩余额度未知」。 |
| `chat.headers` | 只对 `codar` 自己的请求发和桌面端一样的 `User-Agent`（这个钩子对所有供应商的请求都会被调用，插件按供应商 id 自筛）。 |

聊天请求由 magpie 直接发到科搭的网关 `https://api.claw.speedai.com/v1`：多数模型走 OpenAI 兼容协议，Claude 系走 Anthropic Messages 协议——和桌面端侧车用的是同样两条。

## 令牌从哪来

科搭登录后是一把 JWT，存在它自己的配置文件里：

- macOS / Linux：`~/.codar/config.json`
- Windows：`%USERPROFILE%\.codar\config.json`
- 设了 `CODAR_HOME` 时是 `$CODAR_HOME/config.json`：App 认这个变量（`codar config path` 会报出它用的路径），插件也认

取 `provider.speedai.token` 的值，粘到 magpie 要 key 的地方：

```bash
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.codar/config.json")))["provider"]["speedai"]["token"])'
```

**更省事的办法**：登录时选「读取本机科搭令牌」，插件自己去读这个文件（只读、不写），不用手工复制。它认 `provider.speedai.token`，并在交出去之前检查令牌里有没有账号名、有没有过期——有问题会直接说原因，而不是存一个用不了的值。

令牌里带着账号名和过期时间（App 最后一次登录后 7 天）。过期后插件不会去调接口，而是直接提示重新登录——打开一次科搭让它自己续期，再重新登录插件一次即可。

## 安装

```bash
magpie plugin add github:MisonL/magpie-plugin-codar
magpie plugin login codar     # 选「读取本机科搭令牌」，或「科搭访问令牌」粘贴
```

然后在 magpie 里选一个 `codar` 模型，到 设置 → 额度 → 预热与签到 → 插件 里打开它的签到开关。

## 这个插件不做什么

- **不领取免费模型活动。** `POST /api/codar/activities/free-model/claim` 是一次性的活动领取，不是每日签到；插件只负责报告正在进行的活动。
- **不读写桌面端的配置文件**——「读取本机科搭令牌」登录时会读一次 `~/.codar/config.json`（只读），令牌存进 magpie 自己的 `plugin-auth.json`；任何时候都不写那个文件。
- **不换算价格。** 科搭的目录是人民币/百万 token，magpie 的金额栏是美元，所以插件自己不报价格，而不是编一个汇率。magpie 仍会按 models.dev 上模型厂商的标价给一些模型定价；`claude-opus-5-kiro` 这种带厂商后缀的 id 不会被定价。想改哪个，在 magpie 里给模型单独设价格即可。

## 说明

- 请求头和 App 保持一致，按链路分：账号接口、活动接口、模型目录用 Node 的默认 `User-Agent`（App 的 Electron 主进程读这些，它自己不加 UA），对话用 Go HTTP 客户端的（App 的 Go 侧车就是这么发的）。除此之外不加任何东西。
- `chat.headers` 钩子会被 magpie 用在每个供应商的请求上（不是只用在科搭上），插件按供应商 id 判断，只改 `codar` 自己的请求，别家的流量原样不动。
- 供应商默认叫「科搭 Codar」，但只在这个供应商还没有名字时才写：在 magpie 里给它改过名之后，`config` 钩子不会把名字改回去，重启也保留。
- `GET /v1/codar/models` 拿不到时，供应商保留 `catalog.mjs` 里内嵌的那份，magpie 会把列表标成回退。回退列表里 Claude 系同样走 Anthropic 协议：每个模型自带自己的 SDK，而不只是供应商的默认值。
- 你自己加到这个供应商里的模型条目（内嵌目录里没有的 id）在实时目录刷新后仍然保留；厂商自己的模型以厂商的目录为准。
- 科搭的免费模型对每个模型限定 3 个并发请求（实测：同时发 4 个，第 4 个收到 429 `concurrent_limit_exceeded`，「Too many concurrent requests」）。插件的 auth 钩子声明了 3，magpie 会把每个账号超过 3 个的请求排队，而不是让它们撞上厂商的限流；供应商设置里可以调高。
  厂商目前哪个接口都不公布这个数——`/v1/codar/models` 没有、`/api/pricing` 没有、429 的响应体里只有 `retry-after`——所以 3 是量出来的。哪天目录里带上 `max_concurrency`，模型钩子会读到它，下次建供应商信息时就用新数，不用等插件发版。
- 点数同时作为一扇带 `balance` 的窗口报出（magpie #3950）：只有 `aside` 行的卡片对路由什么都没说，magpie 就在账号旁边写「剩余额度未知」。钱包读数让它变成已知，直接给出还剩多少，也不编造百分比。读不懂窗口 `balance` 的旧版 magpie 只把它当文字行显示、照旧说未知；两种版本都不会出错。
- 免费模型活动按厂商 App 自己的判据画——`free_until` 未到、`remaining_quota` 没花光——不看它不读的 `status` 字段。它是 `aside`——用完了只是这些模型回到按点数计费，账号不停——只有厂商给了总额（`user_quota_limit`）时才带 `amount`/`limit`；不限量的活动显示为它的文字。
- 每日签到是一行文字，不是百分比：签到不是会用完的额度，插件不报 `used`，magpie 就照文字显示。
- 「读取本机科搭令牌」认 `CODAR_HOME`：App 认它（`codar config path` 会答 `$CODAR_HOME/config.json`），所以插件读的就是 App 写的那份文件；没设时用上面的主目录。
- 科搭自己的网关出过短时故障（模型目录对所有客户端都 500，桌面端也一样）；这种情况下插件保留卡片上的点数，只丢掉读不到的部分。

## 开发

```bash
node --test        # 整个测试套件，不联网
bun test           # magpie 真正加载插件的运行时
```

测试会桩掉 `fetch`，不连 SpeedAI。CI 在 Node 18–24、Bun（Linux/macOS/Windows）、以及 Windows/macOS 的 Node 上跑同一套——插件会读主目录下的文件，平台差异就在那里暴露。

## 许可

MIT。
