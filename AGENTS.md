# AGENTS.md — vscode.d365fo.tools.xpp (D365FO AOT Browser)

Instructions for any coding agent (and human contributors) working in this repo.

## 1. Repo layout

- `src/extension.ts` — activation, view + command registration
- `src/aotTree.ts` — `TreeDataProvider`: `MS-UDE` / `MS-Packages` / `Custom`
  roots; versions (UDE-filtered, or synthetic for packages/custom entries,
  all carrying `source`) → models; version rows carry the AOT icon
- `src/classic.ts` — Classic-view mapping: VS Application Explorer category/type
  names (from MS VSIX resources) → on-disk `Ax*` folders; `extra` = invented labels
- `src/xpp/` — MIT transpiler core vendored verbatim from XppSourceViewer
  (see `THIRD-PARTY-NOTICES`; keep verbatim to ease upstream syncs)
- `src/xppPreview.ts` — readonly X++ preview (`d365fo-xpp` scheme ≈ VS XppSource docs)
- `src/searchView.ts` — the AOT search page, a contributed **webview** view
  (`d365fo-aot-search`) with an input, a funnel and a result list. It has to
  be a webview: VS Code ships no API for a search box above a contributed
  tree view. Its own Extensions view is a workbench widget — `ExtensionsViewlet`
  builds `.extensions-search-container` and instantiates the input with
  `triggerCharacters: ['@']` plus a `provideResults` suggest, and the funnel
  is an internal action, not a `contributes.menus` entry. The installed
  `vscode.d.ts` has no `searchBox`/`filterBox`, `TreeViewOptions` has exactly
  five options, and the team declined it in vscode#161753 ("ctrl+f is our
  unified tree search mechanism"). The funnel, the `@` filters and the cascade
  are all reproducible; the inline box is not.
- `src/searchFilter.ts` — the filter model both views share: free text plus
  `@` type tokens, where a token is an option key (first section
  Table/View/Class/Form, then the 14 first-level nodes, then each node’s
  child types, all derived from `CLASSIC_CATEGORIES`). Token keys are
  space-free because they are machine-inserted, and a group option stands for
  its leaf types. Also owns the tree-side pruning rules (`nodeSurvives`,
  `labelSurvives`) and the filter state the tree reads.
- `syntaxes/xpp.tmLanguage.json` + `language-configuration.json` — X++ grammar
  (vendored from the same MIT repo; `.xpp` extension matches MS VS registration)
- `src/discovery.ts` — fast filesystem scan (`discoverVersions`, `discoverModels`, `expandPath`)
- `src/metadataGrid.ts` — the data source overview, shared by views and queries.
  A view keeps its backing query under `<ViewMetadata>`, a query carries
  `<DataSources>` at the document root, and the shapes below them are identical
  (same `AxQuerySimpleRootDataSource`, same `Ranges`/`Relations`/`GroupBy`
  members), so the reader takes whichever container holds them. Selecting a
  **query** element opens this page directly (`QUERY_OVERVIEW_FOLDERS`) instead
  of its XML; the raw file stays one right-click away via `openElementXml`.
- `resources/kernel-enums.json` — values of the enums the platform builds in:
  47 of the enums referenced by metadata have no `AxEnum` file in the installed
  packages and carry 55% of all enum references. The AOS ships each as an
  `AxEnum_<Name>.xml` document embedded in
  `Microsoft.Dynamics.AX.Metadata.dll` (namespace
  `Microsoft.Dynamics.AX.Metadata.Static.Models.AxEnum`), so the file is
  generated from that assembly by `scripts/extract-kernel-enums.mjs` and checked
  in — 258 enums / 1,750 values, and the extension needs no AOS at hand. A label
  beginning with `@` is a label id and is only shown once it resolves.
- `scripts/release.mjs` — **canonical release script** (bump + changelog + VSIX)
- `scripts/extract-kernel-enums.mjs` — regenerates
  `resources/kernel-enums.json` from an AOS metadata assembly
  (`node scripts/extract-kernel-enums.mjs <AOS bin folder>`); a development tool
  only, the extension never reads the assembly at runtime
- `package.json` — extension manifest **and** npm scripts
- `resources/icons/*.svg` — bundled custom tree icons (composed from
  MIT-licensed Codicons, see `iconPathFor` + `customIcons` in `src/aotTree.ts`).
  File SVGs can't inherit the tree foreground, so every icon ships as a baked
  pair `<name>-dark.svg` (`#CCCCCC`) / `<name>-light.svg` (`#616161`);
  never reference a bare `<name>.svg`. Workshop scripts live outside the repo
  (temp `icons/build*.js` + Edge headless previews).

## 2. Build & verify

```powershell
npm install          # once (or when dependencies change)
npm run compile      # tsc — must pass with no errors before any release
```

Press `F5` in VS Code for the Extension Development Host, then open the
**Application Explorer** activity → **AOT** view to test manually.

## 3. Release policy — MANDATORY

> **After implementing any new feature or bug fix, the agent MUST ship it as a
> new extension version by running the release script.** Do not leave version
> bumps "for later" and do not hand back an unbumped tree.

