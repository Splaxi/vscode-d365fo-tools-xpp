import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import {
  DEFAULT_RESOLVE_LANGUAGE,
  SearchAbortedError,
  type AotTreeProvider,
  type ViewFieldTravel,
} from './aotTree';
import type { DiscoveredVersion } from './discovery';
import { childElements, tagOf, type DomElement } from './xpp/walker';

/**
 * View / data entity Fields grid: `Name | Data source | Data field | Type |
 * Size | Flags`, with a Resolve button and a selection-driven lower panel.
 *
 * A view field is not a storage field. Either it declares its own type (computed
 * or unmapped — `ExtendedDataType` / `EnumType` right in the field, which needs
 * no I/O and is filled immediately), or it binds to a column of a data source
 * and the type lives in another element: view field → data source → backing
 * table → column → EDT. `Resolve…` follows that chain for every row at once,
 * bounded pool, progress and cancel — a view touches a median of 2 tables, so
 * it is usually instant, and shared tables are already cached per version.
 *
 * The Data source and Data field columns are the reason this grid is worth
 * having: 9.8% of view fields name a data source their own `ViewMetadata` never
 * declares, and nothing else in the browser shows that binding. Those cells say
 * `N/A` rather than staying blank, so an unresolved binding never reads like a
 * cell nobody looked at.
 *
 * The lower panel is a stack of sections — Binding, EDT Lineage, Enum options —
 * and a section is emitted only when the selected field has something in it, the
 * same rule the Fields and Metadata grids use.
 */

/** One row of the grid, read from the view file alone. */
interface ViewFieldRow {
  name: string;
  /** The field's own label id, when it declares one. */
  label?: string;
  dataSource?: string;
  dataField?: string;
  /** Computed / unmapped fields carry their own type here. */
  inlineType?: string;
  /** Primitive straight from the field's `i:type` — no I/O. */
  inlinePrim?: string;
  inlineSize?: string;
  flags: string[];
  /** Backing table, when this field's data source is declared in the file. */
  table?: string;
  /** A data source the view's own metadata does not declare, or no binding. */
  gap?: 'no-metadata' | 'no-binding';
}

interface ViewFieldModel {
  rows: ViewFieldRow[];
}

/** Sparse per-field modifiers worth a grid cell when present. */
const FLAG_TAGS = ['Mandatory', 'Visible', 'AllowEdit', 'IsObsolete'];
/** Data source containers that hold nested sources. */
const NESTED_TAGS = ['DataSources', 'DerivedDataSources', 'ReferencedDataSources'];

/** Storage-class discriminator (`i:type`) → primitive, mirroring the tree. */
const TYPE_TAG_PRIMITIVES: Record<string, string> = {
  axtablefieldstring: 'String',
  axtablefieldint: 'Int',
  axtablefieldint64: 'Int64',
  axtablefieldreal: 'Real',
  axtablefielddate: 'Date',
  axtablefieldutcdatetime: 'UtcDateTime',
  axtablefieldtime: 'Time',
  axtablefieldenum: 'Enum',
  // View / data entity fields spell the same families differently.
  axviewfieldcomputedstring: 'String',
  axviewfieldunmappedfieldstring: 'String',
  axviewfieldcomputedint: 'Int',
  axviewfieldcomputedint64: 'Int64',
  axviewfieldcomputedreal: 'Real',
  axviewfieldcomputeddate: 'Date',
  axviewfieldcomputedutcdatetime: 'UtcDateTime',
  axviewfieldcomputedenum: 'Enum',
  axviewfieldunmappedfieldenum: 'Enum',
  axdataentityviewunmappedfieldstring: 'String',
  axdataentityviewunmappedfieldint: 'Int',
  axdataentityviewunmappedfieldint64: 'Int64',
  axdataentityviewunmappedfieldreal: 'Real',
  axdataentityviewunmappedfielddate: 'Date',
  axdataentityviewunmappedfieldutcdatetime: 'UtcDateTime',
  axdataentityviewunmappedfieldenum: 'Enum',
  // `AxDataEntityViewMappedField` is deliberately absent: a mapped field binds
  // to a column, so its type is the column's and must be resolved, never
  // guessed from the discriminator.
};

