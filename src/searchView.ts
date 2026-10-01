import * as vscode from 'vscode';
import {
  AotSearchFilter,
  EMPTY_FILTER,
  isEmptyFilter,
  nodeOptions,
  optionForKey,
  parseQuery,
  quickOptions,
  selectedTypeLabels,
  typeOptions,
} from './searchFilter';
import { AotTreeProvider } from './aotTree';

export const AOT_SEARCH_VIEW_ID = 'd365fo-aot-search';

/**
 * The AOT search page: an input with a funnel and `@` type filters above the whole
 * Application Explorer tree. VS Code has no API for a search box above a
 * contributed tree view - its own Extensions view is a workbench widget, not an
 * extension contribution - so the page is a webview view, and the tree is kept in
 * step through the provider's filter state.
 */
export interface AotSearchOptions {
  /**
   * When set, this page filters only its own rendering: the state goes to
   * `setViewFilter(viewId, …)` instead of the shared filter the native tree
   * reads, so the two trees can disagree. AOT Search (v1) leaves it unset and
   * keeps filtering the native tree, as it always has.
   */
  viewId?: string;
}

export class AotSearchViewProvider implements vscode.WebviewViewProvider {
  protected view: vscode.WebviewView | undefined;
  private filter: AotSearchFilter = EMPTY_FILTER;
  protected readonly viewId: string | undefined;

