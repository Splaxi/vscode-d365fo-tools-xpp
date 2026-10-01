import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AotSearchViewProvider, type TreeAssets } from './searchView';
import type { AotNode, AotTreeProvider } from './aotTree';

export const AOT_SEARCH_TREE_VIEW_ID = 'd365fo-aot-search-v2';
/** The view id this page filters under; keeps v2 off the native tree's filter. */
const VIEW_ID = 'v2';

/**
 * The node kinds worth warming ahead of the user. Everything below `elemtype` is
 * either a single-file parse (XML sections, table members, enum values) or the
 * element list itself, which warming an `elemtype` already covers. A `model` row
 * is a leaf: the models listing is flat, the Classic view hangs off the version.
 */
const WARM_BRANCHES = new Set(['source', 'version', 'category', 'group', 'elemtype']);
const WARM_DEPTH = 5;
/** Only this extension's own commands may be run from a row click. */
const ROW_COMMAND_PREFIX = 'd365fo-aot.';

/** How often the warm reports progress. Fast enough to feel live, rare enough to be free. */
const WARM_POST_MS = 120;

/**
 * What the warm has covered. Deliberately just the type counts.
 *
 * This used to carry a version count too, and it was wrong twice over: the
 * roots include a *synthetic* version node for MS-Packages (a folder dressed as
 * a version so the toggle, caches and warm-up all work unchanged), and the UDE
 * scan returns every version folder including ones with no models, which the
 * tree then hides. The tally said 4 where the tree showed 2. The page counts
 * the version rows it actually rendered instead, so the two cannot disagree.
 */
interface WarmStat {
  /** Types found so far - the denominator grows as the crawl discovers them. */
  types: number;
  /** Types whose element list is now available (head first, full behind). */
  typesReady: number;
}

/** One row as the page draws it. */
interface TreeRow {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  collapsible: boolean;
  contextValue?: string;
  kind: string;
  /**
   * The command a click or Enter runs, or undefined for a row that only folds
   * (a source, a version, a category, a group, a type, an XML node).
   */
  command?: string;
  /** True when there is such a command, i.e. the row opens something. */
  open: boolean;
  fsPath?: string;
  node: AotNode;
}

/**
 * AOT Search v2: the same input, funnel and `@` filters as v1, with the whole
 * Application Explorer tree in place of the result list.
 *
 * The rows come from `AotTreeProvider.getTreeItem`, so the labels, icons,
 * descriptions and click behaviour are whatever the native tree says they are -
 * there is no second definition of the tree to drift. The provider also does the
 * caching, prefetching and background warm-up, so navigating this tree exercises
 * exactly the same machinery as the native view.
 *
 * Two things make it *behave* like the native view rather than just look like it:
 *
 *  - It listens to the provider's `onDidChangeTreeData`. That is how the async
 *    side lands: a version row that the model probe proves empty disappears, a
 *    version whose models arrive appears, and a streamed element list replaces
 *    the eager head it started with. A page that never listens shows the first
 *    snapshot forever, which is why the version list used to keep folders that
 *    are not versions.
 *  - It warms the whole tree in the background, so by the time a node is
 *    expanded its children are usually already cached and the expand is instant.
 */
export class AotSearchTreeViewProvider extends AotSearchViewProvider {
  private readonly icons: TreeAssets['icons'];
  private readonly listener: vscode.Disposable;
  /** Row ids with a children request in flight, so one refresh cannot pile up. */
  private readonly inFlight = new Set<string>();
  /** Row ids the user has open. Only these are re-sent on a background refresh. */
  private readonly open = new Set<string>();
  /** Branches owed another read because one was already in flight. */
  private readonly queued = new Set<string>();
  private warming = false;

  constructor(
    tree: AotTreeProvider,
    private readonly extensionUri: vscode.Uri,
  ) {
    super(tree, { viewId: VIEW_ID });
    this.icons = readIconMap(extensionUri);
    // The provider fires with the node instances it handed out; a fresh instance
    // for the same node is fine, because the page's row id is the provider's own
    // stable TreeItem id, so a fired node always maps back to the right row.
    this.listener = this.searchTree.onDidChangeTreeData((node) => {
      void this.onTreeDataChanged(node);
    });
  }

  dispose(): void {
    this.listener.dispose();
  }

