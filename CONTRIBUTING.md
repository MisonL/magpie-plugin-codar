# Contributing

Thanks for looking at this. A few things about the plugin are load-bearing, and
the test suite pins each of them — the notes below say why, so a change that
trips one is a change to argue for, not to route around.

## The rules the suite defends

**Where each file lives.**
`index.mjs` at the root is the entry magpie's `main`/`exports` point at, and
it loads three modules from here, one line each: `lib/internal.mjs` (the
reader and the `testables` object), `lib/catalog.mjs` (the fallback catalog)
and `lib/guarded.mjs` (the ordinary fetch the plugin falls back on, held to the
proxy's redirect rule). Everything else the plugin runs lives in `lib/`: the
sign-in page (`lib/signinpage.mjs`) and the native transport
(`lib/native.mjs`).
`scripts/` holds the tools a developer or a release runs (`catalog.mjs` writes
`lib/catalog.mjs`), `test/` the suite, and `native/` the Go proxy with its
per-platform builds. A new module belongs in `lib/` unless it is a tool or a
test; keep the entry module's imports to one line each so the load path stays
obvious.

**The entry module exports only plugin functions.** magpie's loader takes
*every* function a module exports as a plugin entry (`servers()` in the host
walks `Object.values(mod)`), and OpenCode 1.x refuses the whole package when
`main` exports anything that is not a plugin — `testables` in `index.mjs` did
exactly that. So `index.mjs` exports only `CodarPlugin`, and exports it by name
only: OpenCode 2.x reads a package's default as its setup object and has no
fallback for a 1.x plugin's named functions (the note atop the community
`opencode2.mjs`), so the entry module carries no default export either. The
readers and the `testables` object live in `lib/internal.mjs`, which the plugin and
the tests import. `test/plugin.test.mjs` pins the entry module's export list,
and magpie-community/plugins' `scripts/check.mjs` is the fuller gate.

**Never print the token.** Error messages pass through `scrubLine`, which cuts
the token where it is known — even when the server folded a control character
into it — and cuts credential-shaped strings where it is not (a JWT by its
`eyJ`/base64url shape, an `sk-…`, a `Bearer …`, a long secret). Answers are
refused while they are read (`readAnswer`'s `MAX_ANSWER_BYTES` cap, on the
stream and on a body that offers none), so an oversized vendor body cannot end
up in an error either. The tests assert no message contains the token.

**A claim needs a positive signal.** The daily check-in reads `code: 200`, or
`success: true`, or the vendor's own success wording; a 200 JSON that names
none of them (`{}`, `[]`, a maintenance note) is a failure the host retries,
not a day settled at zero points. A message that also carries a failure word
(失败, not successful, rate limit, …) is not a claim even when it carries a
success word — in either order ("not successful", "success not confirmed") —
the retry that follows costs a request, while a false claim settles the day.
A wait beside a refusal is a claim in exactly two shapes: the
message says the day was already claimed, or the refusal is a 400 business
code with a readable `retry_after` (the rolling 24-hour window's own pair);
a failure word takes either away. `401`/`403`
are read before `success: false`, and `account_restricted` is told apart from
an expired sign-in.

Both branches — a 2xx answer and an HTTP error carrying the same body — read
one envelope, one refusal and one negation (`deepRefusal`, `deniedFlat`,
`successDenied` in `index.mjs`): a refusal two wrappers deep fails whatever
the status, a success word the next sentence denies is no claim, and a day's
own sentence ("24小时内仅可领取一次") wins over a flat `success: false` the
same way on both, because the vendor's flag speaks for the call and the
sentence for the day. A test sends one body over 200/400/409/500 and pins
one reading; add a shape there rather than to one branch.

**The fallback catalog is generated, not hand-written.** `node scripts/catalog.mjs`
rewrites `lib/catalog.mjs` through the plugin's own `catalogOf` — the same rules the
live path uses. Anything that is not a usable run exits `2` and writes nothing
— a failed read, a failed write, or an argument it does not know (only
`--check` is one): an answer that could not be fetched is "ask again", never
"the catalog moved". Don't edit
`lib/catalog.mjs` by hand except to repair a record the vendor will not fix.

**`CODAR_HOME` is read verbatim, not trimmed.** The app's sidecar takes the
value as it is; both readers (the plugin's `configPath` and the generator's
`configPathOf`) do the same, with an empty value meaning "not set". A trim on
one side points the two at different files.

**User model edits are magpie's, not this plugin's.** Name, price, reasoning
levels, context and output edits live in magpie's own settings and are applied
*after* the plugin returns its model list; the `given` a hook receives carries
only the catalog defaults this plugin wrote. Do not merge `given` back over the
vendor's entries — that freezes the catalog at the day the plugin shipped.

**Timeouts stay under the host's deadlines.** magpie gives a usage read 20
seconds and a check-in 2 minutes; the plugin's budgets (exported as `timing`
on `testables`) and its per-request timeout are pinned against those figures.

