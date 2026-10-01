import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import { childElements, tagOf, type DomElement } from './xpp/walker';

/**
 * Table Relations grid (case #3): Name | RelatedTable | Mapping |
 * Cardinality | OnDelete in a webview beside the tree, opened from a
 * table's Relations section. Mapping joins the relation constraints as
 * `Field → RelatedField` pairs. Read-only, theme-aware, no scripts.
 * Self-contained like the other grids on purpose — shared webview helpers
 * come after the grid directions are proven.
 */

interface RelationRow {
  name: string;
  relatedTable?: string;
  mapping?: string;
  cardinality?: string;
  onDelete?: string;
}

/** One grid panel per table file (re-revealed on re-select, like the X++ tab). */
const panels = new Map<string, vscode.WebviewPanel>();

export async function openTableRelationsGrid(fsPath: string, label: string): Promise<void> {
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
    'd365fo-tableRelations',
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
  let rows: RelationRow[];
  try {
    const xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
    rows = readTableRelations(xml);
  } catch {
    return page(label, `<p class="sub">Could not read ${escapeHtml(fsPath)}.</p>`);
  }
  const body =
    rows.length === 0
      ? `<p class="sub">No relations found in ${escapeHtml(label)}.</p>`
      : `<div class="sub">${rows.length} relation${rows.length === 1 ? '' : 's'}</div>
<table>
<thead><tr><th>Name</th><th>RelatedTable</th><th>Mapping</th><th>Cardinality</th><th>OnDelete</th></tr></thead>
<tbody>
${rows.map((r) => `<tr><td class="name">${escapeHtml(r.name)}</td><td class="type">${escapeHtml(r.relatedTable ?? '')}</td><td>${escapeHtml(r.mapping ?? '')}</td><td>${escapeHtml(r.cardinality ?? '')}</td><td>${escapeHtml(r.onDelete ?? '')}</td></tr>`).join('\n')}
</tbody>
</table>`;
  return page(label, body);
}

/** Every relation under the root `<Relations>` collection, in document order. */
function readTableRelations(xml: string): RelationRow[] {
  const out: RelationRow[] = [];
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
  const relations = childElements(root).find((c) => tagOf(c) === 'Relations');
  if (!relations) {
    return out;
  }
  for (const relation of childElements(relations)) {
    const name = textOf(relation, 'Name');
    if (!name) {
      continue;
    }
    const constraints = childElements(relation).find((c) => tagOf(c) === 'Constraints');
    const pairs: string[] = [];
    if (constraints) {
      for (const constraint of childElements(constraints)) {
        const field = textOf(constraint, 'Field');
        const related = textOf(constraint, 'RelatedField');
        if (field && related) {
          pairs.push(`${field} → ${related}`);
        } else if (field) {
          pairs.push(field);
        }
      }
    }
    out.push({
      name,
      relatedTable: textOf(relation, 'RelatedTable'),
      mapping: pairs.length > 0 ? pairs.join(', ') : undefined,
      cardinality: textOf(relation, 'Cardinality'),
      onDelete: textOf(relation, 'OnDelete'),
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
td.name, td.type { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}
