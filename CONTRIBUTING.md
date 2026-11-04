# Contributing

Thanks for looking at this. A few things about the plugin are load-bearing, and
the test suite pins each of them — the notes below say why, so a change that
trips one is a change to argue for, not to route around.

## The rules the suite defends

**The entry module exports only plugin functions.** magpie's loader takes
*every* function a module exports as a plugin entry (`servers()` in the host
walks `Object.values(mod)`), and OpenCode 1.x refuses the whole package when
`main` exports anything that is not a plugin — `testables` in `index.mjs` did
exactly that. So `index.mjs` exports only `CodarPlugin`; the readers and the
`testables` object live in `internal.mjs`, which the plugin and the tests
import. `test/plugin.test.mjs` pins the entry module's export list, and
magpie-community/plugins' `scripts/check.mjs` is the fuller gate.

**Never print the token.** Error messages pass through `scrubLine`, which cuts
the token where it is known and any JWT-shaped string where it is not; answers
are refused while they are read (`readAnswer`'s `MAX_ANSWER_BYTES` cap), so an
oversized vendor body cannot end up in an error either. The tests assert no
message contains the token.

**The fallback catalog is generated, not hand-written.** `node scripts/catalog.mjs`
rewrites `catalog.mjs` through the plugin's own `catalogOf` — the same rules the
live path uses. A failed read exits `2` and writes nothing: an answer that could
not be fetched is "ask again", never "the catalog moved". Don't edit
`catalog.mjs` by hand except to repair a record the vendor will not fix.

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
node --test                        # the whole suite, no network
bun test                           # the runtime magpie actually loads plugins on
node scripts/catalog.mjs --check   # is catalog.mjs still what the vendor says?
```

The tests stub `fetch`; nothing here talks to speedai. Fixtures follow the
clock, so they don't expire on a given day. `test/style.test.mjs` pins the
formatting rules in `.editorconfig` (LF, one final newline, no trailing
whitespace, two-space indent) and discovers files from the tree, so a new file
is covered the moment it lands.

CI runs the suite on Node 18–24, on Bun across Linux / macOS / Windows, and on
Node on Windows and macOS.

## Against the real API

The vendor's endpoints are unversioned, and its own desktop client is the
authority on how each field is read — the comments in `internal.mjs` name the
functions in `app.asar` each reader follows. When a shape changes, widen the
reader and add a test that sends the new shape; run
`node scripts/catalog.mjs --check` after a catalog change.

## Documentation

Everything a reader sees is English: the README, this file, `CHANGELOG.md`,
GitHub release notes and the npm metadata. Code that quotes the vendor's own
Chinese strings keeps them — they are behaviour, not prose.

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
version with the release date, then:

```bash
npm version <patch|minor|major> -m "release: v%s"   # bumps package.json, commits, tags
git push --follow-tags
npm publish                                         # prepublishOnly runs the suite
gh release create vX.Y.Z --title vX.Y.Z --notes "<the CHANGELOG section>"
```

`npm pack --dry-run` lists what ships: the plugin, the catalog and its
generator, both test files, the README, the changelog and the licence.
