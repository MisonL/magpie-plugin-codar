# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `CHANGELOG.md`, shipped with the package.

### Removed

- The Chinese README. Project documentation — the README, CONTRIBUTING,
  this changelog and the GitHub release notes — is English-only.

## [0.1.0] - 2026-11-04

Initial release.

### Added

- A `codar` provider for magpie: 17 models (the `auto` router plus the
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

[Unreleased]: https://github.com/MisonL/magpie-plugin-codar/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MisonL/magpie-plugin-codar/releases/tag/v0.1.0