  constructor(
    private readonly tree: AotTreeProvider,
    private readonly options: AotSearchOptions = {},
  ) {
    this.viewId = options.viewId;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: this.resourceRoots() };
    view.webview.html = this.buildPage(view.webview);
    view.webview.onDidReceiveMessage((msg: unknown) => {
      void this.onMessage(msg);
    });
    void this.pushState();
  }

  /** Expose the page (e.g. from a command or the tree context menu). */
  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${this.viewId ?? AOT_SEARCH_VIEW_ID}.focus`);
    if (!this.view) {
      void vscode.window.showInformationMessage('Open the AOT Search view to search elements.');
    }
  }

  /** Icon fonts and codepoints, for the tree page. */
  protected pageAssets: TreeAssets | undefined;
  /** Folders the page may load files from. The tree needs resources/ for the fonts. */
  protected resourceRoots(): vscode.Uri[] {
    return [];
  }

  /** The markup for this page. A subclass renders a different body. */
  protected buildPage(webview: vscode.Webview): string {
    return page(this.pageAssets, webview.cspSource);
  }

  /** Send a message to the page, if it is resolved. */
  protected postToPage(message: unknown): Thenable<boolean> {
    return this.view ? this.view.webview.postMessage(message) : Promise.resolve(false);
  }

  /** Give the tree view the host-side helpers it needs. */
  protected get searchTree(): AotTreeProvider {
    return this.tree;
  }

  /** Push the current filter into the tree so both views agree. */
  private syncTree(): void {
    const state = isEmptyFilter(this.filter)
      ? undefined
      : {
          text: this.filter.text,
          typeLabels: selectedTypeLabels(this.filter),
        };
    if (this.viewId) {
      // This page's own tree only; the native tree keeps its own state.
      this.tree.setViewFilter(this.viewId, state);
      return;
    }
    this.tree.setElementFilter(state);
    // Reconcile by stable id so expansion and selection survive a filter change.
    this.tree.refreshView(undefined);
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null) {
      return;
    }
    const m = msg as { type?: unknown; value?: unknown; offset?: unknown; fsPath?: unknown; label?: unknown };
    switch (m.type) {
      case 'ready':
        await this.pushState();
        return;
      case 'query': {
        const value = typeof m.value === 'string' ? m.value : '';
        const parsed = parseQuery(value);
        this.filter = { text: parsed.text, keys: parsed.keys.filter((k) => !!optionForKey(k)) };
        await this.pushState();
        return;
      }
      default:
        return;
    }
  }

  private async pushState(): Promise<void> {
    // The filter is the whole state: the tree prunes itself with it
    // (nodeSurvives / labelSurvives), so there is nothing to count here and no
    // element index behind the page. Synced even when the view is not resolved
    // yet — the filter is host state, the view is only a mirror of it.
    this.syncTree();
    const view = this.view;
    if (!view) {
      return;
    }
    const options = {
      quick: quickOptions().map((o) => ({ key: o.key, label: o.label })),
      // The node list, and each node's child types keyed BY NODE. Keying this
      // by type instead would both break the third column (a node would have
      // no entry) and repeat every child once per sibling group.
      nodes: nodeOptions().map((o) => ({ key: o.key, label: o.label, catId: o.catId })),
      types: Object.fromEntries(
        nodeOptions().map((o) => [
          o.key,
          typeOptions(o.catId).map((t) => ({ key: t.key, label: t.label })),
        ]),
      ),
    };
    await view.webview.postMessage({ type: 'state', filter: this.filter, options });
  }
}

function page(assets: TreeAssets | undefined, cspSource: string): string {
  const id = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${id}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; padding: 8px; }
#bar { position: relative; display: flex; align-items: center; gap: 4px; }
#q { flex: 1; min-width: 0; box-sizing: border-box; padding: 4px 26px 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); outline: none; }
#q:focus { border-color: var(--vscode-focusBorder); }
#funnel { position: absolute; right: 2px; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; border: none; background: none; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; border-radius: 3px; }
#funnel:hover { background: var(--vscode-toolbar-hoverBackground); }
#funnel.on { color: var(--vscode-focusBorder); }
#funnel svg { width: 15px; height: 15px; fill: currentColor; }
#menu { position: absolute; z-index: 5; top: 30px; left: 0; right: 0; max-height: 60vh; overflow: auto; display: flex; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
#menu[hidden] { display: none; }
.col { flex: 1 1 0; min-width: 0; padding: 2px 0; border-right: 1px solid var(--vscode-editorWidget-border); }
.col:last-child { border-right: none; }
.item { display: flex; align-items: flex-start; gap: 6px; padding: 4px 8px; cursor: pointer; }
/* Long official names ("Business Process and Workflow") must wrap, never clip. */
.item .label { flex: 1; min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.35; }
.item:hover { background: var(--vscode-list-hoverBackground); }
.item.static { cursor: default; }
.item .tick { width: 14px; flex: none; opacity: 0.9; line-height: 1.35; }
.item .arrow { flex: none; opacity: 0.7; line-height: 1.35; }
/* How many types sit under a node, so the user can see where the depth is
   before drilling into it. Sits before the arrow, right-aligned. */
.item .count { flex: none; margin-left: auto; padding-left: 10px; color: var(--vscode-descriptionForeground); font-size: 0.85em; line-height: 1.35; font-variant-numeric: tabular-nums; }
.sep { height: 1px; margin: 4px 8px; background: var(--vscode-editorWidget-border); }
.dim { color: var(--vscode-descriptionForeground); }
${treeCss(assets)}
#sug { position: absolute; z-index: 6; top: 30px; left: 0; right: 0; max-height: 40vh; overflow: auto; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
#sug[hidden] { display: none; }
#sug .item { padding: 4px 8px; }
/* Keyboard-highlighted row, the same tokens the list uses for selection. */
#sug .item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
#status { display: flex; align-items: baseline; gap: 8px; margin: 8px 2px 4px; color: var(--vscode-descriptionForeground); }
#status .warn { color: var(--vscode-editorWarning-foreground); }
[hidden] { display: none !important; }
</style>
</head>
<body>
<div id="bar">
  <input id="q" type="text" placeholder="Search AOT elements" spellcheck="false" />
  <button id="funnel" title="Filter by type" aria-label="Filter by type">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2h13l-5 6v5.5l-3 1.5V8z"/></svg>
  </button>
</div>
<div id="sug" hidden></div>
<div id="menu" hidden></div>
<div id="status"><span id="note"></span></div>
<div id="tree"></div>
<div id="ctxmenu" role="menu" hidden></div>
<script nonce="${id}">
(function () {
  var ASSETS = ${JSON.stringify(assets ?? null)};
  var vscode = acquireVsCodeApi();
${treeScript()}
  var q = document.getElementById('q');
  var funnel = document.getElementById('funnel');
  var menu = document.getElementById('menu');
  var sug = document.getElementById('sug');
  var note = document.getElementById('note');
  var options = { quick: [], nodes: [], types: {} };
  var stage = 0;         // 0 = quick kinds, 1 = + nodes, 2 = + a node's children
  var colNode = -1;      // index into options.nodes for the drilled node
  var sugIndex = 0;      // highlighted row in the @ list
  var seeded = false;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // The input text is the single source of truth: the funnel edits the same
  // tokens the '@' list inserts, so the two can never disagree.
  function tokens() {
    var words = q.value.split(/\\s+/);
    var out = [];
    var text_ = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w && w.charAt(0) === '@' && w.length > 1 && optionByKey(w.slice(1))) out.push(w.slice(1));
      else if (w) text_.push(w);
    }
    return { text: text_.join(' '), keys: out };
  }
  /**
   * Put the keyboard on the tree. Declared out here because the search box
   * owns the only focus the page starts with, and Escape out of it is how the
   * user reaches the tree without a mouse.
   */
  function focusTree() {
    if (typeof focusRowEl === 'function') {
      if (!focusId && roots.length) focusId = roots[0].id;
      focusRowEl();
    }
  }

  function setValue(keys, text_) {
    q.value = (keys.length ? keys.map(function (k) { return '@' + k; }).join(' ') + ' ' : '') + (text_ || '');
  }
  function post() {
    syncInput();
    vscode.postMessage({ type: 'query', value: q.value, offset: 0 });
  }
  /**
   * A type picked from the menu is a single choice: it replaces any type tokens
   * already there, and the rest of the box is left as the user typed it. The
   * token goes in first, so "CustTable" becomes "@Table CustTable".
   */
  function pickType(key) {
    var v = q.value;
    var had = [];
    // Keep every non-token character exactly as typed; tidy the gaps the
    // removed tokens left behind, then trim so a pick never doubles a space.
    var text_ = v.replace(/@[A-Za-z0-9:]+/g, function (m) { had.push(m.slice(1)); return ''; }).replace(/\\s+/g, ' ').trim();
    // Picking the type that is already the only one clears it.
    var keys = (had.length === 1 && had[0] === key) ? [] : [key];
    // Only separate the token from the text when there IS text. A token on its
    // own used to leave a trailing space and a caret past the end of it, which
    // reads as if something were still being typed.
    var value = (keys.length ? '@' + key + (text_ ? ' ' : '') : '') + text_;
    q.value = value;
    var at = value.length;
    q.focus();
    q.setSelectionRange(at, at);
    post();
  }
  function syncInput() {
    var n = tokens().keys.length;
    funnel.className = n ? 'on' : '';
    funnel.title = n ? n + ' type filter(s) active' : 'Filter by type';
  }
  function render() {
    // Only ask the host for results. The value is NOT rewritten here: the funnel
    // and the @ list set it themselves, and re-serialising it on every keystroke
    // would move the caret out from under the user mid-@word.
    post();
  }

  function optionByKey(key) {
    for (var i = 0; i < options.quick.length; i++) if (options.quick[i].key === key) return options.quick[i];
    for (var i = 0; i < options.nodes.length; i++) if (options.nodes[i].key === key) return options.nodes[i];
    for (var node in options.types) {
      var list = options.types[node];
      for (var j = 0; j < list.length; j++) if (list[j].key === key) return list[j];
    }
    return undefined;
  }

  // ---- the @ suggestions ------------------------------------------------------
  function activeToken() {
    var upto = q.value.slice(0, q.selectionStart || q.value.length);
    var m = upto.match(/@([A-Za-z0-9:]*)$/);
    return m ? m[1] : undefined;
  }
  function showSuggestions(partial) {
    var keys = [];
    for (var i = 0; i < options.quick.length; i++) keys.push(options.quick[i].key);
    for (var i = 0; i < options.nodes.length; i++) keys.push(options.nodes[i].key);
    // One entry per option: each node is listed once, and its children come
    // from that node's own list.
    var seen = {};
    for (var k = 0; k < keys.length; k++) seen[keys[k]] = true;
    for (var node in options.types) {
      var list = options.types[node];
      for (var j = 0; j < list.length; j++) if (!seen[list[j].key]) { seen[list[j].key] = true; keys.push(list[j].key); }
    }
    var p = (partial || '').toLowerCase();
    // A hand-typed @word is a *hint*, not a filter. Filtering the list to it hides
    // exactly the options the user is trying to find by typing a fragment, and an
    // empty list is a dead end mid-word. So nothing is ever hidden: matches rank
    // first, and everything else stays below them, ready to arrow down to.
    var rank = function (k) { return k.indexOf(':') === -1 ? 0 : 1; };
    var hit = function (k) { return p && k.toLowerCase().indexOf(p) >= 0 ? 0 : 1; };
    var scored = keys.slice().sort(function (a, b) {
      return hit(a) - hit(b) || rank(a) - rank(b) ||
        (p ? a.toLowerCase().indexOf(p) - b.toLowerCase().indexOf(p) : 0) || a.length - b.length;
    }).slice(0, 40);
    if (!scored.length) { hideSuggestions(); return; }
    var html = '';
    for (var i = 0; i < scored.length; i++) {
      html += '<div class="item" data-key="' + esc(scored[i]) + '"><span>@' + esc(scored[i]) + '</span></div>';
    }
    sug.innerHTML = html;
    sug.hidden = false;
    sugIndex = 0;
    markSug();
  }
  function hideSuggestions() { sug.hidden = true; sugIndex = 0; }
  function sugItems() { return [...sug.querySelectorAll('.item')]; }
  /** Highlight the active row and keep it in view; the caret stays in the box. */
  function markSug() {
    var list = sugItems();
    for (var i = 0; i < list.length; i++) {
      list[i].classList.toggle('active', i === sugIndex);
    }
    var active = list[sugIndex];
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }
  function insertToken(key) {
    var v = q.value;
    var at = q.selectionStart == null ? v.length : q.selectionStart;
    // Swallow the half-typed @word under the caret, up to the caret itself, and
    // cut the string at that same offset - slicing at the old one would leave a
    // fragment behind.
    var head = v.slice(0, at);
    var pos = head.lastIndexOf('@');
    if (pos >= 0 && /^[A-Za-z0-9:]*\s*$/.test(head.slice(pos + 1))) {
      head = head.slice(0, pos);
    } else if (head && !/\s$/.test(head)) {
      head += ' ';
    }
    var value = head + '@' + key + ' ' + v.slice(at);
    q.value = value;
    var caret = head.length + key.length + 2;
    q.focus();
    q.setSelectionRange(caret, caret);
    hideSuggestions();
    post();
  }

  // ---- the funnel -------------------------------------------------------------
  // Progressive disclosure, like the Extensions filter widget: the four kinds
  // first, then "Advanced" opens the nodes, then a node opens its own types.
  function tick(key) {
    return tokens().keys.indexOf(key) >= 0 ? '<span class="tick">&#10003;</span>' : '<span class="tick"></span>';
  }
  function renderMenu() {
    var cols = [];
    var c0 = '';
    for (var i = 0; i < options.quick.length; i++) {
      var o = options.quick[i];
      c0 += '<div class="item" data-key="' + esc(o.key) + '" data-top="1">' + tick(o.key) + '<span class="label">' + esc(o.label) + '</span></div>';
    }
    c0 += '<div class="item" data-advanced="1"><span class="tick"></span><span class="label">Advanced</span><span class="arrow">&rsaquo;</span></div>';
    cols.push(c0);

    var c1 = '';
    for (var i = 0; i < options.nodes.length; i++) {
      var n = options.nodes[i];
      var under = (options.types[n.key] || []).length;
      c1 += '<div class="item" data-key="' + esc(n.key) + '" data-node="' + i + '">' + tick(n.key) +
        '<span class="label">' + esc(n.label) + '</span>' +
        (under ? '<span class="count" title="' + under + ' type' + (under === 1 ? '' : 's') + '">' + under + '</span>' : '') +
        '<span class="arrow">&rsaquo;</span></div>';
    }
    cols.push(c1);

    var c2 = '';
    if (colNode >= 0) {
      var node = options.nodes[colNode];
      var list = node ? options.types[node.key] || [] : [];
      if (!list.length) {
        c2 += '<div class="item static"><span class="label dim">No types</span></div>';
      }
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        c2 += '<div class="item" data-key="' + esc(t.key) + '">' + tick(t.key) + '<span class="label">' + esc(t.label) + '</span></div>';
      }
    }
    cols.push(c2);

    menu.innerHTML = cols.slice(0, stage + 1).map(function (c) { return '<div class="col">' + c + '</div>'; }).join('');
    menu.hidden = false;
  }
  function closeMenu() { menu.hidden = true; stage = 0; colNode = -1; }

  // ---- the background warm, told honestly ------------------------------
  /**
   * The warm is the only progress this page reports: there is no element index
   * behind it, so the note must never claim one is running.
   *
   * A type counts as warm the moment its eager head (prefetchCount rows) is
   * cached, because that is what makes its foldout open instantly. So reaching the
   * total means every foldout is already instant, and the full lists that stream
   * in behind only fill rows in - which the page takes as the provider reports
   * them.
   */
  function renderWarm(m) {
    if (!m) return;
    lastWarm = m;
    var done = m.typesReady || 0;
    var total = m.types || 0;
    if (m.ready) {
      var bits = total ? total + (total === 1 ? ' type' : ' types') : '';
      if (versionRows) bits += (bits ? ' \\u00b7 ' : '') + versionRows + (versionRows === 1 ? ' version' : ' versions');
      note.textContent = bits ? 'Ready \\u00b7 ' + bits : 'Ready';
      note.className = '';
      return;
    }
    if (!total) {
      note.textContent = versionRows ? 'Loading\\u2026' : 'Reading versions\\u2026';
      note.className = '';
      return;
    }
    note.textContent = 'Warming ' + done + '/' + total + (total === 1 ? ' type' : ' types') + '\\u2026';
    note.className = '';
  }

  // ---- wiring -----------------------------------------------------------------
  q.addEventListener('input', function () {
    // Typing collapses the funnel: the type is already in the box, so the menu
    // has done its job and would only cover the results.
    closeMenu();
    var t = activeToken();
    if (t !== undefined) showSuggestions(t); else hideSuggestions();
    render();
  });
  q.addEventListener('keydown', function (e) {
    // Escape peels off one layer at a time: first the @ list, then the funnel,
    // and only then the text itself. Clearing the box is destructive, so it must
    // not be what a single Escape does while a menu is still open.
    if (e.key === 'Escape') {
      if (!sug.hidden) { hideSuggestions(); e.preventDefault(); return; }
      if (!menu.hidden) { closeMenu(); e.preventDefault(); return; }
      if (q.value) { q.value = ''; post(); e.preventDefault(); return; }
      // Nothing left to clear, so hand the keyboard over to the tree. That is the
      // route into it without a mouse: Escape out of an empty box, then the
      // arrows. (A webview's iframe only takes keys once something in it has the
      // focus, so the tree has to be reachable from the one thing that starts
      // focused.)
      if (treeEl) { e.preventDefault(); focusTree(); }
      return;
    }
    if (sug.hidden) {
      return;
    }
    // Arrow keys walk the list, Enter (or Tab) takes the highlighted row. The
    // caret never leaves the input, so the half-typed @word is still there.
    var list = sugItems();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.length) {
        return;
      }
      sugIndex = e.key === 'ArrowDown'
        ? (sugIndex + 1) % list.length
        : (sugIndex - 1 + list.length) % list.length;
      markSug();
      return;
    }
    if (e.key === 'Home' && list.length) { e.preventDefault(); sugIndex = 0; markSug(); return; }
    if (e.key === 'End' && list.length) { e.preventDefault(); sugIndex = list.length - 1; markSug(); return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && list.length) {
      e.preventDefault();
      insertToken(list[sugIndex].getAttribute('data-key'));
    }
  });
  sug.addEventListener('mouseover', function (e) {
    var it = e.target.closest('.item');
    if (!it) {
      return;
    }
    var list = sugItems();
    var i = list.indexOf(it);
    if (i >= 0 && i !== sugIndex) {
      sugIndex = i;
      markSug();
    }
  });
  sug.addEventListener('click', function (e) {
    var it = e.target.closest('.item');
    if (it) insertToken(it.getAttribute('data-key'));
  });
  funnel.addEventListener('click', function (e) {
    e.stopPropagation();
    if (menu.hidden) renderMenu(); else closeMenu();
  });
  menu.addEventListener('click', function (e) {
    var it = e.target.closest('.item');
    if (!it) return;
    if (it.getAttribute('data-advanced') === '1') {
      // Reveal the first-level nodes; they are not shown until asked for.
      stage = 1;
      renderMenu();
      return;
    }    var nodeIndex = it.getAttribute('data-node');
    if (nodeIndex !== null) {
      colNode = Number(nodeIndex);
      stage = 2;
      pickType(it.getAttribute('data-key'));
      renderMenu();
      return;
    }
    // The four quick kinds are the top of the funnel, and picking one is a step
    // on the way to a narrower type, not the end of it: Advanced is one click
    // away and each node has its own list. So the menu stays open, ready to drill
    // into, instead of getting out of the way.
    if (it.getAttribute('data-top') === '1') {
      pickType(it.getAttribute('data-key'));
      renderMenu();
      return;
    }
    // A leaf type is terminal: there is nothing below it to narrow to.
    pickType(it.getAttribute('data-key'));
    closeMenu();
  });
  // Close on mousedown, not click: a menu row re-renders on click, which
  // detaches the row that was clicked, so a bubbled document click would no
  // longer find it inside the menu and would close the menu over the top of
  // the column it just opened. On mousedown the row is still attached.
  document.addEventListener('mousedown', function (e) {
    if (!menu.contains(e.target) && !funnel.contains(e.target)) closeMenu();
  });
  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.type === 'state') {
      options = m.options || options;
      // Seed the input once, from the host's own state, and never again: this
      // handler must not rewrite the value, or the re-render would post another
      // query and the exchange would never settle.
      if (!seeded) {
        seeded = true;
        var t = m.filter || { text: '', keys: [] };
        if (!q.value) {
          setValue(t.keys || [], t.text || '');
        }
        syncInput();
      }
    } else if (m.type === 'warm') {
      // The background warm, told honestly by renderWarm. There is no index
      // behind this page, so the note never claims one is running.
      renderWarm(m);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

/** What the page needs from the extension host: fonts and icon codepoints. */
export interface TreeAssets {
  /** CSS `url(...)` for each icon font, by font id. */
  fonts: Record<string, string>;
  /** Icon id -> font + codepoint, from resources/icon-map.json. */
  icons: Record<string, { font: string; code: string }>;
}

/**
 * Icon fonts and tree styling. A webview cannot use a ThemeIcon or a product
 * icon font, so the two fonts are shipped as files and addressed by the
 * generated codepoint map - which is what makes the tree look identical to the
 * native one.
 */
function treeCss(assets: TreeAssets | undefined): string {
  if (!assets) {
    return '';
  }
  const faces = Object.entries(assets.fonts)
    .map(([id, href]) => `@font-face { font-family: '${id}'; font-display: block; src: url('${href}') format('truetype'); }`)
    .join('\n');
  return `${faces}