function inlinePrimOf(field: DomElement): string | undefined {
  const get = (field as unknown as { getAttribute?: (n: string) => string | null }).getAttribute;
  if (typeof get !== 'function') {
    return undefined;
  }
  try {
    const iType = get.call(field, 'i:type')?.toLowerCase();
    return iType ? TYPE_TAG_PRIMITIVES[iType] : undefined;
  } catch {
    return undefined;
  }
}

/** One grid panel per element file (re-revealed on re-select, like the X++ tab). */
const panels = new Map<string, vscode.WebviewPanel>();
/** Toolbar state per panel, so a silent re-render keeps the Resolve button as-is. */
const panelChrome = new Map<string, { language: string; autoResolve: boolean }>();

export async function openViewFieldsGrid(
  fsPath: string,
  label: string,
  version?: DiscoveredVersion,
  provider?: AotTreeProvider,
): Promise<void> {
  const key = fsPath.toLowerCase();
  const chrome = {
    language: provider?.resolveLanguage() ?? DEFAULT_RESOLVE_LANGUAGE,
    autoResolve: provider?.autoResolve() ?? false,
  };
  const html = await renderGrid(fsPath, label, version, provider);
  const existing = panels.get(key);
  if (existing) {
    existing.title = label;
    panelChrome.set(key, chrome);
    existing.webview.html = html;
    existing.reveal(vscode.ViewColumn.Beside, true);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'd365fo-viewFields',
    label,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true },
  );
  panels.set(key, panel);
  panelChrome.set(key, chrome);
  panel.onDidDispose(() => {
    panels.delete(key);
    panelChrome.delete(key);
  });
  panel.webview.html = html;
  panel.webview.onDidReceiveMessage(
    async (msg: unknown) => {
      if (!provider || !version) {
        return;
      }
      if (typeof msg !== 'object' || msg === null) {
        return;
      }
      const type = (msg as { type?: unknown }).type;
      if (type === 'fieldSelected') {
        const field = (msg as { field?: unknown }).field;
        if (typeof field !== 'string' || !field) {
          return;
        }
        try {
          const travel = await provider.viewFieldTravel(version, fsPath, field);
          await panel.webview.postMessage({ type: 'travel', field, travel: travel ?? null });
        } catch {
          await panel.webview.postMessage({ type: 'travel', field, travel: null });
        }
        return;
      }
      if (type === 'resolve') {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Resolving view field types for ${label}`,
            cancellable: true,
          },
          async (progress, token) => {
            let reported = 0;
            try {
              await provider.resolveViewFieldTypes(
                version,
                fsPath,
                (done, total) => {
                  progress.report({ message: `${done}/${total} fields`, increment: done - reported });
                  reported = done;
                },
                () => token.isCancellationRequested,
              );
            } catch (e) {
              if (!(e instanceof SearchAbortedError)) {
                throw e;
              }
            } finally {
              const memo = provider.viewFieldsFor(version, fsPath);
              const types: Record<string, { type?: string; prim?: string; size?: string; na?: boolean; labelId?: string }> = {};
              if (memo) {
                for (const [name, chain] of memo) {
                  types[name] = {
                    type: typeText(chain),
                    prim: chain.prim,
                    size: chain.size,
                    na: chain.gap !== undefined,
                    labelId: chain.typeLabelId,
                  };
                }
              }
              // Same pass as the types: the label column gets its text here.
              const labels = await provider.collectViewLabels(version, fsPath, () =>
                token.isCancellationRequested,
              );
              await panel.webview.postMessage({
                type: 'resolved',
                types,
                labels: Object.fromEntries(labels),
              });
              await panel.webview.postMessage({ type: 'resolveDone' });
            }
          },
        );
      }
    },
    undefined,
    [],
  );
}

/**
 * Silently re-render an open view Fields grid — used after a resolve started
 * from the tree context menu rather than the grid's own button. No-op when the
 * panel isn't open; never steals focus or reveals.
 */
export async function refreshViewFieldsGrid(
  fsPath: string,
  label: string,
  version?: DiscoveredVersion,
  provider?: AotTreeProvider,
): Promise<void> {
  const key = fsPath.toLowerCase();
  const existing = panels.get(key);
  if (!existing) {
    return;
  }
  // Reuse the panel's own toolbar state; a provider-less refresh must not silently
  // re-enable the button or drop the language back to the default.
  let saved = panelChrome.get(key);
  if (!saved && provider) {
    saved = {
      language: provider.resolveLanguage() ?? DEFAULT_RESOLVE_LANGUAGE,
      autoResolve: provider.autoResolve() ?? false,
    };
    panelChrome.set(key, saved);
  }
  existing.title = label;
  existing.webview.html = await renderGrid(fsPath, label, version, provider, saved?.language, saved?.autoResolve);
}

/** The type a resolved chain reports, preferring the named type over a primitive. */
function typeText(chain: ViewFieldTravel): string | undefined {
  return chain.typeLabel ?? chain.startEdt ?? chain.startEnum ?? chain.prim;
}

async function renderGrid(
  fsPath: string,
  label: string,
  version?: DiscoveredVersion,
  provider?: AotTreeProvider,
  language?: string,
  autoResolve?: boolean,
): Promise<string> {
  let model: ViewFieldModel;
  try {
    const xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
    model = readViewFields(xml);
  } catch {
    return page(label, `<p class="sub">Could not read ${escapeHtml(fsPath)}.</p>`);
  }
  if (model.rows.length === 0) {
    return page(label, `<p class="sub">No fields found in ${escapeHtml(label)}.</p>`);
  }
  const resolved = version && provider ? provider.viewFieldsFor(version, fsPath) : undefined;
  // Labels are cached per label file, so re-translating on a reopen is cheap and
  // keeps the grid complete without pressing Resolve again.
  const labels =
    version && provider && resolved
      ? Object.fromEntries(await provider.collectViewLabels(version, fsPath))
      : undefined;
  const useLanguage = provider?.resolveLanguage() ?? language ?? DEFAULT_RESOLVE_LANGUAGE;
  const useAuto = provider?.autoResolve() ?? autoResolve ?? false;
  return page(
    label,
    body(model, resolved, labels, useLanguage, useAuto),
    version && provider ? 'live' : undefined,
    useAuto,
  );
}

function body(
  model: ViewFieldModel,
  resolved?: Map<string, ViewFieldTravel>,
  labels?: Readonly<Record<string, string>>,
  language = DEFAULT_RESOLVE_LANGUAGE,
  autoResolve = false,
): string {
  const bound = model.rows.filter((r) => r.dataSource).length;
  const undeclared = model.rows.filter((r) => r.gap === 'no-metadata').length;
  const summary = [
    `${model.rows.length} field${model.rows.length === 1 ? '' : 's'}`,
    `${bound} bound to a data source`,
  ];
  if (undeclared > 0) {
    summary.push(`${undeclared} naming an undeclared data source`);
  }
  if (resolved) {
    summary.push('types resolved');
  }
  const rows = model.rows
    .map((r) => {
      const chain = resolved?.get(r.name.toLowerCase());
      const type = chain
        ? chain.gap
          ? '<span class="zero">N/A</span>'
          : escapeHtml(typeText(chain) ?? '')
        : escapeHtml(r.inlineType ?? '');
      const size = chain?.size ?? r.inlineSize ?? '';
      const prim = chain?.prim ?? r.inlinePrim;
      // A bound field rarely declares its own label; it inherits the name of
      // the column it binds to, so the type's label stands in once resolved.
      const own = r.label ?? '';
      const labelId = own || chain?.typeLabelId || '';
      const labelText = labelId ? labels?.[labelId.toLowerCase()] ?? labelId : '';
      return `<tr data-field="${escapeHtml(r.name.toLowerCase())}" data-label="${escapeHtml(r.name)}" data-label-id="${escapeHtml(labelId)}" tabindex="0"><td class="name">${escapeHtml(r.name)}</td><td class="lbl">${escapeHtml(labelText)}</td><td class="name">${escapeHtml(r.dataSource ?? '')}</td><td class="name dim">${escapeHtml(r.dataField ?? '')}</td><td class="type">${type}</td><td class="prim">${escapeHtml(prim ?? '')}</td><td class="num size">${escapeHtml(size)}</td><td class="flags">${escapeHtml(r.flags.join(', '))}</td></tr>`;
    })
    .join('\n');
  return `<div class="sub">${escapeHtml(summary.join(' · '))}</div>
<div class="toolbar"><button id="resolve" type="button"${autoResolve ? ' disabled title="Auto Resolve is on — picking a field resolves the whole grid."' : ''}>Resolve…</button><span id="rstatus" class="count"></span><span class="dim">Fills type, size and label text (${escapeHtml(language)}).</span></div>
<table id="fields">
<thead><tr><th>Name</th><th>Label</th><th>Data source</th><th>Data field</th><th>Type</th><th>Primitive</th><th class="num">Size</th><th>Flags</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<div id="hint" class="sub">Select a row to see its data source and type lineage.</div>
<div id="bindSec" hidden><h2>Binding <span id="bindFor" class="count"></span></h2>
<div id="binding"></div></div>
<div id="lineageSec" hidden><h2>EDT Lineage <span id="lineageFor" class="count"></span></h2>
<div id="lineage"></div></div>
<div id="enumSec" hidden><h2>Enum options <span id="enumFor" class="count"></span></h2>
<div id="enumbox"></div></div>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One random CSP nonce per render for the inline interaction script. */
function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function page(title: string, bodyHtml: string, scriptNonce?: string, autoResolve = false): string {
  const csp =
    scriptNonce === undefined
      ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">`
      : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">`;
  const script =
    scriptNonce === undefined
      ? ''
      : `<script nonce="${scriptNonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var btn = document.getElementById('resolve');
  var status = document.getElementById('rstatus');
  var rows = Array.prototype.slice.call(document.querySelectorAll('#fields tbody tr'));
  var hint = document.getElementById('hint');
  var bindSec = document.getElementById('bindSec');
  var lineageSec = document.getElementById('lineageSec');
  var enumSec = document.getElementById('enumSec');
  var binding = document.getElementById('binding');
  var lineage = document.getElementById('lineage');
  var enumbox = document.getElementById('enumbox');
  var bindFor = document.getElementById('bindFor');
  var lineageFor = document.getElementById('lineageFor');
  var enumFor = document.getElementById('enumFor');
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function row(label, value) {
    return '<div class="brow"><span class="name browName">' + esc(label) + '</span><span>' + value + '</span></div>';
  }
  // Each section is shown only when the selected field has something in it.
  function showSections(t, label) {
    var hasBind = !!(t && (t.dataSource || t.dataField || t.gap));
    var hasLineage = !!(t && t.hops && t.hops.length);
    var hasEnum = !!(t && t.enumName);
    bindSec.hidden = !hasBind;
    lineageSec.hidden = !hasLineage;
    enumSec.hidden = !hasEnum;
    hint.hidden = hasBind || hasLineage || hasEnum;
    bindFor.textContent = hasBind ? '— ' + label : '';
    lineageFor.textContent = hasLineage ? '— ' + label : '';
    enumFor.textContent = hasEnum ? '— ' + t.enumName : '';
    binding.innerHTML = hasBind ? renderBinding(t) : '';
    lineage.innerHTML = hasLineage ? renderLineage(t) : '';
    enumbox.innerHTML = hasEnum ? renderEnum(t) : '';
  }
  function renderBinding(t) {
    var out = '';
    if (t.dataSource) { out += row('Data source', esc(t.dataSource)); }
    if (t.dataField) { out += row('Data field', esc(t.dataField)); }
    if (t.gap === 'no-metadata') {
      out += row('Backing table', '<span class="na">N/A</span>');
      out += row('', '<span class="dim">a view in this chain does not declare that data source</span>');
    } else if (t.gap === 'no-column') {
      out += row('Backing table', esc(t.table || ''));
      out += row('Table field', '<span class="na">N/A</span>');
      out += row('', '<span class="dim">no field of that name in the backing element</span>');
    } else if (t.gap === 'no-type') {
      out += row('Backing table', esc(t.table || ''));
      out += row('Type', '<span class="na">N/A</span>');
      out += row('', '<span class="dim">the backing field is a view field and declares no type of its own</span>');
    } else if (t.gap === 'no-binding') {
      out += row('', '<span class="dim">computed or unmapped — the field declares its own type</span>');
    } else {
      if (t.table) { out += row('Backing table', esc(t.table)); }
      if (t.dataField) { out += row('Table field', esc(t.dataField)); }
    }
    if (t.via) { out += row('Via', esc(t.via)); }
    if (t.selfTyped) {
      out += row('', '<span class="dim">declared inline on the view field</span>');
    }
    return out;
  }
  function renderLineage(t) {
    var h = '<table><thead><tr><th>#</th><th>EDT</th><th>Type</th><th class="num">Size</th><th>Model</th></tr></thead><tbody>';
    t.hops.forEach(function (hop, i) {
      var cls = hop.terminal ? ' class="terminal"' : '';
      var type = hop.kernel ? 'kernel — no file' : esc((hop.iType || '').replace(/^AxEdt/, '') || '—');
      h += '<tr' + cls + '><td class="num">' + (i + 1) + '</td><td class="name">' + esc(hop.edt) + '</td><td>' + type + '</td><td class="num">' + esc(hop.size || '—') + '</td><td class="dim">' + esc(hop.model || '') + '</td></tr>';
    });
    return h + '</tbody></table>';
  }
  function renderEnum(t) {
      if (t.enumValues && t.enumValues.length) {
        var e = '<div class="sub">' + t.enumTotal + ' value' + (t.enumTotal === 1 ? '' : 's') + (t.enumTruncated ? ' (top 10)' : '') + '</div>';
        // Built-in values carry a label id (@sys####). Until that resolves there is
        // nothing to print, so the column is left out rather than shown full of ids.
        var labelOf = function (s) {
          return s && String(s).charAt(0) !== '@' ? String(s) : '';
        };
        var anyLabel = t.enumValues.some(function (v) { return labelOf(v.label); });
        e += '<table><thead><tr><th>Name</th>' + (anyLabel ? '<th>Label</th>' : '') + '<th class="num">Value</th></tr></thead><tbody>';
        t.enumValues.forEach(function (v) {
          e += '<tr><td class="name">' + esc(v.name) + '</td>' + (anyLabel ? '<td class="dim">' + esc(labelOf(v.label)) + '</td>' : '') + '<td class="num">' + esc(v.value || '') + '</td></tr>';
        });
      e += '</tbody></table>';
      if (t.enumTruncated) { e += '<p class="sub">+ ' + (t.enumTotal - t.enumValues.length) + ' more</p>'; }
      return e;
    }
    return '<p class="sub">Kernel enum — this version ships no metadata file for it, so its values are not available here.</p>';
  }
  // The lineage already knows the type of the selected row, so paint it back
  // into the overview: Type and Primitive fill on a row click, before Resolve.
  function paintRow(t, field) {
    if (!t) { return; }
    var key = String(field || '').toLowerCase();
    var tr = rows.filter(function (r) { return r.getAttribute('data-field') === key; })[0];
    if (!tr) { return; }
    var cells = tr.querySelectorAll('td');
    var typeCell = cells[4];
    if (typeCell) {
      typeCell.innerHTML = t.gap ? '<span class="zero">N/A</span>' : esc(typeLabelOf(t));
    }
    var primCell = tr.querySelector('td.prim');
    if (primCell && !primCell.textContent) { primCell.textContent = t.prim || ''; }
    var sizeCell = tr.querySelector('td.size');
    if (sizeCell && t.size) { sizeCell.textContent = t.size; }
  }
  function typeLabelOf(t) {
    return t.typeLabel || t.startEdt || t.startEnum || t.prim || '';
  }
  var autoResolve = ${autoResolve ? 'true' : 'false'};
  var autoDone = false;
  function startResolve() {
    btn.disabled = true;
    status.textContent = 'Resolving…';
    vscode.postMessage({ type: 'resolve' });
  }
  function select(tr) {
    rows.forEach(function (r) { r.classList.remove('selected'); });
    tr.classList.add('selected');
    var label = tr.getAttribute('data-label');
    hint.hidden = false;
    bindSec.hidden = true; lineageSec.hidden = true; enumSec.hidden = true;
    binding.innerHTML = ''; lineage.innerHTML = ''; enumbox.innerHTML = '';
    bindFor.textContent = ''; lineageFor.textContent = ''; enumFor.textContent = '';
    vscode.postMessage({ type: 'fieldSelected', field: label });
    if (autoResolve && !autoDone) {
      autoDone = true;
      startResolve();
    }
  }
  rows.forEach(function (tr) {
    tr.addEventListener('click', function () { select(tr); });
    tr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(tr); }
    });
  });
  btn.addEventListener('click', startResolve);
  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.type === 'travel') {
      showSections(m.travel, m.field);
      paintRow(m.travel, m.field);
    } else if (m.type === 'resolved') {
      var types = m.types || {};
      var labels = m.labels || {};
      rows.forEach(function (tr) {
        var got = types[tr.getAttribute('data-field')];
        if (got) {
          var typeCell = tr.querySelectorAll('td')[4];
          if (typeCell) { typeCell.innerHTML = got.na ? '<span class="zero">N/A</span>' : esc(got.type || ''); }
          var primCell = tr.querySelector('td.prim');
          if (got.prim) { if (primCell) { primCell.textContent = got.prim; } } else if (primCell && !primCell.textContent) { primCell.textContent = ''; }
          if (got.size) {
            var sizeCell = tr.querySelector('td.size');
            if (sizeCell) { sizeCell.textContent = got.size; }
          }
          if (got.labelId && !tr.getAttribute('data-label-id')) {
            tr.setAttribute('data-label-id', got.labelId);
          }
        }
        // A bound field inherits the name of the type it resolved to.
        var labelCell = tr.querySelector('td.lbl');
        var labelId = (tr.getAttribute('data-label-id') || '').toLowerCase();
        if (labelCell && labelId && labels[labelId] !== undefined) {
          labelCell.textContent = labels[labelId];
        }
      });
    } else if (m.type === 'resolveDone') {
      btn.disabled = false;
      status.textContent = '';
    }
  });
})();
</script>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px 20px 40px; }
h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 2px; }
h2 { font-size: 1em; font-weight: 600; margin: 20px 0 8px; }
h2 .count { font-weight: 400; color: var(--vscode-descriptionForeground); }
.sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 8px 0; background: var(--vscode-editor-background); }
.toolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 14px; font-family: inherit; font-size: inherit; cursor: pointer; }
.toolbar button:disabled { opacity: 0.6; cursor: default; }
.toolbar button:focus { outline: 1px solid var(--vscode-focusBorder); }
.toolbar .count { color: var(--vscode-descriptionForeground); white-space: nowrap; }
table { border-collapse: collapse; width: 100%; max-width: 1100px; }
thead th { text-align: left; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 12px 6px 0; position: sticky; top: 46px; background: var(--vscode-editor-background); }
thead th.num { text-align: right; }
tbody td { border-bottom: 1px solid var(--vscode-panel-border); padding: 5px 12px 5px 0; vertical-align: top; }
tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
tbody tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
tbody tr.selected td.dim { color: inherit; opacity: 0.75; }
tbody tr { cursor: pointer; }
tbody tr:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
td.name, td.type { font-family: var(--vscode-editor-font-family); }
td.num { text-align: right; font-family: var(--vscode-editor-font-family); }
td.flags, td.dim { color: var(--vscode-descriptionForeground); }
td.flags { white-space: nowrap; }
tbody tr.terminal td { color: var(--vscode-charts-green, var(--vscode-foreground)); }
.zero { color: var(--vscode-descriptionForeground); opacity: 0.5; }
.na { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
[hidden] { display: none !important; }
#binding, #lineage, #enumbox { max-width: 1100px; }
.brow { display: flex; align-items: baseline; gap: 16px; padding: 4px 0; border-top: 1px solid var(--vscode-panel-border); }
.brow .browName { min-width: 140px; }
.brow .name { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
${script}
</body>
</html>`;
}

/**
 * The view's fields plus, for each bound field, the table its data source
 * points at. One parse covers both, so the grid can fill the inline types and
 * flag an undeclared data source without asking the provider for anything.
 */
function readViewFields(xml: string): ViewFieldModel {
  const model: ViewFieldModel = { rows: [] };
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
  // Data source alias → backing table, from the view's own ViewMetadata.
  const tables = new Map<string, string>();
  const vm = childElements(root).find((c) => tagOf(c) === 'ViewMetadata');
  const dsRoot = vm && childElements(vm).find((c) => tagOf(c) === 'DataSources');
  const walkSources = (ds: DomElement): void => {
    const alias = textOf(ds, 'Name');
    const table = textOf(ds, 'Table');
    if (alias && table) {
      tables.set(alias.toLowerCase(), table);
    }
    for (const nest of NESTED_TAGS) {
      const container = childElements(ds).find((c) => tagOf(c) === nest);
      if (container) {
        for (const sub of childElements(container)) {
          walkSources(sub);
        }
      }
    }
  };
  if (dsRoot) {
    for (const ds of childElements(dsRoot)) {
      walkSources(ds);
    }
  }
  const fieldsEl = childElements(root).find((c) => tagOf(c) === 'Fields');
  for (const field of childElements(fieldsEl ?? root)) {
    const name = textOf(field, 'Name');
    if (!name || childElements(field).length === 0) {
      continue;
    }
    const dataSource = textOf(field, 'DataSource');
    const dataField = textOf(field, 'DataField');
    const table = dataSource ? tables.get(dataSource.toLowerCase()) : undefined;
    const inlineType = textOf(field, 'ExtendedDataType') ?? textOf(field, 'EnumType');
    // Unmapped/computed fields carry their own `i:type`; the primitive is the
    // first letter of it, so the overview can show it before any resolve.
    const inlinePrim = inlinePrimOf(field);
    let gap: ViewFieldRow['gap'];
    if (dataSource && dataField && !table) {
      gap = 'no-metadata';
    } else if (!dataSource && !dataField) {
      gap = 'no-binding';
    }
    model.rows.push({
      name,
      label: textOf(field, 'Label'),
      dataSource,
      dataField,
      inlineType,
      inlinePrim,
      inlineSize: textOf(field, 'StringSize'),
      flags: FLAG_TAGS.map((t) => {
        const v = textOf(field, t);
        return v ? `${t}: ${v}` : undefined;
      }).filter((s): s is string => s !== undefined),
      table,
      gap,
    });
  }
  return model;
}
