# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The provider's `baseURL` ended at the gateway, without `/v1`: an OpenAI-compatible client joins `/chat/completions` onto the base and asked `https://api.claw.speedai.com/chat/completions`, which the gateway answers with a 405 page (issue #3). The loader now answers the base with `/v1`, as the vendor's own documents it, and the config hook passes a user's own base through unchanged.
- The fallback transport followed a redirect to any host. When the Go proxy could not run, requests and chat went through `fetch`, which follows a `Location` and carries `Authorization` to it; the proxy refuses a hop off the host and port it started on, and the fallback now applies the same rule (`lib/guarded.mjs`): at most five hops on the origin the request started on, a one-shot body stops at the redirect, and the redirect is returned as the answer.
- A user's own `api` written without a path was used as written, so the clients asked `host/chat/completions` and `host/messages` with no `/v1`: /v1 was there only when the user happened to type it. A user's address now follows the vendor's rule — an address that already ends in `/v1` is left as it is, any other is given `/v1`, as `https://api.claw.speedai.com` always was.
- The fallback transport refused every redirect when the host handed it a `URL` or a `Request` instead of a string, and read an upper-case `HTTPS://` address as not https, which sent it out with no rule at all; both are now parsed the way the URL parser reads them. A `Request` is sent with its own method, headers and body (the URL alone was sent, as an unauthenticated GET), a `DataView` body no longer throws, and an `ArrayBuffer` or `Buffer` body is copied at the call.
- The fallback transport re-sent a POST with its body when a 303 (or a 301/302 after a POST) named a new address; fetch asks for a GET with no body there, and a result endpoint accepts only that. 307 and 308 still keep the method and the body, and the redirect's own body is cancelled instead of left holding its connection.
- A redirect whose `Location` names a user in its authority (`https://someone@api.claw.speedai.com/…`) is no longer followed as a hop on the same origin.
- The sign-in page took the account's QR code image from any URL the vendor's answer named. It is now only loaded from the vendor's own hosts over https.
- The proxy refuses a redirect that names a port, not only one that names another host: `https://api.claw.speedai.com:8443` is another service on the vendor's name.
- The install check in `scripts/tarball.mjs` passed without running when the checkout had no `native/bin` (a fresh clone, a `npm pack --dry-run`): it printed that the platform packages were "not installed" and exited 0. A tree without builds now says the check was skipped, and the release run (`prepublishOnly`) passes `--require-builds`, where it is exit 2 — a release cannot ship on a check that did not run.
- The install check added in 0.3.0 failed on CI (ubuntu runs of `node --test` and `bun test`, the Windows job and the `tarball` job) after the release was published: it copied a checkout build that CI runners without `native/bin` do not have, asserted an execute bit Windows does not have, and unpacked with `tar -C`/`-s`, which the tar on ubuntu and Windows reads as member names. The fix ships with the next version; the published 0.3.0 package itself is unaffected.

## [0.3.0] - 2026-11-16

### Changed

- **A release now publishes six packages, platform ones first (0.3.0).** The compiled Go proxy and its platform packages are built inputs, so this ships as a minor version rather than a patch. Nothing a magpie user configures changes, but the shape of a release does: the five platform packages must be published before the main package, or an install lands without its proxy (it then falls back to the ordinary fetch, the old fingerprint, without saying so). Publish them with `node scripts/native-packages.mjs --publish`, then the main package.
- **Each platform's proxy build ships in its own npm package.** `magpie-plugin-codar-<os>-<cpu>` (darwin/linux arm64+x64, win32 x64) carries one ~6 MB build and declares `os`/`cpu`, and the main package names all five in `optionalDependencies`, so a package manager installs only the one that fits the machine. An install drops from 32.0 MB unpacked (13.3 MB of tarball) to 7–8 MB on disk (about 3 MB of tarball: a 0.33 MB main package and one 2.4–2.8 MB platform package), and magpie's bun and npm both pick the right package. The `cpu` field is npm's spelling — `x64`, never Go's `amd64`, which npm refuses with `EBADPLATFORM` — and the plugin resolves the build through the installed package rather than computing a path from `process.arch`, so an x64 runtime under Rosetta gets the x64 build. Release: `node scripts/native-packages.mjs --publish` publishes the five packages before the main one, which `CONTRIBUTING.md` documents.
- **The release gate now performs an install.** `node scripts/tarball.mjs` served the packed main package from a local registry to a scratch project, and requires the install to land exactly this machine's platform package and the plugin to start it. It previously only unpacked the tarball, which is why five builds in one package shipped for two minor versions without anything checking the install path.
- The main package no longer carries `native/bin`; `files` and the gate refuse it, because the builds are the platform packages' now.

### Removed

- `requireNativeBin` no longer checks five builds in the tarball; the main package must carry none of them.

## [0.2.4] - 2026-11-15

### Fixed

- The shipped proxy binaries carried a VCS stamp that named the wrong commit:
  `go build` reads the checkout it runs in, and `native/bin` was last built
  before the 0.2.0 tree, so every binary said `vcs.revision=c90d4d9` (v0.1.2)
  with `vcs.modified=true`. `scripts/build-native.mjs` now passes
  `-buildvcs=false`; `go version -m` reports the module as `(devel)` and no
  commit, which is what a review should read. All five builds are remade from
  the current source.
- A `GOEXPERIMENT` set in the releaser's own `go env` reached the pinned
  toolchains: `greenteagc` made Go 1.24.3 refuse to build at all, and any
  value it accepted would have changed the binary behind the build's back. The
  build pins `GOEXPERIMENT=none` (`CODAR_GOEXPERIMENT` names another
  deliberately).

## [0.2.3] - 2026-11-14

### Changed

> v0.2.2 was published to npm before the README commit that this section describes
> landed, so its tarball lacks both sections; its tag was withdrawn, the release
> marked superseded, and the same change ships in v0.2.3.

