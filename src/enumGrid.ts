import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import { childElements, tagOf, type DomElement } from './xpp/walker';

/**
 * UI proof-of-concept: Base Enum values as a 3-column grid (Name | Label |
 * Value) in a webview beside the tree. Read-only, theme-aware, no scripts.
 * Parsing + rendering live here inline on purpose — helper extraction comes
 * after the UI direction is proven.
 */

export interface EnumValueRow {
  name: string;
  label?: string;
  value?: string;
}

/** One grid panel per enum file (re-revealed on re-select, like the X++ tab). */
const panels = new Map<string, vscode.WebviewPanel>();

export async function openEnumGrid(fsPath: string, label: string): Promise<void> {
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
    'd365fo-enumGrid',
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
  let rows: EnumValueRow[];
  try {
    const xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
    rows = readEnumValues(xml);
  } catch {
    return page(label, `<p class="sub">Could not read ${escapeHtml(fsPath)}.</p>`);
  }
  const body =
    rows.length === 0
      ? `<p class="sub">No values found in ${escapeHtml(label)}.</p>`
      : `<div class="sub">${rows.length} value${rows.length === 1 ? '' : 's'}</div>
<table>
<thead><tr><th>Name</th><th>Label</th><th class="num">Value</th></tr></thead>
<tbody>
${rows.map((r) => `<tr><td class="name">${escapeHtml(r.name)}</td><td>${escapeHtml(r.label ?? '')}</td><td class="num">${escapeHtml(r.value ?? '')}</td></tr>`).join('\n')}
</tbody>
</table>`;
  return page(label, body);
}

/** Every `<AxEnumValue>` below the root, in document order. Exported for the field-travel enum lookup. */
export function readEnumValues(xml: string): EnumValueRow[] {
  const out: EnumValueRow[] = [];
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
  const walk = (node: DomElement): void => {
    if (tagOf(node) === 'AxEnumValue') {
      const name = textOf(node, 'Name');
      if (name) {
        out.push({ name, label: textOf(node, 'Label'), value: textOf(node, 'Value') });
      }
      return;
    }
    for (const child of childElements(node)) {
      walk(child);
    }
  };
  walk(root);
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
table { border-collapse: collapse; width: 100%; max-width: 900px; }
thead th { text-align: left; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 12px 6px 0; position: sticky; top: 0; background: var(--vscode-editor-background); }
thead th.num { text-align: right; }
tbody td { border-bottom: 1px solid var(--vscode-panel-border); padding: 5px 12px 5px 0; vertical-align: top; }
tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
td.name, td.num { font-family: var(--vscode-editor-font-family); }
td.num { text-align: right; white-space: nowrap; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}