#tree { margin-top: 2px; }
/* The tree is one tab stop; the focused row carries a visible marker, the way the
   native tree marks the selected row. */
#tree:focus { outline: none; }
#tree .trow.focused {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
#tree .trow.focused .tdesc { color: inherit; opacity: 0.8; }
#tree .trow:hover:not(.focused) { background: var(--vscode-list-hoverBackground); }
/* The context menu a webview cannot borrow from the workbench. */
#ctxmenu {
  position: fixed; z-index: 20; min-width: 220px; padding: 4px 0;
  background: var(--vscode-menu-background);
  border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
  box-shadow: 0 2px 8px var(--vscode-widget-shadow);
}
#ctxmenu .item { padding: 4px 12px; gap: 6px; }
#ctxmenu .item:hover, #ctxmenu .item.active { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
.trow { display: flex; align-items: center; gap: 4px; padding: 1px 4px 1px 0; border-radius: 3px; cursor: pointer; white-space: nowrap; }
.trow:hover { background: var(--vscode-list-hoverBackground); }
.trow.open { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.trow .twisty { width: 14px; height: 14px; flex: none; display: flex; align-items: center; justify-content: center; opacity: 0.8; }
.trow .twisty svg { width: 12px; height: 12px; fill: currentColor; transition: transform 0.08s linear; }
.trow.expanded .twisty svg { transform: rotate(90deg); }
.trow .ticon { flex: none; width: 15px; text-align: center; font-size: 14px; line-height: 1; }
.trow .tlabel { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.trow .tdesc { flex: 0 1 auto; color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; }
.tkids { margin-left: 12px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke, var(--vscode-panel-border)); }`;
}

/**
 * The tree renderer. It asks the host for the children of a node and draws what
 * comes back, so the rows are the same nodes, with the same labels, icons and
 * descriptions, that the native tree shows - `getTreeItem` is the single
 * source for all three.
 */
  function treeScript(): string {
    return `  // ---- the tree (AOT Search v2) ----
  var treeEl = document.getElementById('tree');
  var ctxEl = document.getElementById('ctxmenu');
  var nodes = {};        // id -> { row, kids, expanded, loaded, node }
  var parentOf = {};     // id -> the id of the row it hangs under
  var roots = [];        // top-level rows
  var focusId = null;    // the one row the keyboard is on (roving tabindex)
  var pending = 0;
  var typeBuf = '';      // type-ahead: what has been typed, and when
  var typeAt = 0;
  // Version rows the page is really showing. The host cannot report this: the
  // roots hold a synthetic version node for MS-Packages, and the UDE scan
  // returns version folders with no models that the tree hides - so a host tally
  // would say 4 where the tree shows 2.
  var versionRows = 0;
  var lastWarm = null;
  var TYPE_RESET_MS = 900;

  function icon(id, label) {
    var spec = ASSETS && ASSETS.icons ? ASSETS.icons[id] : undefined;
    if (!spec) return '';
    // \`approx\` marks a stand-in glyph: the published Codicon set has no such
    // icon, so the row says so rather than pretending.
    var note = spec.approx ? ' \\u2248 ' + spec.approx + ' (no exact Codicon)' : '';
    return '<span class="ticon" style="font-family:\\'' + spec.font + '\\'" title="' + esc(label || id) + note + '">&#x' + spec.code + ';</span>';
  }
  function twisty() {
    return '<span class="twisty"><svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4z"/></svg></span>';
  }

  // ---- rows -------------------------------------------------------------
  function rowHtml(row, depth) {
    var slot = nodes[row.id];
    var kids = slot && slot.kids ? slot.kids : null;
    var open = !!(slot && slot.expanded);
    var h = '<div class="trow' + (depth === 0 ? ' top' : '') + (open ? ' expanded' : '') +
      (row.id === focusId ? ' focused' : '') + '"';
    h += ' data-id="' + esc(row.id) + '" data-depth="' + depth + '"';
    h += ' data-context="' + esc(row.contextValue || '') + '"';
    // The row IS the accessible widget: one tab stop for the whole tree, and the
    // focused row carries it - the roving tabindex the native tree uses.
    h += ' role="treeitem" tabindex="' + (row.id === focusId ? '0' : '-1') + '"';
    h += ' aria-level="' + (depth + 1) + '"';
    if (row.collapsible) h += ' aria-expanded="' + (open ? 'true' : 'false') + '"';
    h += ' title="' + esc(row.tooltip || row.label) + '">';
    h += row.collapsible ? twisty() : '<span class="twisty"></span>';
    h += icon(row.icon, row.label);
    h += '<span class="tlabel">' + esc(row.label) + '</span>';
    if (row.description) h += '<span class="tdesc">' + esc(row.description) + '</span>';
    h += '</div>';
    if (row.collapsible && kids) {
      h += '<div class="tkids"' + (open ? '' : ' hidden') + '>';
      for (var i = 0; i < kids.length; i++) h += rowHtml(kids[i], depth + 1);
      h += '</div>';
    }
    return h;
  }
  function renderTree() {
    if (!treeEl) return;
    // Replacing innerHTML destroys the focused row, and a real browser then drops
    // focus to the body - after which the tree is deaf to the keyboard, which is
    // exactly what happened on the first expand. So remember whether the tree
    // held the focus, and put it back on the same row afterwards.
    var had = treeEl.contains(treeEl.ownerDocument.activeElement);
    var h = '';
    for (var i = 0; i < roots.length; i++) h += rowHtml(roots[i], 0);
    treeEl.innerHTML = h;
    if (had) focusRowEl();
  }
  /** Give the DOM focus to the focused row, or to the tree itself. */
  function focusRowEl() {
    if (!treeEl) return;
    var el = (focusId && rowEl(focusId)) || treeEl;
    try { el.focus({ preventScroll: true }); } catch (e) { /* detached */ }
  }

  function store(id, rows) {
    // Only make the slot if it is really new. It must NOT be re-seeded from a
    // stub row: the slot holds the node payload the host needs to re-ask for
    // these children, and a stub would wipe it (the re-ask would then come back
    // with the roots instead of this branch).
    var slot = nodes[id];
    if (!slot) slot = nodes[id] = { kids: null, expanded: false, loaded: false };
    slot.kids = rows;
    slot.loaded = true;
    for (var i = 0; i < rows.length; i++) {
      remember(rows[i]);
      parentOf[rows[i].id] = id;
    }
    countVersions(id, rows);
  }
  function countVersions(id, rows) {
    // Only the children of a SOURCE row are real versions. Ask the parent's own
    // row what it is, rather than pattern-matching the provider's id format: a
    // version row at the root is the synthetic packages entry, and its parent is
    // the root set, not a source.
    var parent = nodes[id] && nodes[id].row;
    if (!parent || parent.kind !== 'source') return;
    var n = 0;
    for (var i = 0; i < rows.length; i++) if (rows[i].kind === 'version') n++;
    if (n !== versionRows) {
      versionRows = n;
      renderWarm(lastWarm);
    }
  }
  /**
   * Learn a row. The expansion flag deliberately lives in the slot, not on the
   * row: every host response is a fresh row object, so a row-carried flag would
   * collapse the tree on each refresh and on each keystroke of the filter.
   */
  function remember(row) {
    var slot = nodes[row.id];
    if (!slot) slot = nodes[row.id] = { kids: null, expanded: false, loaded: false };
    slot.node = row.node;
    slot.row = row;
    return slot;
  }
  function askFor(id, slot) {
    pending++;
    vscode.postMessage({ type: 'children', id: id, node: slot ? slot.node : undefined });
  }
  function expand(id) {
    var slot = nodes[id];
    if (!slot || !slot.row || !slot.row.collapsible) return;
    slot.expanded = !slot.expanded;
    if (slot.expanded) {
      if (!slot.loaded) askFor(id, slot);
    } else {
      // Say so, and drop what we were showing: a closed branch must cost the
      // page nothing, or a background refresh would re-render it for ever.
      vscode.postMessage({ type: 'collapse', id: id });
      slot.kids = null;
      slot.loaded = false;
    }
    renderTree();
  }

  // ---- navigation -------------------------------------------------------
  /** Every row the user can currently see, in visual order. */
  function visibleRows() {
    var out = [];
    (function walk(rows) {
      for (var i = 0; i < rows.length; i++) {
        var slot = nodes[rows[i].id];
        out.push(rows[i]);
        if (slot && slot.expanded && slot.kids) walk(slot.kids);
      }
    })(roots);
    return out;
  }
  function rowEl(id) {
    return treeEl ? treeEl.querySelector('.trow[data-id="' + cssEscape(id) + '"]') : null;
  }
  function cssEscape(v) {
    return String(v).replace(/["\\\\]/g, '\\\\$&');
  }
  /**
   * Move the keyboard (and the visible selection) to a row. Done on the two
   * affected rows only - a full re-render on every arrow press would be the one
   * thing that could make the tree feel heavy again.
   */
  function setFocus(id, scroll) {
    if (!treeEl || !id) return;
    if (focusId && focusId !== id) {
      var prev = rowEl(focusId);
      if (prev) { prev.classList.remove('focused'); prev.setAttribute('tabindex', '-1'); }
    }
    focusId = id;
    var el = rowEl(id);
    if (el) {
      el.classList.add('focused');
      el.setAttribute('tabindex', '0');
      if (scroll !== false && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
    // Tab into the tree when the focus moved by keyboard, so the roving
    // tabindex actually owns the focus.
    if (el && treeEl.ownerDocument.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch (e) { /* jsdom, or detached */ }
    }
    closeCtx();
  }
  function focusIndex(i) {
    var list = visibleRows();
    if (!list.length) return;
    setFocus(list[Math.max(0, Math.min(i, list.length - 1))].id, true);
  }
  function focusNeighbour(delta) {
    var list = visibleRows();
    if (!list.length) return;
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === focusId) { at = i; break; }
    if (at < 0) { focusIndex(delta > 0 ? 0 : list.length - 1); return; }
    focusIndex(at + delta);
  }
  /** Right arrow: open a closed node, else step onto its first child. */
  function focusForward() {
    var slot = nodes[focusId];
    if (!slot || !slot.row) return;
    if (slot.row.collapsible && !slot.expanded) { expand(focusId); return; }
    if (slot.expanded && slot.kids && slot.kids.length) setFocus(slot.kids[0].id, true);
  }
  /** Left arrow: close an open node, else step out to its parent. */
  function focusBack() {
    var slot = nodes[focusId];
    if (!slot || !slot.row) return;
    if (slot.row.collapsible && slot.expanded) { expand(focusId); return; }
    var p = parentOf[focusId];
    if (p) setFocus(p, true);
  }
  function focusEdge(which) {
    var list = visibleRows();
    if (list.length) setFocus(which === 'home' ? list[0].id : list[list.length - 1].id, true);
  }
  function focusLevel(delta) {
    var list = visibleRows();
    if (!list.length) return;
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === focusId) { at = i; break; }
    var step = delta > 0 ? 20 : -20;
    focusIndex((at < 0 ? 0 : at) + step);
  }

  // ---- type-ahead -------------------------------------------------------
  /** Jump to the next visible row whose label starts with what was typed. */
  function typeAhead(ch) {
    var now = Date.now();
    if (now - typeAt > TYPE_RESET_MS) typeBuf = '';
    typeAt = now;
    typeBuf += ch.toLowerCase();
    var list = visibleRows();
    if (!list.length) return;
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === focusId) { at = i; break; }
    for (var n = 1; n <= list.length; n++) {
      var row = list[(at + n) % list.length];
      if (String(row.label || '').toLowerCase().indexOf(typeBuf) === 0) { setFocus(row.id, true); return; }
    }
  }

  // ---- activation -------------------------------------------------------
  /**
   * What a click or Enter does. The host told us which command this row declares
   * - the same one the native tree runs - so a Base Enum opens its values grid, a
   * query its metadata, a Fields section its grid. With no command the row just
   * folds, exactly as natively.
   */
  function activate(id) {
    var slot = nodes[id];
    if (!slot || !slot.row) return;
    var row = slot.row;
    if (row.command) {
      vscode.postMessage({ type: 'activate', id: id, command: row.command, node: row.node });
      return;
    }
    if (row.collapsible) expand(id);
  }
  function onRowClick(e) {
    var tr = e.target.closest('.trow');
    if (!tr) return;
    var id = tr.getAttribute('data-id');
    closeCtx();
    if (e.target.closest('.twisty')) { setFocus(id, false); expand(id); return; }
    setFocus(id, false);
    activate(id);
  }

  // ---- the context menu -------------------------------------------------
  // A webview cannot show the workbench's own menus, so this is our own. Only
  // the one action a version row offers is here for now.
  var CTX = [{ when: 'd365fo-version', command: 'd365fo-aot.toggleView', title: 'Toggle Models/Classic View' }];
  function ctxItemsFor(contextValue) {
    var out = [];
    for (var i = 0; i < CTX.length; i++) if (CTX[i].when === contextValue) out.push(CTX[i]);
    return out;
  }
  function openCtx(id, x, y) {
    if (!ctxEl) return;
    var slot = nodes[id];
    var row = slot && slot.row;
    if (!row) return;
    var entries = ctxItemsFor(row.contextValue);
    if (!entries.length) return;
    ctxEl.innerHTML = entries.map(function (c) {
      return '<div class="item" role="menuitem" tabindex="-1" data-command="' + esc(c.command) + '">' +
        '<span class="label">' + esc(c.title) + '</span></div>';
    }).join('');
    ctxEl.hidden = false;
    ctxEl.style.left = Math.max(0, x) + 'px';
    ctxEl.style.top = Math.max(0, y) + 'px';
    ctxEl.setAttribute('data-target', id);
  }
  function closeCtx() { if (ctxEl) { ctxEl.hidden = true; ctxEl.innerHTML = ''; } }
  function ctxOpen() { return !!ctxEl && !ctxEl.hidden; }
  function ctxRun(el) {
    var id = ctxEl.getAttribute('data-target');
    var slot = nodes[id];
    closeCtx();
    if (el && slot && slot.row) {
      vscode.postMessage({ type: 'activate', id: id, command: el.getAttribute('data-command'), node: slot.row.node });
    }
  }

  // ---- wiring -----------------------------------------------------------
  function reloadExpanded() {
    for (var id in nodes) {
      var slot = nodes[id];
      if (slot && slot.expanded) {
        slot.loaded = false;
        askFor(id, slot);
      }
    }
    renderTree();
  }
  function wire() {
    if (!treeEl) return;
    treeEl.setAttribute('tabindex', '0');
    treeEl.setAttribute('role', 'tree');
    treeEl.addEventListener('click', onRowClick);
    treeEl.addEventListener('mousedown', function (e) {
      // A click below the last row is still a click on the tree: focus it, so the
      // keyboard works without having to land on a row first.
      if (!e.target.closest('.trow')) { closeCtx(); focusRowEl(); }
    });
    treeEl.addEventListener('mousedown', function (e) {
      var tr = e.target.closest('.trow');
      if (!tr) return;
      // Right-click opens our menu instead of the browser's, and does not move
      // the keyboard - a context menu is not a selection.
      if (e.button === 2) {
        e.preventDefault();
        var r = tr.getBoundingClientRect ? tr.getBoundingClientRect() : { left: 0, top: 0 };
        openCtx(tr.getAttribute('data-id'), e.clientX || r.left, e.clientY || r.top);
      }
    });
    treeEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    treeEl.addEventListener('dblclick', function (e) { e.preventDefault(); });
    // On the DOCUMENT, not on the tree. Inside a webview the focus can end up on
    // the body (any re-render, any click on empty space), and a listener bound to
    // the tree would then never fire - the arrows would simply do nothing. The
    // search input is excluded, so it keeps its own caret and @-list handling.
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      onTreeKey(e);
    });
  }
  function onTreeKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); closeCtx(); focusNeighbour(1); return; }
    if (k === 'ArrowUp') { e.preventDefault(); closeCtx(); focusNeighbour(-1); return; }
    if (k === 'ArrowRight') { e.preventDefault(); closeCtx(); focusForward(); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); closeCtx(); focusBack(); return; }
    if (k === 'Home') { e.preventDefault(); closeCtx(); focusEdge('home'); return; }
    if (k === 'End') { e.preventDefault(); closeCtx(); focusEdge('end'); return; }
    if (k === 'PageDown') { e.preventDefault(); closeCtx(); focusLevel(1); return; }
    if (k === 'PageUp') { e.preventDefault(); closeCtx(); focusLevel(-1); return; }
    if (k === 'Enter') { e.preventDefault(); closeCtx(); activate(focusId); return; }
    if (k === ' ') { e.preventDefault(); closeCtx(); expand(focusId); return; }
    if (k === 'Escape') { closeCtx(); return; }
    if (k === 'F10' && e.shiftKey) {
      e.preventDefault();
      if (ctxOpen()) { closeCtx(); return; }
      var slot = nodes[focusId];
      if (slot && slot.row) {
        var el = rowEl(focusId);
        var r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 };
        openCtx(focusId, r.left + 16, r.top + 16);
      }
      return;
    }
    // Type-ahead: a printable character with no modifier jumps by label.
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      typeAhead(k);
    }
  }
  if (treeEl) {
    wire();
    document.addEventListener('mousedown', function (e) {
      // Only a press OUTSIDE the tree and the menu closes it. A press inside the
      // tree is the one that opened it - it bubbles to here in the same event, so
      // treating it as "outside" closed the menu the instant it appeared.
      if (ctxEl && !ctxEl.contains(e.target) && !treeEl.contains(e.target)) closeCtx();
    });
    ctxEl.addEventListener('click', function (e) {
      var it = e.target.closest('.item');
      if (it) ctxRun(it);
    });
  }
  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.type === 'roots') {
      roots = m.rows || [];
      for (var i = 0; i < roots.length; i++) remember(roots[i]);
      // The keyboard starts on the first row, so the tree is usable without a
      // click and the roving tabindex always has somewhere to be.
      if (!focusId && roots.length) focusId = roots[0].id;
      renderTree();
      return;
    }
    if (m.type === 'children') {
      var slot = nodes[m.id];
      if (slot && !slot.expanded) return;
      store(m.id, m.rows || []);
      renderTree();
      return;
    }
    if (m.type === 'state') {
      if (m.filter !== undefined) reloadExpanded();
    }
  });
  if (treeEl) {
    vscode.postMessage({ type: 'roots' });
  }
  `
    ;
}
function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}