## Development

```bash
node --test                        # the whole suite (a 127.0.0.1 registry, no vendor calls)
bun test                           # the runtime magpie actually loads plugins on
node scripts/catalog.mjs --check   # is lib/catalog.mjs still what the vendor says?
```

The tests stub `fetch`; nothing here talks to speedai. Fixtures follow the
clock, so they don't expire on a given day. `test/style.test.mjs` pins the
formatting rules in `.editorconfig` (LF, one final newline, no trailing
whitespace, two-space indent) for `.mjs`, `.md`, `.json`, `.yml` and `.yaml` files,
discovered from the tree (`.github` included; dot-directories such as `.git` are skipped),
so a new one of those is covered the moment it lands.

CI runs the suite on Node 20–24, on Bun across Linux / macOS / Windows, and on
Node on Windows and macOS. A `tarball` job packs the artifact and runs the
suite inside it on both runtimes
(`node scripts/tarball.mjs --require-bun`): `files` decides what ships, and a
test that references a file outside it passes in a checkout and fails for
users. The Windows job runs the gate too (without Bun), which is where its
`.cmd` and CRLF branches are exercised: an argument it does not know is
exit 2 and a misspelt `--require-bun` cannot silently skip the Bun half. `prepublishOnly` runs the same gate
before every publish; a bare `npm pack` does not run it, so use
`node scripts/tarball.mjs` when checking an artifact by hand (add
`--require-builds` to make a tree without `native/bin` an error rather than a
named skip). Every CI job has
a 15-minute timeout, so a hung vendor or a stalled child process cannot hold a
runner for hours.

## Against the real API

The vendor's endpoints are unversioned, and its own desktop client is the
authority on how each field is read — the comments in `lib/internal.mjs` name the
functions in `app.asar` each reader follows. When a shape changes, widen the
reader and add a test that sends the new shape; run
`node scripts/catalog.mjs --check` after a catalog change.

## Documentation

Everything a reader sees is English: the README, this file, `CHANGELOG.md`,
GitHub release notes, the npm metadata, every code comment, and the generator's
terminal messages. Two kinds of Chinese stay, because they are behaviour rather
than prose: the strings the plugin matches against the vendor's answers (成功,
失败, 24小时内仅可领取一次) and the labels and messages magpie's Chinese UI shows
(科搭令牌（留空读本机）, 登录已过期，请重新登录). Do not translate either — a translated
label stops matching its UI, and a translated pattern stops matching the vendor.

## Versioning and releases

The version in `package.json` is the single source of truth; git tags are
`v<version>`, and `CHANGELOG.md` holds one dated section per version in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. The project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the
pre-1.0 reading: a new feature or a behaviour change is a minor bump, a fix is
a patch, and 1.0.0 is reserved for the point where the plugin's reader
contract is stable.

