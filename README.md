# Application Explorer for Dynamics 365 Finance & Operations

Browse and read the local metadata of a Finance & Operations instance from VS
Code — the Application Explorer tree, plus a search view that filters it.

## Install

Build and install the `.vsix`:

```powershell
npm install
npm run compile
npm run package
code --install-extension vscode-d365fo-tools-xpp-<version>.vsix
```

Press `F5` to launch the Extension Development Host, then open the
**Application Explorer (Xpp)** activity.

## The views

Both live in the **Application Explorer (Xpp)** activity in the Activity Bar.

### Application Explorer (Xpp)

The metadata tree, mirroring Visual Studio's Application Explorer.

- Three roots, all tolerant of missing or empty folders:
  - **MS-UDE** — the versions under `d365fo.aot.ude.rootPath`. A folder only
    becomes a version row if its name is a four-part version (`10.0.2645.32`)
    and it holds at least one model, so `Logs`, `XPPConfig` and `RuntimeSymLinks`
    never appear. A version with no models is dropped once the scan proves it.
  - **MS-Packages** — the models under `d365fo.aot.rootPath`.
  - **Custom** — one entry per path in `d365fo.aot.custom.rootPath`.
- Expanding a version lists its **models**. Each version row has a **toggle**
  switching between the models listing and a **Classic view** that mirrors Visual
  Studio's AOT: Data Types, Data Model, Code, User Interface … down to individual
  elements. Category and type names match Microsoft's Application Explorer
  resources exactly.
- The Classic view expands further: a category shows its types, a type shows its
  elements, and an element folds into its live XML outline — table sections with
  their child counts, base-enum values, form controls, data entity fields,
  workflow outcomes and so on.
- Clicking an element opens a read-only **X++ source view**, reconstructed from
  the XML on the fly with X++ syntax highlighting — our equivalent of VS's
  transient `XppSource` documents. The raw XML stays one right-click away.
- A query row is a special case: selecting it shows the **Metadata overview** of
  the query that backs it, which is the same page a view shows under its Metadata
  node.
- Right-click a row for its actions.

#### Row actions (right-click)

| Where | Action |
|---|---|
| Version | Toggle Models/Classic View |
| Any row | Refresh |
| Model, element, enum value, table section, member | Reveal Model Folder in Explorer |
| Element | Open X++ Source · Show Raw Element XML · Show Properties · Resolve Field Types |
| Element, table section, member, XML node | Resolve Field Types |

Models also carry an inline action that opens the model's `Descriptor/*.xml`.

#### Grids

Several actions open a table instead of the tree, and stay open behind the
Extension Development Host while you work:

- **Table fields** — every field, with its type, id, label and relation keys.
  Views and data entities get their own grid, because their fields bind to a data
  source rather than declaring a type.
- **Table relations**, **Table indexes** and **Metadata** for a table.
- **Enum values** for a base enum, and **labels** for a label file.
- **Properties** for any element: name, label, help text, the group and menu
  items it belongs to, where the platform places it, and its cross-references.

Fields resolve their types by walking the whole chain — EDT, table field, base
data type — and show the travel as a hover. **Auto Resolve**
(`d365fo.aot.autoResolve`, off by default) resolves every field the moment you
pick one. The resolve language comes from `d365fo.aot.resolve.language`
(`en-US` by default).

### AOT Search

A search view with a search box, a funnel and `@` type filters above the whole
tree — the same shell VS's Extensions view has.

- **The tree is the answer.** There is no separate result list, and no element
  index behind the page: the filter is applied to the tree itself, so expanding a
  node shows its real children, pruned.
- Filtering prunes this tree only. It never folds: whatever you have open stays
  open as you add and remove text.
- Right-click a row for its actions.

#### The funnel

The funnel opens on the four kinds you reach for most — **Table, View, Class,
Form** — then an **Advanced** row opens the fourteen first-level nodes, and each
node opens its own child types. Each node shows how many types sit under it, so
you can see where the depth is before drilling in.

- Picking one of the four top kinds leaves no trailing space and keeps the menu
  open, so *Advanced* is one click away and narrowing from `@Table` to an exact
  type is two clicks rather than reopen-type-pick.
- A leaf type is the end of the road and closes the menu.

#### `@` type filters