- The README now says where the two things a review of 0.2.x asks about live: how
  the shipped proxy binaries are made (built locally by `npm run native:all`, not in a
  release workflow; not byte-reproducible from a tag, since Go embeds its build path and
  the binaries are not committed — what a tag fixes is the source and the toolchain), what
  CI and the publish gate do and do not check, and exactly where the account's name and
  password go (the vendor's own `POST /v1/login`, once, never kept).

## [0.2.1] - 2026-11-14

### Fixed

- The suite tried to bind unix sockets on Windows: twenty-one of
  `test/native.test.mjs`'s tests speak the proxy's unix transport, which Windows
  Node cannot listen on (`EACCES`), so they now skip there. The loopback TCP
  transport the proxy uses on Windows keeps its own test, which runs on every
  platform.
- The `tarball` CI job would not take the package it was given:
  upload/download-artifact carries bytes, not modes, so the builds the `native`
  job uploaded came back read-only, and the gate rightly refuses a package
  whose proxy cannot be run. The job restores the executable bit after
  downloading, as a local build leaves it.

## [0.2.0] - 2026-11-14

### Fixed

- A vendor answer that states `Content-Encoding` is read instead of refused.
  The reader rejected any compressed answer on the assumption that the bytes
  on the wire were what reached it; every transport used here hands back the
  decoded body, so the header described nothing left to guard against. The
  vendor began gzipping `POST /v1/wechat/login/qrcode`, and every QR sign-in
  failed with “厂商应答经过压缩编码，已放弃” before the code was drawn. The
  8 MB cap still applies, counted over the decoded body as it is read.

- The sign-in page's listener now holds the SMS resend cooldown and a submit
  budget itself. The page's 60-second countdown only ran in the page, so a
  script that knew the page's path could spend the account's SMS quota; the
  listener now answers `429` for a second send inside the cooldown and after
  five code submissions, refusals included, without reaching the vendor.
  Either limit is raised or lowered through `sendCooldownMs` / `maxSubmits`.

- A card request that falls back from the native proxy to `fetch` hands that
  fetch its own copy of the request options, so a body the native transport
  had already read is not handed on used.

- The sign-in page handed the vendor's captcha widget an undefined `captchaId`:
  the script said `captchaId: ${captchaId}`, which is spliced into the page's
  markup only, never into the script, so the page read a variable it did not
  have and the widget threw. The id is now written into the page as a quoted
  string, and a test checks the page's own script for it.

- A sign-in page whose listener had gone (magpie closed it, or its TTL ran out)
  said “登录页面已失效” in its status line but left the buttons in place, so the
  next click failed the same way. The page now ends on that sentence.

- The sign-in page's last screen still showed the tab bar above it. The page
  hides the tab bar by setting `hidden`, but its own `.tabs { display: flex }`
  rule outranks the browser's `[hidden] { display: none }`, so the bar stayed
  drawn. An author-level `[hidden] { display: none !important }` reset puts the
  attribute back in charge, and the now-redundant per-panel hidden rules are
  gone.

- A renewal refused inside a `data` wrapper (`{code:200, data:{code:401,…}}`)
  is read as the expired sign-in it is. It used to be reported as an answer
  with no token, which the host retries forever instead of asking to sign in.

- A check-in answer wrapped more than one `data` level deep is read at the
  depth the refusal reader already used: “Already signed today” two levels in
  is the day settled, not this attempt's claim, and a wrapped `already_claimed`
  is the day's statement rather than a refusal. The usage card's claim row
  reads the same depth.

- A free-model claim the vendor refused (`success:false`, a non-200 business
  code, or a code in words) is not reported as claimed: the card no longer
  says 已领取免费模型 over a write that did not land, and the campaign is not
  recorded as done. The campaign read refuses the same words at any wrapper
  level, so a refused read is not followed by a claim write. Two check-ins at
  once claim one campaign once.

- “Already signed in on another device” is a sign-in note, not today's
  check-in: the English already-claimed wording now needs the check-in's own
  words (“checked in”) or a “today” beside it, and no longer settles the day
  as done.

- A model list whose live refresh failed is handed back as the very table the
  host gave, which is how magpie reads a fallback. The table was always
  returned as a copy, so an outage replaced the account's models with the
  embedded catalog.

- A business code a JSON number can state but a double cannot (`1e999`, which
  parses to `Infinity`) is a refusal, not “no code”: a refused catalog,
  activities list, campaign, balance or check-in is no longer accepted on it.

- A token split one character per model field is caught by the catalog gate,
  and the generator refuses it too.

- The SMS page does not print the code or temp token a vendor echoes back in
  a refusal, and a WeChat QR sign-in the vendor ends with an error settles at
  once instead of waiting out the page's TTL.

- The native proxy follows a redirect only on the host the request started
  on: Go's client copies `X-Api-Key` to any target, so a cross-host redirect
  handed one service's credential to another. The proxy also refuses a TCP
  listen address that is not loopback (the plugin passes `127.0.0.1:0`).

- The release gate reads the architecture a build's header names (a build of
  the other architecture under a file name is refused; a fat Mach-O is read by
  its slices), not only the four magic bytes. The catalog generator's temporary
  file is created exclusively under a random name, so another process in the
  directory cannot pre-create it as a symlink. The tarball CI job now packs
  the native job's builds, and the style test covers JSON and YAML.

- A streamed answer never resolved its promise until the last chunk arrived,
  which buffered the whole answer despite streaming it.

- A phone-and-SMS sign-in (“科搭手机号短信登录”): the vendor will not send a
  code without a solved captcha (measured: `{"code":400,"message":"请完成人机验证"}`),
  and that captcha is a person's puzzle, so the plugin serves a page on
  `127.0.0.1` and opens it from magpie. The page loads the vendor's own
  captcha (`ct4.js`, its own captchaId) and shows the phone and SMS-code
  fields; every vendor call is made by the plugin, the page never sees the
  token, and the listener is loopback-only, behind a random path, for ten
  minutes at most.

- A password sign-in (“科搭账号密码登录”): the Codar account's own name and
  password, as the desktop and web clients take them (`POST /v1/login` on
  `api.kuaipaper.com`). The password goes to the vendor in that one request and
  is kept nowhere; what reaches magpie is the token. A vendor that answers
  `code 201` / `ip_verify_required` wants an SMS check no plugin can pass for
  the user, and the answer names “科搭手机号短信登录” instead.

- Sign-ins are now kept with their token's own expiry and renewed by magpie
  through `POST /v1/token/refresh` twelve hours before they run out, so an
  account signed in once stays signed in instead of waiting for the desktop app
  to renew it. A token that has already expired cannot be renewed — the vendor
  answers it with `code 401`, “Token has expired” — so that account is asked to
  sign in again.

- The catalog, check-in, account and activity requests now leave through a
  small Go proxy (`native/cmd/codar-proxy`) that rebuilds the Codar desktop
  sidecar's provider client from the 0.3.13 binaries — the sidecar's transport
  defaults, its last-known-address `DialContext` and its direct connection to
  the gateway (TLS left to net/http, as on the sidecar), built with the Go
  toolchain each platform's sidecar uses — so those requests carry the
  desktop's TLS and HTTP shape instead of Bun's. The plugin reaches it over a
  private temp-directory socket (loopback with a token on Windows); it
  forwards only the desktop's four official hosts and only the desktop's own
  four fields (`Authorization`, `Content-Type`, `X-Api-Key`,
  `Anthropic-Version`), each host with the transport its own base gets (the gateway direct, the rest through the environment's proxy). Built
  per platform by `scripts/build-native.mjs`, shipped in `native/bin`; without
  a binary the requests fall back to fetch, which is the old fingerprint.
  The host and URL gate is the desktop's own `officialURL`
  (`electron/cloud-network.cjs` in the 0.3.13 packages): https, no userinfo,
  no port, and one of those four hosts.

- A split of the token into pieces of **one or two characters**, each piece
  wrapped in a label of its own, is no longer served or written: the list's
  raw strings are read in order at every piece width from 1 up to the square
  root of the token's length, and a list whose pieces spell the token is no
  list (the generator says "part of the account token" and writes nothing).
  The 3-character-window gate that stood in for this is gone: it refused
  ordinary catalogs whose prose happened to hold a three-letter run.

- An encoded echo is cut where it stands: a base64 (URL-safe or standard) or
  hex copy of the token, whole, folded over lines, behind a label, padded in
  front, or as a `\u00xx`-escaped spelling, is cut from the card and from a
  keyless shape pass (the `--check` print, a failed sign-in), and the
  generator's encoded gate reads the folded answer with its separators taken
  out.

- The check-in reads one envelope, one refusal and one negation on both
  branches: a refusal two wrappers deep is a failure whatever the HTTP status
  (it was checked on 2xx only), a success word the next sentence denies is no
  claim (a bare `code:200` beside it used to settle the day), and a flat
  `success:false` beside the vendor's own "already claimed" sentence no
  longer costs the day and its wait on the error branch — a refusal wrapped in
  `data`, or a code in words, still vetoes, as it does on 2xx.

- An account name is refused only when it is a JWT (three dot-separated
  base64url segments with header and signature), not for being long:
  `AlexanderHamilton` and `long_normal_user_name` sign in again.

- The credential-shape rule cuts a 24+ mixed run only when it wears a
  secret's marks (an underscore, all capitals, or word boundaries that spell
  gibberish), so the vendor's own ids (`claude-sonnet-4-5-20250929`,
  `DeepSeekR1DistillQwen32BInstruct`, `LongCamelCaseModelIdentifierV2`) are
  served, generated and left readable on the card; a bare 32+ hex run is
  still cut unless a digest label introduces it.

