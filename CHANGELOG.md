# Changelog

All notable changes to Draw Vector Art are documented here. Release tags are immutable; the repository's `main` branch is the rolling channel.

## [0.2.2] - 2026-07-22

Reliability release. The scene format and drawing command interface remain compatible with 0.2.1.

### Added

- A committed JavaScript runtime and dependency launcher, so installed plugins do not need TypeScript or permission to build inside their installation directory.
- `doctor` and `prepare` commands for checking Node/npm prerequisites and preloading production dependencies into a writable versioned cache.
- GitHub CI across Node 20 and 22 on Ubuntu, macOS, and Windows, including a clean packaged-plugin bootstrap and render smoke test.
- Public release and compatibility guidance, including reproducible tag-pinned installation.

### Improved

- Benchmark run validation rejects duplicate or incomplete task sets, balances blind A/B assignments, and produces native 64 px and reference-aware review artifacts.
- First-run failures now report actionable bootstrap diagnostics without mixing installer output into engine JSON.

## [0.2.1] - 2026-07-22

Initial public MIT release of the Codex plugin and deterministic TypeScript drawing engine.

### Added

- A semantic JSON scene format for named vector primitives, placement relationships, mirroring, clipping, palettes, and local-grid Bézier paths.
- Structural validation, deterministic SVG compilation, 64/256/1024 px previews, debug overlays, and reference comparison sheets.
- Codex workflow instructions for staged composition, visual inspection, and targeted refinement.
- A 12-task evaluation manifest and an illustrative three-task comparison pilot. The pilot is a workflow demonstration, not an independent quality claim.

[0.2.2]: https://github.com/ryanp7272/draw-vector-art/releases/tag/v0.2.2
[0.2.1]: https://github.com/ryanp7272/draw-vector-art/commit/4d48a3f