Why: VS Code only treats reinstalling a `.vsix` as an *update* when its version
number increased. No bump = testers never get the fix.

### 3.1 Which command

| Change | Command | Effect |
|---|---|---|
| Bug fix, perf tweak, small improvement | `npm run release` | patch bump `x.y.Z+1` |
| New backwards-compatible feature | `npm run release:minor` | minor bump `x.Y+1.0` |
| Breaking change (settings/commands removed or renamed) | `npm run release:major` | major bump `X+1.0.0` |

Direct script invocation (same thing, all flags):

```powershell
node ./scripts/release.mjs --bump patch|minor|major|none [--keep] [--no-package] [--if-changed]
```

### 3.2 What the script does (`scripts/release.mjs`)

1. `npm run compile` — aborts the release if TypeScript fails
2. Bumps semver in `package.json` **and** `package-lock.json`
3. `npm run package` — builds the VSIX via `vsce` (filename contains the new version)
   (must include production `node_modules` — never pass `--no-dependencies`
   while the extension has runtime deps, or activation crashes with
   "command not found")
4. Deletes stale `*.vsix` files, keeping only the new one (unless `--keep`)
5. Prints the install command (`code --install-extension <file.vsix>`)

### 3.3 Agent checklist after a feature/fix

- [ ] `npm run compile` passes
- [ ] Ran the matching release command (`patch` by default, `minor` for features)
- [ ] New `*.vsix` exists and its filename version matches `package.json`
- [ ] Install it into the local VS Code so iteration continues on the new build:
      `code --install-extension <file.vsix> --force` (then Reload Window)
- [ ] If the running behavior doesn't match the new build (stale install —
      old version dirs pile up under `~/.vscode/extensions` when installing
      while VS Code runs): `code --uninstall-extension
      d365fo.vscode-d365fo-tools-xpp`, delete leftover
      `d365fo.vscode-d365fo-tools-xpp-*` dirs, reinstall, then fully
      restart VS Code (not just Reload Window)
- [ ] Commit `package.json`, `package-lock.json`, and source changes —
      never commit `*.vsix`, `node_modules/`, or `out/` (gitignored build artifacts)

## 4. Performance constraints (do not regress)

The tree scans thousands of model folders. Keep it fast:
- Discovery stays lazy: versions first, models only on expand (`src/aotTree.ts` cache)
- No recursive globs; bounded-concurrency `readdir` batches (`src/discovery.ts`)
- `Descriptor/*.xml` check is one `readdir` per candidate dir; never descend into a matched model
- Keep `modelSearchDepth` default low (3)
- Never `push(...unboundedArray)` — argument-count limits crash past ~65k
  items; use loops for element lists (bit us in search + direct categories)

> **Refresh events must pass node instances previously returned by
> `getChildren` (or received as command args).** VS Code matches refresh
> targets by object identity and silently drops freshly constructed
> lookalikes — background refreshes then never land (only manual full
> refresh appears to work). `refreshAdoptedSource` exists for the roots;
> everywhere else, fire with the adopted instance or `undefined` (whole
> tree, reconciled via stable item `id`s).

## 5. Settings contract

- `d365fo.aot.ude.rootPath` default stays `%LocalAppData%\Microsoft\Dynamics365`
- `d365fo.aot.rootPath` default stays `K:\AosService\PackagesLocalDirectory`
  (both expanded at runtime via `expandPath` — `%ENV%`, `$ENV`, `~` supported)
- `d365fo.aot.custom.rootPath` is an array of paths
- `d365fo.aot.autoResolve` is a bool, default `false`; when on, picking a field in
  a Fields grid resolves the whole grid and the Resolve button is disabled
- Per-root cache settings `d365fo.aot.{ude,packages,custom}.cache.memory`
  (bool, default `true`) and `.cache.ttlMinutes` (number, default `60`, `0` =
  manual only). Session-valid caches (no TTL expiry mid-session); a per-root
  timer rebuilds 5 min before TTL and swaps atomically. Toggling either
  setting invalidates that root and rebuilds now.
- Version indexes persist as JSON under the extension global storage
  (`aot-index/`); validated by dir-mtime signature on load, rewritten on
  rebuild, deleted on invalidate. Custom uses the same store for now.
- Renaming/removing a `d365fo.aot.*` setting or a `d365fo-aot.*` command is a
  **major** bump; adding one is a **minor** bump.

## 6. Future ideas (parked, not scheduled)

- **Custom icon font from combined SVGs.** Today composites ship as baked
  light/dark SVG pairs because file icons can't inherit the tree foreground
  the way Codicon font glyphs do. Compiling our combined sources into a small
  icon font (e.g. via `fantasticon`) would get composites closer to real
  Codicons: single files, automatic theming, crisper scaling. Open question
  for pickup time: tree rows can only reference product-icon `ThemeIcon`s or
  file paths, so verify how (or whether) custom-font glyphs can be addressed
  from `TreeItem`s before building — if they can't, the baked-pair approach
  stands.
