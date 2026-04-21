# Publishing to the VS Code Marketplace

## 1. Create a publisher account
- Sign in at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) with a Microsoft account
- Create a publisher (e.g. `nichobbs`)

## 2. Create a Personal Access Token (PAT)
- Go to [dev.azure.com](https://dev.azure.com) → User Settings → Personal Access Tokens
- Scope: **Marketplace → Manage**
- Copy the token — you only see it once

## 3. Install `vsce`
```bash
npm install -g @vscode/vsce
```
(Already included as a dev dependency; an `npx vsce package` task is configured in the workspace)

## 4. Package and publish
```bash
# Login once
vsce login nichobbs

# Package to inspect before publishing
vsce package

# Publish
vsce publish
```

Or combine: `vsce publish` builds and uploads in one step. The version in `package.json` is what gets published.

## 5. Version bumping
```bash
vsce publish minor   # bumps 0.1.0 → 0.2.0 and publishes
vsce publish patch   # bumps 0.1.0 → 0.1.1
```

## Checklist before going live
- [ ] Remove `"preview": true` from `package.json` (or keep intentionally for pre-release)
- [ ] Add an icon (128×128 PNG) via `"icon"` field in `package.json`
- [ ] Fill in `"categories"` and `"keywords"` in `package.json` for discoverability
- [ ] Polish `README.md` — it becomes the Marketplace listing page
- [ ] Update `"name"`, `"displayName"`, and `"publisher"` in `package.json` if renaming (e.g. to GitBraid / `nichobbs.gitbraid`)
- [ ] Verify `LICENSE` file is present ✓
- [ ] Verify `"repository"` URL is correct in `package.json` ✓
