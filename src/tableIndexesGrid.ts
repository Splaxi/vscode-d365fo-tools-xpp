import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import { childElements, tagOf, type DomElement } from './xpp/walker';

/**
 * Table Indexes grid: Name | Fields | Flags in a webview beside the tree,
 * opened from a table's Indexes section, an index branch, or one of its
 * fields. Fields joins the index's `DataField` entries; Flags collects only
 * the sparse non-default modifiers that are present (AlternateKey /
 * AllowDuplicates / AllowPageLocks / Enabled / IsSystemGenerated /
 * ConfigurationKey). Read-only, theme-aware, no scripts. Self-contained
 * like the other grids on purpose — shared webview helpers come after the
 * grid directions are proven.
 */

interface IndexRow {
  name: string;
  fields?: string;
  flags?: string;
}

/** Sparse per-index modifiers worth a grid cell when present. */
const FLAG_TAGS = [
  'AlternateKey',
  'AllowDuplicates',
  'AllowPageLocks',
  'Enabled',
  'IsSystemGenerated',
  'ConfigurationKey',
];

/** One grid panel per table file (re-revealed on re-select, like the X++ tab). */
const panels = new Map<string, vscode.WebviewPanel>();

export async function openTableIndexesGrid(fsPath: string, label: string): Promise<void> {
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
    'd365fo-tableIndexes',
    label,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: false },
  );
  panels.set(key, panel);
  panel.onDidDispose(() => {
    panels.delete(key);
  });
  panel.webview.html = html;
}

async function renderGrid(fsPath: string, label: string): Promise<string> {
  let rows: IndexRow[];
  try {
    const xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
    rows = readTableIndexes(xml);
  } catch {
    return page(label, `<p class="sub">Could not read ${escapeHtml(fsPath)}.</p>`);
  }
  const body =
    rows.length === 0
      ? `<p class="sub">No indexes found in ${escapeHtml(label)}.</p>`
      : `<div class="sub">${rows.length} index${rows.length === 1 ? '' : 'es'}</div>
<table>
<thead><tr><th>Name</th><th>Fields</th><th>Flags</th></tr></thead>
<tbody>
${rows.map((r) => `<tr><td class="name">${escapeHtml(r.name)}</td><td>${escapeHtml(r.fields ?? '')}</td><td class="flags">${escapeHtml(r.flags ?? '')}</td></tr>`).join('\n')}
</tbody>
</table>`;
  return page(label, body);
}

/** Every index under the root `<Indexes>` collection, in document order. */
function readTableIndexes(xml: string): IndexRow[] {
  const out: IndexRow[] = [];
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
  const indexes = childElements(root).find((c) => tagOf(c) === 'Indexes');
  if (!indexes) {
    return out;
  }
  for (const index of childElements(indexes)) {
    const name = textOf(index, 'Name');
    if (!name) {
      continue;
    }
    const fieldsEl = childElements(index).find((c) => tagOf(c) === 'Fields');
    const fields: string[] = [];
    if (fieldsEl) {
      for (const field of childElements(fieldsEl)) {
        const fieldName = textOf(field, 'DataField') ?? textOf(field, 'Name');
        if (fieldName) {
          fields.push(fieldName);
        }
      }
    }
    const flags = FLAG_TAGS.map((t) => {
      const v = textOf(index, t);
      return v ? `${t}: ${v}` : undefined;
    }).filter((s): s is string => s !== undefined);
    out.push({
      name,
      fields: fields.length > 0 ? fields.join(', ') : undefined,
      flags: flags.length > 0 ? flags.join(', ') : undefined,
    });
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px 20px; }
h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 2px; }
.sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
table { border-collapse: collapse; width: 100%; max-width: 1100px; }
thead th { text-align: left; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 12px 6px 0; position: sticky; top: 0; background: var(--vscode-editor-background); }
tbody td { border-bottom: 1px solid var(--vscode-panel-border); padding: 5px 12px 5px 0; vertical-align: top; }
tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
td.name { font-family: var(--vscode-editor-font-family); }
td.flags { color: var(--vscode-descriptionForeground); white-space: nowrap; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}
