# Releasing Draw Vector Art

Tagged releases are immutable, reproducible plugin distribution points. The `main` marketplace reference is the rolling channel for users who want the newest changes.

## Release checklist

1. Choose a semantic version and update the plugin manifest, engine package, lockfile, and public installation example together.
2. From a clean checkout, install development dependencies and run the complete check:

   ```bash
   npm --prefix plugins/draw-vector-art/skills/draw-vector-art ci
   npm --prefix plugins/draw-vector-art/skills/draw-vector-art run check
   git diff --exit-code -- plugins/draw-vector-art/skills/draw-vector-art/runtime
   ```

3. Confirm the GitHub CI matrix passes on Node 20 and 22 under Ubuntu, macOS, and Windows. The packaged-plugin smoke job must also pass; it verifies a `git archive` copy with no `node_modules`, bootstraps production dependencies into a writable cache, and renders the deterministic fixture from that cache with npm unavailable. Its paths intentionally contain spaces.
4. Review the generated runtime and schema changes alongside their TypeScript source changes. Do not publish hand-edited generated files.
5. Tag the exact verified commit as `v<version>`, push the tag, and confirm the tag-triggered CI run passes.
6. Publish release notes describing user-visible changes, scene-format compatibility, and any migration steps.
7. Test the tagged marketplace reference in Codex:

   ```bash
   codex plugin marketplace add ryanp7272/draw-vector-art --ref v<version>
   codex plugin add draw-vector-art@draw-vector-art
   ```

8. Keep the release tag unchanged. Publish fixes under a new version rather than moving or replacing an existing tag.

## Compatibility expectations

- Node.js 20.3 or newer and npm are required for the launcher and first-run dependency bootstrap.
- Patch releases preserve the current scene format and command interface.
- Minor releases may add backward-compatible scene features. Any intentional incompatibility requires a migration note and a new major version.
- The committed runtime must always be generated from the TypeScript sources in the same commit.
- The plugin must not write into its installation directory at runtime. Its production dependencies belong in the versioned, platform-specific writable cache selected by `DRAW_VECTOR_ART_CACHE_DIR`, or in the operating system's temporary directory by default.