Type `@` for the full list of options, navigable with the arrow keys: `Home` and
`End` jump to the ends, `Enter` or `Tab` take the highlighted row, and `Escape`
dismisses. A hand-typed `@word` never filters the list away — matches rank first
and everything else stays below them, ready to arrow down to, so a half-typed word
is never a dead end.

Picking a type puts its `@token` in front of whatever you have typed and replaces
any other type token:

| You type | You get | Means |
|---|---|---|
| `@Table custtable` | `@Table CustTable` | tables named *custtable* |
| `@CustTable` | `@Table CustTable` | resolved to the same token |
| `@DataModel` | `@DataModel:Tables` | one node, narrowed to one of its types |
| `@datamodel @tables` | `@DataModel:Tables` | the same, written longhand |

A node's own types live in its column: Data Model holds Tables, Table Extensions,
Views, View Extensions, Queries, Data Entities, Maps, Table Collections and the
rest; Code holds Classes, Macros and so on.

`Escape` peels off one layer at a time: the `@` list, then the funnel, and only
then the text in the box. With the box empty, `Escape` hands the keyboard to the
tree.

#### Keyboard

The tree is a single tab stop and the focused row carries it, so the keyboard
starts on the first row without a click.

| Key | Does |
|---|---|
| `↑` `↓` | move down / up |
| `→` | opens a closed node, then steps onto its first child |
| `←` | closes an open node, then steps out to its parent |
| `Home` `End` | first / last visible row |
| `PageUp` `PageDown` | jump a screenful |
| `Enter` | opens the focused row — a Base Enum's values, a query's metadata, a Fields section's grid, an element's X++ source |
| `Space` | folds the focused row |
| letters | jumps to the next row by label prefix; the buffer resets after ~0.9 s, and the same letter cycles through matching names |
| `Shift+F10` | opens the row's context menu |

To get the keyboard into the tree without a mouse: click anywhere in it, or press
`Escape` in an empty search box.

#### Background loading

Opening the view starts a background warm and reports it — `Reading versions…`,
then `Warming 42/318 types…`, then `Ready · 318 types · 2 versions`.

A type counts as warm the moment its eager head (500 rows, `prefetchCount`) is
cached, which is what makes its foldout open instantly. So reaching the total
means every foldout is already instant; the complete element lists stream in
behind that and simply fill rows in. The counts are the page's own, taken from the
version rows it is actually showing.

Only branches you have **open** are refreshed when something changes, so the
background work cannot make the tree feel heavy while you are clicking in it.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `d365fo.aot.ude.rootPath` | `%LocalAppData%\Microsoft\Dynamics365` | Versions root shown as **MS-UDE** |
| `d365fo.aot.rootPath` | `K:\AosService\PackagesLocalDirectory` | Packages root shown as **MS-Packages** |
| `d365fo.aot.custom.rootPath` | *(empty)* | Array of extra roots; each is one **Custom** entry |
| `d365fo.aot.modelSearchDepth` | `3` | Levels below a version scanned for models (1–5) |
| `d365fo.aot.defaultViewMode` | `models` | `models` or `classic` — what a version opens as |
| `d365fo.aot.eagerLoad` | `true` | Prefetch element lists in the background |
| `d365fo.aot.prefetchCount` | `500` | Rows prefetched per type; the rest stream in |
| `d365fo.aot.showDescriptorPath` | `false` | Show a model's descriptor path in the row |
| `d365fo.aot.autoResolve` | `false` | Resolve every field when one is picked |
| `d365fo.aot.resolve.language` | `en-US` | Language of resolved labels and help |
| `d365fo.aot.{ude,packages,custom}.cache.memory` | `true` | Keep discovered models in memory |
| `d365fo.aot.{ude,packages,custom}.cache.ttlMinutes` | `60` | Rebuild that root this long after startup; `0` = manual only |

Paths expand `%NAME%`, `$NAME`, `${NAME}` and a leading `~`.

## Development

```powershell
npm install
npm run compile       # tsc
npm run icons         # regenerate resources/icon-map.json from the icon sources
npm run package       # build the .vsix
node ./scripts/release.mjs --bump patch|minor|major
```

Release notes are in each commit message; `AGENTS.md` describes the layout and the
constraints worth keeping.