  /** The two icon fonts ship as files, so the page may load them. */
  protected override resourceRoots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.extensionUri, 'resources')];
  }

  override resolveWebviewView(view: vscode.WebviewView): void {
    // The fonts are addressed per webview, and only once the view exists.
    this.pageAssets = {
      icons: this.icons,
      fonts: {
        'd365fo-icons': view.webview.asWebviewUri(
          vscode.Uri.joinPath(this.extensionUri, 'resources', 'd365fo-icons.woff'),
        ).toString(),
        codicon: view.webview.asWebviewUri(
          vscode.Uri.joinPath(this.extensionUri, 'resources', 'codicon.ttf'),
        ).toString(),
      },
    };
    super.resolveWebviewView(view);
    // A second listener: the base one owns ready/query/open, this one the tree.
    view.webview.onDidReceiveMessage((msg: unknown) => {
      void this.onTreeMessage(msg);
    });
  }

  private async onTreeMessage(msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null) {
      return;
    }
    const m = msg as { type?: unknown; id?: unknown; node?: unknown; command?: unknown };
    if (m.type === 'children') {
      const id = typeof m.id === 'string' ? m.id : '';
      if (id !== '') {
        // The page only asks for a node it is opening, or re-asks one it already
        // has open, so this request doubles as "the user has this open" - which
        // is what decides whether a later refresh is worth sending at all.
        this.open.add(id);
      }
      await this.sendChildren(id, m.node as AotNode | undefined);
      return;
    }
    if (m.type === 'collapse') {
      // Closed: stop shipping this branch's children on every background
      // refresh. They stay cached host-side, so re-opening is still instant.
      if (typeof m.id === 'string') {
        this.open.delete(m.id);
      }
      return;
    }
    if (m.type === 'activate') {
      await this.runRowCommand(m.command, m.node as AotNode | undefined);
      return;
    }
    if (m.type === 'roots') {
      await this.sendChildren('', undefined);
      // The page is up: start filling the caches behind the user's back.
      this.startWarm();
      return;
    }
    // Everything else - ready, query, open - is the base class's business.
  }

  /**
   * The provider changed something: re-send the children of the node it named,
   * or of the roots when it named nothing. A fired node this view never showed
   * (the native tree is looking at it) is simply ignored.
   */
  private async onTreeDataChanged(node: AotNode | undefined | void): Promise<void> {
    if (!this.view) {
      return; // nobody is looking; the next roots request gets the current state
    }
    if (node === undefined || node === null) {
      await this.sendChildren('', undefined);
      return;
    }
    const id = this.rowId(node);
    if (id === undefined || !this.open.has(id)) {
      return;
    }
    await this.sendChildren(id, node);
  }

  /**
   * Ask the provider for a node's children and send them as rows. The view id
   * is passed through so this page reads its own filter, never the shared one.
   */
  private async sendChildren(id: string, node: AotNode | undefined): Promise<void> {
    if (id !== '' && this.inFlight.has(id)) {
      // Never drop one: a background refresh for this branch may be in flight,
      // and silently discarding the user's own click is what made a foldout look
      // like it had hung. Remember that another read is owed, and run it when the
      // in-flight one lands.
      this.queued.add(id);
      return;
    }
    if (id !== '') {
      this.inFlight.add(id);
    }
    try {
      const children = await this.searchTree.getChildren(node, VIEW_ID);
      const rows = children.map((c) => this.toRow(c));
      // The roots come back under their own message, since the page holds them.
      await this.postToPage({ type: node === undefined ? 'roots' : 'children', id, rows });
    } catch {
      // A branch that will not build stays as it was; the native view behaves
      // the same way (a failed expand leaves the row, not a broken one).
    } finally {
      if (id !== '') {
        this.inFlight.delete(id);
        if (this.queued.delete(id)) {
          void this.sendChildren(id, node);
        }
      }
    }
  }

  /**
   * Warm every level in the background so an expand is a cache hit, and report
   * it while it happens.
   *
   * The provider's own prefetch is what makes the tree *feel* ready: visiting a
   * type hands back its eager head (`prefetchCount` rows, default 500) straight
   * away and streams the complete list in behind it. So the number that matters
   * to the user is "types with a list available / types found" - once that
   * reaches the total, every foldout opens instantly and the remaining work is
   * the full rebuild filling rows in, which the page already takes as it lands.
   *
   * Nothing here is capped or awaited by the page: the walk is fire-and-forget,
   * yields between nodes so the editor stays responsive, and the provider's
   * single-flighted caches mean a warm node costs one readdir no matter how often
   * it is visited.
   */
  private startWarm(): void {
    if (this.warming) {
      return;
    }
    this.warming = true;
    const stat: WarmStat = { types: 0, typesReady: 0 };
    let lastPost = 0;
    // Post at most every WARM_POST_MS, plus always the first and the last.
    const report = (ready = false, force = false): void => {
      const now = Date.now();
      if (!force && now - lastPost < WARM_POST_MS) {
        return;
      }
      lastPost = now;
      void this.postToPage({ type: 'warm', ...stat, ready });
    };
    void (async () => {
      try {
        const roots = await this.searchTree.getChildren(undefined, VIEW_ID);
        for (const root of roots) {
          // The roots are not uniform: MS-UDE is a source holding versions, but
          // MS-Packages is a synthetic *version* (one folder, no level to
          // descend), and Custom is a source of one entry per configured path.
          // Walking only sources would silently skip MS-Packages entirely.
          if (root.kind === 'source') {
            const versions = await this.searchTree.getChildren(root, VIEW_ID);
            report(false, true);
              for (const version of versions) {
                if (version.kind !== 'version') {
                  continue;
                }
                await this.warmLevel([version], 0, stat, report);
              }
          } else if (root.kind === 'version') {
            // MS-Packages: a synthetic version. Warm it, but it is not a version
            // the user can browse, so it must not be counted as one.
            await this.warmLevel([root], 0, stat, report);
          }
        }
      } catch {
        // Background best effort: a cold root simply means less is warm.
      } finally {
        this.warming = false;
        // Ready is a real answer, not a guess: the walk is done, so every type
        // it found has a list. Anything still building streams in behind.
        report(true, true);
      }
    })();
  }

  private async warmLevel(nodes: AotNode[], depth: number, stat: WarmStat, report: (ready?: boolean, force?: boolean) => void): Promise<void> {
    for (const node of nodes) {
      if (depth >= WARM_DEPTH) {
        continue;
      }
      if (node.kind === 'model') {
        report();
        continue; // the models listing is flat; a model row has no children
      }
      if (node.kind === 'elemtype') {
        // Asking for a type's children is what warms its element list (head
        // first), so this is the step the user is waiting on.
        stat.types++;
        await this.warmOne(node);
        stat.typesReady++;
        report();
        continue;
      }
      if (!WARM_BRANCHES.has(node.kind)) {
        continue;
      }
      let kids: AotNode[] = [];
      try {
        kids = await this.searchTree.getChildren(node, VIEW_ID);
      } catch {
        continue;
      }
      if (node.kind === 'version' || node.kind === 'category') {
        report();
      }
      await this.warmLevel(kids, depth + 1, stat, report);
      // Give the editor a turn between nodes - the walk is never urgent.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** Warm one node's children, counting the type even if the read fails. */
  private async warmOne(node: AotNode): Promise<void> {
    try {
      await this.searchTree.getChildren(node, VIEW_ID);
    } catch {
      // A type that will not build stays cold; its expand falls back to the
      // provider's own foreground path, exactly as the native view does.
    }
  }

  /** Everything the page draws for one node comes from getTreeItem. */
  private toRow(node: AotNode): TreeRow {
    const item = this.searchTree.getTreeItem(node);
    // A TreeItem label/description/tooltip may be a string, a label object or a MarkdownString.
    const label = textOf(item.label) ?? '';
    const iconPath = item.iconPath;
    return {
      // The provider's own stable id: the same one the native tree reconciles on,
      // which is what lets a refresh find this row again.
      id: item.id ?? `${node.kind}:${label}`,
      label,
      description: textOf(item.description),
      tooltip: textOf(item.tooltip),
      icon: iconPath instanceof vscode.ThemeIcon ? iconPath.id : undefined,
      collapsible: item.collapsibleState !== vscode.TreeItemCollapsibleState.None,
      contextValue: item.contextValue,
      kind: node.kind,
      // The command the NATIVE row runs on click, taken from the same
      // getTreeItem call that produced the label and the icon. Sending it (rather
      // than deciding in the page) is what keeps the two views honest: a Base Enum
      // opens its values grid, a query its metadata, a Fields section its grid -
      // because both views execute the identical command id.
      command: item.command?.command,
      open: !!item.command,
      fsPath: fsPathOf(node),
      node,
    };
  }

  /**
   * Run the command the row declared, with the node it declared it for.
   *
   * The page is not trusted with the command id: it is checked against this
   * extension's own prefix, so a page message can only ever reach a command this
   * extension contributed.
   */
  private async runRowCommand(command: unknown, node: AotNode | undefined): Promise<void> {
    if (typeof command !== 'string' || !command.startsWith(ROW_COMMAND_PREFIX)) {
      return;
    }
    if (!node) {
      return;
    }
    await vscode.commands.executeCommand(command, node);
  }

  /** The row id for a node the provider named in a refresh, if it has one. */
  private rowId(node: AotNode): string | undefined {
    return this.searchTree.getTreeItem(node).id;
  }
}

/** A TreeItem label/description/tooltip may be a string, a label object or a MarkdownString. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const labelled = value as { label?: unknown } | undefined;
  return typeof labelled?.label === 'string' ? labelled.label : undefined;
}

function fsPathOf(node: AotNode): string | undefined {
  const withPath = node as { fsPath?: unknown; parent?: { fsPath?: unknown }; element?: { fsPath?: unknown } };
  if (typeof withPath.fsPath === 'string') {
    return withPath.fsPath;
  }
  if (withPath.parent && typeof withPath.parent.fsPath === 'string') {
    return withPath.parent.fsPath;
  }
  if (withPath.element && typeof withPath.element.fsPath === 'string') {
    return withPath.element.fsPath;
  }
  return undefined;
}

/**
 * The generated icon map: icon id -> font + codepoint. A webview cannot use a
 * ThemeIcon or a product icon font, so the fonts ship as files and each icon id
 * is resolved through this map - which is what makes the tree look the same as
 * the native one. `approx` marks the one id with no exact Codicon.
 */
function readIconMap(extensionUri: vscode.Uri): TreeAssets['icons'] {
  try {
    const raw = fs.readFileSync(path.join(extensionUri.fsPath, 'resources', 'icon-map.json'), 'utf8');
    const doc = JSON.parse(raw.replace(/^\uFEFF/, '')) as { icons?: TreeAssets['icons'] };
    return doc.icons ?? {};
  } catch {
    // No map: rows fall back to a plain indent, the tree still works.
    return {};
  }
}
