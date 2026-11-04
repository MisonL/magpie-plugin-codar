# magpie-plugin-codar

给 [magpie](https://github.com/yetone/magpie) 用的 **Codar（科搭）** 插件——把科搭（SpeedAI 出品的研究用桌面应用）的模型接进 magpie 当供应商，自动每日签到，并在账号卡片上显示点数。

## 功能

- **供应商** — 注册一个 `codar` 供应商，带科搭的模型表（17 个：`auto` 路由 + DeepSeek、GLM、GPT、Claude 各系）。模型表内嵌在 `catalog.mjs`，登录后通过 `GET /v1/codar/models` 刷新。聊天由 magpie 直发科搭网关（`https://api.claw.speedai.com/v1`），多数模型走 OpenAI 兼容协议，Claude 系走 Anthropic Messages。
- **登录** — 两种方式：「读取本机科搭令牌」（keyless，插件自读桌面端令牌文件，只读）和「科搭访问令牌」粘贴。
- **每日签到** — `POST /v1/daily-sign`，滚动 24 小时一次。返回区分「本次领到」（含点数增量）和「今天已领过」，带 `until`（magpie ≥ 0.1.1795）让 magpie 到点再问而非每 30 分钟重试。
- **用量** — 点数（通用 + Agent）、签到状态、进行中的免费模型活动。通用点数同时作为钱包读数报出（magpie #3950），路由页便有此账号的余量可参考；第一处余额读取失败时，卡片仍显示第二条余额接口的数据。

## 安装

```bash
magpie plugin add "$PWD"       # 尚未发布；先从这个目录装
# magpie plugin add github:MisonL/magpie-plugin-codar   # 发布之后
magpie plugin login codar     # 选「读取本机科搭令牌」，或粘贴令牌
```

然后在 magpie 里选一个 `codar` 模型，到 设置 → 额度 → 预热与签到 → 插件 中开启签到。

## 登录

科搭的登录令牌（JWT）存在它自己的配置文件里：

- macOS / Linux：`~/.codar/config.json`
- Windows：`%USERPROFILE%\.codar\config.json`
- `$CODAR_HOME/config.json`（设了 `CODAR_HOME` 时，App 和插件都认它）

取 `provider.speedai.token` 的值。「读取本机科搭令牌」自动完成以上步骤（只读，不写文件），并在保存前检查令牌是否有账号名及是否过期。手工操作：

```bash
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.codar/config.json")))["provider"]["speedai"]["token"])'
```

令牌有效期 7 天（自 App 最后一次登录起）。过期后插件提示重新登录——打开科搭续期，再登录一次插件即可。

## 说明

- **价格**：科搭目录以人民币计，magpie 的金额栏为美元，插件不自行换算。magpie 按 models.dev 的厂商标价给模型定价，在 magpie 界面为单个模型设置的价格优先级最高。
- **推理档位**：厂商目录 `reasoning.levels` 中的 `set`/`omit` 是桌面端自行套用的请求体改写规则；magpie 的 variants 仅列档位名，因此模型只带 `reasoning: true`，不带 variants。
- **免费模型活动**：插件仅报告进行中的活动，不执行一次性活动领取。
- **并发控制**：每模型 3 个并发（实测值，厂商未公开该参数）。超出时 magpie 排队，供应商设置可调高。目录中出现 `max_concurrency` 后自动采用，无需插件发版。
- **签到窗口**：以文字行显示（非百分比）。无法使用的等待值（缺失、0、超年 9999、超一周）降级为 30 分钟保质期，避免滚动 24 小时窗口丢失下一次可领时机。
- **回退列表**：`GET /v1/codar/models` 不可达时，供应商保留 `catalog.mjs` 内嵌列表并标记回退。尺寸可能滞后于实时目录，能取到实时数据时以实时为准。每个模型的回复上限（`request_schema.properties.max_tokens.maximum` → `limit.output`）按厂商实际数据报告，magpie 对超限请求自动降级而非让厂商拒绝。
- 用户自行加入的模型条目在刷新后保留；厂商目录中的条目以厂商为准。magpie 界面中设置的供应商名称或 api 在重启后保持。
- 所有字段按厂商客户端读法解析（字段拼写、应答码、「已领过」文案中英文均支持）；写不出的时刻省略而非凑合；任何情况下不打印凭据（错误信息按令牌形状截断，超长应答边读边拒）。
- 请求头与桌面端对齐：账号/活动/目录接口发 Node 默认 `User-Agent`，对话发 Go HTTP 客户端的。`chat.headers` 按供应商 id 自筛，仅影响 `codar` 的请求。

## 开发

```bash
node --test                        # 整个测试套件，不联网
bun test                           # magpie 真正加载插件的运行时
node scripts/catalog.mjs --check   # catalog.mjs 是否仍与厂商一致
node scripts/catalog.mjs           # 按本机已登录的 App 重新生成
```

`catalog.mjs` 使用插件自身的 `catalogOf` 生成，回退列表与实时列表按同一套规则构建。退出码：`0` 无变化，`1` 记录有变动（仅 `--check`），`2` 厂商或文件不可读——取数失败不写文件、不清空回退。该命令需要已登录的 App，因此作为本地命令而非 CI 步骤。

CI 在 Node 18–24、Bun（Linux / macOS / Windows）、以及 Windows / macOS 的 Node 上运行——插件读取主目录下的文件，平台差异在此暴露。

## 许可

MIT。