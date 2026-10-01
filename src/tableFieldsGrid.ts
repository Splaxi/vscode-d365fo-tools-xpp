import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import {
  DEFAULT_RESOLVE_LANGUAGE,
  SearchAbortedError,
  type AotTreeProvider,
  type FieldPrimitive,
  type FieldResolution,
  type FieldTravel,
} from './aotTree';
import type { DiscoveredVersion } from './discovery';
import { childElements, tagOf, type DomElement } from './xpp/walker';

/**
 * Table Fields grid (v2): Name | Label | Type | Size | Flags on top, with a
 * Resolve button and a selection-driven lower panel showing the EDT lineage
 * (chain hops with type/size/model) plus the terminal enum's options.
 * Size renders instantly from the field XML and backfills from the
 * traversal memo; the lineage resolves on row click (bounded walk, memoized
 * in the provider). Theme-aware; scripts are static and nonce-locked.
 */

interface FieldRow {
  name: string;
  label?: string;
  type?: string;
  flags?: string;
  /** Instant primitive from the field's own `i:type`, if present. */
  prim?: FieldPrimitive;
  /** Instant size from the field's own `StringSize`, if present. */
  size?: string;
}

/** Storage-class discriminator (`i:type`) → primitive. Mirrors the tree. */
const TYPE_TAG_PRIMITIVES: Record<string, FieldPrimitive> = {
  axtablefieldstring: 'String',
  axtablefieldint: 'Int',
  axtablefieldint64: 'Int64',
  axtablefieldreal: 'Real',
  axtablefielddate: 'Date',
  axtablefieldutcdatetime: 'UtcDateTime',
  axtablefieldtime: 'Time',
  axtablefieldenum: 'Enum',
};

/** Sparse per-field modifiers worth a grid cell when present. */
const FLAG_TAGS = ['Mandatory', 'Visible', 'AllowEdit', 'IsObsolete'];

/** One grid panel per table file (re-revealed on re-select, like the X++ tab). */
const panels = new Map<string, vscode.WebviewPanel>();
/** Toolbar state per panel, so a silent re-render keeps the Resolve button as-is. */
const panelChrome = new Map<string, { language: string; autoResolve: boolean }>();

