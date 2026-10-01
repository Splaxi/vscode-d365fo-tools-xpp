import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import { childElements, tagOf, type DomElement } from './xpp/walker';

/**
 * Label file grid (case #6): Id | Value | Comment in a webview beside the
 * tree, opened from a Label File element. Label texts live next to the
 * element XML in `LabelResources/<lang>/*.label.txt` as `Id=Value` lines
 * with ` ;comment` lines describing the entry above them. Read-only,
 * theme-aware, no scripts. Self-contained like the other grids on purpose —
 * shared webview helpers come after the grid directions are proven.
 */

interface LabelRow {
  id: string;
  value: string;
  comment?: string;
}

/** One grid panel per label file element (re-revealed on re-select). */
const panels = new Map<string, vscode.WebviewPanel>();

export async function openLabelGrid(fsPath: string, label: string): Promise<void> {
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
    'd365fo-labelGrid',
    label,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    // Scripts on: the in-grid search box filters rows locally (proof-of-concept
    // for interactive grids; the script is static and nonce-locked).
    { enableScripts: true },
  );
  panels.set(key, panel);
  panel.onDidDispose(() => {
    panels.delete(key);
  });
  panel.webview.html = html;
}

async function renderGrid(fsPath: string, label: string): Promise<string> {
  const resolved = await resolveLabelTxt(fsPath);
  if (!resolved) {
    return page(label, `<p class="sub">Could not find the label text file for ${escapeHtml(label)}.</p>`);
  }
  let rows: LabelRow[];
  try {
    const text = (await fs.readFile(resolved.txtPath, 'utf8')).replace(/^\uFEFF/, '');
    rows = readLabelTxt(text);
  } catch {
    return page(label, `<p class="sub">Could not read ${escapeHtml(resolved.txtPath)}.</p>`);
  }
  const sub = `${rows.length} label${rows.length === 1 ? '' : 's'} · ${escapeHtml(resolved.language ?? '')}`;
  const body =
    rows.length === 0
      ? `<p class="sub">No labels found.</p>`
      : `<div class="sub">${sub}</div>
<div class="toolbar"><input id="q" type="search" placeholder="Search id, value and comment…" autocomplete="off" spellcheck="false"><span id="count" class="count"></span></div>
<table>
<thead><tr><th>Id</th><th>Value</th><th>Comment</th></tr></thead>
<tbody>
${rows.map((r) => `<tr><td class="name">${escapeHtml(r.id)}</td><td>${escapeHtml(r.value)}</td><td class="comment">${escapeHtml(r.comment ?? '')}</td></tr>`).join('\n')}
</tbody>
</table>`;
  return page(label, body, rows.length === 0 ? undefined : nonce());
}

/**
 * Locate the `.label.txt` for a label-file element: `<AxLabelFile dir>/
 * LabelResources/<lang>/<LabelContentFileName>`. The language folder is
 * discovered (not guessed) so custom layouts keep working.
 */
async function resolveLabelTxt(fsPath: string): Promise<{ txtPath: string; language?: string } | undefined> {
  let xml: string;
  try {
    xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
  let root: DomElement | undefined;
  try {
    const document = new DOMParser().parseFromString(xml, 'text/xml') as unknown as {
      documentElement?: DomElement | null;
    };
    root = document.documentElement ?? undefined;
  } catch {
    return undefined;
  }
  const textOf = (tag: string): string | undefined => {
    const text = root && childElements(root).find((c) => tagOf(c) === tag)?.textContent?.trim();
    return text ? text : undefined;
  };
  const contentFile = textOf('LabelContentFileName');
  const language = textOf('Language');
  if (!contentFile) {
    return undefined;
  }
  const resources = path.join(path.dirname(fsPath), 'LabelResources');
  let langs: string[];
  try {
    langs = (await fs.readdir(resources, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return undefined;
  }
  // Preferred language folder first (usually matches), then any folder.
  const ordered = [
    ...(language ? langs.filter((l) => l.toLowerCase() === language.toLowerCase()) : []),
    ...langs.filter((l) => !language || l.toLowerCase() !== language.toLowerCase()),
  ];
  for (const lang of ordered) {
    const candidate = path.join(resources, lang, contentFile);
    try {
      await fs.stat(candidate);
      return { txtPath: candidate, language };
    } catch {
      // Not here — keep looking.
    }
  }
  return undefined;
}

/**
 * Parse label text: `Id=Value` entries (split on the first `=`) with
 * following ` ;comment` lines attached to the entry above them. Blank lines
 * and stray leading comments are skipped.
 */
function readLabelTxt(text: string): LabelRow[] {
  const out: LabelRow[] = [];
  const pendingComments: string[] = [];
  let current: LabelRow | undefined;
  const flushComments = (): string | undefined => {
    if (pendingComments.length === 0) {
      return undefined;
    }
    const joined = pendingComments.join('\n');
    pendingComments.length = 0;
    return joined;
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') {
      continue;
    }
    if (line.trimStart().startsWith(';')) {
      const comment = line.trimStart().slice(1).trim();
      if (current) {
        current.comment = current.comment ? `${current.comment}\n${comment}` : comment;
      } else {
        pendingComments.push(comment);
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const id = line.slice(0, eq).trim();
    if (!id) {
      continue;
    }
    current = { id, value: line.slice(eq + 1).trim(), comment: flushComments() };
    out.push(current);
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One random CSP nonce per render for the inline filter script. */
function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function page(title: string, body: string, scriptNonce?: string): string {
  const csp =
    scriptNonce === undefined
      ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">`
      : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">`;
  const script =
    scriptNonce === undefined
      ? ''
      : `<script nonce="${scriptNonce}">
(function () {
  var box = document.getElementById('q');
  var count = document.getElementById('count');
  var rows = Array.prototype.map.call(document.querySelectorAll('tbody tr'), function (tr) {
    return { el: tr, hay: tr.innerText.toLowerCase() };
  });
  var total = rows.length;
  function apply() {
    var q = box.value.trim().toLowerCase();
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var hit = q === '' || rows[i].hay.indexOf(q) !== -1;
      rows[i].el.style.display = hit ? '' : 'none';
      if (hit) shown++;
    }
    count.textContent = q === '' ? total + ' labels' : shown + ' of ' + total;
  }
  box.addEventListener('input', apply);
  apply();
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
.sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 8px 0; background: var(--vscode-editor-background); }
.toolbar input { flex: 1; max-width: 500px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 4px 8px; font-family: inherit; font-size: inherit; }
.toolbar input:focus { outline: 1px solid var(--vscode-focusBorder); }
.toolbar .count { color: var(--vscode-descriptionForeground); white-space: nowrap; }
table { border-collapse: collapse; width: 100%; max-width: 1100px; }
thead th { text-align: left; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 12px 6px 0; position: sticky; top: 46px; background: var(--vscode-editor-background); }
tbody td { border-bottom: 1px solid var(--vscode-panel-border); padding: 5px 12px 5px 0; vertical-align: top; }
tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
td.name { font-family: var(--vscode-editor-font-family); white-space: nowrap; }
td.comment { color: var(--vscode-descriptionForeground); white-space: pre-line; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
${script}
</body>
</html>`;
}
