import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import { childElements, tagOf, type DomElement } from './xpp/walker';

/**
 * Properties inspector (case #4): one generic webview for the long tail of
 * element types — menu items, tiles, services, references, KPIs, workflows,
 * config keys, licenses, macros, and everything else. Scalar leaf props
 * render as a grid; named collections render as native <details> groups
 * (no scripts needed). `SourceCode` and `ViewMetadata` are skipped on
 * purpose: code and backing queries already have dedicated surfaces (X++
 * preview, tree outlines). Self-contained like the other grids on purpose —
 * shared webview helpers come after the directions are proven.
 */

interface PropRow {
  name: string;
  value: string;
}

interface CollectionGroup {
  tag: string;
  members: string[];
}

/** Subtrees with dedicated surfaces elsewhere — never inlined here. */
const SKIP_SUBTREES = new Set(['SourceCode', 'ViewMetadata']);

/** Member display name tags (mirrors the tree's memberNameOf). */
const MEMBER_NAME_TAGS = ['Name', 'MenuItemName', 'Table', 'Field', 'Service'];

/** One inspector panel per element file (re-revealed on re-select). */
const panels = new Map<string, vscode.WebviewPanel>();

export async function openProperties(fsPath: string, label: string): Promise<void> {
  const key = fsPath.toLowerCase();
  const html = await renderInspector(fsPath, label);
  const existing = panels.get(key);
  if (existing) {
    existing.title = label;
    existing.webview.html = html;
    existing.reveal(vscode.ViewColumn.Beside, true);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'd365fo-properties',
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

async function renderInspector(fsPath: string, label: string): Promise<string> {
  let root: DomElement | undefined;
  try {
    const xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
    const document = new DOMParser().parseFromString(xml, 'text/xml') as unknown as {
      documentElement?: DomElement | null;
    };
    root = document.documentElement ?? undefined;
  } catch {
    root = undefined;
  }
  if (!root) {
    return page(label, '', `<p class="sub">Could not read ${escapeHtml(fsPath)}.</p>`);
  }
  const kind = tagOf(root);
  const props: PropRow[] = [];
  const groups: CollectionGroup[] = [];
  for (const child of childElements(root)) {
    const tag = tagOf(child);
    if (tag === 'Name' || SKIP_SUBTREES.has(tag)) {
      continue;
    }
    if (childElements(child).length === 0) {
      const value = (child.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (value) {
        props.push({ name: tag, value });
      }
      continue;
    }
    const members = namedMembers(child);
    if (members.length > 0) {
      groups.push({ tag, members });
    }
  }
  const propsBody =
    props.length === 0
      ? ''
      : `<table>
<thead><tr><th>Property</th><th>Value</th></tr></thead>
<tbody>
${props.map((p) => `<tr><td class="name">${escapeHtml(p.name)}</td><td class="value">${escapeHtml(p.value)}</td></tr>`).join('\n')}
</tbody>
</table>`;
  const groupsBody = groups
    .map(
      (g) => `<details>
<summary>${escapeHtml(g.tag)} <span class="count">${g.members.length}</span></summary>
<ul>
${g.members.map((m) => `<li>${escapeHtml(m)}</li>`).join('\n')}
</ul>
</details>`,
    )
    .join('\n');
  const body =
    propsBody === '' && groupsBody === ''
      ? `<p class="sub">No properties found in ${escapeHtml(label)}.</p>`
      : `${propsBody}${groupsBody}`;
  return page(label, kind, body);
}

/** Named direct children (skips leaf values), one level into unnamed containers. */
function namedMembers(node: DomElement): string[] {
  const out: string[] = [];
  const pushNamed = (el: DomElement): void => {
    for (const tag of MEMBER_NAME_TAGS) {
      const text = childElements(el)
        .find((c) => tagOf(c) === tag)
        ?.textContent?.trim();
      if (text) {
        out.push(text);
        return;
      }
    }
  };
  for (const child of childElements(node)) {
    if (childElements(child).length === 0) {
      continue;
    }
    const before = out.length;
    pushNamed(child);
    if (out.length === before) {
      // Unnamed wrapper (submenu containers, state lists, ...): one level in.
      for (const grand of childElements(child)) {
        if (childElements(grand).length === 0) {
          continue;
        }
        pushNamed(grand);
      }
    }
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, kind: string, body: string): string {
  const sub = kind ? `<div class="sub">${escapeHtml(kind)}</div>` : '';
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
table { border-collapse: collapse; width: 100%; max-width: 900px; margin-bottom: 16px; }
thead th { text-align: left; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 12px 6px 0; }
tbody td { border-bottom: 1px solid var(--vscode-panel-border); padding: 5px 12px 5px 0; vertical-align: top; }
tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
td.name { font-family: var(--vscode-editor-font-family); white-space: nowrap; }
td.value { word-break: break-word; }
details { margin-bottom: 8px; max-width: 900px; }
summary { cursor: pointer; padding: 4px 0; font-weight: 600; }
summary:hover { color: var(--vscode-list-highlightForeground); }
summary .count { color: var(--vscode-descriptionForeground); font-weight: 400; }
ul { margin: 4px 0 12px; padding-left: 20px; }
li { font-family: var(--vscode-editor-font-family); padding: 1px 0; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${sub}
${body}
</body>
</html>`;
}