export async function openTableFieldsGrid(
  fsPath: string,
  label: string,
  resolved?: ReadonlyMap<string, FieldResolution>,
  version?: DiscoveredVersion,
  provider?: AotTreeProvider,
  labels?: Readonly<Record<string, string>>,
): Promise<void> {
  const key = fsPath.toLowerCase();
  const chrome = {
    language: provider?.resolveLanguage() ?? DEFAULT_RESOLVE_LANGUAGE,
    autoResolve: provider?.autoResolve() ?? false,
  };
  const existing = panels.get(key);
  if (existing) {
    existing.title = label;
    panelChrome.set(key, chrome);
    existing.webview.html = await renderGrid(fsPath, label, resolved, labels, chrome.language, chrome.autoResolve);
    existing.reveal(vscode.ViewColumn.Beside, true);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'd365fo-tableFields',
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
  panel.webview.html = await renderGrid(fsPath, label, resolved, labels, chrome.language, chrome.autoResolve);
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
          const travel = await provider.fieldTravel(version, fsPath, field);
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
            title: `Resolving field types for ${label}`,
            cancellable: true,
          },
          async (progress, token) => {
            let reported = 0;
            try {
              await provider.collectFieldPrimitives(
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
              const memo = provider.fieldPrimitivesFor(version, fsPath);
              const sizes: Record<string, string> = {};
              const prims: Record<string, string> = {};
              if (memo) {
                for (const [name, r] of memo) {
                  if (r.size) {
                    sizes[name] = r.size;
                  }
                  if (r.prim) {
                    prims[name] = r.prim;
                  }
                }
              }
              // Labels come from the same pass: the id in the Label column is
              // replaced by its text in the configured language.
              const labels = await provider.collectTableLabels(version, fsPath, () =>
                token.isCancellationRequested,
              );
              provider.refreshView(undefined);
              await panel.webview.postMessage({ type: 'sizes', sizes });
              await panel.webview.postMessage({ type: 'prims', prims });
              await panel.webview.postMessage({ type: 'labels', labels: Object.fromEntries(labels) });
              await refreshFieldsGrid(
                fsPath,
                label,
                memo,
                Object.fromEntries(labels),
              );
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
 * Silently re-render an open Fields grid (e.g. after the tree's traversal
 * lands). No-op when the panel isn't open; never steals focus or reveals.
 */
export async function refreshFieldsGrid(
  fsPath: string,
  label: string,
  resolved?: ReadonlyMap<string, FieldResolution>,
  labels?: Readonly<Record<string, string>>,
): Promise<void> {
  const key = fsPath.toLowerCase();
  const existing = panels.get(key);
  if (!existing) {
    return;
  }
  const chrome = panelChrome.get(key) ?? {
    language: DEFAULT_RESOLVE_LANGUAGE,
    autoResolve: false,
  };
  existing.title = label;
  existing.webview.html = await renderGrid(fsPath, label, resolved, labels, chrome.language, chrome.autoResolve);
}

async function renderGrid(
  fsPath: string,
  label: string,
  resolved?: ReadonlyMap<string, FieldResolution>,
  labels?: Readonly<Record<string, string>>,
  language = DEFAULT_RESOLVE_LANGUAGE,
  autoResolve = false,
): Promise<string> {
  let rows: FieldRow[];
  try {
    const xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
    rows = readTableFields(xml);
  } catch {
    return page(label, `<p class="sub">Could not read ${escapeHtml(fsPath)}.</p>`);
  }
  if (rows.length === 0) {
    return page(label, `<p class="sub">No fields found in ${escapeHtml(label)}.</p>`);
  }
  const body = `<div class="sub">${rows.length} field${rows.length === 1 ? '' : 's'}</div>
<div class="toolbar"><button id="resolve" type="button"${autoResolve ? ' disabled title="Auto Resolve is on — picking a field resolves the whole grid."' : ''}>Resolve…</button><span id="rstatus" class="count"></span><span class="dim">Fills type, size and label text (${escapeHtml(language)}).</span></div>
<table id="fields">
<thead><tr><th>Name</th><th>Label</th><th>Type</th><th>Primitive</th><th class="num">Size</th><th>Flags</th></tr></thead>
<tbody>
${rows.map((r) => {
  // Instant row evidence first, traversal memo fills the gaps.
  const cached = resolved?.get(r.name.toLowerCase());
  const size = r.size ?? cached?.size ?? '';
  const prim = cached?.prim ?? r.prim;
  const labelText = r.label ? labels?.[r.label.toLowerCase()] ?? r.label : '';
  return `<tr data-field="${escapeHtml(r.name.toLowerCase())}" data-label="${escapeHtml(r.name)}"><td class="name">${escapeHtml(r.name)}</td><td class="lbl" data-id="${escapeHtml(r.label ?? '')}">${escapeHtml(labelText)}</td><td class="type">${escapeHtml(r.type ?? '')}</td><td class="prim">${escapeHtml(prim ?? '')}</td><td class="num size">${escapeHtml(size)}</td><td class="flags">${escapeHtml(r.flags ?? '')}</td></tr>`;
}).join('\n')}
</tbody>
</table>
<div id="hint" class="sub">Select a row to see its type lineage.</div>
<div id="lineageSec" hidden><h2>EDT Lineage <span id="lineageFor" class="count"></span></h2>
<div id="lineage"></div></div>
<div id="enumSec" hidden><h2>Enum options <span id="enumFor" class="count"></span></h2>
<div id="enumbox"></div></div>`;
  return page(label, body, nonce(), autoResolve);
}

/** Every field under the root `<Fields>` collection, in document order. */
function readTableFields(xml: string): FieldRow[] {
  const out: FieldRow[] = [];
  let root: DomElement | undefined;
  try {
    const document = new DOMParser().parseFromString(xml, 'text/xml') as unknown as {
      documentElement?: DomElement | null;
    };
    root = document.documentElement ?? undefined;
  } catch {
    return out;
  }
  if (!root) {
    return out;
  }
  const textOf = (node: DomElement, tag: string): string | undefined => {
    const text = childElements(node).find((c) => tagOf(c) === tag)?.textContent?.trim();
    return text ? text : undefined;
  };
  const fields = childElements(root).find((c) => tagOf(c) === 'Fields');
  if (!fields) {
    return out;
  }
  const attrOf = (node: DomElement, attr: string): string | undefined => {
    const get = (node as unknown as { getAttribute?: (n: string) => string | null }).getAttribute;
    if (typeof get !== 'function') {
      return undefined;
    }
    try {
      return get.call(node, attr)?.toLowerCase();
    } catch {
      return undefined;
    }
  };
  for (const field of childElements(fields)) {
    const name = textOf(field, 'Name');
    if (!name) {
      continue;
    }
    const flags = FLAG_TAGS.map((t) => {
      const v = textOf(field, t);
      return v ? `${t}: ${v}` : undefined;
    }).filter((s): s is string => s !== undefined);
    const iType = attrOf(field, 'i:type');
    out.push({
      name,
      label: textOf(field, 'Label'),
      type: textOf(field, 'ExtendedDataType') ?? textOf(field, 'EnumType') ?? textOf(field, 'Type'),
      flags: flags.length > 0 ? flags.join(', ') : undefined,
      prim: (iType && TYPE_TAG_PRIMITIVES[iType]) || undefined,
      size: textOf(field, 'StringSize'),
    });
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One random CSP nonce per render for the inline interaction script. */
function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function page(title: string, body: string, scriptNonce?: string, autoResolve = false): string {
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
  var lineageSec = document.getElementById('lineageSec');
  var enumSec = document.getElementById('enumSec');
  var lineage = document.getElementById('lineage');
  var enumbox = document.getElementById('enumbox');
  var lineageFor = document.getElementById('lineageFor');
  var enumFor = document.getElementById('enumFor');
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  var autoResolve = ${autoResolve ? 'true' : 'false'};
  var autoDone = false;
  function startResolve() {
    btn.disabled = true;
    status.textContent = 'Resolving…';
    vscode.postMessage({ type: 'resolve' });
  }
  rows.forEach(function (tr) {
    tr.addEventListener('click', function () {
      rows.forEach(function (r) { r.classList.remove('selected'); });
      tr.classList.add('selected');
      var label = tr.getAttribute('data-label');
      hint.hidden = true;
      lineageSec.hidden = false;
      lineageFor.textContent = '— ' + label;
      lineage.innerHTML = '<p class="sub">Loading lineage…</p>';
      enumSec.hidden = true;
      enumFor.textContent = '';
      enumbox.innerHTML = '';
      vscode.postMessage({ type: 'fieldSelected', field: label });
      if (autoResolve && !autoDone) {
        autoDone = true;
        startResolve();
      }
    });
  });
  btn.addEventListener('click', startResolve);
  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.type === 'travel') {
      renderLineage(m.travel);
    } else if (m.type === 'sizes') {
      var sizes = m.sizes || {};
      rows.forEach(function (tr) {
        var cell = tr.querySelector('td.size');
        if (cell && !cell.textContent && sizes[tr.getAttribute('data-field')]) {
          cell.textContent = sizes[tr.getAttribute('data-field')];
        }
      });
    } else if (m.type === 'prims') {
      var prims = m.prims || {};
      rows.forEach(function (tr) {
        var got = prims[tr.getAttribute('data-field')];
        var cell = tr.querySelector('td.prim');
        if (got && cell && !cell.textContent) { cell.textContent = got; }
      });
    } else if (m.type === 'labels') {
      var labels = m.labels || {};
      rows.forEach(function (tr) {
        var cell = tr.querySelector('td.lbl');
        if (!cell) { return; }
        var id = (cell.getAttribute('data-id') || '').toLowerCase();
        if (id && labels[id] !== undefined) { cell.textContent = labels[id]; }
      });
    } else if (m.type === 'resolveDone') {
      btn.disabled = false;
      status.textContent = '';
    }
  });
  // A section is shown only when it has something to show. A field whose type
  // lineage is empty but which resolves to an enum gets the enum panel alone,
  // and a field with neither gets a single line — never a bare heading.
  function renderLineage(t) {
    var hasTravel = !!(t && t.hops && t.hops.length);
    var hasEnum = !!(t && t.enumName);
    lineageSec.hidden = !hasTravel;
    enumSec.hidden = !hasEnum;
    hint.hidden = hasTravel || hasEnum;
    if (hasTravel) {
      lineageFor.textContent = '— ' + (t.field || '');
      var h = '<table><thead><tr><th>#</th><th>EDT</th><th>Type</th><th class="num">Size</th><th>Model</th></tr></thead><tbody>';
      t.hops.forEach(function (hop, i) {
        var cls = hop.terminal ? ' class="terminal"' : '';
        var type = hop.kernel ? 'kernel — no file' : esc((hop.iType || '').replace(/^AxEdt/, '') || '—');
        h += '<tr' + cls + '><td class="num">' + (i + 1) + '</td><td class="name">' + esc(hop.edt) + '</td><td>' + type + '</td><td class="num">' + esc(hop.size || '—') + '</td><td class="dim">' + esc(hop.model || '') + '</td></tr>';
      });
      lineage.innerHTML = h + '</tbody></table>';
    } else {
      lineageFor.textContent = '';
      lineage.innerHTML = '';
    }
    if (hasEnum) {
      enumFor.textContent = '— ' + t.enumName;
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
        if (t.enumTruncated) {
          e += '<p class="sub">+ ' + (t.enumTotal - t.enumValues.length) + ' more</p>';
        }
        enumbox.innerHTML = e;
      } else {
        enumbox.innerHTML = '<p class="sub">Kernel enum — this version ships no metadata file for it, so its values are not available here.</p>';
      }
    } else {
      enumFor.textContent = '';
      enumbox.innerHTML = '';
    }
  }
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
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px 20px; }
h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 2px; }
h2 { font-size: 1em; font-weight: 600; margin: 20px 0 8px; }
h2 .count { font-weight: 400; }
[hidden] { display: none !important; }
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
td.name, td.type { font-family: var(--vscode-editor-font-family); }
td.num { text-align: right; font-family: var(--vscode-editor-font-family); }
td.flags, td.dim { color: var(--vscode-descriptionForeground); }
tbody tr.selected td.dim { color: inherit; opacity: 0.8; }
td.flags { white-space: nowrap; }
tbody tr.terminal td { color: var(--vscode-charts-green, var(--vscode-foreground)); }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
${script}
</body>
</html>`;
}
