# Changelog

Every published version of Pilot Connector, the self-hosted blind relay between a desktop and a
phone. It forwards WebSocket frames by room only: it never stores messages and never holds the
end-to-end keys.

**The Pilot project does not run a public relay.** To reach your phone across networks, deploy your
own.

This file is maintained by hand: add an entry at the top when a version ships. Older history lives on
the [Releases page](https://github.com/yunjianmanbu/pilot-connector/releases) and on the website
(<https://pilot.medpilot.cc/>).

Chinese version: [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). Every entry needs Node.js >= 22.12.

## [0.2.3] - 2026-11-20

### Added

- **L1 admission code and random connection path.** The installer generates a `home:<random>`
  admission code and a `/c/<random>` path and prints the whole connection string.
- The relay verifies the code before creating a room and rejects a bad one with `4009`; `/healthz`
  exposes `anonymous` and `rejected` counters.

### Changed

- `RELAY_ACCESS_STRICT` defaults to `0`, which records code-less connections without refusing them.
  Switch it to `1` once every client has updated, so an upgrade cannot lock you out.
- The forwarding path, the blind-relay promise and the protocol are unchanged.

## [0.2.2] - 2026-11-19

### Added

- A per-source connection cap: at most 64 concurrent connections from one address by default, with
  the upgrade refused above it (`MAX_CONNECTIONS_PER_IP`, set `0` to disable).
- A source cut-off switch: addresses listed in `RELAY_BLOCK_IPS` are dropped at handshake.
- `/healthz` reports `sources` and `blockedSources` so an operator can spot a source worth cutting off.

### Changed

- The archives now ship `LICENSE`, `NOTICE` and `RESPONSIBLE_USE.md` inside the package, and the
  links in `README.md` point at those copies instead of the repository root.
- No message storage, no key custody, no protocol change.

## [0.2.1] - 2026-11-19

### Added

- Room-based forwarding with no message storage and no key custody.
- A systemd unit, an nginx reverse-proxy sample and a one-line installer.
- A matching `.sha256` for every archive.
