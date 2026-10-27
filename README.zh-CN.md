# magpie-plugin-codar

给 [magpie](https://github.com/yetone/magpie) 用的 **Codar（科搭）** 插件——把科搭的模型接进 magpie 当供应商用，替你每天签到，并在账号卡片上显示点数。

## 做了什么

| 钩子 | 作用 |
|---|---|
| `config` / `provider` | 增加一个 `codar` 供应商，带科搭的模型表（16 个：DeepSeek、GLM、GPT、Claude 各系）。表是从 App 自己的目录里取的，登录后还会从 `GET /v1/codar/models` 刷新。 |
| `auth.checkin` | 每天 `POST /v1/daily-sign` 一次。返回能区分「本次领到」和「今天已经领过」，并给出距下次可领的时间。 |
| `auth.usage` | 点数（`/v1/gettoken`：通用点数 + Agent 点数）、今天签到状态、还在进行中的免费模型活动及其到期时间。 |
| `chat.headers` | 发和桌面端一样的 `User-Agent`，让网关看到的客户端与 App 自己的流量同形。 |

聊天请求由 magpie 直接发到科搭的网关 `https://api.claw.speedai.com/v1`：多数模型走 OpenAI 兼容协议，Claude 系走 Anthropic Messages 协议——和桌面端侧车用的是同样两条。

## 令牌从哪来

科搭登录后是一把 JWT，存在它自己的配置文件里：

- macOS / Linux：`~/.codar/config.json`
- Windows：`%USERPROFILE%\.codar\config.json`

取 `provider.speedai.token` 的值，粘到 magpie 要 key 的地方：

```bash
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.codar/config.json")))["provider"]["speedai"]["token"])'
```

**更省事的办法**：登录时选「从本机科搭读取」，插件自己去读这个文件（只读、不写），不用手工复制。它认 `provider.speedai.token`，并在交出去之前检查令牌里有没有账号名、有没有过期——有问题会直接说原因，而不是存一个用不了的值。

令牌里带着账号名和过期时间（App 最后一次登录后 7 天）。过期后插件不会去调接口，而是直接提示重新登录——打开一次科搭让它自己续期，再重新登录插件一次即可。

## 安装

```bash
magpie plugin add github:MisonL/magpie-plugin-codar
magpie plugin login codar     # 选「从本机科搭读取」，或「Codar 访问令牌」粘贴
```

然后在 magpie 里选一个 `codar` 模型，到 设置 → 额度 → 预热与签到 → 插件 里打开它的签到开关。

## 这个插件不做什么

- **不领取免费模型活动。** `POST /api/codar/activities/free-model/claim` 是一次性的活动领取，不是每日签到；插件只负责报告正在进行的活动。
- **不读写桌面端的配置文件**——「从本机科搭读取」登录时会读一次 `~/.codar/config.json`（只读），令牌存进 magpie 自己的 `plugin-auth.json`；任何时候都不写那个文件。
- **不换算价格。** 科搭的目录是人民币/百万 token，magpie 的金额栏是美元，所以这些模型显示为未定价，而不是编一个汇率。想让它进用量统计，可以在 magpie 里给模型单独设美元价格。

## 说明

- 请求头和 App 保持一致：网关（`api.claw.speedai.com`）用 Go HTTP 客户端的 `User-Agent`（App 的 Go 侧车就是这么发的），账号接口（`api.kuaipaper.com`）用 Node 的默认值（App 的 Electron 主进程就是这么发的）。除此之外不加任何东西。
- `chat.headers` 钩子会被 magpie 用在每个供应商的请求上（不是只用在科搭上），插件按供应商 id 判断，只改 `codar` 自己的请求，别家的流量原样不动。
- `GET /v1/codar/models` 拿不到时，供应商保留 `catalog.mjs` 里内嵌的那份，magpie 会把列表标成回退。
- 科搭自己的网关出过短时故障（模型目录对所有客户端都 500，桌面端也一样）；这种情况下插件保留卡片上的点数，只丢掉读不到的部分。
- 科搭的免费模型对每个模型限定 3 个并发请求（实测：同时发 4 个，第 4 个收到 429 `concurrent_limit_exceeded`，「Too many concurrent requests」）。插件的 auth 钩子声明了 `maxConcurrency: 3`，magpie 会把每个账号超过 3 个的请求排队，而不是让它们撞上厂商的限流；供应商设置里可以调高。

## 开发

```bash
node --test        # 整个测试套件，不联网
```

测试会桩掉 `fetch`，不连 SpeedAI。

## 许可

MIT。
