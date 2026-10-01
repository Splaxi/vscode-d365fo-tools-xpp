import * as vscode from 'vscode';
import { AotNode, AotTreeProvider, METADATA_FOLDERS, QUERY_OVERVIEW_FOLDERS, SearchAbortedError, VIEW_FIELD_FOLDERS, descriptorUriFor, elementFileUriFor, revealUriFor } from './aotTree';
import { ENUM_VALUE_FOLDERS, TABLE_SECTION_FOLDERS } from './classic';
import type { DiscoveredVersion } from './discovery';
import { openEnumGrid } from './enumGrid';
import { openLabelGrid } from './labelGrid';
import { openMetadataGrid } from './metadataGrid';
import { openProperties } from './propertiesInspector';
import { AotSearchTreeViewProvider, AOT_SEARCH_TREE_VIEW_ID } from './searchView2';
import { openTableFieldsGrid, refreshFieldsGrid } from './tableFieldsGrid';
import { openTableIndexesGrid } from './tableIndexesGrid';
import { openTableRelationsGrid } from './tableRelationsGrid';
import { openViewFieldsGrid, refreshViewFieldsGrid } from './viewFieldsGrid';
import { XPP_SCHEME, XppPreviewProvider, openXppPreview } from './xppPreview';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AotTreeProvider(context.globalStorageUri.fsPath);
  const view = vscode.window.createTreeView('d365fo-aot-browser', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  // AOT Search v2: the same page shell as v1, but the whole Application Explorer
  // tree instead of a result list, driven by the same provider.
  //
  // v1 (the flat result list) is parked, not deleted: the code is still in
  // src/searchView.ts, which is also the base class v2 builds on. It is simply
  // not contributed and not registered, so it never loads, caches or indexes a
  // thing - two search pages indexing the same metadata fought each other for
  // I/O. To bring it back: re-add the `d365fo-aot-search` entry in
  // contributes.views and register `new AotSearchViewProvider(provider)` below.
  const searchTreeView = new AotSearchTreeViewProvider(provider, context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AOT_SEARCH_TREE_VIEW_ID, searchTreeView),
  );
  const xppPreview = new XppPreviewProvider();

  context.subscriptions.push(
    view,
    vscode.workspace.registerTextDocumentContentProvider(XPP_SCHEME, xppPreview),
    vscode.commands.registerCommand('d365fo-aot.refresh', (node?: AotNode) => {
      if (node) {
        provider.refreshNode(node);
      } else {
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('d365fo-aot.revealModelInExplorer', async (node?: AotNode) => {
      const uri = revealUriFor(node) ?? revealUriFor(view.selection?.[0] as AotNode | undefined);
      if (uri) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      } else {
        void vscode.window.showInformationMessage('Select a version or model in the AOT view first.');
      }
    }),
    vscode.commands.registerCommand('d365fo-aot.openSearch', async () => {
      await searchTreeView.show();
    }),
    vscode.commands.registerCommand('d365fo-aot.toggleView', async (node?: AotNode) => {
      const target = asVersionNode(node) ?? asVersionNode(view.selection?.[0]);
      if (!target) {
        void vscode.window.showInformationMessage('Expand a version first, then use the toggle on a version row.');
        return;
      }
      provider.toggleViewMode(target.version);
      provider.refreshView(target);
    }),
    vscode.commands.registerCommand('d365fo-aot.openElement', async (node?: AotNode, methodName?: string) => {
      const target =
        AotTreeProvider.elementNode(node) ?? AotTreeProvider.elementNode(view.selection?.[0]);
      if (target) {
        // Base Enums carry no X++ source — show their values grid instead.
        if (target.folders.some((f) => ENUM_VALUE_FOLDERS.has(f))) {
          await openEnumGrid(target.fsPath, target.label);
          return;
        }
        // Label Files are pointers to label text — show the labels grid instead.
        if (target.folders.some((f) => f === 'axlabelfile')) {
          await openLabelGrid(target.fsPath, target.label);
          return;
        }
        await openXppPreview(target.fsPath, target.label, typeof methodName === 'string' ? methodName : undefined);
        return;
      }
      // A method row selected (palette/keyboard path): open its element scrolled to the method.
      const method = asMethodMember(node) ?? asMethodMember(view.selection?.[0]);
      if (method) {
        await openXppPreview(method.fsPath, method.label, method.method);
        return;
      }
      // An enum value row selected: show the parent enum's grid.
      const enumValue = asEnumValue(node) ?? asEnumValue(view.selection?.[0]);
      if (enumValue) {
        await openEnumGrid(enumValue.fsPath, enumValue.label);
        return;
      }
      void vscode.window.showInformationMessage('Expand a version in Classic view and select an element to open its X++ source.');
    }),
    vscode.commands.registerCommand('d365fo-aot.openProperties', async (node?: AotNode) => {
      const target =
        AotTreeProvider.elementNode(node) ?? AotTreeProvider.elementNode(view.selection?.[0]);
      if (target) {
        await openProperties(target.fsPath, target.label);
        return;
      }
      void vscode.window.showInformationMessage('Expand a version and select an element to show its properties.');
    }),
    vscode.commands.registerCommand('d365fo-aot.openFieldsGrid', async (node?: AotNode) => {
      const section = asTableSection(node, 'Fields') ?? asTableSection(view.selection?.[0], 'Fields');
      if (section) {
        // Size column fills from the traversal memo when present, else stays blank.
        // The grid resolves travels + full traversal on demand (needs version + provider).
        const resolved = section.version
          ? provider.fieldPrimitivesFor(section.version, section.fsPath)
          : undefined;
        await openTableFieldsGrid(section.fsPath, section.label, resolved, section.version, provider);
        return;
      }
      void vscode.window.showInformationMessage('Expand a table and select its Fields section to show the grid.');
    }),
    vscode.commands.registerCommand('d365fo-aot.openViewFieldsGrid', async (node?: AotNode) => {
      const section = asViewFieldsSection(node) ?? asViewFieldsSection(view.selection?.[0]);
      if (section) {
        await openViewFieldsGrid(section.fsPath, section.label, section.version, provider);
        return;
      }
      void vscode.window.showInformationMessage(
        'Expand a view or data entity and select its Fields section to show the grid.',
      );
    }),
    vscode.commands.registerCommand('d365fo-aot.openRelationsGrid', async (node?: AotNode) => {
      const section = asTableSection(node, 'Relations') ?? asTableSection(view.selection?.[0], 'Relations');
      if (section) {
        await openTableRelationsGrid(section.fsPath, section.label);
        return;
      }
      void vscode.window.showInformationMessage('Expand a table and select its Relations section to show the grid.');
    }),
    vscode.commands.registerCommand('d365fo-aot.openIndexesGrid', async (node?: AotNode) => {
      const section = asTableSection(node, 'Indexes') ?? asTableSection(view.selection?.[0], 'Indexes');
      if (section) {
        await openTableIndexesGrid(section.fsPath, section.label);
        return;
      }
      void vscode.window.showInformationMessage('Expand a table and select its Indexes section to show the grid.');
    }),
    vscode.commands.registerCommand('d365fo-aot.openMetadataGrid', async (node?: AotNode) => {
      const section = asTableSection(node, 'Metadata') ?? asTableSection(view.selection?.[0], 'Metadata');
      if (section) {
        await openMetadataGrid(section.fsPath, section.label);
        return;
      }
      // A query carries the data sources at its document root, so selecting the
      // element itself is enough — same page, no Metadata child to hunt for.
      const query = asQueryElement(node) ?? asQueryElement(view.selection?.[0]);
      if (query) {
        await openMetadataGrid(query.fsPath, `${query.label} · Metadata`);
        return;
      }
      void vscode.window.showInformationMessage('Select a query, or a view\u2019s Metadata node, to show the grid.');
    }),
    vscode.commands.registerCommand('d365fo-aot.resolveFieldTypes', async (node?: AotNode) => {
      const table = asTableElement(node) ?? asTableElement(view.selection?.[0]);
      const viewFields = asViewFieldsSection(node) ?? asViewFieldsSection(view.selection?.[0]);
      if (!table && !viewFields) {
        void vscode.window.showInformationMessage(
          'Right-click a table, view or data entity (or anything under it) to resolve field types and labels.',
        );
        return;
      }
      const what = table?.label ?? viewFields?.label ?? '';
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Resolving types and labels for ${what}`,
          cancellable: true,
        },
        async (progress, token) => {
          const cancelled = (): boolean => token.isCancellationRequested;
          let reported = 0;
          const report = (done: number, total: number): void => {
            progress.report({ message: `${done}/${total} fields`, increment: done - reported });
            reported = done;
          };
          // The grid buttons and this context menu run the same two steps in the
          // same order, so either way round you end up with types and labels.
          try {
            if (table) {
              await provider.collectFieldPrimitives(table.version, table.fsPath, report, cancelled);
              await provider.collectTableLabels(table.version, table.fsPath, cancelled);
            } else if (viewFields) {
              await provider.resolveViewFieldTypes(viewFields.version, viewFields.fsPath, report, cancelled);
              await provider.collectViewLabels(viewFields.version, viewFields.fsPath, cancelled);
            }
          } catch (e) {
            // Cancel keeps partial results (already memoized); anything else rethrows.
            if (!(e instanceof SearchAbortedError)) {
              throw e;
            }
          } finally {
            // One reconcile by stable id — expansion state survives, icons land —
            // plus a silent backfill of an open Fields grid, if any.
            provider.refreshView(undefined);
            if (table) {
              await refreshFieldsGrid(
                table.fsPath,
                `${table.label} · Fields`,
                provider.fieldPrimitivesFor(table.version, table.fsPath),
                Object.fromEntries(await provider.collectTableLabels(table.version, table.fsPath)),
              );
            } else if (viewFields) {
              await refreshViewFieldsGrid(
                viewFields.fsPath,
                viewFields.label,
                viewFields.version,
                provider,
              );
            }
          }
        },
      );
    }),
    vscode.commands.registerCommand('d365fo-aot.openElementXml', async (node?: AotNode) => {
      const direct = elementFileUriFor(node) ?? elementFileUriFor(view.selection?.[0] as AotNode | undefined);
      if (direct) {
        // Pinned (not preview): opening raw XML must never clobber the X++
        // preview tab, so both can sit side by side and be dragged to splits.
        await vscode.window.showTextDocument(direct, { preview: false });
        return;
      }
      void vscode.window.showInformationMessage('Expand a version in Classic view and select an element to open its raw XML.');
    }),
    vscode.commands.registerCommand('d365fo-aot.openDescriptor', async (node?: AotNode) => {
      const direct = descriptorUriFor(node);
      if (direct) {
        // Preview tab, focus stays in the tree (same as the X++ preview).
        await vscode.window.showTextDocument(direct, { preview: true, preserveFocus: true });
        return;
      }
      const fromSelection = descriptorUriFor(view.selection?.[0] as AotNode | undefined);
      if (fromSelection) {
        await vscode.window.showTextDocument(fromSelection, { preview: true, preserveFocus: true });
        return;
      }
      void vscode.window.showInformationMessage('Expand a version and select a model to open its Descriptor XML.');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      for (const root of ['ude', 'packages', 'custom'] as const) {
        if (e.affectsConfiguration(`d365fo.aot.${root}.cache`)) {
          // Memory/TTL toggle: invalidate that root now and rebuild on schedule.
          void provider.refreshRootCache(root);
          return;
        }
      }
      if (e.affectsConfiguration('d365fo.aot') || e.affectsConfiguration('d365.aot.custom.rootPath')) {
        provider.refresh();
      }
    }),
  );
}

function asVersionNode(node: unknown) {
  return AotTreeProvider.versionNode(node);
}

/** A Methods-section member row → its element plus the method to reveal. */
function asMethodMember(node: unknown): { fsPath: string; label: string; method: string } | undefined {
  if (typeof node === 'object' && node !== null && (node as AotNode).kind === 'member') {
    const member = node as Extract<AotNode, { kind: 'member' }>;
    if (member.section === 'Methods') {
      return { fsPath: member.element.fsPath, label: member.element.label, method: member.label };
    }
  }
  return undefined;
}

/** An enum value row → its parent enum's file and label (opens the values grid). */
function asEnumValue(node: unknown): { fsPath: string; label: string } | undefined {
  if (typeof node === 'object' && node !== null && (node as AotNode).kind === 'enumvalue') {
    const value = node as Extract<AotNode, { kind: 'enumvalue' }>;
    return { fsPath: value.parent.fsPath, label: value.parent.label };
  }
  return undefined;
}

/** A query element node, from an argument or the current tree selection. */
function asQueryElement(node: unknown): { fsPath: string; label: string } | undefined {
  let element: { fsPath: string; label: string; folders: string[] } | undefined;
  if (typeof node === 'object' && node !== null) {
    const kind = (node as AotNode).kind;
    if (kind === 'element') {
      element = node as Extract<AotNode, { kind: 'element' }>;
    } else if (kind === 'xmlnode') {
      element = (node as Extract<AotNode, { kind: 'xmlnode' }>).element;
    } else if (kind === 'member') {
      element = (node as Extract<AotNode, { kind: 'member' }>).element;
    }
  }
  if (element && element.folders.some((f) => QUERY_OVERVIEW_FOLDERS.has(f.toLowerCase()))) {
    return { fsPath: element.fsPath, label: element.label };
  }
  return undefined;
}

/** A table element, or the owning table of any node under one (any depth). */
function asTableElement(node: unknown): { version: DiscoveredVersion; fsPath: string; label: string } | undefined {
  let element: { version: DiscoveredVersion; fsPath: string; label: string; folders: string[] } | undefined;
  if (typeof node === 'object' && node !== null) {
    const kind = (node as AotNode).kind;
    if (kind === 'element') {
      element = node as Extract<AotNode, { kind: 'element' }>;
    } else if (kind === 'tablesection') {
      element = (node as Extract<AotNode, { kind: 'tablesection' }>).parent;
    } else if (kind === 'member') {
      element = (node as Extract<AotNode, { kind: 'member' }>).element;
    } else if (kind === 'enumvalue') {
      element = (node as Extract<AotNode, { kind: 'enumvalue' }>).parent;
    } else if (kind === 'xmlnode') {
      element = (node as Extract<AotNode, { kind: 'xmlnode' }>).element;
    }
  }
  if (element && element.folders.some((f) => TABLE_SECTION_FOLDERS.has(f))) {
    return { version: element.version, fsPath: element.fsPath, label: element.label };
  }
  return undefined;
}

/** A table section row (Fields, Relations, ...) → the table file plus a grid title. */
function asTableSection(
  node: unknown,
  sectionId: string,
): { version?: DiscoveredVersion; fsPath: string; label: string } | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  const kind = (node as AotNode).kind;
  if (kind === 'tablesection') {
    const section = node as Extract<AotNode, { kind: 'tablesection' }>;
    if (
      section.section === sectionId &&
      section.parent.folders.some((f) => TABLE_SECTION_FOLDERS.has(f))
    ) {
      return { version: section.parent.version, fsPath: section.fsPath, label: `${section.parent.label} · ${section.label}` };
    }
    return undefined;
  }
  if (sectionId === 'Relations' || sectionId === 'Indexes') {
    // Relation/index branches and constraint/field rows open the same grid as the section.
    if (kind === 'xmlnode') {
      const branch = node as Extract<AotNode, { kind: 'xmlnode' }>;
      if (
        branch.outline === `tablechild:${sectionId}` &&
        branch.element.folders.some((f) => TABLE_SECTION_FOLDERS.has(f))
      ) {
        return { fsPath: branch.element.fsPath, label: `${branch.element.label} · ${sectionId}` };
      }
    }
    if (kind === 'member') {
      const member = node as Extract<AotNode, { kind: 'member' }>;
      if (
        (member.section === sectionId || member.gridSection === sectionId) &&
        member.element.folders.some((f) => TABLE_SECTION_FOLDERS.has(f))
      ) {
        return { fsPath: member.element.fsPath, label: `${member.element.label} · ${sectionId}` };
      }
    }
  }
  if (sectionId === 'Metadata') {
    // Metadata branches and their rows open the same grid as the Metadata node.
    if (kind === 'xmlnode') {
      const branch = node as Extract<AotNode, { kind: 'xmlnode' }>;
      if (
        branch.outline === 'metadata' &&
        branch.element.folders.some((f) => METADATA_FOLDERS.has(f))
      ) {
        return { fsPath: branch.element.fsPath, label: `${branch.element.label} · Metadata` };
      }
    }
    if (kind === 'member') {
      const member = node as Extract<AotNode, { kind: 'member' }>;
      if (
        member.gridSection === 'Metadata' &&
        member.element.folders.some((f) => METADATA_FOLDERS.has(f))
      ) {
        return { fsPath: member.element.fsPath, label: `${member.element.label} · Metadata` };
      }
    }
  }
  return undefined;
}

/**
 * A view / data entity Fields section row → the element file plus a grid title.
 * View fields bind to a data source instead of declaring a type, so they get
 * their own grid and need the version for the cross-element resolution.
 */
function asViewFieldsSection(
  node: unknown,
): { version: DiscoveredVersion; fsPath: string; label: string } | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  if ((node as AotNode).kind !== 'tablesection') {
    return undefined;
  }
  const section = node as Extract<AotNode, { kind: 'tablesection' }>;
  if (
    section.section === 'Fields' &&
    section.parent.folders.some((f) => VIEW_FIELD_FOLDERS.has(f))
  ) {
    return {
      version: section.parent.version,
      fsPath: section.fsPath,
      label: `${section.parent.label} · ${section.label}`,
    };
  }
  return undefined;
}

export function deactivate(): void {
  // Nothing to dispose beyond subscriptions.
}