Every user-visible change lands under `## [Unreleased]` first, in one of
Added / Changed / Fixed / Removed. A release moves that section under the new
version with the release date: rename `## [Unreleased]` to
`## [X.Y.Z] - YYYY-MM-DD` with the version `npm version` is about to write
(and leave a fresh empty `## [Unreleased]` above it). A release that ships a
registry package with no CHANGELOG entry for its own version is a mistake
nobody catches later — the file records why a version exists, and a missing
one cannot be filled in faithfully after the fact. Then:

```bash
npm run native:all                                  # the five platform builds
npm version <patch|minor|major> -m "release: v%s"   # bumps package.json, commits, tags
# npm version does NOT touch optionalDependencies: bump those five pins to the same version by hand,
# or native-packages.mjs --check will refuse the staged set (this bit 0.3.1 — see its release entry).
node scripts/native-packages.mjs                    # stage the five from native/bin at this version
node scripts/native-packages.mjs --check            # the five stage at this version, and the manifest reaches them
node scripts/tarball.mjs --require-bun --require-builds  # every gate first: the packed suite, the install check, Bun
node scripts/native-packages.mjs --publish          # the five platform packages, first
git push --follow-tags
npm publish                                         # prepublishOnly re-runs the same gates: --strict builds, the packed suite and install check (--require-bun --require-builds), the staged set (--check)
gh release create vX.Y.Z --title vX.Y.Z --notes "<the CHANGELOG section>"
```

The staging step comes before its check: `--check` reads the staged set, and a
tree still holding the previous version's staging fails it for that reason
alone. The no-argument run stages from the current `native/bin` and main
`package.json`; `--publish` stages the same set again before it uploads, so a
stale staging directory is never what reaches the registry.

**The gates run before the first publish, not after it.** A platform package
published at a version cannot be replaced or withdrawn (npm refuses to
overwrite a version), and `--publish` uploads five of them one after another:
a gate that fails afterwards leaves half a version behind. `node
scripts/tarball.mjs --require-bun --require-builds` packs, runs the suite on
both runtimes, installs the main package against the staged platform packages
with both bun and npm, and starts the proxy the install landed; `node
scripts/native-packages.mjs --check` then says the staged set and
`package.json`'s `optionalDependencies` agree at this version. Only then
publish.

**The platform packages are published before the main one, and at the same
version.** The main package's `optionalDependencies` name them at its own exact
version, so publishing it first would install with an optional dependency npm
cannot find — an install that quietly has no proxy. `node
scripts/native-packages.mjs --publish` stages all five from `native/bin` and
publishes them; `--check` says what is staged and refuses a version that is not
the main package's. `prepublishOnly` starts with
`node scripts/build-native.mjs --check --strict`, which refuses a release that
has no build (or only a stub where one belongs) for any platform, and then runs
the tarball gate with `--require-bun --require-builds`, which installs the
packed main package in a scratch project with bun and with npm and requires
each install to land this machine's platform package and start its proxy. Neither check can tell a fresh build from
an old one: `--strict` reads presence, headers and the executable bit, and the
staged packages are whatever `native/bin` held. Running `npm run native:all`
first is the release step that keeps them current, and a build made before the
release's source change looks exactly like one made after it.

An install is one platform's build: `npm install magpie-plugin-codar` (or bun)
pulls the ~2.5 MB package whose `os`/`cpu` match the machine and skips the other
four. Nothing runs at install time — bun blocks postinstall scripts of packages
it does not trust, so a build placed by a script would silently be missing on
the runtime magpie uses. The `cpu` field is npm's spelling (`x64`, `arm64`);
npm refuses `amd64` outright, which is why the platform package is named for
Node's architecture and the binary inside keeps Go's.

`npm pack --dry-run` lists what ships: the plugin modules, the catalog and
its generator, the tarball gate, the build script and the platform-package
stager, the Go proxy with its own tests, the four test files, the README, the
changelog and the licence — and no `native/bin`: the builds travel in the
platform packages, and a main package carrying them again is five builds
shipped twice. The tarball gate ships because `test:tarball` is in
`package.json`: a script entry that points at a file outside `files` is a
command that fails for everyone who installs the package.
