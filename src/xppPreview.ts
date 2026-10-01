import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { looksLikeMetadata, NotMetadataError, transpile } from './xpp/index';

/**
 * Read-only X++ source view for metadata elements — our equivalent of Visual
 * Studio's transient `XppSource` documents: the XML on disk is reconstructed
 * to human-readable X++ on the fly, nothing is written back.
 *
 * Virtual documents live under the `d365fo-xpp` scheme as `<Label>.xpp` (the
 * real XML path travels in the query string), so tabs read naturally and the
 * `xpp` language + grammar applies for highlighting.
 */

export const XPP_SCHEME = 'd365fo-xpp';
export const XPP_LANGUAGE_ID = 'xpp';

export function xppUriFor(fsPath: string, label: string): vscode.Uri {
  const safe = label.trim().length > 0 ? label.trim() : 'element';
  return vscode.Uri.parse(`${XPP_SCHEME}:/${encodeURIComponent(safe)}.xpp?src=${encodeURIComponent(fsPath)}`);
}

export function sourcePathOf(uri: vscode.Uri): string | undefined {
  try {
    const src = new URLSearchParams(uri.query).get('src');
    return src ? decodeURIComponent(src) : undefined;
  } catch {
    return undefined;
  }
}

export class XppPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  refresh(uri?: vscode.Uri): void {
    this.onDidChangeEmitter.fire(uri!);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const fsPath = sourcePathOf(uri);
    if (!fsPath) {
      return '// d365fo-xpp: missing source reference.';
    }
    let xml: string;
    try {
      xml = await fs.readFile(fsPath, 'utf8');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return `// Could not read ${fsPath}: ${detail}`;
    }
    if (!looksLikeMetadata(xml)) {
      // Signature-only copies under <Module>/XppMetadata/... carry no source.
      // Prefer the source twin from a sibling model folder when one exists.
      const twin = await findSourceTwin(fsPath);
      if (twin) {
        try {
          xml = await fs.readFile(twin, 'utf8');
        } catch {
          // Fall through to the message below.
        }
      }
    }
    try {
      const result = transpile(xml);
      if (result.empty || result.xpp.trim().length === 0) {
        const name = result.name || decodeURIComponent(uri.path.split('/').pop() ?? '').replace(/\.xpp$/i, '');
        return `// ${result.kind} ${name} carries no embedded X++ source.`;
      }
      return result.xpp;
    } catch (e) {
      const detail = e instanceof NotMetadataError ? e.message : e instanceof Error ? e.message : String(e);
      return `// Could not reconstruct X++ source: ${detail}\n// Use "Open Raw Element XML" from the Explorer context menu to see the file.`;
    }
  }
}

/**
 * Source twin for signature-only copies: `<Module>/XppMetadata/<Pkg>/Ax<T>/F.xml`
 * → `<Module>/<Model>/Ax<T>/F.xml`. Scans the module's sibling folders
 * (cheap: one readdir + a few head reads) and returns the first file that
 * actually carries X++ source.
 */
async function findSourceTwin(fsPath: string): Promise<string | undefined> {
  const lower = fsPath.toLowerCase();
  const marker = `${path.sep}xppmetadata${path.sep}`;
  const at = lower.lastIndexOf(marker);
  if (at === -1) {
    return undefined;
  }
  const moduleDir = fsPath.slice(0, at);
  const rest = fsPath.slice(at + marker.length); // <Pkg>/Ax<T>/F.xml
  const parts = rest.split(path.sep);
  if (parts.length < 3) {
    return undefined;
  }
  const axDir = parts[parts.length - 2];
  const file = parts[parts.length - 1];
  let entries;
  try {
    entries = await fs.readdir(moduleDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const skip = new Set(['xppmetadata', 'bin', 'descriptor', 'resources', 'reports', 'webcontent']);
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) {
      continue;
    }
    if (skip.has(e.name.toLowerCase())) {
      continue;
    }
    const candidate = path.join(moduleDir, e.name, axDir, file);
    try {
      const head = await fs.readFile(candidate, 'utf8').then((t) => t.slice(0, 8192));
      if (looksLikeMetadata(head)) {
        return candidate;
      }
    } catch {
      // Not here — keep looking.
    }
  }
  return undefined;
}

/** Open (or reveal) the X++ preview for a metadata XML file. */
export async function openXppPreview(fsPath: string, label: string, methodName?: string): Promise<void> {
  const uri = xppUriFor(fsPath, label);
  const doc = await vscode.workspace.openTextDocument(uri);
  // Like the File Explorer preview: selecting rows swaps the preview tab
  // but focus stays in the tree, so arrowing through elements never
  // yanks the cursor into the editor.
  const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
  if (methodName) {
    revealMethod(editor, methodName);
  }
  try {
    if (doc.languageId !== XPP_LANGUAGE_ID) {
      await vscode.languages.setTextDocumentLanguage(doc, XPP_LANGUAGE_ID);
    }
  } catch {
    // Language stays plaintext; content is still readable.
  }
}

/** Regex-unsafe characters in a method name (identifiers, but be safe). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Header span of a method in preview text: the declaration line plus the
 * contiguous block directly above it (doc `///`/`//` comments and `[...]`
 * attributes) — a blank line ends the block, so only comments glued to the
 * declaration count as part of the method.
 */
function methodHeaderRange(lines: string[], method: string): { start: number; decl: number; nameCol: number } | undefined {
  const declRe = new RegExp(`(^|[\\s,;(])(${escapeRegExp(method)})\\s*\\(`);
  let first: { start: number; decl: number; nameCol: number } | undefined;
  let firstDocumented: { start: number; decl: number; nameCol: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    const match = declRe.exec(line);
    if (!match) {
      continue;
    }
    const nameCol = match.index + match[1].length;
    let start = i;
    let documented = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j].trim();
      if (prev === '') {
        break; // A line break detaches everything above from the method.
      }
      if (prev.startsWith('//') || (/^\[.*\]$/.test(prev))) {
        start = j;
        documented = documented || prev.startsWith('///');
        continue;
      }
      break;
    }
    const found = { start, decl: i, nameCol };
    first ??= found;
    if (documented) {
      firstDocumented ??= found;
      break; // Documented headers are unambiguous — prefer the first one.
    }
  }
  return firstDocumented ?? first;
}

/**
 * Scroll the preview to a method (cursor on its name, header centered).
 * Unknown names leave the preview at the top — same as opening the element.
 */
function revealMethod(editor: vscode.TextEditor, method: string): void {
  const lines = editor.document.getText().split('\n');
  const range = methodHeaderRange(lines, method);
  if (!range) {
    return;
  }
  const namePos = new vscode.Position(range.decl, range.nameCol);
  editor.selection = new vscode.Selection(namePos, namePos);
  editor.revealRange(
    new vscode.Range(new vscode.Position(range.start, 0), new vscode.Position(range.decl, lines[range.decl].length)),
    vscode.TextEditorRevealType.InCenter,
  );
}
