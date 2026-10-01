import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import {
  CLASSIC_CATEGORIES,
  ClassicTypeDef,
  elementLabel,
  ENTITY_SECTIONS,
  ENUM_VALUE_FOLDERS,
  isExtensionFolder,
  isGroup,
  KNOWN_AX_FOLDERS,
  MAP_SECTIONS,
  TABLE_SECTION_FOLDERS,
  TABLE_SECTIONS,
  TableSectionDef,
  VIEW_SECTIONS,
} from './classic';
import { childElements, tagOf, type DomElement } from './xpp/walker';
import { readEnumValues } from './enumGrid';
import {
  labelSurvives,
  nodeSurvives,
  typeLabelsUnder,
  type ElementFilterState,
} from './searchFilter';
import { DiscoveredModel, DiscoveredVersion, discoverModels, discoverVersions, expandPath, hasAnyModel, resolveRootPath } from './discovery';

export type VersionSource = 'ude' | 'packages' | 'custom';
type VersionNode = { kind: 'version'; version: DiscoveredVersion; source: VersionSource };
type ModelNode = { kind: 'model'; version: DiscoveredVersion; source: VersionSource; model: DiscoveredModel };
type CategoryNode = { kind: 'category'; version: DiscoveredVersion; source: VersionSource; catId: string; label: string; icon: string };
type GroupNode = { kind: 'group'; version: DiscoveredVersion; source: VersionSource; catId: string; label: string; icon: string };
type ElemTypeNode = {
  kind: 'elemtype';
  version: DiscoveredVersion;
  source: VersionSource;
  catId: string;
  group?: string;
  label: string;
  icon: string;
  folders: string[];
  modelPrefix?: string;
};
type ElementNode = {
  kind: 'element';
  version: DiscoveredVersion;
  source: VersionSource;
  catId: string;
  group?: string;
  /** Undefined for elements listed directly under a category (reports, labels, ...). */
  typeLabel?: string;
  typeIcon?: string;
  folders: string[];
  modelPrefix?: string;
  label: string;
  fsPath: string;
  icon: string;
  description?: string;
};
type EnumValueNode = {
  kind: 'enumvalue';
  /** Owning element instance (adopted by VS Code — returned verbatim by getParent). */
  parent: ElementNode;
  label: string;
  value?: string;
  fsPath: string;
};
type TableSectionNode = {
  kind: 'tablesection';
  /** Owning element instance (adopted by VS Code — returned verbatim by getParent). */
  parent: ElementNode;
  section: string;
  label: string;
  icon: string;
  fsPath: string;
  /** Child count at parse time (drives the twistie; re-parsed on every expand). */
  count: number;
};
type TableMemberNode = {
  kind: 'member';
  /** Owning section instance (adopted by VS Code — returned verbatim by getParent). */
  sectionNode: TableSectionNode;
  /** Owning element (for preview commands + refresh). */
  element: ElementNode;
  section: string;
  label: string;
  icon: string;
  fsPath: string;
  /**
   * Grid section this member opens on click (relation constraints live under
   * a synthetic branch section, so the lineage is carried explicitly).
   * Currently only 'Relations'.
   */
  gridSection?: string;
};
/**
 * Branch of a live-parsed element outline (queries, forms, reports, nested
 * menu items, second-level table children). Parsed live from the element XML
 * on every expand — only what the file directly contains, no cross-references.
 */
type XmlNode = {
  kind: 'xmlnode';
  /** Owning element instance. */
  element: ElementNode;
  /** Adopted parent (element, section or xmlnode) — returned verbatim by getParent. */
  parent: ElementNode | TableSectionNode | XmlNode;
  /** Which outline builder produced this branch. */
  outline: string;
  /** Slash-joined kid indices from the outline root. */
  path: string;
  label: string;
  /** Dim row suffix carried from the outline branch. */
  description?: string;
  icon: string;
  fsPath: string;
  /** Resolved at creation (drives the twistie). */
  expandable: boolean;
};
/**
 * One branch of a live-parsed element outline. Branches nest (data sources,
 * designs, controls, ...); leaves are member-name lists.
 */
interface OutlineKid {
  label: string;
  icon: string;
  /** Dim row suffix (data source table, fetch mode, ...). */
  description?: string;
  /** Leaf members listed directly under this branch. */
  members?: string[];
  /** Icon for leaf members (defaults to the branch icon). */
  memberIcon?: string;
  /** Section id carried by leaf members (drives X++ preview for Methods). */
  memberSection?: string;
  /** Sub-branches. */
  kids?: OutlineKid[];
}
export type AotNode = SourceNode | VersionNode | ModelNode | CategoryNode | GroupNode | ElemTypeNode | ElementNode | EnumValueNode | TableSectionNode | TableMemberNode | XmlNode;

export type ViewMode = 'models' | 'classic';

/** Top-level roots. MS-Packages is itself version-shaped (see getChildren). */
export type SourceId = 'ude' | 'custom';
type SourceNode = { kind: 'source'; sourceId: SourceId; label: string; icon: string; fsPath?: string };

interface ClassicIndex {
  at: number;
  /** lowercase Ax folder name → locations holding it */
  folders: Map<string, Array<{ model: DiscoveredModel; dir: string }>>;
  /** lowercase dir path → *.xml file names inside (cached listings) */
  files: Map<string, string[]>;
}

/** Cached element list bound to the classic index that produced it. */
interface ScopeList {
  indexAt: number;
  nodes: ElementNode[];
}

/** One prefetchable/full-loadable element scope (a type or a direct folder set). */
interface ScopeRef {
  key: string;
  version: DiscoveredVersion;
  source: VersionSource;
  catId: string;
  group?: string;
  typeLabel?: string;
  typeIcon?: string;
  folders: string[];
  modelPrefix?: string;
}

/** Prefetch job description (key materialized via scopeRef at runtime). */
interface PrefetchDef {
  catId: string;
  scope: string;
  /** Display label (type label, or direct folder label). */
  label: string;
  group?: string;
  typeLabel?: string;
  typeIcon: string;
  folders: string[];
  modelPrefix?: string;
}

/** One searchable element: name only, never file content. */
export interface SearchEntry {
  label: string;
  labelLower: string;
  model: string;
  typeLabel: string;
  versionName: string;
  fsPath: string;
}

/** Thrown when the user cancels a search index build. */
export class SearchAbortedError extends Error {
  constructor() {
    super('Search aborted');
    this.name = 'SearchAbortedError';
  }
}

/**
 * File-backed version index (`<storage>/aot-index/<hash>.json`).
 * Structural only (names/paths) — file *content* edits can never stale it;
 * add/remove/rename bumps a recorded dir mtime and fails validation.
 */
interface FileVersionIndex {
  format: 1;
  fsPath: string;
  builtAt: number;
  models: DiscoveredModel[];
  folders: Record<string, Array<{ model: string; dir: string }>>;
  files: Record<string, string[]>;
  sig: Array<{ p: string; m: number }>;
}

/** How deep below a model folder Ax* folders are searched (covers `XppMetadata/<pkg>/Ax*`). */
const CLASSIC_AX_SEARCH_DEPTH = 3;
/** Model-level folders that never contain Ax* metadata — not descended into. */
const CLASSIC_SKIP_DIRS = new Set(['descriptor', 'bin', 'reports', 'resources', 'webcontent']);

/**
 * Element folders with VS-style static sections (same machinery as tables).
 * Lowercase Ax folder names.
 */
const VIEW_SECTION_FOLDERS = new Set(['axview', 'axviewextension']);
const ENTITY_SECTION_FOLDERS = new Set([
  'axdataentityview',
  'axdataentityviewextension',
  'axcompositedataentityview',
  'axaggregatedataentity',
]);
const MAP_SECTION_FOLDERS = new Set(['axmap', 'axmapextension']);
/**
 * Element folders whose `Fields` section binds each field to a data source
 * rather than declaring a type, and therefore gets the view Fields grid.
 * Exported for the command wiring in extension.ts.
 */
export const VIEW_FIELD_FOLDERS = new Set([...VIEW_SECTION_FOLDERS, ...ENTITY_SECTION_FOLDERS]);
/**
 * Element folders whose elements carry a `ViewMetadata` backing query,
 * surfaced as a Metadata node (DataSources + Methods). Views and data
 * entity views, verified live; the node appears only when the metadata
 * actually holds content.
 */
export const METADATA_FOLDERS = new Set([
  'axview',
  'axviewextension',
  'axdataentityview',
  'axdataentityviewextension',
]);
/**
 * Element folders whose elements *are* a backing query, so selecting one shows
 * the data source overview directly instead of a Metadata child. The tree shape
 * is unchanged — the outline still expands under the chevron.
 */
export const QUERY_OVERVIEW_FOLDERS = new Set(['axquery', 'axquerysimpleextension']);
/** Element folders rendered as live-parsed outline trees (queries/forms/reports). */
const TREE_FOLDERS = new Set(['axquery', 'axquerysimpleextension', 'axform', 'axformextension', 'axreport', 'axreportextension']);
/**
 * Element folders rendered as generic named-collection sections (menus,
 * security, services, classes, EDTs, workflows, ...). Anything else stays a
 * leaf (tiles, menu items, labels, resources, KPIs, ...).
 */
const GENERIC_FOLDERS = new Set([
  'axmenu', 'axmenuextension',
  'axsecurityrole', 'axsecurityroleextension',
  'axsecurityduty', 'axsecuritydutyextension',
  'axsecurityprivilege', 'axsecurityprivilegeextension',
  'axsecuritypolicy', 'axsecuritypolicyextension',
  'axservice', 'axserviceextension', 'axservicegroup', 'axservicegroupextension',
  'axclass', 'axclassextension',
  'axedt', 'axedtextension',
  'axmacrodictionary',
  'axworkflowcategory', 'axworkflowapproval', 'axworkflowapprovalextension',
  'axworkflowtask', 'axworkflowtaskextension', 'axworkflowautomatedtask',
  'axworkflowtemplate', 'axworkflowtemplateextension',
  'axworkflowduedatecalculationprovider', 'axworkflowhierarchyassignmentprovider',
  'axworkflowparticipantassignmentprovider', 'axworkflowqueueassignmentprovider',
  'axaggregatedimension', 'axaggregatemeasurement',
  'axaggregatecalculatedmeasuretemplate', 'axaggregatecalculatedmeasuretemplateotherperiod',
]);
/** Workflow approvals/tasks carry outcomes as direct named tags (no container). */
const WORKFLOW_OUTCOME_FOLDERS = new Set(['axworkflowapproval', 'axworkflowapprovalextension']);
/** Every folder whose elements expand (sections, outlines or generic). */
const FOLDOUT_FOLDERS = new Set([
  ...WORKFLOW_OUTCOME_FOLDERS,
  ...TABLE_SECTION_FOLDERS,
  ...VIEW_SECTION_FOLDERS,
  ...ENTITY_SECTION_FOLDERS,
  ...MAP_SECTION_FOLDERS,
  ...TREE_FOLDERS,
  ...GENERIC_FOLDERS,
]);
/** Static section tables by element folder (views/entities/maps). */
function sectionDefsFor(folders: string[]): TableSectionDef[] | undefined {
  const primary = (folders[0] ?? '').toLowerCase();
  if (VIEW_SECTION_FOLDERS.has(primary)) {
    return VIEW_SECTIONS;
  }
  if (ENTITY_SECTION_FOLDERS.has(primary)) {
    return ENTITY_SECTIONS;
  }
  if (MAP_SECTION_FOLDERS.has(primary)) {
    return MAP_SECTIONS;
  }
  return undefined;
}
/** Fallback section icons for generic (tag-driven) sections.
 * All neutral Codicons on purpose: VS Code auto-colors `symbol-*` ids with
 * language-symbol hues, which would break the monochrome tree. */
const GENERIC_SECTION_ICONS: Record<string, string> = {
  Fields: 'd365fo-fields',
  Methods: 'd365fo-methods',
  DataSources: 'database',
  Designs: 'window-compact',
  Controls: 'window',
  Parts: 'puzzle',
  Elements: 'folder-library',
  Duties: 'd365fo-sec-duty',
  Privileges: 'd365fo-sec-priv',
  SubRoles: 'd365fo-sec-role',
  DirectAccessPermissions: 'lock',
  EntryPoints: 'key',
  DataEntityPermissions: 'lock',
  ServiceOperations: 'zap',
  Services: 'server',
  Outcomes: 'git-branch',
  WorkflowOutcomes: 'git-branch',
  Attributes: 'info',
  Hierarchies: 'type-hierarchy-sub',
  ArrayElements: 'list-ordered',
  DataSets: 'database',
  DataMethods: 'd365fo-methods',
  EmbeddedImages: 'file-media-compact',
  Parameters: 'bracket',
  Tables: 'd365fo-table',
  Keys: 'key',
  Ranges: 'filter',
  Mappings: 'd365fo-maps',
  Relations: 'references',
  Indexes: 'key',
  Constraints: 'link',
  States: 'circle-outline',
  Transitions: 'arrow-right',
  Macros: 'd365fo-macros',
  MeasureGroups: 'package',
};
/** Table sections with a grid overview: section id → [command, title]. */
const SECTION_GRID_COMMANDS: Record<string, [command: string, title: string]> = {
  Fields: ['d365fo-aot.openFieldsGrid', 'Show Table Fields Grid'],
  Relations: ['d365fo-aot.openRelationsGrid', 'Show Table Relations Grid'],
  Indexes: ['d365fo-aot.openIndexesGrid', 'Show Table Indexes Grid'],
  Metadata: ['d365fo-aot.openMetadataGrid', 'Show Metadata'],
};
/**
 * Grid for a section, chosen by the element kind. Views and data entities get
 * their own Fields grid because their fields bind to a data source instead of
 * declaring a type; every other section shares the table grid.
 */
function sectionGridCommand(
  section: string,
  folders: string[],
): [command: string, title: string] | undefined {
  if (section === 'Fields' && folders.some((f) => VIEW_FIELD_FOLDERS.has(f))) {
    return ['d365fo-aot.openViewFieldsGrid', 'Show View Fields Grid'];
  }
  return SECTION_GRID_COMMANDS[section];
}

/**
 * Whether a section of this element kind has a grid at all. Views and data
 * entities only get the Fields grid; their other sections stay tree-only.
 */
function sectionHasGrid(section: string, folders: string[]): boolean {
  if (folders.some((f) => TABLE_SECTION_FOLDERS.has(f))) {
    return true;
  }
  return section === 'Fields' && folders.some((f) => VIEW_FIELD_FOLDERS.has(f));
}
/** Field primitive families from EDT resolution. */
export type FieldPrimitive = 'String' | 'Int' | 'Int64' | 'Real' | 'Date' | 'UtcDateTime' | 'Time' | 'Enum';
/** Resolved field type: primitive (null = unresolvable) plus optional size. */
export interface FieldResolution {
  prim: FieldPrimitive | null;
  size?: string;
  /** Nearest-wins label id of the type, for translation by Resolve. */
  label?: string;
}
/** One EDT hop in a field's type travel. */
export interface FieldTravelHop {
  edt: string;
  iType?: string;
  size?: string;
  label?: string;
  model?: string;
  /** Last hop: terminal EDT or kernel object with no file. */
  terminal?: boolean;
  /** No metadata file (kernel object like `str` / `Money`). */
  kernel?: boolean;
}
/** One enum option in a field's type travel (top 10; see `enumTruncated`). */
export interface FieldTravelEnumValue {
  name: string;
  label?: string;
  value?: string;
}
/** Full type travel for one table field: EDT chain plus terminal enum options. */
export interface FieldTravel {
  field: string;
  edt: string;
  hops: FieldTravelHop[];
  enumName?: string;
  enumValues?: FieldTravelEnumValue[];
  enumTotal?: number;
  enumTruncated?: boolean;
}
/**
 * Why a view field's binding could not be followed to a table column. Every
 * value is a real, observable shape in the corpus — the grid shows `N/A` for
 * these rather than a blank cell that reads like "not looked at".
 */
export type ViewFieldGap = 'no-metadata' | 'no-column' | 'no-binding' | 'no-type';
/** One view/entity field as its own file declares it. */
export interface ViewFieldRef {
  name: string;
  /** Data source alias the field binds to, and the column within it. */
  dataSource?: string;
  dataField?: string;
  /** `i:type`, which on an unmapped field carries the primitive. */
  iType?: string;
  prim?: FieldPrimitive;
  /** Computed / unmapped fields declare their own type inline. */
  edt?: string;
  /** The inline type as the file spells it, for display. */
  edtLabel?: string;
  enum?: string;
  size?: string;
  /** The field's own label id, when it declares one. */
  label?: string;
}
/** One view field's binding resolved through to a type, plus its EDT travel. */
export interface ViewFieldTravel {
  field: string;
  dataSource?: string;
  dataField?: string;
  /** The field declared its own type (computed / unmapped). */
  selfTyped?: boolean;
  /** Table the data source points at, and the column resolved inside it. */
  table?: string;
  /** Set when the binding could not be followed. */
  gap?: ViewFieldGap;
  /** Intermediate `table.column` the chain passed through, when it had to. */
  via?: string;
  /** Type the chain starts from, before the EDT walk (lower-cased for lookup). */
  startEdt?: string;
  startEnum?: string;
  /** The same type as the file spells it, for display. */
  typeLabel?: string;
  /** Label id of the resolved type, translated by Resolve. */
  typeLabelId?: string;
  prim?: FieldPrimitive;
  size?: string;
  hops: FieldTravelHop[];
  enumName?: string;
  enumValues?: FieldTravelEnumValue[];
  enumTotal?: number;
  enumTruncated?: boolean;
}
/** How far a view field's binding chain is followed through nested views. */
const MAX_BINDING_DEPTH = 4;

/** Language Resolve translates labels into when the setting says nothing. */
const DEFAULT_RESOLVE_LANGUAGE = 'en-US';
export { DEFAULT_RESOLVE_LANGUAGE };

/** Primitive → tree glyph (first-letter alpha boxes). */
const PRIMITIVE_GLYPHS: Record<FieldPrimitive, string> = {
  String: 'd365fo-type-string',
  Int: 'd365fo-type-int',
  Int64: 'd365fo-type-int',
  Real: 'd365fo-type-real',
  Date: 'd365fo-type-date',
  UtcDateTime: 'd365fo-type-utcdatetime',
  Time: 'd365fo-type-time',
  Enum: 'd365fo-type-enum',
};
/**
 * Field element `i:type` discriminator → primitive. Every AxTableField
 * carries its storage class directly, so most fields resolve with zero EDT
 * reads. Lowercase full tag.
 */
const FIELD_TYPE_PRIMITIVES: Record<string, FieldPrimitive> = {
  axtablefieldstring: 'String',
  axtablefieldint: 'Int',
  axtablefieldint64: 'Int64',
  axtablefieldreal: 'Real',
  axtablefielddate: 'Date',
  axtablefieldutcdatetime: 'UtcDateTime',
  axtablefieldtime: 'Time',
  axtablefieldenum: 'Enum',
};
/**
 * Storage-class discriminator (`i:type`) → primitive, for field elements
 * (`AxTableFieldString`, …) and EDT elements (`AxEdtString`, …) alike.
 * Lowercase full tag. Unknown tags resolve to nothing (default glyph).
 */
const TYPE_TAG_PRIMITIVES: Record<string, FieldPrimitive> = {
  axtablefieldstring: 'String',
  axedtstring: 'String',
  axtablefieldint: 'Int',
  axedtint: 'Int',
  axtablefieldint64: 'Int64',
  axedtint64: 'Int64',
  axtablefieldreal: 'Real',
  axedtreal: 'Real',
  axtablefielddate: 'Date',
  axedtdate: 'Date',
  axtablefieldutcdatetime: 'UtcDateTime',
  axedtutcdatetime: 'UtcDateTime',
  axtablefieldtime: 'Time',
  axedttime: 'Time',
  axtablefieldenum: 'Enum',
  axedtenum: 'Enum',
};
/**
 * Kernel/system EDT names (no metadata file) → primitive. Lowercase.
 * Curated once from the census; the resolver only translates the last mile
 * after reading `i:type` — no guessing, unknown names stay untyped.
 */
const SYSTEM_EDT_PRIMITIVES: Record<string, FieldPrimitive> = {
  str: 'String',
  int: 'Int',
  int64: 'Int64',
  real: 'Real',
  date: 'Date',
  utcdatetime: 'UtcDateTime',
  time: 'Time',
  enum: 'Enum',
  recid: 'Int64',
  money: 'Real',
  moneymst: 'Real',
  integer: 'Int',
  transdate: 'Date',
  noyesid: 'Enum',
  tableid: 'Int',
  fieldid: 'Int',
  sysgroup: 'String',
  itemid: 'String',
  itemidsmall: 'String',
  segmentedentryfield: 'String',
  selectabledataarea: 'String',
  dataareaid: 'String',
  userid: 'String',
  projid: 'String',
  invoiceid: 'String',
  vendaccount: 'String',
  tablename: 'String',
  ecorescolorname: 'String',
  ecoressizename: 'String',
  ecoresstylename: 'String',
  projcategoryid: 'String',
  taxgroup: 'String',
  fieldname: 'String',
  taxitemgroup: 'String',
  bankaccountid: 'String',
  addresszipcodeid: 'String',
  addressstateid: 'String',
  inventtransid: 'String',
  postingprofile: 'String',
  identifiername: 'String',
  wmslocationid: 'String',
  paymmode: 'String',
  classname: 'String',
  paymtermid: 'String',
  projinvoiceprojid: 'String',
  projlinepropertyid: 'String',
  inventtransrefid: 'String',
  taxcode: 'String',
  salesid: 'String',
  unitofmeasuresymbol: 'String',
  ecoresversionname: 'String',
  realbase: 'Real',
  currencyexchangerate: 'Real',
  pdscwinventqty: 'Real',
  salesqty: 'Real',
  priceunit: 'Real',
  salesprice: 'Real',
  hrmcompamountcur: 'Real',
  validfromdate: 'Date',
  validtodate: 'Date',
  hcmdate: 'Date',
  validfromdatetime: 'UtcDateTime',
  validtodatetime: 'UtcDateTime',
  timeofday: 'Time',
  jmgseconds: 'Int',
  whsinventstatusid: 'Int',
};
/** Member display name: `<Name>`, with fallbacks for reference-style items
 * and `DataField` (field-group fields like ExtensionList carry no `<Name>`). */
