# Changelog

All notable changes to PacketAtlas are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-11-06

### Added

- **Abandoned services.** Mark a service that's off on purpose with
  `abandoned: true`, or the `packetatlas.io/abandoned: "true"` label or
  annotation on a discovered one. While its check fails it shows as
  abandoned instead of down: boarded-up windows and doors, grime, cracks
  and ivy, with a torn chain-link fence and a keep-out sign around the lot,
  and no fire. Every building and landmark has its own abandoned version,
  such as a crumbled factory chimney, a collapsed water tower, a caved-in
  capitol dome or a ruined castle. If the service comes back up, it's shown
  as it is. The map pin is brown, and the summary bar and side panel show
  the new state. See the wiki page
  [Abandoned services](https://github.com/AgroDan/packetatlas/wiki/Abandoned-Services).
- Discovery keeps abandoned Kubernetes workloads that are scaled to zero
  and abandoned compose services whose containers have all exited, so
  switching them off boards them up instead of removing them from the map.
- An isometric car favicon, with a `favicon.ico` fallback.

### Changed

- The README is now a short overview, and the documentation lives in the
  [wiki](https://github.com/AgroDan/packetatlas/wiki).

## [0.4.0] - 2026-10-26

### Added

- **Landmarks** for important services: big, ornate buildings that take a
  whole block. These are `skyscraper`, `twins`, `capitol`, `pylon`,
  `fortress` and `arcology`, or `landmark` to pick one from the service's
  id. Configured checks set `important: true` or a landmark building, and
  discovered services are listed by name under a top-level `important:` or
  annotated `packetatlas.io/important: "true"`. Names that discovery
  doesn't find are logged and ignored.

## [0.3.0] - 2026-10-26

### Added

- Colours can be CSS names (`pink`, `darkblue`), `light`/`dark` plus a
  name (`lightpurple`), or hex. Unknown colours fall back to the default
  and are logged once.
- The Helm chart is published to GHCR as an OCI chart.
- Every Helm value is documented, and the README has an animated demo.

## [0.2.0] - 2026-10-25

### Added

- **Map environments**, set with `map.environment`, each with its own
  border between services inside the Docker host or cluster and those
  outside it: `suburban` (a river, the default), `mountains` (a range
  crossed by a pass), `islands` (open sea), `desert` (a canyon) and
  `winter` (a frozen river). `?environment=<name>` in the URL previews one.
- More documentation for Docker access and for telling inside services
  apart from outside ones.

## [0.1.0] - 2026-10-22

The first release.

### Added

- An isometric pixel-art city as the UI: each monitored service is a
  building, and traffic is cars on the streets.
- HTTP, TCP, ping, Docker and Kubernetes checks, opt-in discovery of
  compose services and Kubernetes workloads, and agents that push to a
  shared hub.
- Building styles: office, apartment, house, deco, modern, tower,
  datacenter, factory, shop and radio. Kubernetes and Docker targets
  default to `auto`, which picks a style from the target's id.
- An organically grown city layout with a river, lakes, a park and
  highways, seeded from neighborhood names so it's stable across reloads.
- A container image on GHCR for linux/amd64 and linux/arm64, running as
  numeric UID 65532, and a Helm chart.

[Unreleased]: https://github.com/AgroDan/packetatlas/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/AgroDan/packetatlas/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AgroDan/packetatlas/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AgroDan/packetatlas/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AgroDan/packetatlas/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AgroDan/packetatlas/releases/tag/v0.1.0
