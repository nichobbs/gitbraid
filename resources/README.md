# `resources/`

Marketplace assets and walkthrough media.

## Marketplace icon

- `icon.png` — the 128×128 icon shown on the VS Code Marketplace listing.
  Must stay a PNG; the Marketplace silently rejects SVG icons.
- `icon.svg` — the activity-bar icon (referenced from
  `package.json:contributes.viewsContainers.activitybar.gitbraid.icon`).
  Activity-bar icons are monochrome SVGs.

## Walkthrough images

`package.json:contributes.walkthroughs` references five images:

| File | Step | Status |
| --- | --- | --- |
| `walkthrough-add-branch.svg` | "Add a branch to the stack" | Placeholder SVG |
| `walkthrough-assign-file.svg` | "Assign a file to a branch" | Placeholder SVG |
| `walkthrough-hunk-routing.svg` | "Split a file's edits across branches" | Placeholder SVG |
| `walkthrough-commit.svg` | "Commit to a branch" | Placeholder SVG |
| `walkthrough-rebase.svg` | "Add another layer" | Placeholder SVG |

The SVGs are **placeholder illustrations** that sketch the UI the step is
describing. They avoid the broken-image placeholder VS Code otherwise
renders but should be replaced with real screenshots before a 1.0 release.

### Capturing replacement screenshots

1. Launch the extension host against `test_projects/proj1/` with a clean
   `.worktrees/local-config.json`.
2. For each step, reproduce the UI state the walkthrough step is
   describing, capture at 2× DPI (for retina crispness), resize to
   approximately 1280×720, and export as PNG.
3. Commit the PNGs alongside the SVGs (keep both — Marketplace renders
   the PNG; the SVG stays as a textual/accessible fallback). Update
   `package.json` entries to reference the `.png` variants.

Any new walkthrough step needs a matching asset here — VS Code does not
provide a graceful fallback when `media.image` is missing.