- The models hook and the check-in stay inside their budgets on hostile
  input: the key's window sets and encodings are computed once per key, only
  runs that carry the key's own encoding head are decoded, and the folded-run
  scan is bounded (an 8 MB word was 809 ms; it is ~15 ms). 2000 records ×
  120-character names take ~1.2–1.6 s on Node.

- Claude models are asked at `.../v1/messages` again under magpie's host. An
  Anthropic model stated the provider's `.../v1` as its own URL while magpie
  joins the SDK's `/v1` onto the loader's base after taking the path's `/v1`
  off (plugins.go's pluginRequestBase) — every Claude request went to
  `.../v1/v1/messages`. The loader now answers the bare base (`baseURL`) and
  an Anthropic model's URL is `base + "/v1"`; the provider's `cfg.api` keeps
  its `/v1`, and a chat model's URL is the bare base, which the host joins its
  `/v1` onto itself.

- The models hook answers the host's fallback signal the way the host reads
  it: the table it handed in, unchanged (a JSON copy, so identity is what the
  host compares), marked with `magpie.fellBack`; a table holding a null or
  string entry is answered from a clean copy instead, so the host never reads
  a non-record.

- More ways of echoing the token are cut: a fullwidth spelling, a JSON-escaped
  text, a dot between every character (or every other one taken), and base64
  or hex with a label an affix or a fold, in halves joined back together, past
  8 KiB, or after another encoding in front of it. Model names, ids, activity
  names, card messages and the catalog file all use the same cuts, and a name
  that would be cut falls back to its id.

- A token split into 5-character pieces, each with a label of its own, across
  model names is no longer served or written: the pieces in key order are
  still the token.

- Another provider's credential (`sk-…`, a Bearer token) or a JWT of an
  earlier sign-in in a vendor field is not served, printed or written — only
  the current key's shapes were checked before.

- A username claim that is itself a credential is not shown as the account's
  name nor sent as one.

- `--check` compares and prints old records as `JSON.parse` reads them (a
  token folded with a JSON escape was printed whole), fails on a field the
  catalog does not write, and prints parse errors through the shape rules.

- The check-in branch for an error status applies the 2xx path's order: an
  explicit `success:false`, a refusal wrapped in `data` (two levels deep
  included) or a business code in words (`invalid_token`,
  `account_restricted`) vetoes a success word; a next sentence that denies the
  claim ("…successfully today? No, not yet") is a denial; a 500 that says
  "Success" is a server failure, not a claim.

- `pointsOf` and the activities reader refuse any non-numeric business code
  instead of reading a refusal's `0` balances or stale list.

- The check-in status row reads the first wait that can be stated (wrapped
  body, top level, `Retry-After` header) instead of letting an unreadable one
  hide a readable one.

- A vendor answer that arrives gzip-encoded is refused at the size gate (the
  inflated copy was held before the cap applied), and the check-in's word
  rules read at most 8 KiB of an answer.

- No hook throws out to the host on a hostile or broken input: a failing auth
  reader in the loader, a null config, a frozen headers bag, a provider getter
  that throws, a model table holding a lone surrogate.

- The style test scans `.github`, which is where a CRLF checkout would show
  (`.gitattributes` claimed it already did).

- A token echoed as fragments is cut in every shape. The gates looked for a
  contiguous 8-character run; a gateway that folds a zero-width mark between
  every character, splits the token into 7-character pieces (with or without a
  label or affix), joins pieces with commas, or base64-encodes it left the
  account's token recoverable from a model name, an activity name, the model
  list the plugin serves, a card message, `--check` output, or the committed
  `catalog.mjs`. `echoesKey` now compares flattened text (the fold is removed
  on both sides) at six characters, `cutKey` projects a message onto the
  token's own alphabet so punctuation-separated pieces are cut whole,
  `scrubShapes` recognises a JWT that only reads as one after the projection,
  `catalogOf` blanks base64-encoded names and ids, and the generator's last
  gate checks the flattened and base64-decoded forms of every field and of the
  reassembled file.

- `cutFolded` no longer trusts a message after cutting the first folded copy:
  a second copy padded past the walk's reach used to survive with 123 of a
  125-character token still readable. The tail is now checked in linear time
  after the cut.

- A 400 that names this attempt's success is a claim, not "already claimed":
  「领取成功，24小时内仅可领取一次」 with `retry_after` (or a `Retry-After`
  header, on a 2xx or an HTTP 400) used to be reported as `done` with no
  credit and the vendor's words replaced. The success word vetoes the
  400-beside-a-wait pair, on both paths.

- The check-in reads a refusal wrapped in `data` the way every other reader
  does: `{code:200,data:{code:401}}`, `{code:200,data:{code:500}}` and
  `{code:200,data:{success:false}}` used to be reported as claimed (with a
  fabricated credit); an inner 401/403 now says to sign in again.

- A numeric string business code is a number: `" 200 "`, `"200.0"` and
  `"2e2"` used to be read as a business *word*, refusing a healthy catalog,
  dropping the check-in status row, and masking a real `account_restricted`
  behind a `" 200 "` envelope.

- The `--check` line folds every JSON escape a separator can be written as
  (`\b`, `\f`, `\u0000`–`\u001f`, not only `\n`/`\r`/`\t`), so a token folded
  with one of the others is not printed whole.

- The generator drops an id the cut had to change (`model-…`), as the live
  list does; the committed file no longer carries a record under an id the
  gateway never named.

- The generator's terminal message for an answer past the size cap is English
  like the rest of its prose (the card keeps the Chinese wording).

- Credit is omitted, not sent as `null`, when the two balance halves are each
  finite but their sum is not (1e308 + 1e308).

- A check-in status answer may state `retry_after` at the top level as well as
  under `data`; both are read, and the card says when the day can be claimed.

- `waitIn`'s de-duplication on the 2xx path only skips the appended wait when
  the vendor's own words do not name a failure; a refusal that says
  「签到失败，请稍后重试」 still reports when to try again.

- The failure words now cover the remaining "try later" spellings the vendor
  and gateways use (故障, 超时, 稍后再来, 系统开小差, throttled, retry later,
  please retry, try later, please wait, wait a moment, daily limit), and
  "Please try again tomorrow" no longer vetoes a genuine success. The English
  denial list is the one the failure words strip, so "No issues, without
  error" no longer fail a claim. A Chinese "not yet credited" no longer
  negates a claimed day.

- The README's clipboard command reads the config as `utf-8-sig`, so a
  Windows-written BOM no longer makes `json.load` refuse a file the plugin
  itself accepts.

- The tarball gate names every file the packed suite loads (including
  `scripts/catalog.mjs`, `README.md` and `CHANGELOG.md`), and a pack or unpack
  that fails exits 2 ("could not run here") rather than 1 ("the artifact is
  bad").

- The CI comment on the Bun job names the real dependency: the tarball-gate
  tests need `node` and `npm`, not the generator (which runs under
  `process.execPath`).

- Documentation no longer claims more than the style test checks: it covers
  `.mjs` and `.md`, and skips dot-directories.

- The check-in's success word, denial list and last-sentence narrowing are
  shared by the 2xx and the HTTP-error branches, and a check-in refusal's wait
  is not printed twice.

- The check-in reads the day's statement before this attempt's: when an answer
  names both the window and a success word, whichever comes **first** decides
  — "Already signed successfully today" is the day claimed (`done`), while
  "领取成功，24小时内仅可领取一次" is this attempt's claim with its credit. The
  success word used to win regardless of order, so an already-claimed day was
  reported as a claim with a credit of 0.

- A said-claimed day that is then negated is not claimed: "You have not already
  claimed today" and "Already signed today? No, not yet" used to be read as
  `done`. The negation may be the next sentence's opening (a question answered
  "No"), but a note after a full stop ("Check-in successful. No points were
  added") is not a veto.

- The negation now gates **every** road to a settled day, not only the
  wording: "Already signed today? No, not yet" beside a `retry_after` (on a 2xx
  or on an HTTP 400) and beside a bare `code:200` used to be read as claimed
  again through the 400-beside-a-wait pair and the code-200 positive signal.
  A next-sentence negation now has to deny the state ("No, not yet", "not
  yet", 尚未, 还没有): "Already signed today. No further action needed." is a
  claim, not a denial.

- "No errors" is not an error, however it is written: 没有错误, 没有异常,
  无任何错误 and 无任何异常 used to fire the failure word inside the denial and
  turn a success sentence into a failure. A dash ends an aside the way a comma
  does — "Check-in successful - no points were added" is a claim — and bare
  "denied"/"invalid" no longer veto one.

- The English negation no longer crosses a comma: "No errors, check-in
  successful" is a claim again, not a failure. A Chinese comma still joins one
  sentence, so 没有错误，签到成功 stays a success.

- A negation in one language vetoes a success word in the other ("check-in not
  成功"), and 成功率 ("success rate") is not a success word: a code-less answer
  saying only 成功率 is no longer a claim, and beside a failure word it is the
  failure it says. The failure words the veto was missing are read too (不可用,
  错误, 异常, 拒绝, 无效, "rate limited", "not available", "system error",
  "internal server error", "bad gateway", "gateway timeout", "try again
  later"), with 没有错误 / 无任何错误 / 未发现异常 and their English forms
  ("no errors", "without errors") left as the denials they are.

- The `success` flag is read as a JSON API spells it: `"false"`, `0` and `"no"`
  are refusals like the boolean `false`, in the check-in and in every balance,
  status, activity and catalog read. A refusal used to become "0 点" or an
  empty model list.

- A `Retry-After` header on a **2xx** answer reaches the card: a 200 whose
  business code refuses (a 429/503 in the body) says when to try again instead
  of losing the wait. The header is read only when it is a number of seconds or
  an HTTP date — a fractional value like "3600.5" used to parse as the year
  3600 — and a wait past a week is "cannot use it" (0), not clamped to a week
  and reported as if the vendor had said it.

- A business code is read wherever the vendor put it (`code`, `error.code`,
  `detail.code`, `data.code`), and a numeric code is no longer returned as a
  business code word.

- A check-in message stays within the 400 code points the card reads, wait
  included: the vendor's words were cut to the cap and the wait was appended
  after it, so a long refusal beside a wait came out past the cap on both the
  2xx-business-refusal path and the HTTP-error path.

- An activity whose `remaining_quota` cannot be read is not drawn as 「不限量」:
  the card read a null as unlimited, so an unreadable value said something the
  vendor did not. A null is still unlimited and a readable number is still
  drawn. A protocol the vendor states as a bare string is read rather than
  falling back to chat, and a token count past 10M is "not stated", not a
  context to plan for.

- Credential scrubbing normalizes every invisible separator before the shape
  pass: a token folded with a character `\s` does not match (U+180E, a
  combining enclosing mark such as U+20DD) used to pass through whole when
  there was no key to cut by. The folded-key walk's stripped-copy fallback
  looks at the whole text rather than the walk's reach window, so a key folded
  several separators per character near the card's cut is cut.

- The catalog generator cuts the token out of its `--check` diff lines — the
  old file's values were printed as they were written — and refuses to write at
  all when a fragment of the token survives in any string the file is built
  from (a token split across two fields), rather than committing the leak.
  The fragment check looks for every window of the token (8 characters since
  the final review; it began at 12) at every position: a gateway that split it
  into four 25-character fields used to pass a per-field cut and write all
  four pieces.

- The live model list cuts the token out of the raw display name before the
  120-character clean: a name of 80 characters of prose followed by the token
  left the token's first 40 characters in the list, where the post-clean cut
  could no longer match them.

- Both config readers (`appToken` and the generator) refuse a config that is
  not a regular file (a FIFO would block the read for ever) or larger than
  1 MiB, before opening it.

- The `models` hook drops a record whose id echoes the account's own token and
  cuts it out of a name; the usage card cuts it out of an activity's model ids,
  both before the 120-character clean truncates the string.

- The tarball gate treats a missing `npm`/`tar` as exit 2 ("could not run
  here"), like a missing Bun it is told to require, clears `npm_config_*`
  case-insensitively (Windows env vars can be upper case), and refuses an
  argument carrying `%` through cmd.exe (exit 2) instead of letting the shell
  expand `%NAME%` even inside quotes. The CI Bun job now sets up Node, because
  the suite spawns `node` for the generator tests, and the README's Windows
  clipboard command honours `CODAR_HOME` like the app does.

- The business body's `retry_after` wins over the gateway's `Retry-After`
  header on the error path too: the thrown message carried the header's
  number, and the check-in's "don't say it twice" rule then kept it over the
  vendor's own.

- A pack that exits 0 and writes no tarball is exit 2 ("ask again") from the
  gate, not exit 1 ("the packed suite failed"): there is nothing to run.

- `cutKey` scans before it allocates: `split().join()` builds a copy of the
  whole string even when there is nothing to cut, which cost an 8 MB error
  message two allocations for a key it never echoed.

- The contradictory-sentence rule is pinned as intended: a message with a
  failure word and a success word in different sentences reads as failure —
  a false claim settles the day at 0 points, while a false failure costs one
  more ask 30 minutes later, and the next answer resolves it either way
  ("签到失败。今天签到成功。" is reported as failed on purpose).

- An activity's model ids are cut out of the **raw** id before cleanText
  truncates it: a 134-character token echoed as an id left 120 of its
  characters on the card, and the same order bug as the model list's, which
  had been fixed in the catalog path only. Only the two ids a window names are
  cleaned now; the rest is counted.

- A restriction the vendor spells only in the words beside a 401/403 is no
  longer read as an expired sign-in: the branch discarded the vendor's words,
  so `{code:403, message:"api access is restricted"}` said "sign in again" and
  magpie marked the account expired.

- The separator normalization the shape pass uses now only fires between two
  characters of the credential's alphabet: a blanket pass over every invisible
  character took the combining marks out of ordinary prose (Devanagari, Thai,
  a decomposed accent) and word-split the message.

- An activity's `model_ids` is bounded: only the ids the card names are
  cleaned, so a hostile activity carrying a huge list costs the host no more
  than the two a window shows.

- The catalog reads a refusal stated on the nested catalog's own `success`
  (`{catalog:{success:false, data:[…]}}` returned a record), and a protocol the
  vendor named with a value that is not a string is no longer read as chat
  (`{protocol:{type:1}}` was served over the chat wire).

- The generator checks `res.ok` before it reads the body: on a runtime whose
  body stream throws for a non-2xx status, a plain refusal read as "this is a
  failed fetch" instead of `HTTP 500`.

- The generator's token-fragment gate reassembles each object's own strings
  and each property's strings across the answer, so a token split into pieces
  shorter than one window (11 fields × 11 characters) is refused instead of
  written piece by piece.

- The tarball gate maps cmd.exe's "not recognized" (exit 9009) to exit 2, the
  same "could not run here" an `ENOENT` is, so the Windows job cannot report a
  missing `npm`/`tar` as a failing gate.

- A claimed check-in carries `until` when the vendor states the next window,
  as the README promises; the claimed branch dropped it and magpie fell back
  to its own 30-minute cadence.

- The usage card's locally detected failures ("no key", "key without an
  account name") carry `signIn: ""` like every other failure, and the
  `FOLDED_ALL` table is gone (dead since the walk took over).

- A vendor refusal whose body words itself in an object `detail` is read
  again: the gateway answers `403 {"detail":{"code":"account_restricted",
  "message":"…"}}`, and `saidBy` read `detail` only as a string, so the card
  showed a bare `HTTP 403` and, worse, read that 403 as an expired sign-in.
  The plugin now carries the vendor's business code and tells
  `account_restricted` apart from a lapsed login, pointing at Codar support
  instead of asking you to sign in again; the README explains why the card
  can look healthy while chat is refused (the card reads account endpoints,
  which need no chat access).

- A claim needs a positive signal. A 200 JSON that says none of them (`{}`,
  `[]`, `{"ok":true}`, a maintenance note) used to settle the day as claimed
  at zero points. Code 200, `success: true`, or the vendor's own success
  wording is now required; anything else is a failure the host retries. The
  `401`/`403` branch now runs before `success: false`, so an expired sign-in
  still asks you to sign in, and `account_restricted` is told apart from it.

- The success wording has to be the word: the substring rule read
  "unsuccessful" and 签到不成功 as a claim, and settled the day at zero points
  over a message that said the opposite. A message carrying a failure word
  (失败, 没能成功, 无法成功, "failed") is not a claim even if it also carries a
  success word — the retry that follows costs a request, while a false claim
  settles the day. The English negations ("not successful", "not been
  successful", "did not succeed", "unsuccessful") and the words a vendor uses
  for throttling (风控, 频繁, 限流, "rate limit", "busy", "maintenance") veto
  the same way — and so does any negation a few words away from the word
  ("this is not a success", "no confirmation of success yet", "cannot confirm
  success"), which used to read as a claim. The negation is read in either
  order: "success not confirmed", "success was not achieved", "success hasn't
  been confirmed" and 成功未确认 used to carry a success word and no veto, and
  settled the day at zero points. A note after a comma or a period is still a
  note, not a veto.

- A business code is read the way the vendor's own client reads it
  (`Number(e.code)`), not the stricter reading used for balances and waits:
  `{code: [], token: 500}` came out as a balance of **500**, and a check-in
  body whose code was `[]`, `true`, `""` or `null` was read as if it had named
  no code. Those shapes are now the codes the client sees (0, 1, 0, 0), and a
  finite code that is not 200 refuses; an object code is still "no code", so a
  hostile body cannot throw out of a hook.

- The check-in reads the vendor's own statement rather than the envelope
  around it: an already-claimed body under another HTTP status (a gateway
  rewriting the 400 into a 409/422/429/500/503 keeps the body) is the day
  claimed again; a success sentence carrying the window rule is this claim,
  with its credit and its words; a 200 beside failure words is a refusal;
  an explicit `success: false` is not overridden by the 400-beside-a-wait
  pair; a wait only the `Retry-After` header carried reaches `until`; a body
  business code of 401/403 says the sign-in expired; a restricted sentence
  whose code the gateway stripped is still the restriction; and a refusal
  no longer says its wait twice.

- The claim row's state is the first **boolean** among the four spellings, as
  the vendor's client reads it (`um`): a body naming `isSigned: null` beside
  `signed: true` was read as "not claimed", offering a claim the account
  could not take.

- A record keeps only the modality kinds the host knows, strings only, in the
  vendor's order. The list was copied as the vendor sent it, so an object —
  or a credential — inside `input_modalities` rode into the committed
  `catalog.mjs` and into the model list the host persists.

- The folded-key cut covers every invisible character, not the hand-written
  list: any whitespace, Unicode format character (`\p{Cf}`), combining mark
  (`\p{Mn}`), and the fillers and braille blank are skipped inside a key,
  with a stripped-copy check as the last resort. A token folded at U+180E,
  U+206F, U+FE0F, U+3164, U+034F, U+115F or U+2800 used to pass through
  whole — in a message and into the committed catalog.

- The folding walk's scope reaches past the card's cut by the key's
  doubled length, and the generator's catalog fields are cut whether the
  token is an object key, a value, a nested branch, or a key that straddles
  the scrub boundary: `MAX_SCRUB_CHARS` used to leave a 71-character prefix
  of a folded token in a log.

- A 400 refusal that says it failed is not re-read as a claim by the
  `retry_after` beside it; a failure that carries a wait now says it
  ("（约 N 后可重试）") instead of dropping the wait on the floor. The same
  veto now covers the body-code branch: a no-code 200 that says
  "24小时内仅可领取一次" **and** that this attempt failed was read as the day
  claimed, because that branch tested the claim wording without the failure
  words the HTTP-400 branch had always applied.

- `account_restricted` is read from the business code wherever the answer
  carries it, not only beside a 401/403 status: a 200 whose body named the
  code went through the claim gate. The vendor's measured sentence ("API
  access is restricted") is still read when a gateway strips the code, but a
  bare "access is restricted" is no longer taken for it — that sentence can
  be about something else, and the card would have sent the user past the
  sign-in step to support.

- The "already claimed" wording now needs the claim said with the window: the
  qualifier (仅/只能/才) or the 一次. A maintenance note ("24小时后可恢复领取")
  and a pause ("24小时内暂停签到") both mention the window near a claim verb
  without saying the day was claimed, and used to settle it.

- The 400-beside-a-readable-`retry_after` pair needs the 400. A 200 with no
  code and only a wait said nothing about a claim — a gateway envelope can
  carry one — and reading it as `done` settled the day on it.

- A refusal that carries a business code in an HTTP 200 body (a 429 or 503
  after a gateway) names the wait its `retry_after` states, as the
  `Retry-After` header path already did, instead of looking like a broken
  account.

- The catalog is regenerated to what the vendor serves today: 15 models — the
  `auto` router plus the DeepSeek, GLM, GPT and Claude families. The Claude
  line now reads 5.5 (`claude-sonnet-5-5`, `claude-sonnet-5-5-kiro` beside the
  opus pair; the plain `claude-sonnet-5` names are gone). A regenerated
  fallback no longer trips the tests, which now pick their ids from the
  catalog instead of pinning retired names.

- The `Retry-After` a 429 carries reaches the card, so a rate-limited request
  says "come back in a moment" instead of looking like a broken account.

- Credential scrubbing by shape is cut down to what a credential looks like:
  `sk-`/`pk-`/`rk-` keys, `api_key=…` assignments, long Bearer tokens, and
  long mixed tokens, while ordinary words that merely share letters
  ("skateboarding", "secretary-general-of-the-united-nations", a sha256
  digest, `quota_exceeded_for_this_account…`) are no longer redacted into
  noise. A run of hex is cut as a key unless a digest label introduces it —
  "sha256 9f86…", "SHA-256: …", "md5: …" are diagnostics; a bare hex key is
  still a key — and the label is matched with fixed-length lookbehinds,
  because a variable-length one was ~400× slower per position. A known key
  echoed with a control character folded inside it is still cut.

- The "read from this machine" sign-in reads a config that starts with a BOM
  instead of calling the whole file corrupt.

- The catalog generator refuses an argument it does not know (`--chek` used to
  run the default write), shortens the home directory in the paths an
  exception quotes (`cannot write ~/…` no longer follows it with the absolute
  one),
  races the body read against the same budget so a vendor that sends headers
  and then goes quiet cannot hang it, and cuts the account's own token where a
  vendor echoes it in a catalog field — the file is committed. The cut is the
  plugin's own (`cutKey`), so a gateway that wraps the token every 20
  characters, or folds a control into it, cannot get most of the key written
  into `catalog.mjs`; the old exact-substring cut missed exactly that echo.

- The catalog generator refuses an answer whose records name no context
  window. Every model the vendor lists states `context_window`, so a record
  without one means the field moved — and writing it would put a model with no
  window into the committed fallback, where the older file still carries the
  last real figure. The run is exit 2 (ask again) and writes nothing; `--check`
  does not call the file stale over it either.

- An address written with an empty authority (`https:///v1`, `https:/v1`)
  falls back to the vendor's gateway instead of sending the account's key to
  a host named after the first path segment.

- The `models` hook survives a provider it cannot read (an explicit `null`,
  or a models table saved as an array) instead of throwing the whole provider
  list down.

- The usage card's check-in row is drawn only when the vendor's answer names a
  state: a body whose `data` is `{}` used to draw "今天还没领，现在可以领"
  over a state the vendor never gave.

- The catalog read refuses an answer whose business code refuses, whatever
  list it carries (`{code: 500, data: […]}`), and drops a record whose
  protocol this host cannot serve instead of listing it as chat.

- An account key that is not a string is no key: a damaged auth file reads as
  "no key", which the sign-in can explain, instead of sending `"123"` or
  `"[object Object]"` to the vendor.

- The answer-size cap holds on a Response that offers no stream: a stated
  `Content-Length` past the cap is refused before reading, and a body that
  states no length is measured after it is read.

- A check-in the vendor answers with an HTTP 400 status and the words
  "already signed today" is read as the day claimed, with `until`, instead of
  as a failure magpie re-asks every 30 minutes: the refusal's body is read the
  same way a 200 body is, including the 400-beside-a-`retry_after` pair.

- The points readers read `account_restricted` before the numeric code, so a
  200 body carrying the word says the account is restricted instead of "the
  points read returned no balance" — and an agent balance that did read no
  longer hides the restriction from the card.

- A known key folded at an ordinary space, or at any invisible character, is
  cut. The folded cut is a walk over the message rather than a pattern built
  from the key: a pattern long enough for a very long key made V8 throw, and
  the error quoted the whole key back into the log. The invisible characters
  the exact split, the stripped key and the folded walk skip are one range
  table (`FOLDED_RANGES`: C0/C1 controls, NBSP, zero-width and BOM
  characters, line/paragraph separators, full-width space), so a key folded
  at NBSP or at a C1 control is cut like one folded at a space.

- The catalog generator's leak gate now reassembles the records in the order
  the committed file carries them (id-sorted, field by field) and looks for
  8-character windows, not 12: a token split into pieces under one window, one
  per record, or alternating between id and name with a numbered filler, was
  written into `catalog.mjs` (a reversed vendor array walked the byName join
  backwards). What remains — an adversarial answer that shuffles
  sub-8-character pieces with its own index — is past what any order-free
  check can see; the gate is defence in depth.

- The generator's "no context_window for …" diagnostic runs after the leak
  gate and hides an id the credential shapes touch: with the token's three
  segments as ids, the pre-gate message printed the whole credential.

- `--check` scrubs the old record by shape (`scrubShapes`: JWT, Bearer, sk-,
  api_key, long mixed tokens), not only by the current token, and turns
  literal `\n`/`\r`/`\t` escapes into spaces first: a stale JWT from an
  earlier sign-in, or this token wrapped with escapes in the file, was printed
  verbatim.

- A refusal wrapped in `data` is a refusal: `{data:{code:401,…}}`,
  `{data:{success:false,…}}` and `data.error.code: account_restricted` were
  read as a balance of 0 (or as a status query that answered), because the
  gates ran on the envelope while the fields were read from the wrapper. The
  points, agent-points and status readers gate the wrapper too; the activity
  reader already refused every wrapped shape by its list check.

- A business code stated in words (`{"code":"account_restricted"}`) is a
  refusal in `catalogOf`: the live list replaced the fallback with the
  refusal's stale list, and the generator exited 0 and wrote it.

- A model id carrying the token is dropped, not renamed: the check compared
  cleanText's output to the already-cut id, so `model-…` was served.

- The check-in's positive signal is the code **or** the success flag, and the
  already-claimed denial gates both: `success:true` beside "You have not
  already claimed today" settled the day as claimed.

- A success word beside a 400 body code is this attempt's claim
  ("领取成功，24小时内仅可领取一次"), as the order rule says; the numeric
  refusal gate ran first and reported a failure.

- A top-level `retry_after` is read on the 2xx path and in the HTTP-error
  catch: a 23-hour wait stated at the top level fell back to the 30-minute
  shelf.

- Server and retry-later wording beside a 400-and-a-wait is a failure, not the
  day claimed: 请稍后再试, 请求超时, "Internal Server Error", "Bad Gateway",
  "gateway timeout", "try again later".

- English "success rate"/"success ratio" is not a success word, as 成功率 is
  not; "no errors" / "without errors" / "with no errors" / 未发现异常 are
  denials before the failure words read them.

- The Chinese "today already signed" spellings are the day claimed: 今日已签到,
  已经签到过了, 今日已领取, 已签到，请勿重复签到, 每天限领一次.

- A next sentence has to deny the state: "Not yet credited" and 没有其他问题
  after the day's statement are notes, not denials.

- A model name or activity name carrying an 8-character run of the token is
  not served: two fields beside each other reassembled the credential.

- The models hook hands on model records only (a null or string entry in the
  user's table would throw in the host's Promise.all), and a credential-shaped
  segment in a `CODAR_HOME` path is not said in the sign-in error.

- The suite pins these fixes with mutations: each one has a test that goes red
  when the fix is removed, including the HTTP-date wait's magnitude, the shell
  guard on the real run path, `claimStated`'s code gate against a 500, and the
  agent-refusal assertion on the figure the card draws.

### Added

- A WeChat QR sign-in: the vendor's own code flow
  (`POST /v1/wechat/login/qrcode` → `{scene, qr_url}`, then
  `POST /v1/wechat/login/status {scene}` every two seconds, as the web app
  polls it). The plugin serves the page on `127.0.0.1` and makes both calls
  itself, so the image the vendor drew is shown from the plugin and the token
  in the status answer never reaches the page. Expiry (including the vendor's
  business code 404) refreshes the code; a WeChat that is not bound to an
  account, or a scan that lands on the vendor's IP check, ends with the sign-in
  that can finish it rather than spinning.

- `POST /v1/user/verify_ip` is now reached the way the vendor's web app
  reaches it. When a password sign-in answers `code 201` /
  `ip_verify_required`, the plugin keeps the temp token that refusal carried
  and the SMS page finishes that check for it — code type `ip_verify` with the
  account's own name, then the three fields the endpoint takes with the temp
  token as its bearer — so the person is not asked for the password again.
  The temp token is held in the plugin's memory only: never saved, never shown.

- The free-model campaign is claimed, not just reported. Beside a check-in the
  plugin calls `GET /api/codar/activities/free-model` and, when the campaign
  says `available`, posts its `claim` (the vendor's own one-click benefit on
  its activities page), then says so in the check-in line. Best-effort
  throughout: a campaign already claimed, none open, or a refused call leaves
  the check-in's own answer untouched, so the extra can never fail the
  check-in. It rides on the check-in, so it happens only for an account whose
  check-in is switched on.

- Chat now leaves through the same Go proxy as the card's requests, when the
  proxy can carry it. The loader answers a `fetch` — magpie runs
  `typeof o.fetch === "function" ? o.fetch : fetch` — so a conversation to the
  gateway carries the desktop's TLS and HTTP shape instead of Bun's, and the
  answer is streamed back as it arrives.

### Changed

- The reader, the sign-in page, the native transport and the fallback catalog
  live in `lib/` (`lib/internal.mjs`, `lib/signinpage.mjs`, `lib/native.mjs`,
  `lib/catalog.mjs`), so the repository root holds only the entry module and
  the project's files. Nothing the plugin does changes; the two never-published
  compatibility names `smslogin.mjs` and `wechatlogin.mjs` are gone.

- The page method is labelled “科搭OAuth登录” in magpie's method list, so the
  three entries read as what they are: a token, the vendor's own OAuth
  sign-in (QR or phone, in one page), and the account's name and password.

- One “科搭OAuth登录” entry in place of the separate SMS (“科搭手机号短信登录”) and
  WeChat QR (“科搭微信扫码登录”) methods. It opens a single page on
  `127.0.0.1` whose tabs are the two ways in the vendor's own login dialog
  offers (扫码登录 / 手机号登录), so switching between them no longer means
  backing out to magpie's method list. The page is redrawn to match the
  vendor's client and site: indigo active tab, near-black primary button, the
  QR dimmed with a sentence over it once it was scanned or is being replaced,
  and one final screen for “登录成功” or a sign-in the vendor will not finish.
  The SMS captcha is loaded only when its tab is first shown, and the QR code
  starts drawing only when the page opens. The IP-check handover now opens this
  page straight on the security check.

- The sign-in page's last screen shares the page's design language instead of
  standing apart from it: the card's own brand mark box (34px, the same radius
  and soft shadow) in green for “登录成功” or red for “无法完成登录”, the card's
  20px/600 heading, the body's 14px ink for the first sentence and the hint's
  13px muted for the closing one, left aligned like the form. The sign-in's own
  heading and hint give way to the end screen's, and a vendor's reason and the
  closing instruction are two lines rather than one merged paragraph. Two
  deeper shades join the page's palette in `:root` for the mark's gradients.

- The sign-in options are four now, not five: “读取本机科搭令牌” (keyless) and
  “科搭访问令牌” (paste) are one entry with an optional token field — leaving
  it empty reads the desktop app's own login on this machine, filling it uses
  the pasted token, and both are checked the same way (visible ASCII, an
  account name, an unexpired exp) before anything is saved. The password
  sign-in sits after the SMS page, because the vendor's IP check commonly
  hands it on to that page.

- The proxy flushes each piece of a streamed answer as it is written and
  bounds the wait for a response head instead of the total length, so a long
  chat answer is no longer cut at a deadline meant for short catalog requests.
  After the head, silence on the body is bounded by the plugin's own stream
  bound, which reaches the proxy as a cancelled request, not by a second
  timer that would have to guess the same number.

- The proxy forwards `X-Api-Key` and `Anthropic-Version` in addition to
  `Authorization` and `Content-Type`: the vendor's Anthropic models
  authenticate with the first and state the second, and a chat request that
  carried them lost its credential and its protocol on the way out. A card
  request never has either, so nothing changes for it.

- Models carry the vendor's own credit multiple: `rate_badge` ("0.20x") is
  read as magpie's `rate` (a positive number; "0.20x"/"0.2×" and a bare
  number are the same rate), live and in the embedded catalog, so the badge
  the vendor's client shows appears beside the model. The vendor's prices in
  CNY are still not reported (see README), and a model the vendor does not
  badge carries no `rate` key in the catalog file (`0` is "not listed", not a
  rate, and `--check` treats a later badge as a change to regenerate for).

- A base32 or percent-encoded copy of the token is cut like base64 and hex:
  on the card, in the keyless shape pass, in model ids and names, and in the
  generator's encoded gate and cross-string check. A token split into pieces
  that only read as one after percent-decoding is no catalog.

- A split of an *encoded* token is no catalog, no card and no `--check` line
  either: pieces of a base32 or `%XX` copy, an id or name on each record, are
  read together and decoded before anything is served, written or printed
  (`%XX` triples the line or field boundaries cut in half included), each
  field's strings are read on their own as well as with the other field, and
  the walk follows the token, its base32 copy or its `%XX` copy piece by
  piece, and a piece padded with prose inside its own field is read field by
  field (the run that continues the spelling, in order) — with no opening a
  list must carry, so a piece behind a label in its id ("model-000-ey") is
  read too. A split that alternates between a record's id and its name is
  read both ways (the vendor order, the file order). `--check` also reads the
  file's values with no order at all: the pieces' own three-character runs,
  collected across the values, must not cover the spelling. A piece the
  window rules refuse on its own is cut as before, and the pieces left do not
  spell the token again.
  An activity whose model ids in order spell the token — encoded or not — is
  not drawn at all, and `--check` prints no diff line when the old file's own
  values reassemble into the token.

- A model id that reads as a word (`sk-whisper-large-v3`, `sk-live-…` with
  segments under 12 characters) is no longer mistaken for an `sk-` credential
  and dropped from the whole catalog; a credential-shaped `sk-` run still is.

- A catalog of long names serves within the models hook's budget: the token
  checks read the first 512 characters of each id and name, the cross-record
  split scan is capped at 16 KiB, each field is judged once however many
  lists read it, and a decoded form is only walked when it holds one of the
  key's own characters. 1000 records of ~6 KB names answer in ~3.4 s inside
  the 20 s host budget (was ~33 s).

- The entry module no longer has a default export. magpie's host and
  OpenCode 1.x take every function a module exports as a plugin, while
  OpenCode 2.x reads a package's default as its setup object and has no
  fallback for a 1.x plugin's named functions; a default pointing at the same
  plugin function is at best a duplicate entry and cannot stand in for 2.x's
  setup. `index.mjs` now exports `CodarPlugin` by name only, and the suite
  asserts that no default export comes back.

- The catalog generator's terminal messages are English, like the rest of the
  project's prose; what each exit code means is unchanged.

- The fallback catalog is regenerated in place (`node scripts/catalog.mjs`);
  the counts in the README and comments were updated and no longer promise a
  fixed number.

- The generator validates the token's account and expiry before fetching,
  reads a BOM-tolerated config like the plugin does, times out instead of
  hanging on a vendor that never answers, and says local paths through
  `shownPath` (no account name in a log or an issue). A permission failure
  now says to check permissions instead of "sign in once", its own output
  path is shortened the same way, and its 15 s timeout is named as this
  script's own budget (the plugin's hooks keep the 8 s magpie's deadlines
  leave them).

- The packed suite gate tells a Bun that is not installed (a skip locally) from
  one that ran and failed (a failure everywhere, with or without
  `--require-bun`); CI now runs it on Windows too, and every job has a
  15-minute timeout. `node` and `bun` run without a shell (a missing Bun is
  then an ENOENT, not a shell's 127 that looks like a failing program), the
  `npm`/`tar` arguments are quoted for cmd.exe (a Windows temp path can carry
  a space, an ampersand or a caret), and an argument it does not know is exit 2
  instead of silently dropping the Bun half of the check. A Bun the run
  requires but cannot find is exit 2 ("could not run here"), not 1 ("the
  packed suite failed").

- The catalog generator writes a sibling temporary file and renames it into
  place, so a write that fails partway cannot leave `catalog.mjs` truncated;
  a catalog file whose records are not records is exit 2 rather than a crash
  out of `--check` (which exited 1, the code that means "regenerate"); an
  unexpected throw is exit 2 with a shortened message; the request race keeps
  the process alive until its budget answers; and the fetch address and
  User-Agent come from the plugin's own constants instead of a second copy.

- The packed suite now has a gate: `node scripts/tarball.mjs` packs,
  unpacks into a scratch directory and runs the suite with Node and Bun
  inside it. CI has a `tarball` job and the release steps call it before
  publishing. The gate now packs the checkout whatever directory it is run
  from, finds `npm` and `tar` on Windows, cleans up after a failure, and CI
  passes `--require-bun` so a Bun that will not run is an error there
  instead of a skipped half; `prepublishOnly` runs the gate itself.

- Node 20 is the engine floor (`>=20`): it is the oldest Node the suite runs
  on, and the CI matrix runs 20, 22 and 24. Node 18 is no longer supported.

- The README's clipboard command honours `CODAR_HOME` the way the app does,
  has a PowerShell line for Windows, and says what Linux needs (`xclip` and
  a display).

## [0.1.2] - 2026-11-04

### Fixed

- The suite now passes from the npm tarball: the style test pinned
  `CONTRIBUTING.md`, which is not shipped with the package, so running
  `node --test` inside a fresh tarball failed 1 of 188 tests. The required
  documentation files are now the ones the package actually carries
  (`README.md` and `CHANGELOG.md`), verified by unpacking a tarball and
  running the full suite inside it (188/188).

## [0.1.1] - 2026-11-04

### Changed

- The test hooks moved out of the entry module: `index.mjs` now exports only
  the plugin function, and every reader plus the `testables` object lives in
  `internal.mjs`. OpenCode 1.x takes every export of `main` for a plugin and
  refused the package over `testables`.
- The auth hook gained a `loader`, as the provider contract expects for a
  provider served through config: a request for the account carries the
  stored key, and an account with no usable key answers `{}`.

### Added

- `CHANGELOG.md`, shipped with the package.

### Removed

- The Chinese README. Project documentation — the README, CONTRIBUTING,
  this changelog and the GitHub release notes — is English-only.

## [0.1.0] - 2026-11-04

Initial release.

### Added

- A `codar` provider for magpie: 17 models at the time (the `auto` router plus the
  DeepSeek, GLM, GPT and Claude families), OpenAI Chat Completions for most
  and Anthropic Messages for the Claude ones.
- The model list refreshed live from `GET /v1/codar/models`, with an embedded
  fallback catalog (`catalog.mjs`) and `scripts/catalog.mjs` to check and
  regenerate it.
- Two sign-in methods: reading the Codar desktop app's own token file
  (read-only) and pasting an access token.
- Daily check-in through `POST /v1/daily-sign`, once per rolling 24 hours,
  reporting the claim (with the points it added) or that the day was already
  claimed, and carrying `until` so magpie re-asks exactly when the next claim
  opens.
- Usage card: general and agent points, today's check-in state, running
  free-model activities, and the general points also reported as a wallet
  reading for routing.
- Per-model concurrency of 3 (measured), adopted from the catalog's
  `max_concurrency` when the vendor states one.
- Requests shaped like the desktop client's per endpoint: matching
  `User-Agent`, header construction, BOM-tolerant reading, an answer-size cap,
  and credential scrubbing in every message.
- A test suite (187 tests) on Node 18–24 and Bun across Linux, macOS and
  Windows, including a formatting test that pins `.editorconfig`.

[Unreleased]: https://github.com/MisonL/magpie-plugin-codar/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/MisonL/magpie-plugin-codar/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/MisonL/magpie-plugin-codar/releases/tag/v0.2.4
[0.2.3]: https://github.com/MisonL/magpie-plugin-codar/releases/tag/v0.2.3
[0.2.2]: https://github.com/MisonL/magpie-plugin-codar/releases/tag/v0.2.2
[0.2.1]: https://github.com/MisonL/magpie-plugin-codar/releases/tag/v0.2.1
[0.2.0]: https://github.com/MisonL/magpie-plugin-codar/releases/tag/v0.2.0
[0.1.2]: https://github.com/MisonL/magpie-plugin-codar/releases/tag/v0.1.2
[0.1.1]: https://github.com/MisonL/magpie-plugin-codar/releases/tag/v0.1.1
[0.1.0]: https://github.com/MisonL/magpie-plugin-codar/releases/tag/v0.1.0