const MEMBER_NAME_TAGS = ['Name', 'MenuItemName', 'Table', 'Field', 'Service', 'DataField'];

/** First non-empty direct-child text among the member-name tags. */
function memberNameOf(node: DomElement): string | undefined {
  for (const tag of MEMBER_NAME_TAGS) {
    const text = childElements(node).find((c) => tagOf(c) === tag)?.textContent?.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

/** First non-empty direct-child text for one tag. */
function elementText(node: DomElement, tag: string): string | undefined {
  const text = childElements(node).find((c) => tagOf(c) === tag)?.textContent?.trim();
  return text ? text : undefined;
}

/** Named direct element-children (skips leaf values like `<SaveDataPerCompany>No`). */
function namedKids(node: DomElement): string[] {
  const out: string[] = [];
  for (const child of childElements(node)) {
    if (childElements(child).length === 0) {
      continue;
    }
    const name = memberNameOf(child);
    if (name) {
      out.push(name);
    }
  }
  return out;
}

/**
 * Named children, descending one level into unnamed containers (state lists,
 * submenu wrappers, ...). Returns the element alongside its name.
 */
function namedKidsDeep(node: DomElement): Array<{ name: string; el: DomElement }> {
  const out: Array<{ name: string; el: DomElement }> = [];
  for (const child of childElements(node)) {
    if (childElements(child).length === 0) {
      continue;
    }
    const name = memberNameOf(child);
    if (name) {
      out.push({ name, el: child });
      continue;
    }
    for (const grand of childElements(child)) {
      if (childElements(grand).length === 0) {
        continue;
      }
      const gname = memberNameOf(grand);
      if (gname) {
        out.push({ name: gname, el: grand });
      }
    }
  }
  return out;
}

/** `SourceCode/Methods/Method/Name` anywhere below (classes, tables, forms, ...). */
function collectMethods(root: DomElement): string[] {
  const sourceCode = childElements(root).find((c) => tagOf(c) === 'SourceCode');
  const out: string[] = [];
  if (!sourceCode) {
    return out;
  }
  const walk = (node: DomElement): void => {
    if (tagOf(node) === 'Method') {
      const name = elementText(node, 'Name');
      if (name) {
        out.push(name);
      }
      return;
    }
    for (const child of childElements(node)) {
      walk(child);
    }
  };
  walk(sourceCode);
  return out;
}

/** Parse an element XML file; undefined when unreadable. */
async function parseElementXml(fsPath: string): Promise<DomElement | undefined> {
  let xml: string;
  try {
    xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
  try {
    const document = new DOMParser().parseFromString(xml, 'text/xml') as unknown as {
      documentElement?: DomElement | null;
    };
    return document.documentElement ?? undefined;
  } catch {
    return undefined;
  }
}

/** Second-level children of a table-family member (constraints/fields/states/index fields). */
function tableChildKid(section: string, memberEl: DomElement): OutlineKid {
  if (section === 'Relations') {
    const constraints = childElements(memberEl).find((c) => tagOf(c) === 'Constraints');
    const members = constraints ? namedKids(constraints) : [];
    return { label: '', icon: 'references', members, memberIcon: 'link' };
  }
  if (section === 'Indexes') {
    const fields = childElements(memberEl).find((c) => tagOf(c) === 'Fields');
    const members = fields ? namedKids(fields) : [];
    return { label: '', icon: 'd365fo-indexes', members, memberIcon: 'd365fo-fields' };
  }
  if (section === 'FieldGroups') {
    const fields = childElements(memberEl).find((c) => tagOf(c) === 'Fields');
    const members = fields ? namedKids(fields) : [];
    return { label: '', icon: 'list-tree', members, memberIcon: 'd365fo-fields' };
  }
  // StateMachines → states → transitions (tag-agnostic, shape-driven).
  const kids: OutlineKid[] = namedKidsDeep(memberEl).map((s) => ({
    label: s.name,
    icon: 'circle-outline',
    members: namedKidsDeep(s.el).map((t) => t.name),
    memberIcon: 'arrow-right',
  }));
  return { label: '', icon: 'd365fo-state-machines', kids };
}

/**
 * One query/view data source branch.
 *
 * The label is the data source `Name` — the alias every other reference in the
 * same file uses (relations, group by, order by, view fields). `Table` differs
 * from it in a fifth of all data sources, so it rides along as the dim row
 * description instead of displacing the name.
 *
 * `Relations` is listed with the other sections: the joins are the reason a
 * view's metadata is read at all, and they were previously invisible.
 */
function querySourceKid(ds: DomElement): OutlineKid {
  const table = elementText(ds, 'Table');
  const label = elementText(ds, 'Name') ?? table ?? 'Data Source';
  const notes: string[] = [];
  const fetchMode = elementText(ds, 'FetchMode');
  if (fetchMode) {
    notes.push(fetchMode);
  }
  if (table && table !== label) {
    notes.push(table);
  }
  const kids: OutlineKid[] = [];
  const secs: Array<[string, string, string, string | undefined]> = [
    ['Fields', 'Fields', 'd365fo-fields', undefined],
    ['Ranges', 'Ranges', 'filter', undefined],
    ['Relations', 'Relations', 'references', 'link'],
    ['GroupBy', 'Group By', 'list-tree', undefined],
    ['Having', 'Having', 'filter', undefined],
    ['OrderBy', 'Order By', 'arrow-swap', undefined],
  ];
  for (const [tag, title, icon, memberIcon] of secs) {
    const container = childElements(ds).find((c) => tagOf(c) === tag);
    const members = container ? namedKids(container) : [];
    if (members.length > 0) {
      kids.push({ label: title, icon, members, memberIcon });
    }
  }
  for (const nest of ['DataSources', 'DerivedDataSources']) {
    const container = childElements(ds).find((c) => tagOf(c) === nest);
    if (container) {
      for (const sub of childElements(container)) {
        if (childElements(sub).length === 0) {
          continue;
        }
        kids.push(querySourceKid(sub));
      }
    }
  }
  return { label, icon: 'database', description: notes.length > 0 ? notes.join(' · ') : undefined, kids };
}

function queryOutline(root: DomElement): OutlineKid[] {
  const kids: OutlineKid[] = [];
  const dsRoot = childElements(root).find((c) => tagOf(c) === 'DataSources');
  if (dsRoot) {
    for (const ds of childElements(dsRoot)) {
      if (childElements(ds).length === 0) {
        continue;
      }
      kids.push(querySourceKid(ds));
    }
  }
  const methods = collectMethods(root);
  if (methods.length > 0) {
    kids.push({ label: 'Methods', icon: 'd365fo-methods', members: methods, memberSection: 'Methods' });
  }
  return kids;
}

function formSourceKid(ds: DomElement): OutlineKid {
  const label = elementText(ds, 'Table') ?? 'Data Source';
  const kids: OutlineKid[] = [];
  const fieldsEl = childElements(ds).find((c) => tagOf(c) === 'Fields');
  const fields = fieldsEl ? namedKids(fieldsEl) : [];
  if (fields.length > 0) {
    kids.push({ label: 'Fields', icon: 'd365fo-fields', members: fields });
  }
  for (const nest of ['ReferencedDataSources', 'DerivedDataSources', 'DataSources']) {
    const container = childElements(ds).find((c) => tagOf(c) === nest);
    if (container) {
      for (const sub of childElements(container)) {
        if (childElements(sub).length === 0) {
          continue;
        }
        kids.push(formSourceKid(sub));
      }
    }
  }
  return { label, icon: 'database', kids };
}

function controlKid(control: DomElement): OutlineKid {
  const label = memberNameOf(control) ?? elementText(control, 'Type') ?? 'Control';
  const type = elementText(control, 'Type') ?? '';
  const kids: OutlineKid[] = [];
  const controls = childElements(control).find((c) => tagOf(c) === 'Controls');
  if (controls) {
    for (const sub of childElements(controls)) {
      if (childElements(sub).length === 0) {
        continue;
      }
      kids.push(controlKid(sub));
    }
  }
  return { label, icon: CONTROL_TYPE_ICONS[type] ?? 'window', kids };
}

/** Form control `<Type>` → icon (unmapped types keep the generic glyph). */
const CONTROL_TYPE_ICONS: Record<string, string> = {
  Grid: 'd365fo-grid',
  Group: 'd365fo-group',
  ActionPane: 'd365fo-action-pane',
};

function formOutline(root: DomElement): OutlineKid[] {
  const kids: OutlineKid[] = [];
  const dsRoot = childElements(root).find((c) => tagOf(c) === 'DataSources');
  if (dsRoot) {
    const sources: OutlineKid[] = [];
    for (const ds of childElements(dsRoot)) {
      if (childElements(ds).length === 0) {
        continue;
      }
      sources.push(formSourceKid(ds));
    }
    if (sources.length > 0) {
      kids.push({ label: 'Data Sources', icon: 'database', kids: sources });
    }
  }
  const design = childElements(root).find((c) => tagOf(c) === 'Design' || tagOf(c) === 'Designs');
  if (design) {
    const controlsEl =
      tagOf(design) === 'Designs' ? design : childElements(design).find((c) => tagOf(c) === 'Controls');
    const controls: OutlineKid[] = [];
    if (controlsEl) {
      const items = tagOf(design) === 'Designs' ? childElements(design) : childElements(controlsEl);
      for (const sub of items) {
        if (childElements(sub).length === 0) {
          continue;
        }
        controls.push(controlKid(sub));
      }
    }
    kids.push({
      label: 'Designs',
      icon: 'window-compact',
      kids: [{ label: 'Design', icon: 'd365fo-design', kids: controls }],
    });
  }
  const parts = childElements(root).find((c) => tagOf(c) === 'Parts');
  const partMembers = parts ? namedKids(parts) : [];
  if (partMembers.length > 0) {
    kids.push({ label: 'Parts', icon: 'puzzle', members: partMembers });
  }
  const methods = collectMethods(root);
  if (methods.length > 0) {
    kids.push({ label: 'Methods', icon: 'd365fo-methods', members: methods, memberSection: 'Methods' });
  }
  return kids;
}

function reportOutline(root: DomElement): OutlineKid[] {
  const kids: OutlineKid[] = [];
  const setsRoot = childElements(root).find((c) => tagOf(c) === 'DataSets');
  if (setsRoot) {
    const sets: OutlineKid[] = [];
    for (const ds of childElements(setsRoot)) {
      if (childElements(ds).length === 0) {
        continue;
      }
      const label = memberNameOf(ds) ?? 'Data Set';
      const sub: OutlineKid[] = [];
      const fields = childElements(ds).find((c) => tagOf(c) === 'Fields');
      const fieldNames = fields ? namedKids(fields) : [];
      if (fieldNames.length > 0) {
        sub.push({ label: 'Fields', icon: 'd365fo-fields', members: fieldNames });
      }
      const params = childElements(ds).find((c) => tagOf(c) === 'Parameters');
      const paramNames = params ? namedKids(params) : [];
      if (paramNames.length > 0) {
        sub.push({ label: 'Parameters', icon: 'bracket', members: paramNames });
      }
      sets.push({ label, icon: 'database', kids: sub });
    }
    if (sets.length > 0) {
      kids.push({ label: 'Data Sets', icon: 'database', kids: sets });
    }
  }
  const designs = childElements(root).find((c) => tagOf(c) === 'Designs');
  const designNames = designs ? namedKids(designs) : [];
  if (designNames.length > 0) {
    kids.push({ label: 'Designs', icon: 'window-compact', members: designNames });
  }
  const dataMethods = childElements(root).find((c) => tagOf(c) === 'DataMethods');
  const dataMethodNames = dataMethods ? namedKids(dataMethods) : [];
  if (dataMethodNames.length > 0) {
    kids.push({
      label: 'Data Methods',
      icon: 'd365fo-methods',
      members: dataMethodNames,
      memberSection: 'Methods',
    });
  }
  const images = childElements(root).find((c) => tagOf(c) === 'EmbeddedImages');
  const imageNames = images ? namedKids(images) : [];
  if (imageNames.length > 0) {
    kids.push({ label: 'Embedded Images', icon: 'file-media-compact', members: imageNames });
  }
  const paramGroup = childElements(root).find((c) => tagOf(c) === 'DefaultParameterGroup');
  const paramNames = paramGroup ? namedKidsDeep(paramGroup).map((p) => p.name) : [];
  if (paramNames.length > 0) {
    kids.push({ label: 'Parameters', icon: 'bracket', members: paramNames });
  }
  const methods = collectMethods(root);
  if (methods.length > 0) {
    kids.push({ label: 'Methods', icon: 'd365fo-methods', members: methods, memberSection: 'Methods' });
  }
  return kids;
}

/** Outline roots for the tree elements (queries/forms/reports). */
function buildOutline(outline: string, root: DomElement): OutlineKid[] {
  if (outline === 'query') {
    return queryOutline(root);
  }
  if (outline === 'form') {
    return formOutline(root);
  }
  if (outline === 'report') {
    return reportOutline(root);
  }
  return [];
}
function menuItemKids(container: DomElement): OutlineKid[] {
  const kids: OutlineKid[] = [];
  for (const child of childElements(container)) {
    if (childElements(child).length === 0) {
      continue;
    }
    const name = memberNameOf(child);
    if (!name) {
      continue;
    }
    const nested = childElements(child).find((c) => tagOf(c) === 'Elements');
    kids.push({
      label: name,
      icon: 'folder-library',
      kids: nested ? menuItemKids(nested) : [],
    });
  }
  return kids;
}

/**
 * Outline roots over a view/entity `ViewMetadata` backing query: the data
 * sources (same shape as query outlines) plus its methods. Empty when the
 * element carries no view metadata content — the Metadata node only renders
 * when this is non-empty.
 */
function metadataOutline(root: DomElement): OutlineKid[] {
  const vm = childElements(root).find((c) => tagOf(c) === 'ViewMetadata');
  if (!vm) {
    return [];
  }
  const out: OutlineKid[] = [];
  const dsRoot = childElements(vm).find((c) => tagOf(c) === 'DataSources');
  if (dsRoot) {
    const sources: OutlineKid[] = [];
    for (const ds of childElements(dsRoot)) {
      if (childElements(ds).length === 0) {
        continue;
      }
      sources.push(querySourceKid(ds));
    }
    if (sources.length > 0) {
      out.push({ label: 'DataSources', icon: 'database', kids: sources });
    }
  }
  const methods = collectMethods(vm);
  if (methods.length > 0) {
    out.push({ label: 'Methods', icon: 'd365fo-methods', members: methods, memberIcon: 'd365fo-method' });
  }
  return out;
}

/**
 * Walk an outline to slash-joined index path. Empty path returns a virtual
 * root over the outline roots (lets enumeration and lookup share one order).
 */
function walkOutline(outline: string, root: DomElement, path: number[]): OutlineKid | undefined {
  let kids: OutlineKid[] | undefined;
  if (outline === 'query' || outline === 'form' || outline === 'report') {
    kids = buildOutline(outline, root);
  } else if (outline === 'menuitem') {
    const elements = childElements(root).find((c) => tagOf(c) === 'Elements');
    kids = elements ? menuItemKids(elements) : [];
  } else if (outline === 'metadata') {
    kids = metadataOutline(root);
  } else if (outline.startsWith('tablechild:')) {
    const section = outline.slice('tablechild:'.length);
    const sectionEl = childElements(root).find((c) => tagOf(c) === section);
    kids = [];
    if (sectionEl) {
      for (const child of childElements(sectionEl)) {
        if (childElements(child).length === 0) {
          continue;
        }
        const name = memberNameOf(child);
        if (!name) {
          continue;
        }
        const sub = tableChildKid(section, child);
        kids.push({ label: name, icon: '', members: sub.members, memberIcon: sub.memberIcon, kids: sub.kids });
      }
    }
  } else {
    return undefined;
  }
  let current: OutlineKid = { label: '', icon: '', kids };
  for (const i of path) {
    const next = current.kids?.[i];
    if (!next) {
      return undefined;
    }
    current = next;
  }
  return current;
}

export class AotTreeProvider implements vscode.TreeDataProvider<AotNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<AotNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private versionsCache: DiscoveredVersion[] | undefined;
  private modelsCache = new Map<string, { at: number; models: DiscoveredModel[] }>();
  /** Version keys with ≥1 model proven by the exit-early probe (display hint). */
  private probedVersions = new Set<string>();
  /** Version keys whose in-RAM index differs from the disk file (skip redundant rewrites). */
  private indexDirty = new Set<string>();
  /** Single in-flight UDE background pass (probes + full scans). */
  private udeInFlight: Promise<void> | undefined;
  /** Visible UDE rows last handed to VS Code (sorted keys; change detection). */
  private udeRenderSig = '';
  /**
   * Root node instances last handed to VS Code. Refresh events MUST reuse
   * these adopted instances — VS Code matches refresh targets by identity
   * and silently drops freshly constructed lookalikes.
   */
  private adoptedRoots: AotNode[] = [];
  private classicCache = new Map<string, ClassicIndex>();
  private viewModes = new Map<string, ViewMode>();
  /** scopeKey → prefetched head (first N elements, N = `prefetchCount`). */
  private headCache = new Map<string, ScopeList>();
  /** scopeKey → complete element list. */
  private fullCache = new Map<string, ScopeList>();
  /** scopeKeys with a background full-list build in flight. */
  private pendingFull = new Set<string>();
  /** search keys with a background full-version index build in flight. */
  private pendingSearch = new Set<string>();
  /** search scope key → name-only entries (never file content). */
  private searchCache = new Map<string, { at: number; entries: SearchEntry[] }>();
  /**
   * The search page's filter, applied in getChildren for category/group/elemtype
   * rows (branches that cannot match are hidden, not greyed) and to element
   * names. Survives a refresh on purpose: filtering should not cost the user
   * their expansion state.
   */
  private elementFilter: ElementFilterState | undefined;
  /** Per-view filters, for a view that must not touch the shared one. */
  private viewFilters = new Map<string, ElementFilterState>();
  /**
   * Lowercase dir → in-flight listing promise. Concurrent expand + prefetch
   * must share ONE readdir per folder instead of queueing duplicates behind
   * the (small) libuv file pool.
   */
  private pendingFiles = new Map<string, Promise<string[]>>();
  /** version key → in-flight classic index build (expand racing prefetch). */
  private pendingClassic = new Map<string, { token: object; promise: Promise<ClassicIndex> }>();
  /** versionKey → edtLower → resolution. Session memo. */
  private edtPrimitiveCache = new Map<string, Map<string, FieldResolution>>();
  /** `${versionKey}|${tablePathLower}` → fieldLabelLower → resolution. */
  private fieldPrimitiveCache = new Map<string, Map<string, FieldResolution>>();
  /** `${versionKey}|${tablePathLower}|${fieldLower}` → type travel. Session memo. */
  private travelCache = new Map<string, FieldTravel>();
  /** `${viewPathLower}` → fieldLabelLower → the field as its own file declares it. */
  private viewRefCache = new Map<string, Promise<Map<string, ViewFieldRef>>>();
  /** `${viewPathLower}` → dataSourceAliasLower → backing table name. */
  private viewDataSourceCache = new Map<string, Promise<Map<string, string>>>();
  /** `${versionKey}|${viewPathLower}` → fieldLabelLower → resolved chain. */
  private viewFieldCache = new Map<string, Map<string, ViewFieldTravel>>();
  /** `${versionKey}|${viewPathLower}|${fieldLower}` → chain with EDT travel. */
  private viewTravelCache = new Map<string, ViewFieldTravel>();
  /** `${versionKey}|${language}` → label text file name → full path. */
  private labelIndexCache = new Map<string, Map<string, string>>();
  /** label text file path (lowercased) → `Id=Value` map. */
  private labelEntriesCache = new Map<string, Map<string, string>>();
  /** Kernel enum name (lowercased) → values, from resources/kernel-enums.json. */
  private kernelEnumCache: Map<string, FieldTravelEnumValue[]> | undefined;
  /** `${versionKey}|${tableLower}|${columnLower}` → the column's own declaration. */
  private columnRefCache = new Map<
    string,
    | {
        edt?: string;
        edtLabel?: string;
        enum?: string;
        size?: string;
        label?: string;
        prim?: FieldPrimitive;
        ownerFile?: string;
        dataSource?: string;
        dataField?: string;
      }
    | undefined
  >();
  /**
   * Serializes background version warmups (index + prefetch) so opening a
   * second version never contends with the first one's storm. Foreground
   * user expands always run immediately with their own (single-flighted) I/O.
   */
  private warmup = Promise.resolve();
  /** Yield to the event loop so tree rendering stays responsive during scans. */
  private static tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }
  /** Max foreground wait for a cold scope build before it streams in behind. */
  private static readonly FULL_BUILD_GRACE_MS = 300;
  /** Resolves after ms (bounds foreground waits). */
  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Session caches: everything below is valid until a manual Refresh (or host
   * restart) — no time expiry. Structural staleness is handled by explicit
   * invalidation (see refreshNode), never by TTL.
   */
  constructor(private readonly storageDir?: string) {}

  // ---- file-backed version index (MS-UDE + MS-Packages; Custom stays RAM-only) ----

  private indexDir(): string | undefined {
    return this.storageDir ? path.join(this.storageDir, 'aot-index') : undefined;
  }

  private indexFileFor(fsPath: string): string | undefined {
    const dir = this.indexDir();
    if (!dir) {
      return undefined;
    }
    return path.join(dir, `${Buffer.from(fsPath.toLowerCase()).toString('base64url')}.json`);
  }

  /** Structural signature: version root + model dirs + Ax dirs (dir mtimes catch add/remove/rename; content edits never affect the tree structure). */
  private async indexSig(version: DiscoveredVersion, models: DiscoveredModel[], index: ClassicIndex): Promise<Array<{ p: string; m: number }>> {
    const dirs = new Set<string>([version.fsPath]);
    for (const m of models) {
      dirs.add(m.fsPath);
    }
    for (const locs of index.folders.values()) {
      for (const l of locs) {
        dirs.add(l.dir);
      }
    }
    const list = [...dirs];
    const out: Array<{ p: string; m: number }> = [];
    for (let i = 0; i < list.length; i += 64) {
      const rows = await Promise.all(
        list.slice(i, i + 64).map(async (dir) => {
          try {
            return { p: dir, m: (await fs.stat(dir)).mtimeMs };
          } catch {
            return { p: dir, m: -1 };
          }
        }),
      );
      out.push(...rows);
    }
    out.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
    return out;
  }

  private async writeVersionFile(version: DiscoveredVersion): Promise<void> {
    const file = this.indexFileFor(version.fsPath);
    const key = version.fsPath.toLowerCase();
    const modelsEntry = this.modelsCache.get(key);
    const index = this.classicCache.get(key);
    if (!file || !modelsEntry || !index) {
      return;
    }
    try {
      const folders: Record<string, Array<{ model: string; dir: string }>> = {};
      for (const [ax, locs] of index.folders) {
        folders[ax] = locs.map((l) => ({ model: l.model.name, dir: l.dir }));
      }
      const files: Record<string, string[]> = {};
      for (const [dir, names] of index.files) {
        files[dir] = names;
      }
      const doc: FileVersionIndex = {
        format: 1,
        fsPath: version.fsPath,
        builtAt: Date.now(),
        models: modelsEntry.models,
        folders,
        files,
        sig: await this.indexSig(version, modelsEntry.models, index),
      };
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Atomic-ish: torn writes never masquerade as a valid index.
      await fs.writeFile(`${file}.tmp`, JSON.stringify(doc));
      await fs.rename(`${file}.tmp`, file);
      this.indexDirty.delete(key);
    } catch {
      // The file is an optimization; a failed write just means rebuild next time.
      try {
        await fs.rm(file, { force: true });
        await fs.rm(`${file}.tmp`, { force: true });
      } catch {
        // Ignore.
      }
    }
  }

  private async readVersionFile(fsPath: string): Promise<FileVersionIndex | undefined> {
    const file = this.indexFileFor(fsPath);
    if (!file) {
      return undefined;
    }
    try {
      const doc = JSON.parse(await fs.readFile(file, 'utf8')) as FileVersionIndex;
      if (!doc || doc.format !== 1 || doc.fsPath.toLowerCase() !== fsPath.toLowerCase()) {
        return undefined;
      }
      // Validate: every recorded dir must still stat with the same mtime.
      const check = await Promise.all(
        doc.sig.map(async (s) => {
          try {
            return (await fs.stat(s.p)).mtimeMs === s.m;
          } catch {
            return s.m === -1;
          }
        }),
      );
      if (!check.every(Boolean)) {
        await fs.rm(file, { force: true });
        return undefined;
      }
      return doc;
    } catch {
      try {
        await fs.rm(file, { force: true });
      } catch {
        // Ignore.
      }
      return undefined;
    }
  }

  private async deleteVersionFile(fsPath: string): Promise<void> {
    this.indexDirty.delete(fsPath.toLowerCase());
    const file = this.indexFileFor(fsPath);
    if (!file) {
      return;
    }
    try {
      await fs.rm(file, { force: true });
    } catch {
      // Ignore.
    }
  }

  refresh(): void {
    this.versionsCache = undefined;
    this.modelsCache.clear();
    this.probedVersions.clear();
    this.udeInFlight = undefined;
    this.udeRenderSig = '';
    this.classicCache.clear();
    this.headCache.clear();
    this.fullCache.clear();
    this.searchCache.clear();
    this.edtPrimitiveCache.clear();
    this.fieldPrimitiveCache.clear();
    this.travelCache.clear();
    this.pendingFull.clear();
    this.pendingSearch.clear();
    this.pendingClassic.clear();
    this.indexDirty.clear();
    this.clearAllRootTimers();
    void this.clearIndexDir();
    this.onDidChangeTreeDataEmitter.fire();
  }

  private async clearIndexDir(): Promise<void> {
    const dir = this.indexDir();
    if (!dir) {
      return;
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Best effort; stale files fail validation on next load anyway.
    }
  }

  /** Drop all RAM state for one version (files go separately). */
  private clearVersionData(version: DiscoveredVersion): void {
    const key = version.fsPath.toLowerCase();
    this.modelsCache.delete(key);
    this.classicCache.delete(key);
    this.pendingClassic.delete(key);
    this.probedVersions.delete(key);
    this.edtPrimitiveCache.delete(key);
    for (const cache of [this.headCache, this.fullCache, this.searchCache, this.fieldPrimitiveCache, this.travelCache] as const) {
      for (const k of [...cache.keys()]) {
        if (k.startsWith(`${key}|`)) {
          cache.delete(k);
        }
      }
    }
    for (const k of [...this.pendingFull]) {
      if (k.startsWith(`${key}|`)) {
        this.pendingFull.delete(k);
      }
    }
    for (const k of [...this.pendingSearch]) {
      if (k.startsWith(`${key}|`)) {
        this.pendingSearch.delete(k);
      }
    }
  }

  /**
   * Granular refresh (all instance-adopted fires, so nothing is ever dropped):
   * - MS-UDE node → every UDE version is invalidated (RAM + file) and rebuilt.
   * - version node → that version only (RAM + file), rebuilt in background.
   * - category/group node → its types only (scope caches + listings), file
   *   rewritten, type rebuilt behind the spinner.
   * - elemtype node → that type only, same treatment.
   * - element node → its parent type (no adopted parent instance exists, so
   *   the whole tree reconciles by stable id instead).
   * - model node → its version (model rows carry no children of their own).
   */
  refreshNode(node: AotNode | undefined): void {
    if (!node) {
      this.refresh();
      return;
    }
    if (node.kind === 'source') {
      if (node.sourceId === 'ude') {
        void this.refreshUdeSource(node);
      } else {
        for (const entry of this.getCustomEntries()) {
          this.clearVersionData(entry.version);
        }
        this.onDidChangeTreeDataEmitter.fire(node);
      }
      this.scheduleRootWake(node.sourceId);
      return;
    }
    if (node.kind === 'version') {
      this.clearVersionData(node.version);
      void this.deleteVersionFile(node.version.fsPath);
      this.warmup = this.warmup.then(() => this.rebuildVersion(node).catch(() => undefined));
      void this.warmup;
      this.scheduleRootWake(node.source);
      this.onDidChangeTreeDataEmitter.fire(node);
      return;
    }
    if (node.kind === 'model') {
      this.clearVersionData(node.version);
      void this.deleteVersionFile(node.version.fsPath);
      const versionNode: VersionNode = { kind: 'version', version: node.version, source: node.source };
      this.warmup = this.warmup.then(() => this.rebuildVersion(versionNode).catch(() => undefined));
      void this.warmup;
      this.scheduleRootWake(node.source);
      this.onDidChangeTreeDataEmitter.fire(node);
      return;
    }
    if (node.kind === 'category' || node.kind === 'group') {
      void this.rebuildCategory(node).catch(() => undefined);
      this.scheduleRootWake(node.source);
      this.onDidChangeTreeDataEmitter.fire(node);
      return;
    }
    if (node.kind === 'elemtype') {
      void this.rebuildType(node).catch(() => undefined);
      this.scheduleRootWake(node.source);
      this.onDidChangeTreeDataEmitter.fire(node);
      return;
    }
    if (node.kind === 'tablesection') {
      // Nothing cached for sections (parsed live) — just repaint the adopted node.
      this.scheduleRootWake(node.parent.source);
      this.onDidChangeTreeDataEmitter.fire(node);
      return;
    }
    if (node.kind === 'member' || node.kind === 'xmlnode') {
      // Members and outline branches parse live (nothing cached) — repaint
      // whole tree by stable id.
      this.scheduleRootWake(node.element.source);
      this.onDidChangeTreeDataEmitter.fire();
      return;
    }
    // Element: no adopted parent instance exists — rebuild the parent scope,
    // then reconcile the whole tree by stable id.
    const target = node.kind === 'enumvalue' ? node.parent : node;
    const parent = this.parentOfElement(target);
    if (parent?.kind === 'elemtype') {
      void this.rebuildType(parent).catch(() => undefined);
    } else if (parent) {
      void this.rebuildCategory(parent).catch(() => undefined);
    }
    this.scheduleRootWake(target.source);
    this.onDidChangeTreeDataEmitter.fire();
  }

  /** MS-UDE refresh: all versions invalidated (RAM + files), then rebuilt. */
  private async refreshUdeSource(node: SourceNode): Promise<void> {
    const versions = await this.getUdeVersions();
    this.versionsCache = undefined;
    this.probedVersions.clear();
    for (const v of versions) {
      this.clearVersionData(v);
      await this.deleteVersionFile(v.fsPath);
    }
    this.onDidChangeTreeDataEmitter.fire(node);
    const fresh = await this.getUdeVersions();
    this.startUdeBackground(fresh);
    this.scheduleRootWake('ude');
  }

  /** Full version rebuild (models + index + heads + search index + file). */
  private async rebuildVersion(node: VersionNode): Promise<void> {
    await this.getModels(node.version);
    await this.getClassicIndex(node.version);
    await this.warmVersion(node);
    this.refreshView(node);
  }

  /** Rebuild every type scope under a category/group node. */
  private async rebuildCategory(node: CategoryNode | GroupNode): Promise<void> {
    const cat = CLASSIC_CATEGORIES.find((c) => c.id === node.catId);
    if (!cat) {
      return;
    }
    const defs: Array<{ scope: string; folders: string[]; modelPrefix?: string }> = [];
    if (node.kind === 'group') {
      for (const t of cat.types) {
        if (isGroup(t) && t.group === node.label) {
          for (const d of t.types) {
            defs.push({
              scope: `${t.group}~${d.label}`,
              folders: d.folders.map((f) => f.toLowerCase()),
              modelPrefix: d.modelPrefix,
            });
          }
        }
      }
    } else {
      for (const t of cat.types) {
        if (isGroup(t)) {
          for (const d of t.types) {
            defs.push({
              scope: `${t.group}~${d.label}`,
              folders: d.folders.map((f) => f.toLowerCase()),
              modelPrefix: d.modelPrefix,
            });
          }
        } else {
          defs.push({
            scope: `~${t.label}`,
            folders: t.folders.map((f) => f.toLowerCase()),
            modelPrefix: t.modelPrefix,
          });
        }
      }
      for (const d of cat.direct ?? []) {
        defs.push({
          scope: `direct:${d.label}`,
          folders: d.folders.map((f) => f.toLowerCase()),
          modelPrefix: d.modelPrefix,
        });
      }
    }
    const index = await this.getClassicIndex(node.version);
    for (const d of defs) {
      await this.rebuildTypeScope(node.version, node.catId, d.scope, d.folders, d.modelPrefix, index);
    }
    await this.writeVersionFile(node.version);
    this.refreshView(node);
  }

  /** Rebuild one element-type scope: purge, re-list, rewrite file, repaint. */
  private async rebuildType(node: ElemTypeNode): Promise<void> {
    const index = await this.getClassicIndex(node.version);
    const scope = `${node.group ?? ''}~${node.label}`;
    await this.rebuildTypeScope(node.version, node.catId, scope, node.folders, node.modelPrefix, index);
    await this.writeVersionFile(node.version);
    this.refreshView(node);
  }

  private parentOfElement(element: ElementNode): ElemTypeNode | CategoryNode | undefined {
    if (element.typeLabel) {
      return {
        kind: 'elemtype',
        version: element.version,
        source: element.source,
        catId: element.catId,
        group: element.group,
        label: element.typeLabel,
        icon: element.typeIcon ?? 'file',
        folders: element.folders,
        modelPrefix: element.modelPrefix,
      };
    }
    const cat = CLASSIC_CATEGORIES.find((c) => c.id === element.catId);
    if (!cat) {
      return undefined;
    }
    return {
      kind: 'category',
      version: element.version,
      source: element.source,
      catId: cat.id,
      label: cat.label,
      icon: cat.icon,
    };
  }

  private async rebuildTypeScope(
    version: DiscoveredVersion,
    catId: string,
    scope: string,
    folders: string[],
    modelPrefix: string | undefined,
    index: ClassicIndex,
  ): Promise<void> {
    const key = AotTreeProvider.scopeKey(version, catId, scope, folders, modelPrefix);
    for (const cache of [this.headCache, this.fullCache, this.searchCache] as const) {
      cache.delete(key);
    }
    this.pendingFull.delete(key);
    // Drop this scope's listings so the re-list below re-reads the disk...
    const locs = this.scopeLocs(index, folders, modelPrefix);
    for (const l of locs) {
      index.files.delete(l.dir.toLowerCase());
    }
    this.indexDirty.add(version.fsPath.toLowerCase());
    // ...then re-warm them (single-flighted, yielded, shared with expands).
    await this.countTypeFiles(index, folders, modelPrefix);
  }

  /** Re-render a node without dropping caches (view-only switches like the toggle). */
  refreshView(node: AotNode | undefined): void {
    this.onDidChangeTreeDataEmitter.fire(node);
  }

  /**
   * Apply the search page's filter to the children of one structural row.
   * Group and type rows are kept when they can still hold a match; element rows
   * are kept when their name contains the filter text.
   */
  private filtered(
    node: CategoryNode | GroupNode | ElemTypeNode,
    kids: AotNode[],
    viewId?: string,
  ): AotNode[] {
    const state = this.filterFor(viewId);
    if (!state) {
      return kids;
    }
    return kids.filter((k) => {
      if (k.kind === 'group') {
        return nodeSurvives(state, typeLabelsUnder(k.catId, k.label));
      }
      if (k.kind === 'elemtype') {
        return nodeSurvives(state, [k.label.toLowerCase()]);
      }
      if (k.kind === 'element') {
        return labelSurvives(state, k.label.toLowerCase());
      }
      return true;
    });
  }

  /**
   * The filter the search page drives the tree with, or undefined when the tree
   * shows everything. This is the *shared* filter: the AOT Search page sets it
   * and the native tree prunes with it, which is what the two views have always
   * done. A view that must not touch the native tree (AOT Search v2) registers
   * its own with `setViewFilter` instead.
   */
  setElementFilter(state: ElementFilterState | undefined): void {
    this.elementFilter = state;
  }

  /**
   * A filter that applies only to one view's own rendering. `getChildren` takes
   * the view id, so the native tree and the v2 tree can be filtered differently
   * at the same time; caches stay unfiltered, so this costs nothing per read.
   */
  setViewFilter(viewId: string, state: ElementFilterState | undefined): void {
    if (state === undefined) {
      this.viewFilters.delete(viewId);
    } else {
      this.viewFilters.set(viewId, state);
    }
  }

  /** The filter in force for a view: its own, else the shared one. */
  private filterFor(viewId?: string): ElementFilterState | undefined {
    return (viewId ? this.viewFilters.get(viewId) : undefined) ?? this.elementFilter;
  }

  /**
   * Versions the search page indexes: every version the tree currently shows,
   * once each. Two roots can reach the same folder (UDE plus a Custom or
   * Packages path pointing at it), and the tree lists it under both, so dedupe
   * on the path — otherwise every element would be indexed twice over.
   */
  async searchableVersions(): Promise<DiscoveredVersion[]> {
    const roots = await this.getChildren(undefined);
    const out: DiscoveredVersion[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      if (root.kind !== 'source') {
        continue;
      }
      for (const kid of await this.getChildren(root)) {
        if (kid.kind !== 'version') {
          continue;
        }
        const key = kid.version.fsPath.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(kid.version);
        }
      }
    }
    return out;
  }

  /** Per-root cache policy. Memory gates the big materialized lists
   * (heads/full/search entries); structural maps stay session-resident. */
  private cacheConfig(source: VersionSource): { memory: boolean; ttlMs: number } {
    const config = vscode.workspace.getConfiguration('d365fo.aot');
    const memory = config.get<boolean>(`${source}.cache.memory`, true);
    const ttlMinutes = Math.max(0, config.get<number>(`${source}.cache.ttlMinutes`, 60) ?? 60);
    return { memory: memory ?? true, ttlMs: ttlMinutes * 60_000 };
  }

  private memOn(source: VersionSource): boolean {
    return this.cacheConfig(source).memory;
  }

  /** Minutes before TTL expiry when the background rebuild wakes (spec). */
  private static readonly REFRESH_AHEAD_MINUTES = 5;

  /** One refresh-ahead timer per root; cleared on manual refresh/toggle. */
  private rootTimers = new Map<VersionSource, NodeJS.Timeout>();

  private rootVersions(root: VersionSource): DiscoveredVersion[] | Promise<DiscoveredVersion[]> {
    if (root === 'ude') {
      return this.getUdeVersions();
    }
    if (root === 'packages') {
      return [this.packagesVersion().version];
    }
    return this.getCustomEntries().map((e) => e.version);
  }

  private scheduleRootWake(root: VersionSource, delayOverrideMs?: number): void {
    this.clearRootTimer(root);
    const { ttlMs } = this.cacheConfig(root);
    if (ttlMs <= 0) {
      return; // Manual refresh only.
    }
    const delay =
      delayOverrideMs ?? Math.max(60_000, ttlMs - AotTreeProvider.REFRESH_AHEAD_MINUTES * 60_000);
    this.rootTimers.set(
      root,
      setTimeout(() => {
        void this.onRootWake(root);
      }, delay),
    );
  }

  private clearRootTimer(root: VersionSource): void {
    const timer = this.rootTimers.get(root);
    if (timer) {
      clearTimeout(timer);
      this.rootTimers.delete(root);
    }
  }

  private clearAllRootTimers(): void {
    for (const root of [...this.rootTimers.keys()]) {
      this.clearRootTimer(root);
    }
  }

  /** Ensure a wake-up is scheduled (no-op when one already is). */
  private ensureRootScheduled(root: VersionSource): void {
    if (!this.rootTimers.has(root)) {
      this.scheduleRootWake(root);
    }
  }

  /**
   * Timer wake: rebuild every version of the root in the background, then
   * reschedule. Old caches keep serving until each rebuild publishes, so the
   * swap is atomic from the user's perspective. Memory-off roots are evicted
   * back down after the file is fresh.
   */
  private async onRootWake(root: VersionSource): Promise<void> {
    this.rootTimers.delete(root);
    try {
      const versions = await this.rootVersions(root);
      for (const version of versions) {
        await this.getModels(version);
        await this.getClassicIndex(version);
        await this.warmVersion({ kind: 'version', version, source: root });
        if (!this.memOn(root)) {
          this.clearVersionData(version);
        }
        await AotTreeProvider.tick();
      }
    } finally {
      this.scheduleRootWake(root);
    }
  }

  /**
   * Settings toggle / manual root refresh: invalidate the root (RAM + files),
   * rebuild now on the warmup queue, reschedule the timer.
   */
  public async refreshRootCache(root: VersionSource): Promise<void> {
    this.clearRootTimer(root);
    const versions = await this.rootVersions(root);
    if (root === 'ude') {
      this.versionsCache = undefined;
      this.probedVersions.clear();
    }
    for (const v of versions) {
      this.clearVersionData(v);
      await this.deleteVersionFile(v.fsPath);
    }
    this.onDidChangeTreeDataEmitter.fire();
    this.warmup = this.warmup.then(async () => {
      try {
        for (const version of await this.rootVersions(root)) {
          await this.getModels(version);
          await this.getClassicIndex(version);
          await this.warmVersion({ kind: 'version', version, source: root });
          if (!this.memOn(root)) {
            this.clearVersionData(version);
          }
        }
      } finally {
        this.scheduleRootWake(root);
      }
    }).catch(() => undefined);
    void this.warmup;
  }

  viewModeFor(version: DiscoveredVersion): ViewMode {
    const override = this.viewModes.get(version.fsPath.toLowerCase());
    if (override) {
      return override;
    }
    const configured = vscode.workspace.getConfiguration('d365fo.aot').get<string>('defaultViewMode', 'models');
    return configured === 'classic' ? 'classic' : 'models';
  }

  toggleViewMode(version: DiscoveredVersion): ViewMode {
    const next: ViewMode = this.viewModeFor(version) === 'classic' ? 'models' : 'classic';
    this.viewModes.set(version.fsPath.toLowerCase(), next);
    return next;
  }

  /** Stable tree identity surviving refreshes (same path under two sources stays distinct). */
  private static nodeKey(version: DiscoveredVersion, source: VersionSource): string {
    return `${source}|${version.fsPath.toLowerCase()}`;
  }

  /**
   * Every tree icon is a VS Code ThemeIcon id — either a built-in Codicon or
   * one of our contributed `d365fo-*` font icons
   * (`resources/d365fo-icons.woff`, see `contributes.icons` in package.json),
   * which inherit the tree foreground like Codicons do.
   */
  private static iconPathFor(name: string): vscode.ThemeIcon {
    return new vscode.ThemeIcon(name);
  }

  getTreeItem(element: AotNode): vscode.TreeItem {
    if (element.kind === 'source') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `s:${element.sourceId}`;
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.contextValue = 'd365fo-source';
      item.tooltip = element.fsPath ?? element.label;
      return item;
    }
    if (element.kind === 'version') {
      // Versions render as top-level sections (Explorer-style foldouts),
      // each carrying the package glyph like the Custom root.
      const item = new vscode.TreeItem(element.version.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `v:${AotTreeProvider.nodeKey(element.version, element.source)}`;
      item.iconPath = new vscode.ThemeIcon('package');
      item.resourceUri = vscode.Uri.file(element.version.fsPath);
      item.contextValue = 'd365fo-version';
      item.tooltip = element.version.fsPath;
      item.description = this.viewModeFor(element.version) === 'classic' ? 'Classic' : 'Model';
      return item;
    }
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `c:${AotTreeProvider.nodeKey(element.version, element.source)}|${element.catId}`;
      item.iconPath = AotTreeProvider.iconPathFor(element.icon);
      item.contextValue = 'd365fo-category';
      item.tooltip = `${element.version.name} / ${element.label}`;
      if (this.elementFilter) {
        item.description = '🔍 filtered';
      }
      return item;
    }
    if (element.kind === 'group') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `g:${AotTreeProvider.nodeKey(element.version, element.source)}|${element.catId}|${element.label}`;
      item.iconPath = AotTreeProvider.iconPathFor(element.icon);
      item.contextValue = 'd365fo-group';
      item.tooltip = `${element.version.name} / ${element.label}`;
      if (this.elementFilter) {
        item.description = '🔍 filtered';
      }
      return item;
    }
    if (element.kind === 'elemtype') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `t:${AotTreeProvider.nodeKey(element.version, element.source)}|${element.catId}|${element.group ?? ''}~${element.label}`;
      item.iconPath = AotTreeProvider.iconPathFor(element.icon);
      item.contextValue = 'd365fo-elemtype';
      item.tooltip = `${element.version.name} / ${element.label}`;
      if (this.elementFilter) {
        item.description = '🔍 filtered';
      }
      return item;
    }
    if (element.kind === 'element') {
      // Base enums fold into values; tables, views, entities, maps, menus,
      // queries, forms, reports, security, services, classes, ... fold into
      // live-parsed XML sections/outlines. Everything else is a leaf.
      const lower = element.folders.map((f) => f.toLowerCase());
      const expandable =
        lower.some((f) => ENUM_VALUE_FOLDERS.has(f)) || lower.some((f) => FOLDOUT_FOLDERS.has(f));
      const item = new vscode.TreeItem(
        element.label,
        expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      item.id = `e:${AotTreeProvider.nodeKey(element.version, element.source)}|${element.fsPath.toLowerCase()}`;
      item.iconPath = AotTreeProvider.iconPathFor(element.icon);
      item.resourceUri = vscode.Uri.file(element.fsPath);
      item.contextValue = 'd365fo-element';
      item.tooltip = element.fsPath;
      item.description = element.description;
      // A query *is* its data sources, so selecting it shows the overview of the
      // backing query — the same page a view shows under its Metadata node. The
      // chevron still expands the raw outline.
      item.command = lower.some((f) => QUERY_OVERVIEW_FOLDERS.has(f))
        ? {
            command: 'd365fo-aot.openMetadataGrid',
            title: 'Show Query Metadata',
            arguments: [element],
          }
        : {
            command: 'd365fo-aot.openElement',
            title: 'Open Element File',
            arguments: [element],
          };
      return item;
    }
    if (element.kind === 'enumvalue') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = `ev:${AotTreeProvider.nodeKey(element.parent.version, element.parent.source)}|${element.fsPath.toLowerCase()}|${element.label}`;
      item.iconPath = new vscode.ThemeIcon('circle-outline');
      item.resourceUri = vscode.Uri.file(element.fsPath);
      item.contextValue = 'd365fo-enumvalue';
      item.tooltip = element.value !== undefined ? `${element.parent.label} :: ${element.label} = ${element.value}` : element.label;
      // Value clicks show the parent enum's grid, like clicking the enum itself.
      item.command = {
        command: 'd365fo-aot.openElement',
        title: 'Show Enum Values',
        arguments: [element.parent],
      };
      return item;
    }
    if (element.kind === 'tablesection') {
      // Gutter first, icon second, text third — always. Structural rows
      // reserve the foldout column even when empty (count 0) so sibling
      // labels scan in one column; the count in the tooltip stays honest.
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `ts:${AotTreeProvider.nodeKey(element.parent.version, element.parent.source)}|${element.fsPath.toLowerCase()}|${element.section}`;
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.resourceUri = vscode.Uri.file(element.fsPath);
      item.contextValue = 'd365fo-tablesection';
      item.tooltip = `${element.parent.label} / ${element.label} (${element.count})`;
      // Table sections with a grid overview open it; other sections expand in the tree.
      const gridCmd = sectionGridCommand(element.section, element.parent.folders);
      if (gridCmd && sectionHasGrid(element.section, element.parent.folders)) {
        item.command = {
          command: gridCmd[0],
          title: gridCmd[1],
          arguments: [element],
        };
      }
      return item;
    }
    if (element.kind === 'member') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = `tm:${AotTreeProvider.nodeKey(element.element.version, element.element.source)}|${element.fsPath.toLowerCase()}|${element.section}|${element.label}`;
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.resourceUri = vscode.Uri.file(element.fsPath);
      item.contextValue = 'd365fo-member';
      item.tooltip = `${element.element.label} / ${element.label}`;
      // Grid members open their grid first (metadata method rows land on
      // the grid, not the X++ preview); plain Methods rows open the preview.
      // Field members stay commandless (the Fields section opens the grid).
      const memberGrid = element.gridSection
        ? SECTION_GRID_COMMANDS[element.gridSection]
        : undefined;
      const memberFolders =
        element.gridSection === 'Metadata' ? METADATA_FOLDERS : TABLE_SECTION_FOLDERS;
      if (memberGrid && element.element.folders.some((f) => memberFolders.has(f))) {
        item.command = {
          command: memberGrid[0],
          title: memberGrid[1],
          arguments: [element],
        };
      } else if (element.section === 'Methods') {
        // Methods carry viewable source — open the element's X++ preview
        // scrolled to the method, like VS would.
        item.command = {
          command: 'd365fo-aot.openElement',
          title: 'Open X++ Source',
          arguments: [element.element, element.label],
        };
      } else if (
        element.section === 'Relations' ||
        element.section === 'Indexes'
      ) {
        // Relation/index rows open the matching grid.
        const gridCmd = SECTION_GRID_COMMANDS[element.section];
        if (gridCmd && element.element.folders.some((f) => TABLE_SECTION_FOLDERS.has(f))) {
          item.command = {
            command: gridCmd[0],
            title: gridCmd[1],
            arguments: [element],
          };
        }
      }
      return item;
    }
    if (element.kind === 'xmlnode') {
      // Same gutter rule as sections: outline branches always reserve the
      // foldout column so labels align with their siblings.
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `xn:${AotTreeProvider.nodeKey(element.element.version, element.element.source)}|${element.fsPath.toLowerCase()}|${element.outline}|${element.path}`;
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.resourceUri = vscode.Uri.file(element.fsPath);
      item.contextValue = 'd365fo-xmlnode';
      item.description = element.description;
      item.tooltip = `${element.element.label} / ${element.label}${
        element.description ? ` (${element.description})` : ''
      }`;
      // Relation/index/metadata branches open the matching grid.
      const branchGrid =
        element.outline === 'tablechild:Relations'
          ? 'Relations'
          : element.outline === 'tablechild:Indexes'
            ? 'Indexes'
            : element.outline === 'metadata'
              ? 'Metadata'
              : undefined;
      const branchCmd = branchGrid ? SECTION_GRID_COMMANDS[branchGrid] : undefined;
      const branchFolders = branchGrid === 'Metadata' ? METADATA_FOLDERS : TABLE_SECTION_FOLDERS;
      if (branchCmd && element.element.folders.some((f) => branchFolders.has(f))) {
        item.command = {
          command: branchCmd[0],
          title: branchCmd[1],
          arguments: [element],
        };
      }
      return item;
    }
    const config = vscode.workspace.getConfiguration('d365fo.aot');
    const showPath = config.get<boolean>('showDescriptorPath', false);
    const item = new vscode.TreeItem(element.model.name, vscode.TreeItemCollapsibleState.None);
    item.id = `m:${AotTreeProvider.nodeKey(element.version, element.source)}|${element.model.fsPath.toLowerCase()}`;
    item.iconPath = new vscode.ThemeIcon('package');
    item.resourceUri = vscode.Uri.file(element.model.fsPath);
    item.contextValue = 'd365fo-model';
    item.tooltip = element.model.descriptorPath;
    item.description = showPath ? element.model.descriptorPath : undefined;
    item.command = {
      command: 'd365fo-aot.openDescriptor',
      title: 'Open Model Descriptor XML',
      arguments: [element],
    };
    return item;
  }

  async getChildren(element?: AotNode, viewId?: string): Promise<AotNode[]> {
    // Top level = fixed source roots. MS-UDE nests discovered versions;
    // MS-Packages and each Custom entry behave as one (synthetic) version, so
    // toggle, caches, prefetch and Classic mode all work unchanged below them.
    // Missing folders or empty content simply expand to nothing — never fail.
    if (!element) {
      this.adoptedRoots = [this.udeSource(), this.packagesVersion(), this.customSource()];
      return this.adoptedRoots;
    }
    if (element.kind === 'source') {
      if (element.sourceId === 'ude') {
        // Instant versions: every discovered version renders immediately
        // (single root readdir — no probe/scan/index wait). Empty folders
        // prune later once a full scan proves them empty; refreshes fire
        // only when the visible rows actually change.
        const versions = await this.getUdeVersions();
        const rendered = this.udeVisibleRows(versions);
        this.udeRenderSig = rendered.sig;
        this.startUdeBackground(versions);
        this.ensureRootScheduled('ude');
        return rendered.nodes;
      }
      // Custom: every configured path is one synthetic version (shown even
      // when empty/missing, since it was explicitly configured).
      this.ensureRootScheduled('custom');
      return this.getCustomEntries();
    }
    if (element.kind === 'version') {
      this.ensureRootScheduled(element.source);
      if (this.viewModeFor(element.version) === 'classic') {
        const key = element.version.fsPath.toLowerCase();
        const warm = this.classicCache.get(key);
        if (warm) {
          const categories = await this.getClassicCategories(element);
          this.queueWarmVersion(element);
          return categories;
        }
        // Cold: render the known categories instantly (zero I/O), verify and
        // warm everything in the background, then reconcile. Stable item ids
        // keep expansion/selection state across the refresh. Warmups serialize
        // so a second version opened right away never waits on the first.
        this.warmup = this.warmup.then(() => this.ensureClassicCategories(element).catch(() => undefined));
        void this.warmup;
        return this.staticCategories(element);
      }
      const models = await this.getModels(element.version);
      return models.map((model) => ({ kind: 'model', version: element.version, source: element.source, model }) as ModelNode);
    }
    if (element.kind === 'category') {
      return this.filtered(element, await this.getClassicTypes(element), viewId);
    }
    if (element.kind === 'group') {
      return this.filtered(element, await this.getClassicGroupTypes(element), viewId);
    }
    if (element.kind === 'elemtype') {
      return this.filtered(element, await this.getClassicElements(element), viewId);
    }
    if (element.kind === 'element') {
      const primary = (element.folders[0] ?? '').toLowerCase();
      if (element.folders.some((f) => TABLE_SECTION_FOLDERS.has(f))) {
        return this.getTableSections(element);
      }
      const defs = sectionDefsFor(element.folders);
      if (defs) {
        const sections = await this.getDefSections(element, defs);
        // Views and data entities with a backing query gain the Metadata
        // node last (VS order), but only when it holds content.
        const metadata = await this.getMetadataRoot(element);
        return metadata ? [...sections, ...metadata] : sections;
      }
      if (TREE_FOLDERS.has(primary)) {
        return this.getTreeRoots(element);
      }
      if (WORKFLOW_OUTCOME_FOLDERS.has(primary)) {
        return this.getWorkflowSections(element);
      }
      if (GENERIC_FOLDERS.has(primary)) {
        return this.getGenericSections(element);
      }
      return this.getEnumValues(element);
    }
    if (element.kind === 'tablesection') {
      return this.getTableMembers(element);
    }
    if (element.kind === 'xmlnode') {
      return this.getXmlKids(element);
    }
    return [];
  }

  /**
   * Table sections at foldout: the 9 VS nodes in VS order, each carrying its
   * child count (shown in the tooltip). Parsed live from the element XML on
   * every expand — only what the file directly contains, no cross-references.
   */
  private async getTableSections(element: ElementNode): Promise<TableSectionNode[]> {
    return this.getDefSections(element, TABLE_SECTIONS);
  }

  /** Static-order sections (tables/views/entities/maps) with child counts. */
  private async getDefSections(element: ElementNode, defs: TableSectionDef[]): Promise<TableSectionNode[]> {
    const items = await this.readTableContents(element.fsPath);
    if (!items) {
      return [];
    }
    return defs.map((def) => ({
      kind: 'tablesection',
      parent: element,
      section: def.id,
      label: def.label,
      icon: def.icon,
      fsPath: element.fsPath,
      count: (items.get(def.id) ?? []).length,
    }) as TableSectionNode);
  }

  /**
   * Workflow approval outcomes (Approve/Deny/Reject/...) are direct named
   * tags rather than a container, so they get one explicit section.
   */
  private async workflowOutcomes(fsPath: string): Promise<string[]> {
    const root = await parseElementXml(fsPath);
    if (!root) {
      return [];
    }
    const out: string[] = [];
    for (const child of childElements(root)) {
      const tag = tagOf(child);
      if (tag === 'Name' || tag === 'SourceCode' || tag === 'Label' || tag === 'Description') {
        continue;
      }
      if (childElements(child).length === 0 || !elementText(child, 'Name')) {
        continue;
      }
      if (!out.includes(tag)) {
        out.push(tag);
      }
    }
    return out;
  }

  private async getWorkflowSections(element: ElementNode): Promise<TableSectionNode[]> {
    const outcomes = await this.workflowOutcomes(element.fsPath);
    if (outcomes.length === 0) {
      return [];
    }
    return [
      {
        kind: 'tablesection',
        parent: element,
        section: 'Outcomes',
        label: 'Outcomes',
        icon: 'git-branch',
        fsPath: element.fsPath,
        count: outcomes.length,
      },
    ];
  }

  /** Generic named-collection sections (menus, security, services, ...). */
  private async getGenericSections(element: ElementNode): Promise<TableSectionNode[]> {    const items = await this.readTableContents(element.fsPath);
    if (!items) {
      return [];
    }
    const out: TableSectionNode[] = [];
    for (const [tag, names] of items) {
      out.push({
        kind: 'tablesection',
        parent: element,
        section: tag,
        label: tag,
        icon: GENERIC_SECTION_ICONS[tag] ?? 'folder',
        fsPath: element.fsPath,
        count: names.length,
      });
    }
    return out;
  }

  private sectionIcon(section: string, fallback: string): string {
    const def = [...TABLE_SECTIONS, ...VIEW_SECTIONS, ...ENTITY_SECTIONS, ...MAP_SECTIONS].find(
      (d) => d.id === section,
    );
    return def?.icon ?? GENERIC_SECTION_ICONS[section] ?? fallback;
  }

  private memberNode(
    sectionNode: TableSectionNode,
    section: string,
    label: string,
    icon: string,
  ): TableMemberNode {
    return {
      kind: 'member',
      sectionNode,
      element: sectionNode.parent,
      section,
      label,
      icon,
      fsPath: sectionNode.fsPath,
    };
  }

  /**
   * Field-row glyph at creation: fresh `i:type` evidence first, traversal
   * memo fills the gaps, else the fallback. Keeps navigation instant — no
   * waiting, no spinners — while the traversal fills what the file itself
   * cannot answer.
   */
  private fieldRowIcon(
    version: DiscoveredVersion,
    tableFsPath: string,
    label: string,
    hints: Map<string, { prim?: FieldPrimitive | null; edt?: string; size?: string }> | undefined,
    fallback: string,
  ): string {
    const labelLower = label.toLowerCase();
    const prim =
      hints?.get(labelLower)?.prim ??
      this.fieldPrimitiveCache
        .get(`${version.fsPath.toLowerCase()}|${tableFsPath.toLowerCase()}`)
        ?.get(labelLower)?.prim;
    return prim ? PRIMITIVE_GLYPHS[prim] : fallback;
  }

  private async getTableMembers(element: TableSectionNode): Promise<AotNode[]> {
    // Second level first: relations → constraints, field groups → fields,
    // state machines → states, indexes → fields. Members with children
    // become branches.
    if (
      element.section === 'Relations' ||
      element.section === 'FieldGroups' ||
      element.section === 'StateMachines' ||
      element.section === 'Indexes'
    ) {
      return this.getTableChildBranches(element);
    }
    // Menu items nest (submenus): items with nested Elements become branches.
    const primary = (element.parent.folders[0] ?? '').toLowerCase();
    if ((primary === 'axmenu' || primary === 'axmenuextension') && element.section === 'Elements') {
      return this.getMenuItemBranches(element);
    }
    // Workflow approval outcomes are direct named tags.
    if (element.section === 'Outcomes') {
      const outcomes = await this.workflowOutcomes(element.fsPath);
      const icon = this.sectionIcon(element.section, element.icon);
      return outcomes.map((label) => this.memberNode(element, element.section, label, icon));
    }
    const items = await this.readTableContents(element.fsPath);
    if (!items) {
      return [];
    }
    if (element.section === 'Fields') {
      // Field rows resolve instant type glyphs from the same expand.
      const hints = await this.readTableFieldRefs(element.fsPath);
      const fallback = this.sectionIcon(element.section, element.icon);
      return (items.get(element.section) ?? []).map((label) =>
        this.memberNode(
          element,
          element.section,
          label,
          this.fieldRowIcon(element.parent.version, element.fsPath, label, hints, fallback),
        ),
      );
    }
    // Method rows carry their own glyph; every other section reuses its icon.
    const icon =
      element.section === 'Methods' ? 'd365fo-method' : this.sectionIcon(element.section, element.icon);
    return (items.get(element.section) ?? []).map((label) =>
      this.memberNode(element, element.section, label, icon),
    );
  }

  /** Relation/field-group/state-machine members with children become branches. */
  private async getTableChildBranches(element: TableSectionNode): Promise<AotNode[]> {
    const root = await parseElementXml(element.fsPath);
    if (!root) {
      return [];
    }
    // Virtual root: same order as lookup, so index paths stay stable.
    const virtual = walkOutline(`tablechild:${element.section}`, root, []);
    const icon = this.sectionIcon(element.section, element.icon);
    // First-level field-group rows — branches and leaves alike — wear the
    // FieldGroups glyph; the fields nested inside keep the Fields glyph.
    const rowIcon = element.section === 'FieldGroups' ? 'd365fo-field-groups' : icon;
    const out: AotNode[] = [];
    (virtual?.kids ?? []).forEach((kid, index) => {
      if ((kid.members?.length ?? 0) > 0 || (kid.kids?.length ?? 0) > 0) {
        out.push(this.xmlKid(element.parent, element, `tablechild:${element.section}`, `${index}`, kid.label, rowIcon, kid));
      } else {
        out.push(this.memberNode(element, element.section, kid.label, rowIcon));
      }
    });
    return out;
  }

  /** Menu Elements members with nested Elements (submenus) become branches. */
  private async getMenuItemBranches(element: TableSectionNode): Promise<AotNode[]> {
    const root = await parseElementXml(element.fsPath);
    if (!root) {
      return [];
    }
    const virtual = walkOutline('menuitem', root, []);
    const out: AotNode[] = [];
    (virtual?.kids ?? []).forEach((kid, index) => {
      if ((kid.kids?.length ?? 0) > 0) {
        out.push(this.xmlKid(element.parent, element, 'menuitem', `${index}`, kid.label, element.icon, kid));
      } else {
        out.push(this.memberNode(element, element.section, kid.label, element.icon));
      }
    });
    return out;
  }

  /** Metadata root for views and data entities with a backing query (VS order: last). */
  private async getMetadataRoot(element: ElementNode): Promise<XmlNode[]> {
    const primary = (element.folders[0] ?? '').toLowerCase();
    if (!METADATA_FOLDERS.has(primary)) {
      return [];
    }
    const root = await parseElementXml(element.fsPath);
    if (!root || metadataOutline(root).length === 0) {
      return [];
    }
    return [
      {
        kind: 'xmlnode',
        element,
        parent: element,
        outline: 'metadata',
        path: '',
        label: 'Metadata',
        icon: 'layers',
        fsPath: element.fsPath,
        expandable: true,
      },
    ];
  }

  /** Tree roots for queries, forms and reports (outline branches + methods). */
  private async getTreeRoots(element: ElementNode): Promise<AotNode[]> {
    const primary = (element.folders[0] ?? '').toLowerCase();
    const outline = primary.startsWith('axquery') ? 'query' : primary.startsWith('axform') ? 'form' : 'report';
    const root = await parseElementXml(element.fsPath);
    if (!root) {
      return [];
    }
    const roots = buildOutline(outline, root);
    const out: AotNode[] = [];
    roots.forEach((kid, i) => {
      out.push(this.xmlKid(element, element, outline, `${i}`, kid.label, kid.icon, kid));
    });
    return out;
  }

  private xmlKid(
    element: ElementNode,
    parent: ElementNode | XmlNode | TableSectionNode,
    outline: string,
    path: string,
    label: string,
    icon: string,
    kid: OutlineKid,
  ): XmlNode {
    return {
      kind: 'xmlnode',
      element,
      parent,
      outline,
      path,
      label,
      icon,
      description: kid.description,
      fsPath: element.fsPath,
      expandable: (kid.kids?.length ?? 0) > 0 || (kid.members?.length ?? 0) > 0,
    };
  }

  private async getXmlKids(node: XmlNode): Promise<AotNode[]> {
    const root = await parseElementXml(node.fsPath);
    if (!root) {
      return [];
    }
    const steps = node.path.split('/').filter((s) => s.length > 0).map(Number);
    if (steps.some((n) => !Number.isInteger(n))) {
      return [];
    }
    const target = walkOutline(node.outline, root, steps);
    if (!target) {
      return [];
    }
    const out: AotNode[] = [];
    (target.kids ?? []).forEach((kid, i) => {
      out.push(this.xmlKid(node.element, node, node.outline, `${node.path}/${i}`, kid.label, kid.icon, kid));
    });
    const members = target.members ?? [];
    if (members.length > 0) {
      // Method rows carry their own glyph (and keep X++ preview via section).
      const memberIcon =
        target.memberSection === 'Methods' ? 'd365fo-method' : (target.memberIcon ?? node.icon);
      const synth: TableSectionNode = {
        kind: 'tablesection',
        parent: node.element,
        section: target.memberSection ?? node.label,
        label: node.label,
        icon: memberIcon,
        fsPath: node.fsPath,
        count: members.length,
      };
      // Table field outlines resolve instant type glyphs from the same expand.
      const fieldOutline =
        node.outline === 'tablechild:FieldGroups' || node.outline === 'tablechild:Indexes';
      const hints = fieldOutline ? await this.readTableFieldRefs(node.fsPath) : undefined;
      for (const label of members) {
        const member = this.memberNode(
          synth,
          synth.section,
          label,
          fieldOutline
            ? this.fieldRowIcon(node.element.version, node.fsPath, label, hints, memberIcon)
            : memberIcon,
        );
        if (
          node.outline === 'tablechild:Relations' ||
          node.outline === 'tablechild:Indexes' ||
          node.outline === 'tablechild:FieldGroups' ||
          node.outline === 'metadata'
        ) {
          // Constraint/field rows open the matching grid (their synthetic
          // branch section carries no lineage of its own). Field-group rows
          // resolve to the Fields lineage for type glyphs.
          member.gridSection =
            node.outline === 'metadata'
              ? 'Metadata'
              : node.outline === 'tablechild:Relations'
                ? 'Relations'
                : node.outline === 'tablechild:Indexes'
                  ? 'Indexes'
                  : 'FieldGroups';
        }
        out.push(member);
      }
    }
    return out;
  }

  /**
   * Direct file content only: section id → ordered member names. Methods come
   * from `SourceCode/Methods/Method/Name`; every other section lists its
   * direct child elements' `<Name>`. Returns undefined when unreadable.
   */
  private async readTableContents(fsPath: string): Promise<Map<string, string[]> | undefined> {
    let xml: string;
    try {
      xml = (await fs.readFile(fsPath, 'utf8')).replace(/^\uFEFF/, '');
    } catch {
      return undefined;
    }
    try {
      const document = new DOMParser().parseFromString(xml, 'text/xml') as unknown as {
        documentElement?: DomElement | null;
      };
      const root = document.documentElement;
      if (!root) {
        return undefined;
      }
      const textOf = (node: DomElement, tag: string): string | undefined => {
        const text = childElements(node).find((c) => tagOf(c) === tag)?.textContent?.trim();
        return text ? text : undefined;
      };
      const namedChildren = (node: DomElement): string[] => {
        const out: string[] = [];
        for (const child of childElements(node)) {
          if (childElements(child).length === 0) {
            continue; // Leaf value (e.g. <SaveDataPerCompany>No), not a member.
          }
          const name = memberNameOf(child);
          if (name) {
            out.push(name);
          }
        }
        return out;
      };
      const out = new Map<string, string[]>();
      for (const child of childElements(root)) {
        const tag = tagOf(child);
        if (tag === 'Name' || tag === 'SourceCode') {
          continue;
        }
        const items = namedChildren(child);
        if (items.length > 0) {
          const prev = out.get(tag) ?? [];
          out.set(tag, [...prev, ...items]);
        }
      }
      // Methods live under SourceCode/Methods/Method — same Name rule.
      const sourceCode = childElements(root).find((c) => tagOf(c) === 'SourceCode');
      if (sourceCode) {
        const methods: string[] = [];
        const walk = (node: DomElement): void => {
          if (tagOf(node) === 'Method') {
            const name = textOf(node, 'Name');
            if (name) {
              methods.push(name);
            }
            return;
          }
          for (const child of childElements(node)) {
            walk(child);
          }
        };
        walk(sourceCode);
        if (methods.length > 0) {
          out.set('Methods', methods);
        }
      }
      return out;
    } catch {
      return undefined;
    }
  }

  /**
   * Enum values at foldout: parsed live from the element XML on every expand
   * (no caching, by design) — `<EnumValues><AxEnumValue><Name>…`.
   */
  private async getEnumValues(element: ElementNode): Promise<EnumValueNode[]> {
    if (!element.folders.some((f) => ENUM_VALUE_FOLDERS.has(f))) {
      return [];
    }
    let xml: string;
    try {
      xml = await fs.readFile(element.fsPath, 'utf8');
    } catch {
      return [];
    }
    try {
      const document = new DOMParser().parseFromString(xml, 'text/xml') as unknown as {
        documentElement?: DomElement | null;
      };
      const root = document.documentElement;
      if (!root) {
        return [];
      }
      const textOf = (node: DomElement, tag: string): string | undefined => {
        const text = childElements(node).find((c) => tagOf(c) === tag)?.textContent?.trim();
        return text ? text : undefined;
      };
      const out: EnumValueNode[] = [];
      const walk = (node: DomElement): void => {
        if (tagOf(node) === 'AxEnumValue') {
          const name = textOf(node, 'Name');
          if (name) {
            out.push({ kind: 'enumvalue', parent: element, label: name, value: textOf(node, 'Value'), fsPath: element.fsPath });
          }
          return;
        }
        for (const child of childElements(node)) {
          walk(child);
        }
      };
      walk(root);
      return out;
    } catch {
      return [];
    }
  }

  /** Single-flight UDE background (probes, then full scans on the warmup queue). */
  private startUdeBackground(versions: DiscoveredVersion[]): void {
    if (!this.udeNeedsBackground(versions) || this.udeInFlight) {
      return;
    }
    const probes = this.runUdeProbes(versions);
    const models = probes.then(
      () => (this.warmup = this.warmup.then(() => this.runUdeModels(versions).catch(() => undefined))),
    );
    this.udeInFlight = models
      .catch(() => undefined)
      .finally(() => {
        this.udeInFlight = undefined;
      });
    void this.udeInFlight;
  }

  private udeSource(): SourceNode {
    return {
      kind: 'source',
      sourceId: 'ude',
      label: 'MS-UDE',
      icon: 'folder',
      fsPath: this.getUdeRootPath(),
    };
  }

  private packagesVersion(): VersionNode {
    const fsPath = this.getPackagesRootPath();
    return { kind: 'version', version: { name: 'MS-Packages', fsPath }, source: 'packages' };
  }

  private customSource(): SourceNode {
    return { kind: 'source', sourceId: 'custom', label: 'Custom', icon: 'package' };
  }

  private getCustomEntries(): VersionNode[] {
    const config = vscode.workspace.getConfiguration('d365fo');
    let entries = config.get<string[]>('aot.custom.rootPath', []);
    if (!entries || entries.length === 0) {
      // One-release grace: pick up paths saved under the typo'd `d365.*` key (0.5.0–0.5.10).
      const legacy = vscode.workspace.getConfiguration('d365').get<string[]>('aot.custom.rootPath', []);
      if (legacy && legacy.length > 0) {
        entries = legacy;
      }
    }
    const out: VersionNode[] = [];
    const seen = new Set<string>();
    for (const raw of entries ?? []) {
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        continue;
      }
      const fsPath = expandPath(raw);
      const key = fsPath.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const base = path.basename(fsPath.replace(/[/\\]+$/, ''));
      out.push({ kind: 'version', version: { name: base || fsPath, fsPath }, source: 'custom' });
    }
    return out;
  }

  async getParent(element: AotNode): Promise<AotNode | undefined> {
    if (element.kind === 'source') {
      return undefined;
    }
    if (element.kind === 'version') {
      if (element.source === 'ude') {
        return this.udeSource();
      }
      if (element.source === 'custom') {
        return this.customSource();
      }
      return undefined;
    }
    if (element.kind === 'model' || element.kind === 'category') {
      return { kind: 'version', version: element.version, source: element.source };
    }
    if (element.kind === 'group') {
      const cat = CLASSIC_CATEGORIES.find((c) => c.id === element.catId);
      if (cat) {
        return { kind: 'category', version: element.version, source: element.source, catId: cat.id, label: cat.label, icon: cat.icon };
      }
      return { kind: 'version', version: element.version, source: element.source };
    }
    if (element.kind === 'elemtype') {
      if (element.group) {
        return { kind: 'group', version: element.version, source: element.source, catId: element.catId, label: element.group, icon: this.groupIcon(element.catId, element.group) };
      }
      const cat = CLASSIC_CATEGORIES.find((c) => c.id === element.catId);
      if (cat) {
        return { kind: 'category', version: element.version, source: element.source, catId: cat.id, label: cat.label, icon: cat.icon };
      }
      return { kind: 'version', version: element.version, source: element.source };
    }
    if (element.kind === 'element') {
      if (!element.typeLabel) {
        const cat = CLASSIC_CATEGORIES.find((c) => c.id === element.catId);
        if (cat) {
          return { kind: 'category', version: element.version, source: element.source, catId: cat.id, label: cat.label, icon: cat.icon };
        }
        return { kind: 'version', version: element.version, source: element.source };
      }
      return {
        kind: 'elemtype',
        version: element.version,
        source: element.source,
        catId: element.catId,
        group: element.group,
        label: element.typeLabel,
        icon: element.typeIcon ?? 'file',
        folders: element.folders,
        modelPrefix: element.modelPrefix,
      };
    }
    if (element.kind === 'enumvalue') {
      return element.parent;
    }
    if (element.kind === 'tablesection') {
      return element.parent;
    }
    if (element.kind === 'member') {
      return element.sectionNode;
    }
    if (element.kind === 'xmlnode') {
      return element.parent;
    }
    return undefined;
  }

  // ---- classic view ----

  private async getClassicIndex(version: DiscoveredVersion): Promise<ClassicIndex> {
    const key = version.fsPath.toLowerCase();
    const cached = this.classicCache.get(key);
    if (cached) {
      return cached;
    }
    // Session file first: validated structural index loads in ~a second,
    // skipping the multi-minute rescan (any source — same path, same bytes).
    const fromFile = await this.hydrateVersionFile(version);
    if (fromFile) {
      return fromFile;
    }
    // Single-flight: an expand racing the background prefetch shares one
    // index build instead of scanning twice.
    const inFlight = this.pendingClassic.get(key);
    if (inFlight) {
      return inFlight.promise;
    }
    const token = {};
    const promise = this.buildClassicIndex(version, key, token);
    this.pendingClassic.set(key, { token, promise });
    return promise;
  }

  /**
   * Load a persisted version index: models + folder map + file listings are
   * restored into the RAM caches after mtime validation. Scope lists
   * (heads/full/search entries) rebuild cheaply from the warm listings.
   */
  private async hydrateVersionFile(version: DiscoveredVersion): Promise<ClassicIndex | undefined> {
    const key = version.fsPath.toLowerCase();
    const doc = await this.readVersionFile(version.fsPath);
    if (!doc) {
      return undefined;
    }
    const byName = new Map(doc.models.map((m) => [m.name, m]));
    const folders = new Map<string, Array<{ model: DiscoveredModel; dir: string }>>();
    for (const [ax, locs] of Object.entries(doc.folders)) {
      const resolved: Array<{ model: DiscoveredModel; dir: string }> = [];
      for (const l of locs) {
        const model = byName.get(l.model);
        if (model) {
          resolved.push({ model, dir: l.dir });
        }
      }
      if (resolved.length > 0) {
        folders.set(ax, resolved);
      }
    }
    const files = new Map<string, string[]>(Object.entries(doc.files));
    const index: ClassicIndex = { at: Date.now(), folders, files };
    this.modelsCache.set(key, { at: Date.now(), models: doc.models });
    this.classicCache.set(key, index);
    return index;
  }

  private async buildClassicIndex(
    version: DiscoveredVersion,
    key: string,
    token: object,
  ): Promise<ClassicIndex> {
    try {
      const models = await this.getModels(version);
      // Fresh index → drop scope lists bound to the previous one (readers also
      // guard on indexAt, this just frees the memory promptly).
      const prefix = `${key}|`;
      for (const cache of [this.headCache, this.fullCache] as const) {
        for (const k of [...cache.keys()]) {
          if (k.startsWith(prefix)) {
            cache.delete(k);
          }
        }
      }
      const folders = new Map<string, Array<{ model: DiscoveredModel; dir: string }>>();
      // Moderate fan-out + cooperative yields: background scans must leave
      // pool slots and event-loop turns for foreground expands.
      for (let i = 0; i < models.length; i += 32) {
        const found = await Promise.all(models.slice(i, i + 32).map((m) => this.findAxFolders(m)));
        await AotTreeProvider.tick();
        for (const locs of found) {
          for (const loc of locs) {
            const list = folders.get(loc.ax);
            if (list) {
              list.push(loc);
            } else {
              folders.set(loc.ax, [loc]);
            }
          }
        }
      }
      const index: ClassicIndex = { at: Date.now(), folders, files: new Map() };
      // Publish only if not superseded by a refresh meanwhile; waiters still
      // receive the data (they revalidate via indexAt on read).
      if (this.pendingClassic.get(key)?.token === token) {
        this.classicCache.set(key, index);
        this.pendingClassic.delete(key);
        this.indexDirty.add(key);
      }
      return index;
    } catch (e) {
      if (this.pendingClassic.get(key)?.token === token) {
        this.pendingClassic.delete(key);
      }
      throw e;
    }
  }

  /** Breadth-first search for known Ax* folders below a model dir (depth-bounded, one readdir per dir). */
  private async findAxFolders(
    model: DiscoveredModel,
  ): Promise<Array<{ model: DiscoveredModel; dir: string; ax: string }>> {
    const found: Array<{ model: DiscoveredModel; dir: string; ax: string }> = [];
    const queue: Array<{ dir: string; level: number }> = [{ dir: model.fsPath, level: 0 }];
    while (queue.length > 0) {
      const batch = queue.splice(0, 128);
      const listings = await Promise.all(
        batch.map(async (item) => {
          try {
            return { item, entries: await fs.readdir(item.dir, { withFileTypes: true }) };
          } catch {
            return { item, entries: undefined as undefined };
          }
        }),
      );
      for (const row of listings) {
        if (!row.entries) {
          continue;
        }
        for (const e of row.entries) {
          if (!e.isDirectory() && !e.isSymbolicLink()) {
            continue;
          }
          const lower = e.name.toLowerCase();
          const full = path.join(row.item.dir, e.name);
          if (KNOWN_AX_FOLDERS.has(lower)) {
            found.push({ model, dir: full, ax: lower });
          } else if (row.item.level < CLASSIC_AX_SEARCH_DEPTH && !CLASSIC_SKIP_DIRS.has(lower)) {
            if (e.isSymbolicLink()) {
              try {
                if (!(await fs.stat(full)).isDirectory()) {
                  continue;
                }
              } catch {
                continue;
              }
            }
            queue.push({ dir: full, level: row.item.level + 1 });
          }
        }
      }
    }
    return found;
  }

  /** Cached `*.xml` listing of one Ax folder, sorted by element *label*. */
  private async listElementFiles(index: ClassicIndex, dir: string): Promise<string[]> {
    const key = dir.toLowerCase();
    const hit = index.files.get(key);
    if (hit) {
      return hit;
    }
    // Single-flight: join an in-flight read instead of issuing a duplicate.
    let pending = this.pendingFiles.get(key);
    if (!pending) {
      pending = (async (): Promise<string[]> => {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const names = entries
            .filter((e) => e.isFile() || e.isSymbolicLink())
            .map((e) => e.name)
            .filter((n) => n.toLowerCase().endsWith('.xml'));
          // Sort by display label, NOT by file name: stripping `.xml` /
          // `.Extension` changes ICU collation (`_` sorts before `.`, but a
          // bare prefix sorts first), and the k-way merge requires label order.
          names.sort(
            (a, b) =>
              elementLabel(a).localeCompare(elementLabel(b), undefined, { numeric: true, sensitivity: 'base' }) ||
              (a < b ? -1 : a > b ? 1 : 0),
          );
          return names;
        } catch {
          return [];
        }
      })();
      this.pendingFiles.set(key, pending);
      try {
        const names = await pending;
        index.files.set(key, names);
      } finally {
        this.pendingFiles.delete(key);
      }
      return index.files.get(key) ?? [];
    }
    return pending;
  }

  /** Locations of Ax folders, optionally restricted to models by name prefix. */
  private scopeLocs(
    index: ClassicIndex,
    folders: string[],
    modelPrefix?: string,
  ): Array<{ model: DiscoveredModel; dir: string; ax: string }> {
    const prefix = modelPrefix?.toLowerCase();
    const out: Array<{ model: DiscoveredModel; dir: string; ax: string }> = [];
    for (const f of folders) {
      const ax = f.toLowerCase();
      for (const l of index.folders.get(ax) ?? []) {
        if (!prefix || l.model.name.toLowerCase().startsWith(prefix)) {
          out.push({ ...l, ax });
        }
      }
    }
    return out;
  }

  /** Total element files across all locations of the given Ax folders. */
  private async countTypeFiles(
    index: ClassicIndex,
    folders: string[],
    modelPrefix?: string,
  ): Promise<{ total: number; perDir: Array<{ model: DiscoveredModel; dir: string; ax: string; files: string[] }> }> {
    const locs = this.scopeLocs(index, folders, modelPrefix);
    let total = 0;
    const perDir: Array<{ model: DiscoveredModel; dir: string; ax: string; files: string[] }> = [];
    for (let i = 0; i < locs.length; i += 32) {
      const rows = await Promise.all(
        locs.slice(i, i + 32).map(async (l) => ({ ...l, files: await this.listElementFiles(index, l.dir) })),
      );
      await AotTreeProvider.tick();
      for (const r of rows) {
        total += r.files.length;
        perDir.push(r);
      }
    }
    return { total, perDir };
  }

  /** All known categories, no I/O — reconciled against the scan on refresh. */
  private staticCategories(element: VersionNode): CategoryNode[] {
    return CLASSIC_CATEGORIES.map((cat) => ({
      kind: 'category',
      version: element.version,
      source: element.source,
      catId: cat.id,
      label: cat.label,
      icon: cat.icon,
    }));
  }

  /** Queue version warmup (heads, then the full search index) behind other background work. */
  private queueWarmVersion(element: VersionNode): void {
    this.warmup = this.warmup.then(() => this.warmVersion(element).catch(() => undefined));
    void this.warmup;
  }

  /** Heads first, then the invisible full-version search index. Silent throughout. */
  private async warmVersion(element: VersionNode): Promise<void> {
    await this.prefetchHeads(element);
    await this.ensureSearchIndex(element);
    // Persist only when the RAM index actually diverged from the file.
    const key = element.version.fsPath.toLowerCase();
    if (this.indexDirty.has(key)) {
      await this.writeVersionFile(element.version);
    }
  }

  /** Background verify + warm after an optimistic render, then reconcile. */
  private async ensureClassicCategories(element: VersionNode): Promise<void> {
    await this.getClassicCategories(element);
    this.refreshView(element);
    await this.warmVersion(element);
  }

  private async getClassicCategories(element: VersionNode): Promise<CategoryNode[]> {
    // Instant by design: categories gate on Ax *folder presence* from the
    // index (directory reads only — never file listings). Per-type file
    // counts happen lazily at category expand, and the background prefetch
    // warms them ahead of time. A category whose folders are all empty still
    // renders but expands to nothing; that is rare and cheap.
    const index = await this.getClassicIndex(element.version);
    const present = (def: Pick<ClassicTypeDef, 'folders' | 'modelPrefix'>): boolean =>
      this.scopeLocs(index, def.folders, def.modelPrefix).length > 0;
    const out: CategoryNode[] = [];
    for (const cat of CLASSIC_CATEGORIES) {
      const visible =
        cat.types.some((t) => (isGroup(t) ? t.types : [t]).some((d) => present(d))) ||
        (cat.direct ?? []).some((d) => present(d));
      if (visible) {
        out.push({ kind: 'category', version: element.version, source: element.source, catId: cat.id, label: cat.label, icon: cat.icon });
      }
    }
    return out;
  }

  private async getClassicTypes(element: CategoryNode): Promise<AotNode[]> {
    const cat = CLASSIC_CATEGORIES.find((c) => c.id === element.catId);
    if (!cat) {
      return [];
    }
    const index = this.classicCache.get(element.version.fsPath.toLowerCase());
    if (!index) {
      // Cold: mapped types render instantly (zero I/O); the version-level
      // scan verifies behind and reconciles via this adopted instance.
      // Direct elements can't be faked — they arrive with the reconcile.
      void this.getClassicIndex(element.version).then(
        () => this.refreshView(element),
        () => undefined,
      );
      return this.staticTypes(element, cat);
    }
    // Warm: types gate on Ax folder *presence* (no content reads).
    const present = (def: Pick<ClassicTypeDef, 'folders' | 'modelPrefix'>): boolean =>
      this.scopeLocs(index, def.folders, def.modelPrefix).length > 0;
    const out: AotNode[] = [];
    for (const t of cat.types) {
      if (isGroup(t)) {
        if (t.types.some((d) => present(d))) {
          // Children resolve on expand via getClassicGroupTypes — never flat here.
          out.push({ kind: 'group', version: element.version, source: element.source, catId: cat.id, label: t.group, icon: t.icon ?? 'folder' });
        }
      } else if (present(t)) {
        out.push(this.typeNode(element, undefined, t));
      }
    }
    // `direct` folders (reports, services, label files, ...) list elements straight under the category.
    // Types/groups above already returned instantly — direct elements must
    // never block them: warm heads/fulls append now, cold scopes build
    // behind and reconcile via this adopted instance. Memory-off stays
    // foreground (nothing cached to reconcile against).
    if (!this.memOn(element.source)) {
      for (const d of cat.direct ?? []) {
        const folders = d.folders.map((f) => f.toLowerCase());
        const scope = this.scopeRef(element, `direct:${d.label}`, undefined, undefined, d.icon, folders, d.modelPrefix);
        // Loop, not spread: direct scopes hold tens of thousands of elements and
        // push(...60k) blows the call stack (max argument count).
        for (const el of await this.fullElements(element, scope)) {
          out.push(el);
        }
      }
    } else {
      for (const d of cat.direct ?? []) {
        const folders = d.folders.map((f) => f.toLowerCase());
        const scope = this.scopeRef(element, `direct:${d.label}`, undefined, undefined, d.icon, folders, d.modelPrefix);
        const full = this.fullCache.get(scope.key);
        if (full && full.indexAt === index.at) {
          for (const el of full.nodes) {
            out.push(el);
          }
          continue;
        }
        const head = this.headCache.get(scope.key);
        if (head && head.indexAt === index.at && head.nodes.length > 0) {
          for (const el of head.nodes) {
            out.push(el);
          }
          this.buildFullInBackground(element, scope, index);
          continue;
        }
        // Cold direct scope: types render now, elements stream in on refresh.
        this.buildFullInBackground(element, scope, index);
      }
    }
    // Priority prefetch: this category's own heads jump the version-wide queue.
    void this.prefetchCategory(element).catch(() => undefined);
    return out;
  }

  /** All mapped types/groups of a category, no I/O — reconciled on index arrival. */
  private staticTypes(element: CategoryNode, cat: (typeof CLASSIC_CATEGORIES)[number]): AotNode[] {
    const out: AotNode[] = [];
    for (const t of cat.types) {
      if (isGroup(t)) {
        out.push({ kind: 'group', version: element.version, source: element.source, catId: cat.id, label: t.group, icon: t.icon ?? 'folder' });
      } else {
        out.push(this.typeNode(element, undefined, t));
      }
    }
    return out;
  }

  /** Icon for an intermediate group node (mapping or `folder` fallback). */
  private groupIcon(catId: string, group: string): string {
    const cat = CLASSIC_CATEGORIES.find((c) => c.id === catId);
    const def = cat?.types.find((t) => isGroup(t) && t.group === group);
    return (def && isGroup(def) && def.icon) || 'folder';
  }

  private async getClassicGroupTypes(element: GroupNode): Promise<ElemTypeNode[]> {
    const cat = CLASSIC_CATEGORIES.find((c) => c.id === element.catId);
    const group = cat?.types.find((t) => isGroup(t) && t.group === element.label);
    if (!cat || !group || !isGroup(group)) {
      return [];
    }
    const index = this.classicCache.get(element.version.fsPath.toLowerCase());
    if (!index) {
      // Cold: mapped subtypes render instantly; reconcile on index arrival.
      void this.getClassicIndex(element.version).then(
        () => this.refreshView(element),
        () => undefined,
      );
      return group.types.map((d) => this.typeNode(element, group.group, d));
    }
    const out: ElemTypeNode[] = [];
    for (const d of group.types) {
      if (this.scopeLocs(index, d.folders, d.modelPrefix).length > 0) {
        out.push(this.typeNode(element, group.group, d));
      }
    }
    // Priority prefetch for the group's scopes (same reasoning as categories).
    void this.prefetchCategory(element).catch(() => undefined);
    return out;
  }

  private async getClassicElements(element: ElemTypeNode): Promise<ElementNode[]> {
    const scope = this.scopeRef(element, `${element.group ?? ''}~${element.label}`, element.group, element.label, element.icon, element.folders, element.modelPrefix);
    return this.fullElements(element, scope);
  }

  private scopeRef(
    parent: CategoryNode | GroupNode | ElemTypeNode,
    scope: string,
    group: string | undefined,
    typeLabel: string | undefined,
    typeIcon: string | undefined,
    folders: string[],
    modelPrefix?: string,
  ): ScopeRef {
    return {
      key: AotTreeProvider.scopeKey(parent.version, parent.catId, scope, folders, modelPrefix),
      version: parent.version,
      source: parent.source,
      catId: parent.catId,
      group,
      typeLabel,
      typeIcon,
      folders,
      modelPrefix,
    };
  }

  private static scopeKey(
    version: DiscoveredVersion,
    catId: string,
    scope: string,
    folders: string[],
    modelPrefix?: string,
  ): string {
    return `${version.fsPath.toLowerCase()}|${catId}|${scope}|${folders.join('+')}|${modelPrefix?.toLowerCase() ?? ''}`;
  }

  /**
   * Complete element list for a scope. Served from cache when warm; a cached
   * eager head renders instantly while the rest loads in the background;
   * otherwise the full list builds in the foreground.
   */
  private async fullElements(
    parent: CategoryNode | ElemTypeNode,
    scope: ScopeRef,
  ): Promise<ElementNode[]> {
    const index = await this.getClassicIndex(parent.version);
    const full = this.fullCache.get(scope.key);
    if (full && full.indexAt === index.at) {
      return full.nodes;
    }
    const head = this.headCache.get(scope.key);
    if (head && head.indexAt === index.at && head.nodes.length > 0) {
      this.buildFullInBackground(parent, scope, index);
      return head.nodes;
    }
    if (this.pendingFull.has(scope.key)) {
      // A build is already streaming; its reconcile lands the rows.
      return [];
    }
    // Cold scope: bound the foreground wait so every foldout stays instant.
    // Slow builds stream in behind and reconcile via the adopted parent.
    this.pendingFull.add(scope.key);
    const build = this.buildFull(scope, index);
    const done = build.finally(() => this.pendingFull.delete(scope.key));
    const winner = await Promise.race([
      done.then((rows) => ({ rows: rows as ElementNode[] | undefined })),
      AotTreeProvider.delay(AotTreeProvider.FULL_BUILD_GRACE_MS).then(() => ({
        rows: undefined as ElementNode[] | undefined,
      })),
    ]);
    if (winner.rows) {
      return winner.rows;
    }
    if (!this.memOn(scope.source)) {
      // Nothing is cached to reconcile against — keep today's foreground wait.
      return done;
    }
    void done.then(
      () => this.onDidChangeTreeDataEmitter.fire(parent),
      () => undefined,
    );
    return [];
  }

  private async buildFull(scope: ScopeRef, index: ClassicIndex): Promise<ElementNode[]> {
    const { perDir } = await this.countTypeFiles(index, scope.folders, scope.modelPrefix);
    const nodes = await this.elementNodes(scope, perDir, Number.POSITIVE_INFINITY);
    if (this.memOn(scope.source)) {
      this.fullCache.set(scope.key, { indexAt: index.at, nodes });
    }
    return nodes;
  }

  private buildFullInBackground(
    parent: CategoryNode | ElemTypeNode,
    scope: ScopeRef,
    index: ClassicIndex,
  ): void {
    if (this.pendingFull.has(scope.key)) {
      return;
    }
    this.pendingFull.add(scope.key);
    void this.buildFull(scope, index).finally(() => {
      this.pendingFull.delete(scope.key);
      // Cache-freshness is guarded by indexAt checks on read; a stale write
      // after refresh is simply ignored on the next getChildren.
      this.onDidChangeTreeDataEmitter.fire(parent);
    });
  }

  /**
   * Eager +1: prefetch the first N (`prefetchCount`) elements of every type
   * and direct scope in this version in parallel, unless disabled via
   * `d365fo.aot.eagerLoad`. Runs at version expand so type nodes AND direct
   * categories (labels, reports, ...) are warm before the user opens them.
   * Scopes smaller than N complete outright into the full cache.
   */
  private async prefetchHeads(element: VersionNode): Promise<void> {
    const count = this.prefetchCount();
    if (count === 0) {
      return;
    }
    const index = await this.getClassicIndex(element.version);
    const defs: PrefetchDef[] = [];
    for (const cat of CLASSIC_CATEGORIES) {
      defs.push(...this.categoryDefs(cat));
    }
    await this.prefetchScopes(element.version, element.source, defs, index, count);
  }

  /**
   * Priority prefetch: when a category (or group) opens, its own scopes jump
   * the queue — the version-wide pass may still be grinding through earlier
   * categories. Shares single-flighted listings, skips warm scopes.
   */
  private async prefetchCategory(element: CategoryNode | GroupNode): Promise<void> {
    const count = this.prefetchCount();
    if (count === 0) {
      return;
    }
    const cat = CLASSIC_CATEGORIES.find((c) => c.id === element.catId);
    if (!cat) {
      return;
    }
    const index = await this.getClassicIndex(element.version);
    const defs =
      element.kind === 'group'
        ? this.groupDefs(cat, element.label)
        : this.categoryDefs(cat);
    await this.prefetchScopes(element.version, element.source, defs, index, count);
  }

  private prefetchCount(): number {
    const config = vscode.workspace.getConfiguration('d365fo.aot');
    if (!config.get<boolean>('eagerLoad', true)) {
      return 0;
    }
    return Math.max(0, config.get<number>('prefetchCount', 500) ?? 500);
  }

  private categoryDefs(cat: (typeof CLASSIC_CATEGORIES)[number]): PrefetchDef[] {
    const defs: PrefetchDef[] = [];
    for (const t of cat.types) {
      if (isGroup(t)) {
        defs.push(...this.groupDefs(cat, t.group));
      } else {
        defs.push({
          catId: cat.id,
          scope: `~${t.label}`,
          label: t.label,
          typeLabel: t.label,
          typeIcon: t.icon,
          folders: t.folders.map((f) => f.toLowerCase()),
          modelPrefix: t.modelPrefix,
        });
      }
    }
    for (const d of cat.direct ?? []) {
      defs.push({
        catId: cat.id,
        scope: `direct:${d.label}`,
        label: d.label,
        typeIcon: d.icon,
        folders: d.folders.map((f) => f.toLowerCase()),
        modelPrefix: d.modelPrefix,
      });
    }
    return defs;
  }

  private groupDefs(
    cat: (typeof CLASSIC_CATEGORIES)[number],
    group: string,
  ): PrefetchDef[] {
    const def = cat.types.find((t) => isGroup(t) && t.group === group);
    if (!def || !isGroup(def)) {
      return [];
    }
    return def.types.map((d) => ({
      catId: cat.id,
      scope: `${group}~${d.label}`,
      group,
      label: d.label,
      typeLabel: d.label,
      typeIcon: d.icon,
      folders: d.folders.map((f) => f.toLowerCase()),
      modelPrefix: d.modelPrefix,
    }));
  }

  private async prefetchScopes(
    version: DiscoveredVersion,
    source: VersionSource,
    defs: PrefetchDef[],
    index: ClassicIndex,
    count: number,
  ): Promise<void> {
    const parentFor = (catId: string): CategoryNode => {
      const cat = CLASSIC_CATEGORIES.find((c) => c.id === catId);
      return { kind: 'category', version, source, catId, label: cat?.label ?? catId, icon: cat?.icon ?? 'folder' };
    };
    const jobs = defs.map(({ catId, scope, group, typeLabel, typeIcon, folders, modelPrefix }) => async () => {
      // Per-job isolation: one bad scope must never abort the remaining queue
      // (previously a single throw in an 8-chunk killed every scope after it).
      try {
        const ref = this.scopeRef(parentFor(catId), scope, group, typeLabel, typeIcon, folders, modelPrefix);
        if ((this.fullCache.get(ref.key)?.indexAt ?? -1) === index.at) {
          return;
        }
        if ((this.headCache.get(ref.key)?.indexAt ?? -1) === index.at) {
          return;
        }
        const { total, perDir } = await this.countTypeFiles(index, folders, modelPrefix);
        if (!this.memOn(source)) {
          return;
        }
        const nodes = await this.elementNodes(ref, perDir, count);
        if (total <= count) {
          this.fullCache.set(ref.key, { indexAt: index.at, nodes });
        } else {
          this.headCache.set(ref.key, { indexAt: index.at, nodes });
        }
      } catch {
        // Unresolved scope stays cold; its expand falls back to foreground build.
      }
    });
    for (let i = 0; i < jobs.length; i += 8) {
      await Promise.all(jobs.slice(i, i + 8).map((j) => j()));
      await AotTreeProvider.tick();
    }
  }

  /** Scope definitions for search/prefetch: whole version, one category, or one group. */
  public scopeDefs(catId?: string, group?: string): PrefetchDef[] {
    if (catId) {
      const cat = CLASSIC_CATEGORIES.find((c) => c.id === catId);
      if (!cat) {
        return [];
      }
      return group ? this.groupDefs(cat, group) : this.categoryDefs(cat);
    }
    return CLASSIC_CATEGORIES.flatMap((cat) => this.categoryDefs(cat));
  }

  private searchKey(version: DiscoveredVersion, defs: PrefetchDef[]): string {
    return `${version.fsPath.toLowerCase()}|search|${defs.map((d) => `${d.catId}${d.scope}${d.folders.join(',')}${d.modelPrefix ?? ''}`).join(';')}`;
  }

  /**
   * Invisible full-version search index: every mapped scope collected into
   * the search cache in the background (chunked, yielded, single-flighted).
   * Later searches — any scope — then hit cache instead of the disk.
   * No refresh fires; the UI reads whatever is warm whenever it asks.
   */
  private async ensureSearchIndex(element: VersionNode): Promise<void> {
    if (this.prefetchCount() === 0) {
      return;
    }
    const version = element.version;
    const defs = this.scopeDefs();
    const key = this.searchKey(version, defs);
    const hit = this.searchCache.get(key);
    if (hit || this.pendingSearch.has(key)) {
      return;
    }
    this.pendingSearch.add(key);
    try {
      await this.collectSearchEntries(version, defs, undefined, undefined, element.source);
    } catch {
      // Search stays cold; expands and explicit searches build foreground.
    } finally {
      this.pendingSearch.delete(key);
    }
  }
  /**
   * Name-only element entries for a version (never file content). Warms the
   * same single-flighted listing cache the tree uses; results are cached per
   * scope. Throws `SearchAbortedError` when `shouldAbort` trips.
   */
  public async collectSearchEntries(
    version: DiscoveredVersion,
    defs: PrefetchDef[],
    shouldAbort?: () => boolean,
    onProgress?: (done: number, total: number, label: string) => void,
    source?: VersionSource,
  ): Promise<SearchEntry[]> {
    const key = this.searchKey(version, defs);
    const cached = this.searchCache.get(key);
    if (cached) {
      return cached.entries;
    }
    const index = await this.getClassicIndex(version);
    const out: SearchEntry[] = [];
    let done = 0;
    for (const def of defs) {
      if (shouldAbort?.()) {
        throw new SearchAbortedError();
      }
      try {
        const { perDir } = await this.countTypeFiles(index, def.folders, def.modelPrefix);
        let built = 0;
        for (const row of perDir) {
          for (const file of row.files) {
            const label = elementLabel(file);
            out.push({
              label,
              labelLower: label.toLowerCase(),
              model: row.model.name,
              typeLabel: def.label,
              versionName: version.name,
              fsPath: path.join(row.dir, file),
            });
            // Breathe during giant scopes so background indexing never freezes the tree.
            if ((++built & 32767) === 0) {
              await AotTreeProvider.tick();
            }
          }
        }
      } catch {
        // Unreadable scope contributes nothing; the rest still search.
      }
      done++;
      onProgress?.(done, defs.length, def.label);
      if (done % 4 === 0) {
        await AotTreeProvider.tick();
      }
    }
    // No global sort by design: sorting ~364k entries with localeCompare
    // blocks the event loop for seconds, freezing every tree expand behind
    // a spinner. Entries stay in deterministic scope-collection order
    // (category/type order, per-directory listing order); the search
    // QuickPick partitions prefix matches first and caps at 300, so it never
    // needed global order.
    if (!source || this.memOn(source)) {
      this.searchCache.set(key, { at: Date.now(), entries: out });
    }
    return out;
  }

  /** Concurrent EDT resolutions (libuv fs pool is tiny — never storm it). */
  private static readonly EDT_POOL_WIDTH = 8;

  /**
   * Resolve every field-like row of one table to its primitive (explicit
   * "Resolve Field Types" traversal, never automatic). The field's own
   * `i:type` discriminator answers most rows with zero EDT reads; the rest
   * resolve through one EDT-file hop (`i:type` there too — never chains).
   * Group and index members reference root fields by `DataField` name.
   * Results land in the session memo (consumed at render, dropped on
   * refresh); partial results are kept when `shouldAbort` trips. Throws
   * `SearchAbortedError`.
   */
  public async collectFieldPrimitives(
    version: DiscoveredVersion,
    tableFsPath: string,
    onProgress?: (done: number, total: number) => void,
    shouldAbort?: () => boolean,
  ): Promise<{ resolved: number; total: number }> {
    const vKey = version.fsPath.toLowerCase();
    const tKey = `${vKey}|${tableFsPath.toLowerCase()}`;
    const refs = await this.readTableFieldRefs(tableFsPath);
    const labels = [...refs.keys()];
    const done = new Map<string, FieldResolution>();
    const fail = (err: unknown): void => {
      this.fieldPrimitiveCache.set(tKey, new Map(done));
      if (err instanceof SearchAbortedError) {
        throw err;
      }
    };
    try {
      if (shouldAbort?.()) {
        throw new SearchAbortedError();
      }
      const index = await this.getClassicIndex(version);
      // Direct answers first (no I/O): the field's own i:type, enums, sizes.
      // An EDT read still follows when the primitive or the size is missing.
      const edtJobs = new Map<string, string[]>();
      const queueJob = (edt: string, label: string): void => {
        const list = edtJobs.get(edt);
        if (list) {
          list.push(label);
        } else {
          edtJobs.set(edt, [label]);
        }
      };
      for (const [label, ref] of refs) {
        if (ref.prim && ref.size) {
          done.set(label, { prim: ref.prim, size: ref.size });
        } else if (ref.edt) {
          queueJob(ref.edt, label);
        } else if (ref.prim) {
          done.set(label, { prim: ref.prim });
        } else {
          done.set(label, { prim: null });
        }
        onProgress?.(done.size, labels.length);
      }
      const names = [...edtJobs.keys()];
      for (let i = 0; i < names.length; i += AotTreeProvider.EDT_POOL_WIDTH) {
        if (shouldAbort?.()) {
          throw new SearchAbortedError();
        }
        const rows = await Promise.all(
          names.slice(i, i + AotTreeProvider.EDT_POOL_WIDTH).map(async (edt) => {
            try {
              return { edt, info: await this.resolveEdtInfo(version, index, edt) };
            } catch {
              return { edt, info: { prim: null } as FieldResolution };
            }
          }),
        );
        for (const { edt, info } of rows) {
          for (const label of edtJobs.get(edt) ?? []) {
            const own = refs.get(label);
            done.set(label, {
              prim: own?.prim ?? info.prim,
              size: own?.size ?? info.size,
            });
          }
          onProgress?.(done.size, labels.length);
        }
        await AotTreeProvider.tick();
      }
    } catch (e) {
      fail(e);
      throw e;
    }
    this.fieldPrimitiveCache.set(tKey, new Map(done));
    let resolved = 0;
    for (const r of done.values()) {
      if (r.prim) {
        resolved++;
      }
    }
    return { resolved, total: labels.length };
  }

  /**
   * Field label → type evidence for one table file. Root fields carry their
   * own `i:type` (+ optional EDT/size); group/index members (`DataField`
   * only) inherit their root field's evidence.
   */
  private async readTableFieldRefs(
    tableFsPath: string,
  ): Promise<Map<string, { prim?: FieldPrimitive | null; edt?: string; enum?: string; size?: string; label?: string }>> {
    const out = new Map<string, { prim?: FieldPrimitive | null; edt?: string; enum?: string; size?: string; label?: string }>();
    const root = await parseElementXml(tableFsPath);
    if (!root) {
      return out;
    }
    const textOf = (node: DomElement, tag: string): string | undefined => {
      const text = childElements(node).find((c) => tagOf(c) === tag)?.textContent?.trim();
      return text ? text : undefined;
    };
    const attrOf = (node: DomElement, name: string): string | undefined => {
      const get = (node as unknown as { getAttribute?: (n: string) => string | null }).getAttribute;
      if (typeof get !== 'function') {
        return undefined;
      }
      try {
        return get.call(node, name) ?? undefined;
      } catch {
        return undefined;
      }
    };
    const refOf = (node: DomElement): { prim?: FieldPrimitive; edt?: string; enum?: string; size?: string; label?: string } => {
      const iType = attrOf(node, 'i:type')?.toLowerCase();
      const prim = (iType && TYPE_TAG_PRIMITIVES[iType]) || undefined;
      const enumName = textOf(node, 'EnumType');
      const label = textOf(node, 'Label');
      if (prim) {
        return { prim, edt: textOf(node, 'ExtendedDataType')?.toLowerCase(), enum: enumName, size: textOf(node, 'StringSize'), label };
      }
      if (enumName) {
        return { prim: 'Enum', edt: textOf(node, 'ExtendedDataType')?.toLowerCase(), enum: enumName, size: textOf(node, 'StringSize'), label };
      }
      const edt = textOf(node, 'ExtendedDataType');
      if (edt) {
        return { edt: edt.toLowerCase(), size: textOf(node, 'StringSize'), label };
      }
      if (childElements(node).some((c) => tagOf(c) === 'StringSize')) {
        return { prim: 'String', size: textOf(node, 'StringSize'), label };
      }
      return label ? { label } : {};
    };
    const rootFields = new Map<string, { prim?: FieldPrimitive | null; edt?: string; enum?: string; size?: string }>();
    const fieldsEl = childElements(root).find((c) => tagOf(c) === 'Fields');
    if (fieldsEl) {
      for (const field of childElements(fieldsEl)) {
        const name = textOf(field, 'Name');
        if (!name) {
          continue;
        }
        const ref = refOf(field);
        rootFields.set(name.toLowerCase(), ref);
        if (!out.has(name.toLowerCase())) {
          out.set(name.toLowerCase(), ref);
        }
      }
    }
    // Group/index members name a root field via `DataField`.
    for (const section of ['FieldGroups', 'Indexes']) {
      const sectionEl = childElements(root).find((c) => tagOf(c) === section);
      if (!sectionEl) {
        continue;
      }
      const walk = (node: DomElement): void => {
        for (const child of childElements(node)) {
          const dataField = textOf(child, 'DataField');
          if (dataField && !out.has(dataField.toLowerCase())) {
            out.set(dataField.toLowerCase(), rootFields.get(dataField.toLowerCase()) ?? { prim: null });
          }
          walk(child);
        }
      };
      walk(sectionEl);
    }
    return out;
  }

  /**
   * One EDT name → primitive + size. The primitive comes from the file's own
   * `i:type` (every EDT self-declares); the size is nearest-wins up the
   * `Extends` chain (cap 6, cycle-guarded — 2,936 string EDTs inherit their
   * size from an ancestor, e.g. CNPJNum_BR via CNPJCPFNum_BR = 20). Falls
   * back to the kernel map for file-less system names; null when
   * unresolvable. Memoized.
   */
  private async resolveEdtInfo(
    version: DiscoveredVersion,
    index: ClassicIndex,
    edtLower: string,
  ): Promise<FieldResolution> {
    const vKey = version.fsPath.toLowerCase();
    const sys = SYSTEM_EDT_PRIMITIVES[edtLower];
    if (sys) {
      return { prim: sys };
    }
    const memo = this.edtPrimitiveCache.get(vKey)?.get(edtLower);
    if (memo) {
      return memo;
    }
    let info: FieldResolution = { prim: null };
    const seen = new Set<string>();
    let cur: string | undefined = edtLower;
    let depth = 0;
    while (cur && !seen.has(cur) && depth < 6) {
      seen.add(cur);
      depth++;
      const file = await this.readEdtFile(index, cur);
      if (!file) {
        break;
      }
      if (!info.prim) {
        const prim = (file.iType && TYPE_TAG_PRIMITIVES[file.iType.toLowerCase()]) || undefined;
        if (prim) {
          info = { ...info, prim };
        } else if (file.enumType) {
          info = { ...info, prim: 'Enum' };
        }
      }
      if (!info.size && file.size) {
        info = { ...info, size: file.size };
      }
      if (!info.label && file.label) {
        info = { ...info, label: file.label };
      }
      if (info.prim && info.prim !== 'String') {
        break; // Only strings can still gain a size further up.
      }
      if (info.prim && info.size) {
        break;
      }
      cur = file.extends;
    }
    let table = this.edtPrimitiveCache.get(vKey);
    if (!table) {
      table = new Map();
      this.edtPrimitiveCache.set(vKey, table);
    }
    table.set(edtLower, info);
    return info;
  }

  /**
   * Full type travel for one table field: the EDT chain hop by hop (each
   * with its storage class, size, label and model) plus the terminal enum's
   * options (top 10). Selection-driven by the Fields grid — on demand, never
   * automatic. Depth-capped (6, the observed corpus max), cycle-guarded,
   * memoized per version+table+field.
   */
  public async fieldTravel(
    version: DiscoveredVersion,
    tableFsPath: string,
    fieldLabel: string,
  ): Promise<FieldTravel | undefined> {
    const vKey = version.fsPath.toLowerCase();
    const tKey = `${vKey}|${tableFsPath.toLowerCase()}|${fieldLabel.toLowerCase()}`;
    const cached = this.travelCache.get(tKey);
    if (cached) {
      return cached;
    }
    const refs = await this.readTableFieldRefs(tableFsPath);
    const ref = refs.get(fieldLabel.toLowerCase());
    if (!ref?.edt && !ref?.enum) {
      return undefined;
    }
    const index = await this.getClassicIndex(version);
    const { hops, enumName } = await this.walkEdtChain(index, ref.edt, ref.enum);
    let enumValues: FieldTravelEnumValue[] | undefined;
    let enumTotal: number | undefined;
    let enumTruncated: boolean | undefined;
    if (enumName) {
      const all = await this.enumOptions(index, enumName);
      if (all) {
        enumTotal = all.length;
        enumValues = all.slice(0, 10);
        enumTruncated = all.length > 10;
      }
    }
    if (hops.length === 0 && !enumName) {
      return undefined;
    }
    const travel: FieldTravel = {
      field: fieldLabel,
      edt: ref.edt ?? '',
      hops,
      enumName,
      enumValues,
      enumTotal,
      enumTruncated,
    };
    this.travelCache.set(tKey, travel);
    return travel;
  }

  /**
   * Walk an EDT chain from a starting type, one hop per level. Shared by table
   * field travel and view field travel — both end up in the same EDT files, so
   * one implementation and one memo warm both surfaces.
   *
   * A direct field EnumType (e.g. kernel `NoYes` with no file) still yields an
   * enum panel when a file exists; otherwise the travel is just the enum.
   * Depth-capped (6, the observed corpus max) and cycle-guarded.
   */
  private async walkEdtChain(
    index: ClassicIndex,
    startEdt: string | undefined,
    startEnum: string | undefined,
  ): Promise<{ hops: FieldTravelHop[]; enumName?: string }> {
    const hops: FieldTravelHop[] = [];
    const seen = new Set<string>();
    let cur = startEdt;
    let enumName = startEnum;
    while (cur && !seen.has(cur) && hops.length < 6) {
      seen.add(cur);
      const file = await this.readEdtFile(index, cur);
      if (!file) {
        // Kernel tail (e.g. `Money`): Extends target with no metadata file.
        hops.push({ edt: cur, kernel: true, terminal: true });
        break;
      }
      hops.push({
        edt: cur,
        iType: file.iType,
        size: file.size,
        label: file.label,
        model: file.model,
      });
      if (file.enumType) {
        enumName ??= file.enumType;
        break;
      }
      cur = file.extends;
    }
    if (hops.length > 0 && !hops[hops.length - 1].terminal) {
      hops[hops.length - 1].terminal = true;
    }
    return { hops, enumName };
  }

  /**
   * One view or data entity field, exactly as its own file declares it.
   *
   * A view field is not a storage field: it either carries its own type
   * (computed / unmapped — `ExtendedDataType` or `EnumType` right here) or it
   * binds to a column of a data source, and *that* column's type lives in
   * another element. `dataSource` / `dataField` are the two halves of the
   * binding; the rest of the chain is resolved on demand.
   */
  private async readViewFieldRefs(
    viewFsPath: string,
  ): Promise<Map<string, ViewFieldRef>> {
    const key = viewFsPath.toLowerCase();
    const hit = this.viewRefCache.get(key);
    if (hit) {
      return hit;
    }
    const pending = (async (): Promise<Map<string, ViewFieldRef>> => {
      const out = new Map<string, ViewFieldRef>();
      const root = await parseElementXml(viewFsPath);
      if (root) {
        const fieldsEl = childElements(root).find((c) => tagOf(c) === 'Fields');
        for (const field of childElements(fieldsEl ?? root)) {
          const name = elementText(field, 'Name');
          if (!name || childElements(field).length === 0) {
            continue;
          }
          const attrOf = (node: DomElement, attribute: string): string | undefined => {
            const get = (node as unknown as { getAttribute?: (n: string) => string | null }).getAttribute;
            if (typeof get !== 'function') {
              return undefined;
            }
            try {
              return get.call(node, attribute)?.toLowerCase() ?? undefined;
            } catch {
              return undefined;
            }
          };
          const iType = attrOf(field, 'i:type');
          const enumName = elementText(field, 'EnumType');
          out.set(name.toLowerCase(), {
            name,
            dataSource: elementText(field, 'DataSource'),
            dataField: elementText(field, 'DataField'),
            iType,
            prim: (iType && TYPE_TAG_PRIMITIVES[iType]) || undefined,
            edt: elementText(field, 'ExtendedDataType')?.toLowerCase(),
            edtLabel: elementText(field, 'ExtendedDataType') ?? enumName,
            enum: enumName,
            size: elementText(field, 'StringSize'),
            label: elementText(field, 'Label'),
          });
        }
      }
      return out;
    })();
    this.viewRefCache.set(key, pending);
    return pending;
  }

  /**
   * Data source alias → backing table, from the view's own `ViewMetadata`.
   *
   * Read straight from the file rather than through the metadata outline: the
   * grid needs the `Name` → `Table` mapping, and the outline has already thrown
   * that pairing away. A view whose `DataSources` block is empty therefore
   * resolves nothing, and its fields report `N/A` instead of pretending.
   */
  private async readViewDataSources(viewFsPath: string): Promise<Map<string, string>> {
    const key = viewFsPath.toLowerCase();
    const hit = this.viewDataSourceCache.get(key);
    if (hit) {
      return hit;
    }
    const pending = (async (): Promise<Map<string, string>> => {
      const out = new Map<string, string>();
      const root = await parseElementXml(viewFsPath);
      const vm = root && childElements(root).find((c) => tagOf(c) === 'ViewMetadata');
      const dsRoot = vm && childElements(vm).find((c) => tagOf(c) === 'DataSources');
      const walk = (ds: DomElement): void => {
        const alias = elementText(ds, 'Name');
        const table = elementText(ds, 'Table');
        if (alias && table) {
          out.set(alias.toLowerCase(), table);
        }
        for (const nest of ['DataSources', 'DerivedDataSources', 'ReferencedDataSources']) {
          const container = childElements(ds).find((c) => tagOf(c) === nest);
          if (container) {
            for (const sub of childElements(container)) {
              walk(sub);
            }
          }
        }
      };
      if (dsRoot) {
        for (const ds of childElements(dsRoot)) {
          walk(ds);
        }
      }
      return out;
    })();
    this.viewDataSourceCache.set(key, pending);
    return pending;
  }

  /**
   * One table/view/entity column, resolved from the element file that owns it.
   *
   * Searched across the three element kinds a data source can point at, so the
   * chain can cross from a view into a view. When the column turns out to be
   * another view's bound field, its own binding is returned too so the caller
   * can follow it.
   */
  private async readColumnRef(
    index: ClassicIndex,
    versionKey: string,
    tableName: string,
    columnName: string,
  ): Promise<
    | {
        edt?: string;
        edtLabel?: string;
        enum?: string;
        size?: string;
        label?: string;
        prim?: FieldPrimitive;
        ownerFile?: string;
        dataSource?: string;
        dataField?: string;
      }
    | undefined
  > {
    // A view typically binds many fields to the same table, and the same column
    // can be bound by several views — resolve each pair once per version.
    const cKey = `${versionKey}|${tableName.toLowerCase()}|${columnName.toLowerCase()}`;
    const memo = this.columnRefCache.get(cKey);
    if (memo !== undefined) {
      return memo;
    }
    const column = await this.readColumnRefUncached(index, tableName, columnName);
    this.columnRefCache.set(cKey, column);
    return column;
  }

  private async readColumnRefUncached(
    index: ClassicIndex,
    tableName: string,
    columnName: string,
  ): Promise<
    | {
        edt?: string;
        edtLabel?: string;
        enum?: string;
        size?: string;
        label?: string;
        prim?: FieldPrimitive;
        ownerFile?: string;
        dataSource?: string;
        dataField?: string;
      }
    | undefined
  > {
    const target = tableName.toLowerCase();
    const column = columnName.toLowerCase();
    for (const loc of this.scopeLocs(index, ['AxTable', 'AxView', 'AxDataEntityView'])) {
      const files = await this.listElementFiles(index, loc.dir);
      const hit = files.find((f) => elementLabel(f).toLowerCase() === target);
      if (!hit) {
        continue;
      }
      const ownerFile = path.join(loc.dir, hit);
      let root: DomElement | undefined;
      try {
        root = await parseElementXml(ownerFile);
      } catch {
        return undefined;
      }
      if (!root) {
        return undefined;
      }
      const fieldsEl = childElements(root).find((c) => tagOf(c) === 'Fields');
      for (const field of childElements(fieldsEl ?? root)) {
        if ((elementText(field, 'Name') ?? '').toLowerCase() !== column) {
          continue;
        }
        const attrOf = (node: DomElement, attribute: string): string | undefined => {
          const get = (node as unknown as { getAttribute?: (n: string) => string | null }).getAttribute;
          if (typeof get !== 'function') {
            return undefined;
          }
          try {
            return get.call(node, attribute)?.toLowerCase() ?? undefined;
          } catch {
            return undefined;
          }
        };
        const iType = attrOf(field, 'i:type');
        const enumName = elementText(field, 'EnumType');
        const edtLabel = elementText(field, 'ExtendedDataType');
        return {
          edt: edtLabel?.toLowerCase(),
          edtLabel: edtLabel ?? enumName,
          enum: enumName,
          size: elementText(field, 'StringSize'),
          label: elementText(field, 'Label'),
          prim: (iType && TYPE_TAG_PRIMITIVES[iType]) || (enumName ? 'Enum' : undefined),
          ownerFile,
          dataSource: elementText(field, 'DataSource'),
          dataField: elementText(field, 'DataField'),
        };
      }
      return undefined;
    }
    return undefined;
  }

  /**
   * One hop of a view field's binding: data source → backing table → column.
   *
   * A backing column is often itself a view field (a view over a view), in which
   * case its own binding is followed too — bounded by `MAX_BINDING_DEPTH` and a
   * visited set, so a cycle or a deep nest reports a gap instead of hanging.
   */
  private async followBinding(
    version: DiscoveredVersion,
    viewFsPath: string,
    dataSource: string,
    dataField: string,
    depth: number,
    seen: Set<string>,
  ): Promise<Partial<ViewFieldTravel>> {
    const dataSources = await this.readViewDataSources(viewFsPath);
    const table = dataSources.get(dataSource.toLowerCase());
    if (!table) {
      return { gap: 'no-metadata' };
    }
    const index = await this.getClassicIndex(version);
    const versionKey = version.fsPath.toLowerCase();
    const column = await this.readColumnRef(index, versionKey, table, dataField);
    if (!column) {
      return { table, gap: 'no-column' };
    }
    if (column.edt || column.enum || column.prim) {
      return {
        table,
        startEdt: column.edt,
        startEnum: column.enum,
        typeLabel: column.edtLabel,
        typeLabelId: column.label,
        prim: column.prim,
        size: column.size,
      };
    }
    const via = `${table}.${dataField}`;
    if (column.ownerFile && column.dataSource && column.dataField && depth < MAX_BINDING_DEPTH) {
      const key = `${column.ownerFile.toLowerCase()}|${column.dataField.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        const nested = await this.followBinding(
          version,
          column.ownerFile,
          column.dataSource,
          column.dataField,
          depth + 1,
          seen,
        );
        if (nested.startEdt || nested.startEnum || nested.prim) {
          return { ...nested, table, via };
        }        if (nested.gap) {
          return { table, gap: nested.gap, via };
        }
      }
    }
    return { table, gap: 'no-type' };
  }

  /**
   * Follow one view field to its type, as far as the files allow: inline type →
   * data source → backing table → column (and through a column that is itself a
   * view field).
   *
   * Stops at the first hop it cannot prove and reports why, so the grid can say
   * `N/A` rather than leaving a cell that reads like "not looked at".
   */
  private async resolveViewField(
    version: DiscoveredVersion,
    viewFsPath: string,
    field: ViewFieldRef,
  ): Promise<ViewFieldTravel> {
    const chain: ViewFieldTravel = {
      field: field.name,
      dataSource: field.dataSource,
      dataField: field.dataField,
      hops: [],
    };
    // A computed or unmapped field declares its own type right here.
    if (field.edt || field.enum) {
      chain.selfTyped = true;
      chain.startEdt = field.edt;
      chain.startEnum = field.enum;
      chain.typeLabel = field.edtLabel;
      chain.size = field.size;
      return chain;
    }
    if (!field.dataSource || !field.dataField) {
      chain.gap = 'no-binding';
      return chain;
    }
    const followed = await this.followBinding(
      version,
      viewFsPath,
      field.dataSource,
      field.dataField,
      0,
      new Set([`${viewFsPath.toLowerCase()}|${field.name.toLowerCase()}`]),
    );
    chain.table = followed.table;
    chain.gap = followed.gap;
    chain.via = followed.via;
    chain.startEdt = followed.startEdt;
    chain.startEnum = followed.startEnum;
    chain.typeLabel = followed.typeLabel;
    chain.typeLabelId = followed.typeLabelId;
    chain.prim = followed.prim;
    chain.size = followed.size;
    return chain;
  }

  /**
   * Resolved chains for one view, if the "Resolve Field Types" traversal ran.
   * Feeds the view Fields grid's Type/Size columns on open.
   */
  public viewFieldsFor(
    version: DiscoveredVersion,
    viewFsPath: string,
  ): Map<string, ViewFieldTravel> | undefined {
    return this.viewFieldCache.get(
      `${version.fsPath.toLowerCase()}|${viewFsPath.toLowerCase()}`,
    );
  }

  /**
   * Resolve every field of a view, so the grid can show Type and Size for all
   * of them at once. Bounded pool, progress and cancel — same contract as the
   * table traversal, but the work here fans out across the tables the view's
   * data sources point at rather than one file.
   */
  public async resolveViewFieldTypes(
    version: DiscoveredVersion,
    viewFsPath: string,
    onProgress: (done: number, total: number) => void,
    isCancelled: () => boolean,
  ): Promise<void> {
    const refs = await this.readViewFieldRefs(viewFsPath);
    const total = refs.size;
    if (total === 0) {
      return;
    }
    const vKey = version.fsPath.toLowerCase();
    const key = `${vKey}|${viewFsPath.toLowerCase()}`;
    const out = new Map<string, ViewFieldTravel>();
    this.viewFieldCache.set(key, out);
    // Phase 1 — follow each field to its backing column. Column reads are
    // memoized per (version, table, column), so a view binding many fields to
    // the same table costs one file read, not one per field.
    const queue = [...refs.values()];
    let done = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (isCancelled()) {
          throw new SearchAbortedError();
        }
        const field = queue.shift();
        if (!field) {
          return;
        }
        out.set(field.name.toLowerCase(), await this.resolveViewField(version, viewFsPath, field));
        done++;
        onProgress(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, total) }, worker));

    // Phase 2 — a column usually carries a named type but no size: the size
    // lives on the EDT, further up. Resolve each distinct type once and hand
    // the answer to every field that shares it, exactly like the table
    // traversal does. Without this the Size column stays blank after Resolve
    // even though the travel panel can show the size.
    const byEdt = new Map<string, ViewFieldTravel[]>();
    for (const chain of out.values()) {
      if (chain.gap || !chain.startEdt || chain.size) {
        continue;
      }
      const list = byEdt.get(chain.startEdt);
      if (list) {
        list.push(chain);
      } else {
        byEdt.set(chain.startEdt, [chain]);
      }
    }
    if (byEdt.size === 0) {
      return;
    }
    const index = await this.getClassicIndex(version);
    const names = [...byEdt.keys()];
    for (let i = 0; i < names.length; i += AotTreeProvider.EDT_POOL_WIDTH) {
      if (isCancelled()) {
        throw new SearchAbortedError();
      }
      await Promise.all(
        names.slice(i, i + AotTreeProvider.EDT_POOL_WIDTH).map(async (edt) => {
          const info = await this.resolveEdtInfo(version, index, edt);
          for (const chain of byEdt.get(edt) ?? []) {
            chain.size ??= info.size;
            chain.prim ??= info.prim ?? undefined;
            // The type's own label id, when the backing column had none.
            chain.typeLabelId ??= info.label;
          }
        }),
      );
    }
  }

  /**
   * Full chain for one view field: the binding it declares, the table column
   * behind it, then the EDT travel and enum options of that column's type.
   * Selection-driven by the view Fields grid, memoized per field.
   */
  public async viewFieldTravel(
    version: DiscoveredVersion,
    viewFsPath: string,
    fieldLabel: string,
  ): Promise<ViewFieldTravel | undefined> {
    const vKey = version.fsPath.toLowerCase();
    const fKey = `${vKey}|${viewFsPath.toLowerCase()}|${fieldLabel.toLowerCase()}`;
    const cached = this.viewTravelCache.get(fKey);
    if (cached) {
      return cached;
    }
    const refs = await this.readViewFieldRefs(viewFsPath);
    const ref = refs.get(fieldLabel.toLowerCase());
    if (!ref) {
      return undefined;
    }
    const resolved = this.viewFieldCache.get(`${vKey}|${viewFsPath.toLowerCase()}`);
    const chain = resolved?.get(ref.name.toLowerCase()) ?? (await this.resolveViewField(version, viewFsPath, ref));
    if (chain.gap) {
      this.viewTravelCache.set(fKey, chain);
      return chain;
    }
    if (chain.hops.length === 0 && (chain.startEdt || chain.startEnum)) {
      const index = await this.getClassicIndex(version);
      const walked = await this.walkEdtChain(index, chain.startEdt, chain.startEnum);
      chain.hops = walked.hops;
      chain.enumName = walked.enumName;
      if (chain.enumName) {
        const all = await this.enumOptions(index, chain.enumName);
        if (all) {
          chain.enumTotal = all.length;
          chain.enumValues = all.slice(0, 10);
          chain.enumTruncated = all.length > 10;
        }
      }
      // A size carried by the type (or an ancestor of it) is the field's size —
      // same nearest-wins rule the table grid's Resolve uses, so the Size column
      // and the travel panel can never disagree.
      if (!chain.size && chain.startEdt) {
        const info = await this.resolveEdtInfo(version, index, chain.startEdt);
        chain.size = info.size;
        chain.prim ??= info.prim ?? undefined;
        chain.typeLabelId ??= info.label;
      }
    }
    this.viewTravelCache.set(fKey, chain);
    return chain;
  }

  /** One EDT file → storage facts + owning model. Undefined when no file. */
  private async readEdtFile(
    index: ClassicIndex,
    edtLower: string,
  ): Promise<{ iType?: string; extends?: string; enumType?: string; size?: string; label?: string; model?: string } | undefined> {
    for (const loc of this.scopeLocs(index, ['AxEdt'])) {
      const files = await this.listElementFiles(index, loc.dir);
      const hit = files.find((f) => elementLabel(f).toLowerCase() === edtLower);
      if (!hit) {
        continue;
      }
      try {
        const xml = await fs.readFile(path.join(loc.dir, hit), 'utf8');
        const document = new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ''), 'text/xml') as unknown as {
          documentElement?: DomElement | null;
        };
        const edtRoot = document.documentElement ?? undefined;
        if (!edtRoot) {
          return undefined;
        }
        const get = (edtRoot as unknown as { getAttribute?: (n: string) => string | null }).getAttribute;
        const iType = typeof get === 'function' ? get.call(edtRoot, 'i:type') ?? undefined : undefined;
        const textOf = (tag: string): string | undefined => {
          const text = childElements(edtRoot).find((c) => tagOf(c) === tag)?.textContent?.trim();
          return text ? text : undefined;
        };
        return {
          iType: iType ?? undefined,
          extends: textOf('Extends')?.toLowerCase(),
          enumType: textOf('EnumType'),
          size: textOf('StringSize'),
          label: textOf('Label'),
          model: loc.model.name,
        };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Language Resolve translates labels into: `d365fo.aot.resolve.language`,
   * default `en-US`.
   */
  public resolveLanguage(): string {
    const configured = vscode.workspace
      .getConfiguration('d365fo.aot')
      .get<string>('resolve.language');
    return configured?.trim() || DEFAULT_RESOLVE_LANGUAGE;
  }

  /** Whether the Fields grids resolve on selection instead of on the button. */
  public autoResolve(): boolean {
    return vscode.workspace.getConfiguration('d365fo.aot').get<boolean>('autoResolve') === true;
  }

  /**
   * Per `${version}|${language}` map of label text file name → full path.
   *
   * Built lazily and only when a resolve actually needs labels: one readdir per
   * `AxLabelFile` folder (177 per version) to learn which files exist for the
   * language. This is deliberately *not* part of the persisted classic index —
   * there are ~60,000 label-file elements per version and a name lookup needs
   * none of them.
   */
  private async labelFileIndex(
    version: DiscoveredVersion,
    language: string,
  ): Promise<Map<string, string>> {
    const key = `${version.fsPath.toLowerCase()}|${language.toLowerCase()}`;
    const hit = this.labelIndexCache.get(key);
    if (hit) {
      return hit;
    }
    const out = new Map<string, string>();
    for (const model of await this.getModels(version)) {
      for (const loc of await this.findAxFolders(model)) {
        if (loc.ax !== 'axlabelfile') {
          continue;
        }
        const resources = path.join(loc.dir, 'LabelResources');
        let langs: string[];
        try {
          langs = await fs.readdir(resources);
        } catch {
          continue;
        }
        // Folder casing is not consistent across models (`en-US` vs `en-us`).
        for (const lang of langs) {
          if (lang.toLowerCase() !== language.toLowerCase()) {
            continue;
          }
          const dir = path.join(resources, lang);
          let files: string[];
          try {
            files = await fs.readdir(dir);
          } catch {
            continue;
          }
          for (const file of files) {
            if (file.toLowerCase().endsWith('.label.txt')) {
              out.set(file.toLowerCase(), path.join(dir, file));
            }
          }
        }
      }
    }
    this.labelIndexCache.set(key, out);
    return out;
  }

  /**
   * One label text file → `Id=Value` map, cached. Keys are kept verbatim and
   * lower-cased for lookup; a label file spells its ids inconsistently
   * (`@SYS300392=…` next to `CAPAProcessTemplates=…`), so `labelTextOf` tries
   * every plausible spelling.
   */
  private async labelFileEntries(file: string): Promise<Map<string, string>> {
    const hit = this.labelEntriesCache.get(file.toLowerCase());
    if (hit) {
      return hit;
    }
    const out = new Map<string, string>();
    try {
      const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
      for (const line of text.split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 1) {
          continue;
        }
        const key = line.slice(0, eq).trim();
        if (key) {
          out.set(key.toLowerCase(), line.slice(eq + 1).trim());
        }
      }
    } catch {
      // Unreadable label file — every id in it simply stays unresolved.
    }
    this.labelEntriesCache.set(file.toLowerCase(), out);
    return out;
  }

  /**
   * A label id points at a label file by name, so no scan is needed: the word
   * after `@`, with trailing digits stripped, is the label file id
   * (`@FBK67` → `FBK`, `@QMS:CAPAProcessTemplates` → `QMS`) and the text file is
   * `<id>.<language>.label.txt`. Falls back to the base language when a model
   * has no folder for the requested one; undefined means "leave the id alone".
   */
  private async labelTextOf(
    version: DiscoveredVersion,
    language: string,
    labelId: string,
  ): Promise<string | undefined> {
    const bare = labelId.replace(/^@/, '');
    const word = /^[A-Za-z0-9_]+/.exec(bare)?.[0] ?? bare;
    const fileId = word.replace(/\d+$/, '') || word;
    const sep = bare.search(/[.:]/);
    // A label id is spelled several ways inside its own label file.
    const keys = new Set<string>([`@${bare}`.toLowerCase(), bare.toLowerCase()]);
    if (sep > 0) {
      keys.add(bare.slice(sep + 1).toLowerCase());
    }
    const base = language.split('-')[0];
    for (const lang of base && base !== language ? [language, base] : [language]) {
      const index = await this.labelFileIndex(version, lang);
      const file = index.get(`${fileId}.${lang}.label.txt`.toLowerCase());
      if (!file) {
        continue;
      }
      const entries = await this.labelFileEntries(file);
      for (const key of keys) {
        const text = entries.get(key);
        if (text !== undefined) {
          return text;
        }
      }
    }
    return undefined;
  }

  /**
   * Translate label ids into text in the configured language. Ids that have no
   * label file or no entry are left out of the result, so callers keep showing
   * the raw id rather than an empty cell.
   */
  public async translateLabels(
    version: DiscoveredVersion,
    labelIds: Iterable<string>,
    isCancelled?: () => boolean,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const language = this.resolveLanguage();
    const unique = new Map<string, string>();
    for (const id of labelIds) {
      const key = id.toLowerCase();
      if (id && !unique.has(key)) {
        unique.set(key, id);
      }
    }
    const ids = [...unique.keys()];
    for (let i = 0; i < ids.length; i += 8) {
      if (isCancelled?.()) {
        throw new SearchAbortedError();
      }
      const texts = await Promise.all(
        ids.slice(i, i + 8).map((key) => this.labelTextOf(version, language, unique.get(key) ?? key)),
      );
      texts.forEach((text, n) => {
        if (text !== undefined) {
          out.set(ids[i + n], text);
        }
      });
    }
    return out;
  }

  /**
   * Label ids an element contributes: every field's own `<Label>`, plus the
   * label of each resolved type — the latter is what a bound view field
   * inherits, and for a table it is what names the column's own type.
   */
  private async elementLabelIds(fsPath: string): Promise<Set<string>> {
    const out = new Set<string>();
    const refs = await this.readTableFieldRefs(fsPath);
    for (const ref of refs.values()) {
      if (ref.label) {
        out.add(ref.label);
      }
    }
    return out;
  }

  /** Resolve every label of a table field list: field labels and type labels. */
  public async collectTableLabels(
    version: DiscoveredVersion,
    tableFsPath: string,
    isCancelled?: () => boolean,
  ): Promise<Map<string, string>> {
    const ids = await this.elementLabelIds(tableFsPath);
    const memo = this.fieldPrimitiveCache.get(
      `${version.fsPath.toLowerCase()}|${tableFsPath.toLowerCase()}`,
    );
    if (memo) {
      for (const info of memo.values()) {
        if (info.label) {
          ids.add(info.label);
        }
      }
    }
    return this.translateLabels(version, ids, isCancelled);
  }

  /**
   * Resolve every label of a view field list: the field's own `<Label>` and,
   * for a bound field, the label of the type it resolved to. Run after
   * `resolveViewFieldTypes`, which fills the memo this reads.
   */
  public async collectViewLabels(
    version: DiscoveredVersion,
    viewFsPath: string,
    isCancelled?: () => boolean,
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();
    const refs = await this.readViewFieldRefs(viewFsPath);
    for (const ref of refs.values()) {
      if (ref.label) {
        ids.add(ref.label);
      }
    }
    const memo = this.viewFieldCache.get(
      `${version.fsPath.toLowerCase()}|${viewFsPath.toLowerCase()}`,
    );
    if (memo) {
      for (const chain of memo.values()) {
        if (chain.typeLabelId) {
          ids.add(chain.typeLabelId);
        }
      }
    }
    return this.translateLabels(version, ids, isCancelled);
  }

  /**
   * Values of the built-in enums, from `resources/kernel-enums.json`.
   *
   * These are the enums the platform compiles in: 47 of the enums referenced by
   * metadata have no `AxEnum` file anywhere in the installed packages, and they
   * carry 55% of all enum references (`NoYes` among them). The AOS ships each one
   * as an `AxEnum_<Name>.xml` document embedded in
   * `Microsoft.Dynamics.AX.Metadata.dll`, so the list here is generated from that
   * assembly by `scripts/extract-kernel-enums.mjs` and checked in — the extension
   * stays self-contained and needs no AOS at hand. An enum absent from the file is
   * unknown, not empty.
   */
  private async kernelEnumValues(enumLower: string): Promise<FieldTravelEnumValue[] | undefined> {
    if (!this.kernelEnumCache) {
      const out = new Map<string, FieldTravelEnumValue[]>();
      try {
        // `out/` sits next to `resources/` in the repo and in the packaged VSIX.
        const raw = await fs.readFile(path.join(__dirname, '..', 'resources', 'kernel-enums.json'), 'utf8');
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as {
          enums?: Record<string, { id?: string; values?: FieldTravelEnumValue[] } | FieldTravelEnumValue[]>;
        };
        for (const [name, entry] of Object.entries(parsed.enums ?? {})) {
          // Written as `{ id, values }`; a bare array is accepted so an older
          // hand-edited file keeps working.
          const values = Array.isArray(entry) ? entry : entry?.values;
          if (Array.isArray(values) && values.length > 0) {
            out.set(name.toLowerCase(), values);
          }
        }
      } catch {
        // No data file: kernel enums simply report no values.
      }
      this.kernelEnumCache = out;
    }
    return this.kernelEnumCache.get(enumLower);
  }

  /** All options of one enum (document order). Undefined when no file. */
  private async readEnumOptions(
    index: ClassicIndex,
    enumName: string,
  ): Promise<FieldTravelEnumValue[] | undefined> {
    const lower = enumName.toLowerCase();
    for (const loc of this.scopeLocs(index, ['AxEnum'])) {
      const files = await this.listElementFiles(index, loc.dir);
      const hit = files.find((f) => elementLabel(f).toLowerCase() === lower);
      if (!hit) {
        continue;
      }
      try {
        const xml = await fs.readFile(path.join(loc.dir, hit), 'utf8');
        return readEnumValues(xml.replace(/^\uFEFF/, '')).map((r) => ({
          name: r.name,
          label: r.label,
          value: r.value,
        }));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * All options of one enum: its `AxEnum` file when it has one, else the
   * built-in table. Undefined when neither can supply values.
   */
  private async enumOptions(index: ClassicIndex, enumName: string): Promise<FieldTravelEnumValue[] | undefined> {
    return (await this.readEnumOptions(index, enumName)) ?? (await this.kernelEnumValues(enumName.toLowerCase()));
  }

  /**
   * Traversed resolutions for one table (field label → resolution), if the
   * "Resolve Field Types" traversal ran. Feeds the Fields grid Final column.
   */
  public fieldPrimitivesFor(
    version: DiscoveredVersion,
    tableFsPath: string,
  ): Map<string, FieldResolution> | undefined {
    return this.fieldPrimitiveCache.get(
      `${version.fsPath.toLowerCase()}|${tableFsPath.toLowerCase()}`,
    );
  }

  private typeNode(
    parent: CategoryNode | GroupNode,
    group: string | undefined,
    def: ClassicTypeDef,
  ): ElemTypeNode {
    return {
      kind: 'elemtype',
      version: parent.version,
      source: parent.source,
      catId: parent.catId,
      group,
      label: def.label,
      icon: def.icon,
      folders: def.folders.map((f) => f.toLowerCase()),
      modelPrefix: def.modelPrefix,
    };
  }

  private async elementNodes(
    scope: ScopeRef,
    perDir: Array<{ model: DiscoveredModel; dir: string; ax: string; files: string[] }>,
    take: number,
  ): Promise<ElementNode[]> {
    // K-way merge over the per-directory listings (each already sorted by
    // listElementFiles): only the first `take` elements are materialized, so
    // types with 100k+ elements stay fast. Order is fully deterministic
    // (label → model → dir).
    //
    // XppMetadata twins: every element also exists as a signature-only copy
    // under `<Module>/XppMetadata/...` (root `<z:anyType>`, no source). Those
    // rows would duplicate the source row (same label, same model) yet can't
    // preview — drop a metadata copy whenever a source twin exists. Metadata
    // copies WITHOUT a source twin are kept (binary-only content).
    const isMetaDir = (dir: string): boolean => /(^|[\\/])xppmetadata([\\/]|$)/i.test(dir);
    const sourced = new Set<string>();
    for (const row of perDir) {
      if (isMetaDir(row.dir)) {
        continue;
      }
      for (const file of row.files) {
        sourced.add(`${elementLabel(file)}\n${row.model.name}`);
      }
    }
    type Cursor = { row: (typeof perDir)[number]; i: number; label: string };
    const less = (a: Cursor, b: Cursor): boolean => {
      const c = a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
      if (c !== 0) {
        return c < 0;
      }
      if (a.row.model.name !== b.row.model.name) {
        return a.row.model.name < b.row.model.name;
      }
      return a.row.dir < b.row.dir;
    };
    const heap: Cursor[] = [];
    let total = 0;
    for (const row of perDir) {
      total += row.files.length;
      if (row.files.length > 0) {
        heap.push({ row, i: 0, label: elementLabel(row.files[0]) });
      }
    }
    const sink = (i: number): void => {
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && less(heap[left], heap[smallest])) {
          smallest = left;
        }
        if (right < heap.length && less(heap[right], heap[smallest])) {
          smallest = right;
        }
        if (smallest === i) {
          return;
        }
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    };
    for (let i = (heap.length >> 1) - 1; i >= 0; i--) {
      sink(i);
    }
    const nodes: ElementNode[] = [];
    let steps = 0;
    while (heap.length > 0 && nodes.length < take) {
      const top = heap[0];
      const file = top.row.files[top.i];
      const isTwin = isMetaDir(top.row.dir) && sourced.has(`${top.label}\n${top.row.model.name}`);
      if (!isTwin) {
        nodes.push(this.makeElementNode(scope, top.row, file, top.label));
      }
      top.i++;
      if (top.i >= top.row.files.length) {
        heap[0] = heap[heap.length - 1];
        heap.pop();
      } else {
        top.label = elementLabel(top.row.files[top.i]);
      }
      if (heap.length > 0) {
        sink(0);
      }
      // Breathe every few thousand pops so huge merges never freeze the tree.
      if ((++steps & 4095) === 0) {
        await AotTreeProvider.tick();
      }
    }
    return nodes;
  }

  private makeElementNode(
    scope: ScopeRef,
    row: { model: DiscoveredModel; dir: string; ax: string },
    file: string,
    label: string,
  ): ElementNode {
    // Every element carries its origin model as the trailing header (plus an
    // `Extension` marker for extension files), so Base Enums, Classes, etc.
    // all render the same `Name  Model` rows.
    const parts: string[] = [];
    if (isExtensionFolder(row.ax)) {
      parts.push('Extension');
    }
    parts.push(row.model.name);
    return {
      kind: 'element',
      version: scope.version,
      source: scope.source,
      catId: scope.catId,
      group: scope.group,
      typeLabel: scope.typeLabel,
      typeIcon: scope.typeIcon ?? 'file',
      folders: scope.folders,
      modelPrefix: scope.modelPrefix,
      label,
      fsPath: path.join(row.dir, file),
      icon: scope.typeIcon ?? 'file',
      description: parts.join(' • '),
    };
  }

  private getUdeRootPath(): string {
    const configured = vscode.workspace.getConfiguration('d365fo.aot').get<string>('ude.rootPath');
    return resolveRootPath(configured ?? '%LocalAppData%\\Microsoft\\Dynamics365');
  }

  private getPackagesRootPath(): string {
    // Fallback mirrors the package.json default (VS Code always supplies it
    // at runtime; this only matters for tests).
    const configured = vscode.workspace.getConfiguration('d365fo.aot').get<string>('rootPath');
    return resolveRootPath(configured ?? 'K:\\AosService\\PackagesLocalDirectory');
  }

  private async getUdeVersions(): Promise<DiscoveredVersion[]> {
    if (!this.versionsCache) {
      this.versionsCache = await discoverVersions(this.getUdeRootPath());
    }
    return this.versionsCache;
  }

  /** Visible UDE rows right now + their change-detection signature.
   *
   * Optimistic by design: every discovered version shows instantly (the only
   * I/O is the single root readdir). Versions are pruned only once a full
   * model scan *proves* them empty — unproven rows stay visible while probes
   * and scans run behind. Display never waits for probes, scans, or indexes.
   */
  private udeVisibleRows(versions: DiscoveredVersion[]): { nodes: VersionNode[]; sig: string } {
    const keys: string[] = [];
    const nodes = versions
      .filter((version) => {
        const key = version.fsPath.toLowerCase();
        const full = this.modelsCache.get(key);
        if (full && full.models.length === 0) {
          return false; // proven empty — prune (Logs, XPPConfig, ...)
        }
        keys.push(key);
        return true;
      })
      .map((version) => ({ kind: 'version', version, source: 'ude' }) as VersionNode);
    keys.sort();
    return { nodes, sig: keys.join('\n') };
  }

  private udeNeedsBackground(versions: DiscoveredVersion[]): boolean {
    return versions.some((version) => !this.modelsCache.has(version.fsPath.toLowerCase()));
  }

  /** Repaint MS-UDE only when the visible rows actually changed. */
  private refreshUdeIfChanged(versions: DiscoveredVersion[]): void {
    const rendered = this.udeVisibleRows(versions);
    if (rendered.sig !== this.udeRenderSig) {
      this.udeRenderSig = rendered.sig;
      this.refreshAdoptedSource('ude');
    }
  }

  /**
   * Background two-track UDE load. Phase 1 (probes) runs immediately and
   * reveals rows progressively; phase 2 (full scans) rides the warmup queue.
   * Every repaint is change-gated, so background work never flickers.
   */
  private async runUdeProbes(versions: DiscoveredVersion[]): Promise<void> {
    const depth = vscode.workspace.getConfiguration('d365fo.aot').get<number>('modelSearchDepth', 3);
    await Promise.all(
      versions.map(async (version) => {
        const key = version.fsPath.toLowerCase();
        const full = this.modelsCache.get(key);
        if (full || this.probedVersions.has(key)) {
          return;
        }
        try {
          if (await hasAnyModel(version.fsPath, depth)) {
            this.probedVersions.add(key);
            this.refreshUdeIfChanged(versions);
          }
        } catch {
          // Probe failure just means no row yet; the full scan decides later.
        }
      }),
    );
  }

  private async runUdeModels(versions: DiscoveredVersion[]): Promise<void> {
    for (let i = 0; i < versions.length; i += 8) {
      await Promise.all(versions.slice(i, i + 8).map((v) => this.getModels(v)));
      await AotTreeProvider.tick();
      this.refreshUdeIfChanged(versions);
    }
  }

  /** Refresh the root node instance VS Code actually holds (identity match). */
  private refreshAdoptedSource(sourceId: SourceId): void {
    const adopted = this.adoptedRoots.find((n) => n.kind === 'source' && n.sourceId === sourceId);
    this.onDidChangeTreeDataEmitter.fire(adopted);
  }

  private async getModels(version: DiscoveredVersion): Promise<DiscoveredModel[]> {
    const key = version.fsPath.toLowerCase();
    const cached = this.modelsCache.get(key);
    if (cached) {
      return cached.models;
    }
    const depth = vscode.workspace.getConfiguration('d365fo.aot').get<number>('modelSearchDepth', 3);
    const models = await discoverModels(version.fsPath, depth);
    this.modelsCache.set(key, { at: Date.now(), models });
    return models;
  }

  get rootPath(): string {
    return this.getPackagesRootPath();
  }

  static versionNode(node: unknown): VersionNode | undefined {
    if (typeof node === 'object' && node !== null && (node as VersionNode).kind === 'version') {
      return node as VersionNode;
    }
    return undefined;
  }

  static elementNode(node: unknown): ElementNode | undefined {
    if (
      typeof node === 'object' &&
      node !== null &&
      (node as ElementNode).kind === 'element' &&
      typeof (node as ElementNode).fsPath === 'string'
    ) {
      return node as ElementNode;
    }
    return undefined;
  }
}

export function descriptorUriFor(node: AotNode | undefined): vscode.Uri | undefined {
  if (node?.kind === 'model') {
    return vscode.Uri.file(node.model.descriptorPath);
  }
  return undefined;
}

export function elementFileUriFor(node: AotNode | undefined): vscode.Uri | undefined {
  if (node?.kind === 'element') {
    return vscode.Uri.file(node.fsPath);
  }
  return undefined;
}

export function revealUriFor(node: AotNode | undefined): vscode.Uri | undefined {
  if (node?.kind === 'source') {
    return node.fsPath ? vscode.Uri.file(node.fsPath) : undefined;
  }
  if (node?.kind === 'enumvalue') {
    return vscode.Uri.file(node.fsPath);
  }
  if (node?.kind === 'tablesection' || node?.kind === 'member' || node?.kind === 'xmlnode') {
    return vscode.Uri.file(node.fsPath);
  }
  if (node?.kind === 'model') {
    return vscode.Uri.file(node.model.fsPath);
  }
  if (node?.kind === 'element') {
    return vscode.Uri.file(node.fsPath);
  }
  if (
    node?.kind === 'version' ||
    node?.kind === 'category' ||
    node?.kind === 'group' ||
    node?.kind === 'elemtype'
  ) {
    return vscode.Uri.file(node.version.fsPath);
  }
  return undefined;
}

