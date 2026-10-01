import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import { childElements, tagOf, type DomElement } from './xpp/walker';

/**
 * View Metadata grid: the backing query's data sources at every nesting level
 * (L0 is the root) with a selection-driven panel below showing what the selected
 * data source declares.
 *
 * The panel is a stack of sections — Relations, Ranges, Grouping and ordering —
 * and a section is emitted only when the selected data source has something in
 * it, so a row with nothing but a join never shows an empty block. That is the
 * rule the Fields grid uses for EDT travel and enum options.
 *
 * The joins are the payload. Every relation target in a view resolves to another
 * data source of the same element, so each target renders as a link that
 * re-selects that row — the grid is a two-way map of the query's shape rather
 * than a flat list of table names.
 *
 * Rows are labelled by the data source `Name`, the alias every other reference in
 * the file (relations, group by, order by, view fields) actually uses, with the
 * `Table` shown beside it. The two differ in a fifth of all data sources, so
 * leading with the table makes those references unfindable.
 *
 * Everything is rendered up front from one DOM parse of a file that is already
 * on disk, so selection is pure client-side state: no `postMessage`, no round
 * trip, no spinner. The page still reads as a static table with the first joins
 * already visible when scripts are unavailable.
 */

/** A group by / order by / having member; it names the data source it acts on. */
interface MemberRow {
  name: string;
  dataSource?: string;
  field?: string;
  /** Having predicate: the aggregate and the value it is compared against. */
  type?: string;
  value?: string;
  /** Resolved data source id, when the named one is part of this element. */
  target?: string;
  /** Label for `target` — the data source name, as the file references it. */
  targetName?: string;
}

/** One join as the file declares it; `target` is resolved to a data source id. */
interface RelationRow {
  name: string;
  /** `this.Field = <target>.RelatedField` form. */
  field?: string;
  relatedField?: string;
  /** Alias the relation joins to; absent means "the parent data source". */
  joinDataSource?: string;
  /** Join declared through a relation on the joined table, not a field pair. */
  joinRelationName?: string;
  derivedTable?: string;
  /** Data source id the join points at, or undefined when it cannot be placed. */
  target?: string;
  /** Label for `target` — the data source name, as the file references it. */
  targetName?: string;
}

interface SourceRow {
  /** Stable, selector-safe id (`s0`, `s1`, ...) — selection and link targets. */
  id: string;
  level: number;
  parent?: string;
  name: string;
  table?: string;
  /** Only ever `OneToN`, only on embedded sources — so it rides as a tag. */
  fetchMode?: string;
  relations: RelationRow[];
  ranges: MemberRow[];
  groupBy: MemberRow[];
  orderBy: MemberRow[];
  having: MemberRow[];
}

interface MetadataModel {
  sources: SourceRow[];
  methods: string[];
}

/** Data source containers that hold nested sources, in document order. */
const NESTED_TAGS = ['DataSources', 'DerivedDataSources', 'ReferencedDataSources'];
/** Data source element kinds; anything else in a container is ignored. */
const SOURCE_TAGS = new Set([
  'AxQuerySimpleRootDataSource',
  'AxQuerySimpleEmbeddedDataSource',
  'AxQuerySimpleDerivedDataSource',
]);

/** One grid panel per element file (re-revealed on re-select, like the X++ tab). */
const panels = new Map<string, vscode.WebviewPanel>();

export async function openMetadataGrid(fsPath: string, label: string): Promise<void> {
  const key = fsPath.toLowerCase();
  const html = await renderGrid(fsPath, label);
  const existing = panels.get(key);
  if (existing) {
    existing.title = label;
    existing.webview.html = html;
    existing.reveal(vscode.ViewColumn.Beside, true);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'd365fo-metadataGrid',
    label,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true },
  );
  panels.set(key, panel);
  panel.onDidDispose(() => {
    panels.delete(key);
  });
  panel.webview.html = html;
}

