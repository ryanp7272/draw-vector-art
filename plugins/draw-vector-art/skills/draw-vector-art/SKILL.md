---
name: draw-vector-art
description: Create, revise, validate, render, and compare clean editable flat-geometric SVG icons and simple vector illustrations from text prompts or local reference images. Use when Codex needs to draw an SVG, make a vector icon or pictogram, adapt a sketch or image into semantic vector geometry, improve an unreliable AI-generated SVG, or deliver named and individually editable vector parts rather than a flattened image.
---

# Draw Vector Art

Create vector artwork through the bundled semantic scene engine. Author constrained JSON, compile it deterministically, inspect rendered previews, and revise named objects instead of hand-writing raw SVG paths.

## Prepare the engine

The engine requires Node.js 20.3 or newer. Locate this skill directory and run the bundled launcher from any working directory:

```bash
node <skill-directory>/scripts/run-engine.mjs doctor
node <skill-directory>/scripts/run-engine.mjs <command>
```

Do not install packages into the installed plugin directory. The launcher uses repository dependencies during development; otherwise, the first engine command runs `npm ci --omit=dev` once in a versioned writable temporary cache. Run `node <skill-directory>/scripts/run-engine.mjs prepare` to perform that bootstrap explicitly. Set `DRAW_VECTOR_ART_CACHE_DIR` only when the default temporary directory is unsuitable.

Read [references/scene-format.md](references/scene-format.md) before authoring or changing a scene. Consult [references/scene.schema.json](references/scene.schema.json) only for exact schema details.

## Follow the drawing loop

1. Translate the request into a brief covering subject, composition, palette, mood, and essential parts. Treat an unspecified reference as `adapt`: preserve its subject, composition, and important colors while simplifying its geometry.
2. Create `<name>.scene.json` in the user's output directory. Build the composition and largest silhouette first. Use semantic lowercase IDs such as `rocket-body` and `left-eye`.
3. Add smaller parts with relative frames, mirrored clones, and groups. Reuse palette references and prefer fewer purposeful shapes over path fragments.
4. Validate after each meaningful stage:

   ```bash
   node <skill-directory>/scripts/run-engine.mjs validate <scene.json>
   ```

5. Render after validation succeeds:

   ```bash
   node <skill-directory>/scripts/run-engine.mjs render <scene.json> --out <output-directory>
   ```

6. Inspect `preview-64.png`, `preview-1024.png`, and `debug.png`. When using a reference, also run and inspect:

   ```bash
   node <skill-directory>/scripts/run-engine.mjs compare <scene.json> --reference <image> --out <output-directory>
   ```

7. Revise only the named objects responsible for visible problems. Repeat validation and rendering for no more than four focused refinement passes unless the user asks for further exploration.

## Judge visual quality

Check every render for:

- Immediate recognition at 64 px.
- Balanced silhouette, negative space, and optical centering.
- Deliberate overlap and layer order.
- Consistent curves, corner treatment, outlines, and palette use.
- Symmetry created through clones rather than independently guessed coordinates.
- Important reference features retained without tracing texture or noise.
- Individually selectable semantic SVG groups and shapes.

Treat `report.json` as structural evidence, not an aesthetic score. Always inspect the actual images. Fix all errors; investigate warnings rather than suppressing them mechanically.

When evaluating a change to this skill or engine, read [references/benchmark.md](references/benchmark.md) and use `node <skill-directory>/scripts/run-engine.mjs benchmark <run.json> --out <output-directory>`. Do not use the benchmark protocol for ordinary drawing requests.

## Preserve reliability

- Keep the scene JSON as the source of truth. Do not manually patch the generated SVG.
- Use the 256×256 canvas unless the request requires another aspect ratio.
- Keep Bézier nodes on the local 0–100 object grid and use relative handle vectors.
- Keep direct hexadecimal colors in `palette`; reference them as `@name` in object paint.
- Keep clones and placement targets among siblings. Keep IDs unique across the entire scene.
- Avoid typography, animation, gradients, remote assets, embedded raster images, scripts, filters, and arbitrary SVG/XML in v1.
- Stop and explain if the request fundamentally requires photorealistic tracing, complex typography, animation, or another unsupported feature.

## Deliver the result

Return links to:

- The editable `.scene.json` source.
- `drawing.svg` as the clean vector export.
- `preview-1024.png` for convenient review.
- `report.json` as validation evidence.
- `compare.png` when a reference was used.

Mention any remaining warning or deliberate simplification. Do not claim reference fidelity from automated validation alone.
