# Draw Vector Art

`draw-vector-art` is a Codex plugin and deterministic TypeScript drawing engine for clean, editable SVG icons and simple illustrations. Codex authors a constrained semantic scene, validates it, renders previews, inspects the result, and revises named parts instead of guessing raw SVG coordinates in one pass.

Version 0.3 adds modeled affine transforms, reusable group instances and repeaters, compound paths with semantic arcs, frame-relative named gradients, and one bounded shadow effect. The engine still rejects raw SVG, scripts, remote assets, arbitrary filters, and CSS.

[![CI](https://github.com/ryanp7272/draw-vector-art/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanp7272/draw-vector-art/actions/workflows/ci.yml)

![Three-task direct SVG versus scene-engine pilot](benchmark-results/pilot/contact-sheet.png)

![Version 0.3 reusable sunflower showcase](plugins/draw-vector-art/skills/draw-vector-art/tests/snapshots/sunflower-medallion.svg)

## Use it in Codex

Node.js 20.3 or newer and npm are required. Install the latest public marketplace directly from GitHub:

```bash
codex plugin marketplace add ryanp7272/draw-vector-art --ref main
codex plugin add draw-vector-art@draw-vector-art
```

For a reproducible install, pin the marketplace to a release instead of the moving `main` branch:

```bash
codex plugin marketplace add ryanp7272/draw-vector-art --ref v0.3.0
codex plugin add draw-vector-art@draw-vector-art
```

Choose either `main` or a release tag for a marketplace installation, not both under the same marketplace name. `main` receives the newest changes; a version tag stays fixed.

Start a new Codex task after installation, then ask naturally or invoke the skill explicitly:

```text
Use $draw-vector-art to make a golf ball on a tee.
```

Codex delivers the editable scene JSON, clean SVG, 64/256/1024 px previews, debug overlay, and validation report. Reference adaptations also include a comparison sheet.

To refresh an installation that tracks `main`:

```bash
codex plugin marketplace upgrade draw-vector-art
codex plugin add draw-vector-art@draw-vector-art
```

Start a new Codex task after upgrading so the refreshed skill instructions are loaded.

### First-run bootstrap

The plugin ships compiled engine code, so using it does not require TypeScript or a build step. On the first engine run for a release, its small launcher downloads the pinned production dependencies with `npm ci` into a versioned, platform-specific directory under the operating system's writable temporary directory. Later runs reuse that cache and do not modify the installed plugin.

Codex normally handles this automatically. To check prerequisites or populate the cache ahead of time from a repository checkout, run:

```bash
node plugins/draw-vector-art/skills/draw-vector-art/scripts/run-engine.mjs doctor
node plugins/draw-vector-art/skills/draw-vector-art/scripts/run-engine.mjs prepare
```

Set `DRAW_VECTOR_ART_CACHE_DIR` to another writable directory if the default temporary directory is unavailable or routinely cleared. `prepare` requires network access the first time it populates a cache; rendering can then reuse that cached release.

## Engine commands

Run from the repository root:

```bash
node plugins/draw-vector-art/skills/draw-vector-art/scripts/run-engine.mjs schema
node plugins/draw-vector-art/skills/draw-vector-art/scripts/run-engine.mjs validate /path/to/scene.json
node plugins/draw-vector-art/skills/draw-vector-art/scripts/run-engine.mjs render /path/to/scene.json --out /path/to/output
```

## Reproduce the comparison pilot

The repository includes a 12-task evaluation manifest and a three-task smoke-test run. The pilot compares a one-shot direct SVG against a validated scene-engine result and generates deterministic blind A/B sheets plus a blank human scorecard:

```bash
node plugins/draw-vector-art/skills/draw-vector-art/scripts/run-engine.mjs benchmark \
  plugins/draw-vector-art/skills/draw-vector-art/tests/evaluation/pilot/run.json \
  --out benchmark-results/pilot
```

The included pilot is illustrative, not an independent model evaluation. A defensible product claim requires independently generated outputs for all 12 tasks and blinded human scoring. The runner deliberately reports structural metrics without pretending they measure visual quality.

## Verify

Install development dependencies and run the complete local check:

```bash
npm --prefix plugins/draw-vector-art/skills/draw-vector-art ci
npm --prefix plugins/draw-vector-art/skills/draw-vector-art run check
```

CI runs the same check on Node 20 and 22 under Ubuntu, macOS, and Windows, rejects stale committed runtime or JSON Schema files, and exercises `doctor`, `prepare`, `schema`, and both legacy and v0.3 showcase renders from a clean `git archive` with no development dependencies present. The packaged smoke test also covers paths containing spaces and renders from the prepared cache with npm unavailable.

## Releases

Release tags are the stable distribution points. Each release includes the semantic skill instructions, TypeScript sources, generated JSON Schema, and committed JavaScript runtime. A release is ready only after the cross-platform checks and clean packaged-plugin bootstrap pass. See the [changelog](CHANGELOG.md) for user-visible changes and [release checklist](docs/RELEASING.md) for the maintainer workflow.

## License

MIT. Use it, modify it, test it, and build on it.