async function renderGrid(fsPath: string, label: string): Promise<string> {
  let model: MetadataModel;
  try {
    const xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
    model = readElementMetadata(xml);
  } catch {
    return page(label, `<p class="sub">Could not read ${escapeHtml(fsPath)}.</p>`);
  }
  if (model.sources.length === 0 && model.methods.length === 0) {
    return page(label, `<p class="sub">No view metadata found in ${escapeHtml(label)}.</p>`);
  }
  return page(label, body(model));
}

/** Top table plus one relations panel per data source. */
function body(model: MetadataModel): string {
  if (model.sources.length === 0) {
    return methodsBlock(model);
  }
  // Open on the first data source that actually has joins, so the panel below
  // is never an empty placeholder on load. Also the no-JS fallback.
  const seed = model.sources.find((s) => s.relations.length > 0) ?? model.sources[0];
  const total = (pick: (s: SourceRow) => number): number => model.sources.reduce((a, s) => a + pick(s), 0);
  const relations = total((s) => s.relations.length);
  const ranges = total((s) => s.ranges.length);
  const rows = model.sources
    .map((s) => {
      const guides = '<span class="guide"></span>'.repeat(s.level);
      return `<tr data-id="${s.id}" tabindex="0" class="${s.id === seed.id ? 'sel' : ''}"><td><span class="lvl">L${s.level}</span></td><td class="name">${guides}${escapeHtml(s.name)}</td><td class="name dim">${escapeHtml(s.table ?? '')}</td><td>${
        s.fetchMode ? `<span class="tag">${escapeHtml(s.fetchMode)}</span>` : '<span class="zero">·</span>'
      }</td><td class="num">${s.relations.length > 0 ? `<span class="relc">${s.relations.length}</span>` : '<span class="zero">·</span>'}</td><td class="num">${
        s.ranges.length > 0 ? s.ranges.length : '<span class="zero">·</span>'
      }</td></tr>`;
    })
    .join('\n');
  const panelsHtml = model.sources.map((s) => sourcePanel(s, s.id === seed.id)).join('\n');
  const parts = [`${model.sources.length} data source${model.sources.length === 1 ? '' : 's'}`, plural(relations, 'relation'), plural(ranges, 'range')];
  if (model.methods.length > 0) {
    parts.push(plural(model.methods.length, 'method'));
  }
  return `<div class="sub">${parts.join(' · ')}</div>
<table id="ds">
<thead><tr><th>Lvl</th><th>Data source</th><th>Table</th><th>Fetch mode</th><th class="num">Relations</th><th class="num">Ranges</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<div id="details">
${panelsHtml}
</div>
${methodsBlock(model)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * What one data source declares, as a stack of sections.
 *
 * Each section is emitted only when the data source has something in it — the
 * same rule the Fields grid applies to EDT travel and enum options, where the
 * panel shows one line for a row with no travel instead of an empty block.
 * Sections that are empty are not rendered at all.
 */
function sourcePanel(s: SourceRow, open: boolean): string {
  const head = `<div class="panelHead"><span class="name">${escapeHtml(s.name)}</span><span class="dim">L${s.level}${
    s.table && s.table !== s.name ? ` · table ${escapeHtml(s.table)}` : ''
  }</span></div>`;
  const sections: string[] = [];
  if (s.relations.length > 0) {
    sections.push(section('Relations', 'relations', s.relations.length, s.relations.map(relationLine).join('\n')));
  }
  if (s.ranges.length > 0) {
    sections.push(section('Ranges', 'ranges', s.ranges.length, s.ranges.map(rangeLine).join('\n')));
  }
  const shaped: string[] = [];
  if (s.groupBy.length > 0) {
    shaped.push(...s.groupBy.map((m) => memberLine('Group by', 'group', m)));
  }
  if (s.orderBy.length > 0) {
    shaped.push(...s.orderBy.map((m) => memberLine('Order by', 'order', m)));
  }
  if (s.having.length > 0) {
    shaped.push(...s.having.map((m) => memberLine('Having', 'having', m)));
  }
  if (shaped.length > 0) {
    sections.push(section('Grouping and ordering', 'grouping', shaped.length, shaped.join('\n')));
  }
  const content =
    sections.length > 0
      ? sections.join('\n')
      : '<div class="sub">No relations, ranges or grouping on this data source.</div>';
  return `<div class="detailPanel" data-for="${s.id}"${open ? '' : ' hidden'}>${head}${content}</div>`;
}

/** Section heading with a count, mirroring the Fields grid's `h2` + count. */
function section(title: string, kind: string, count: number, content: string): string {
  return `<h2 data-section="${kind}">${escapeHtml(title)} <span class="count">${count}</span></h2>\n${content}`;
}

function linkTo(row: { target?: string; targetName?: string }, fallback: string | undefined): string {
  return row.target
    ? `<a href="#" data-goto="${row.target}">${escapeHtml(row.targetName ?? row.target)}</a>`
    : `<span class="dim">${escapeHtml(fallback ?? '—')}</span>`;
}

function relationLine(r: RelationRow): string {
  const target = linkTo(r, r.joinDataSource ?? 'parent');
  let join: string;
  if (r.field && r.relatedField) {
    join = `<span class="name">${escapeHtml(r.field)}</span> = ${target}<span class="name">.${escapeHtml(r.relatedField)}</span>`;
  } else if (r.joinRelationName) {
    join = `${target} <span class="chip">table relation ${escapeHtml(r.joinRelationName)}</span>`;
  } else {
    join = `<span class="dim">derived table ${escapeHtml(r.derivedTable ?? '—')}</span>`;
  }
  return row('relation', 'relation', r.name, join);
}

/** `<field> = <value>`; the range applies to the data source that declares it. */
function rangeLine(m: MemberRow): string {
  const left = `<span class="name">${escapeHtml(m.field ?? m.name)}</span>`;
  const right = `<span class="name">${escapeHtml(m.value ?? '')}</span>`;
  return row('range', 'range', m.name, `${left} = ${right}`);
}

function memberLine(label: string, kind: string, m: MemberRow): string {
  const bits = [linkTo(m, m.dataSource)];
  if (m.field) {
    bits.push(`<span class="name">.${escapeHtml(m.field)}</span>`);
  }
  if (m.type) {
    bits.push(`<span class="kind">${escapeHtml(m.type)}</span>`);
  }
  if (m.value) {
    bits.push(`<span class="name">${escapeHtml(m.value)}</span>`);
  }
  return row(kind, kind, label, bits.join(' '));
}

function row(cssClass: string, kind: string, first: string, content: string): string {
  return `<div class="row ${cssClass}" data-kind="${kind}"><span class="name rowName">${escapeHtml(first)}</span><span>${content}</span></div>`;
}

function methodsBlock(model: MetadataModel): string {
  if (model.methods.length === 0) {
    return '';
  }
  return `<h2>Methods</h2>
<table id="methods">
<thead><tr><th>Method</th></tr></thead>
<tbody>
${model.methods.map((m) => `<tr><td class="name">${escapeHtml(m)}</td></tr>`).join('\n')}
</tbody>
</table>`;
}

/**
 * Data sources with their level, joins and range count, plus the element's
 * methods. Levels follow the nesting depth of the query's data sources, so L0
 * is the root and L1+ are embedded below it — the flat grid lost that.
 *
 * Works for a view and a query alike: a view keeps its backing query under
 * `<ViewMetadata>`, a query carries `<DataSources>` at the document root, and
 * the shapes below either one are identical — same `AxQuerySimpleRootDataSource`
 * elements, same `Ranges`/`Relations` members.
 */
function readElementMetadata(xml: string): MetadataModel {
  const model: MetadataModel = { sources: [], methods: [] };
  let root: DomElement | undefined;
  try {
    const document = new DOMParser().parseFromString(xml, 'text/xml') as unknown as {
      documentElement?: DomElement | null;
    };
    root = document.documentElement ?? undefined;
  } catch {
    return model;
  }
  if (!root) {
    return model;
  }
  const textOf = (node: DomElement, tag: string): string | undefined => {
    const text = childElements(node).find((c) => tagOf(c) === tag)?.textContent?.trim();
    return text ? text : undefined;
  };
  const container = (node: DomElement, tag: string): DomElement[] => {
    const el = childElements(node).find((c) => tagOf(c) === tag);
    return el ? childElements(el) : [];
  };
  const vm =
    childElements(root).find((c) => tagOf(c) === 'ViewMetadata') ??
    // A query is its own container: DataSources/SourceCode sit at the root.
    root;
  const dsRoot = childElements(vm).find((c) => tagOf(c) === 'DataSources');
  if (dsRoot) {
    const visit = (ds: DomElement, level: number, parent: string | undefined): void => {
      if (!SOURCE_TAGS.has(tagOf(ds))) {
        return;
      }
      const table = textOf(ds, 'Table');
      const id = `s${model.sources.length}`;
      // Members are the named elements of a section — the same rule the tree
      // outline uses, so a row here and a node there always agree.
      const members = (tag: string): MemberRow[] =>
        container(ds, tag).flatMap((el) => {
          const name = textOf(el, 'Name');
          return name
            ? [
                {
                  name,
                  dataSource: textOf(el, 'DataSource'),
                  field: textOf(el, 'Field'),
                  type: textOf(el, 'Type'),
                  value: textOf(el, 'Value'),
                },
              ]
            : [];
        });
      const source: SourceRow = {
        id,
        level,
        parent,
        name: textOf(ds, 'Name') ?? table ?? 'Data Source',
        table,
        fetchMode: textOf(ds, 'FetchMode'),
        relations: [],
        ranges: members('Ranges'),
        groupBy: members('GroupBy'),
        orderBy: members('OrderBy'),
        having: members('Having'),
      };
      for (const rel of container(ds, 'Relations')) {
        const name = textOf(rel, 'Name');
        if (!name) {
          continue;
        }
        source.relations.push({
          name,
          field: textOf(rel, 'Field'),
          relatedField: textOf(rel, 'RelatedField'),
          joinDataSource: textOf(rel, 'JoinDataSource'),
          joinRelationName: textOf(rel, 'JoinRelationName'),
          derivedTable: textOf(rel, 'JoinDerivedTable') ?? textOf(rel, 'DerivedTable'),
        });
      }
      model.sources.push(source);
      for (const nest of NESTED_TAGS) {
        for (const sub of container(ds, nest)) {
          visit(sub, level + 1, id);
        }
      }
    };
    for (const ds of childElements(dsRoot)) {
      visit(ds, 0, undefined);
    }
  }
  const sourceCode = childElements(vm).find((c) => tagOf(c) === 'SourceCode');
  if (sourceCode) {
    const walk = (node: DomElement): void => {
      for (const child of childElements(node)) {
        if (tagOf(child) === 'Method') {
          const name = textOf(child, 'Name');
          if (name) {
            model.methods.push(name);
          }
          continue;
        }
        walk(child);
      }
    };
    walk(sourceCode);
  }
  placeRelationTargets(model);
  return model;
}

/**
 * Point every join and grouping member at a data source row. A relation names
 * the data source it joins to; when it names none it joins its own parent.
 * Matching is case-insensitive because the corpus is not consistent about it.
 */
function placeRelationTargets(model: MetadataModel): void {
  const byId = new Map(model.sources.map((s) => [s.id, s] as const));
  const byKey = new Map<string, string>();
  for (const s of model.sources) {
    for (const key of [s.name, s.table]) {
      if (key) {
        byKey.set(key.toLowerCase(), s.id);
      }
    }
  }
  const point = (row: { target?: string; targetName?: string }, named: string | undefined, parent?: string): void => {
    const target = byId.get(named ?? parent ?? '');
    if (target) {
      row.target = target.id;
      row.targetName = target.name;
    }
  };
  for (const s of model.sources) {
    for (const r of s.relations) {
      point(r, r.joinDataSource, s.parent);
    }
    for (const m of [...s.groupBy, ...s.orderBy, ...s.having]) {
      point(m, m.dataSource, s.id);
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One random CSP nonce per render for the inline interaction script. */
function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function page(title: string, bodyHtml: string): string {
  const id = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${id}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px 20px 40px; }
h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 2px; }
h2 { font-size: 1em; font-weight: 600; margin: 26px 0 8px; }
.sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
table { border-collapse: collapse; width: 100%; max-width: 1100px; }
thead th { text-align: left; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 12px 6px 0; position: sticky; top: 0; background: var(--vscode-editor-background); }
thead th.num { text-align: right; }
tbody td { border-bottom: 1px solid var(--vscode-panel-border); padding: 5px 12px 5px 0; vertical-align: top; }
tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
tbody tr.sel td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
tbody tr.sel td.dim { color: inherit; opacity: 0.75; }
#ds tbody tr { cursor: pointer; }
#ds tbody tr:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
td.name { font-family: var(--vscode-editor-font-family); }
td.num { text-align: right; font-family: var(--vscode-editor-font-family); }
td.dim, .dim { color: var(--vscode-descriptionForeground); }
tbody tr.sel a { color: inherit; }
.lvl { display: inline-block; min-width: 1.6em; text-align: center; border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 4px; font-family: var(--vscode-editor-font-family); font-size: 0.85em; }
/* Drawn, not a box-drawing glyph: the editor font is not guaranteed to carry
   U+2502, and a missing glyph would render as a tofu box. */
.guide { display: inline-block; width: 0; height: 1.15em; margin: 0 4px; vertical-align: -0.2em; border-left: 1px solid var(--vscode-editorIndentGuide-background, var(--vscode-descriptionForeground)); opacity: 0.6; }
.tag { border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 5px; font-size: 0.85em; }
.relc, a { color: var(--vscode-textLink-foreground); }
.zero { color: var(--vscode-descriptionForeground); opacity: 0.5; }
[hidden] { display: none !important; }
#details { max-width: 1100px; margin-top: 10px; }
.detailPanel h2 { margin: 16px 0 2px; }
.detailPanel h2:first-of-type { margin-top: 8px; }
h2 .count { font-weight: 400; color: var(--vscode-descriptionForeground); }
.panelHead { display: flex; align-items: baseline; gap: 10px; padding: 10px 0 6px; }
.panelHead .name { font-family: var(--vscode-editor-font-family); }
.row { display: flex; align-items: baseline; gap: 16px; padding: 4px 0; border-top: 1px solid var(--vscode-panel-border); }
.row .rowName { min-width: 220px; }
.row .name { font-family: var(--vscode-editor-font-family); }
.row .kind { border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 5px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
.chip { border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 5px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
<script nonce="${id}">
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#ds tbody tr'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.detailPanel'));
  function show(id) {
    var i;
    for (i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('sel', rows[i].getAttribute('data-id') === id);
    }
    for (i = 0; i < panels.length; i++) {
      panels[i].hidden = panels[i].getAttribute('data-for') !== id;
    }
  }
  function select(tr) {
    show(tr.getAttribute('data-id'));
  }
  rows.forEach(function (tr) {
    tr.addEventListener('click', function () { select(tr); });
    tr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(tr); }
    });
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[data-goto]') : null;
    if (!a) { return; }
    e.preventDefault();
    var id = a.getAttribute('data-goto');
    show(id);
    var tr = document.querySelector('#ds tbody tr[data-id="' + id + '"]');
    if (tr) {
      tr.focus();
      tr.scrollIntoView({ block: 'nearest' });
    }
  });
})();
</script>
</body>
</html>`;
}
