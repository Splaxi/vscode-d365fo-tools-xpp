/**
 * Classic (Visual Studio AOT) view mapping.
 *
 * Category and element-type display names are the exact strings shipped by
 * Microsoft in `Microsoft.Dynamics.Framework.Tools.ApplicationExplorer.17.0`
 * (`*NodeName` resources), extracted from:
 *   Microsoft.Dynamics.Framework.Tools.Installer.17.0.vsix
 * Order of categories follows the VS Application Explorer.
 *
 * Each element type lists the on-disk `Ax*` metadata folders (matched
 * case-insensitively) whose `*.xml` files become the elements.
 *
 * `direct` folders hold elements listed straight under the category (VS shows
 * no intermediate type node for them, e.g. reports, services, label files).
 */

export interface ClassicTypeDef {
  /** Display label — the exact VS Application Explorer name. */
  label: string;
  /** ThemeIcon id (Codicon or contributed `d365fo-*` icon) for the type node and its elements. */
  icon: string;
  /** On-disk Ax* folder names (any casing). */
  folders: string[];
  /**
   * Restrict to models whose name starts with this (case-insensitive).
   * Used by System Documentation, which VS sources from the
   * SourceDocumentation* models (plain descriptors — the name is the marker).
   */
  modelPrefix?: string;
}

export interface ClassicGroupDef {
  /** Intermediate node, e.g. "Menu Items". Official VS name. */
  group: string;
  /** ThemeIcon id for the group node (defaults to `folder`). */
  icon?: string;
  types: ClassicTypeDef[];
}

export interface ClassicCategoryDef {
  id: string;
  label: string;
  icon: string;
  types: Array<ClassicTypeDef | ClassicGroupDef>;
  /** Folders whose elements appear directly under the category. */
  direct?: ClassicTypeDef[];
}

export function isGroup(t: ClassicTypeDef | ClassicGroupDef): t is ClassicGroupDef {
  return (t as ClassicGroupDef).group !== undefined;
}

const F = (label: string, icon: string, folders: string[]): ClassicTypeDef => ({
  label,
  icon,
  folders,
});

export const CLASSIC_CATEGORIES: ClassicCategoryDef[] = [
  {
    id: 'datatypes',
    label: 'Data Types',
    icon: 'd365fo-data-types',
    types: [
      F('Base Enums', 'd365fo-base-enums', ['AxEnum']),
      F('Base Enum Extensions', 'd365fo-base-enums', ['AxEnumExtension']),
      F('Extended Data Types', 'd365fo-extended-data-types', ['AxEDT']),
      F('Extended Data Type Extensions', 'd365fo-extended-data-types', ['AxEdtExtension']),
    ],
  },
  {
    id: 'datamodel',
    label: 'Data Model',
    icon: 'd365fo-table',
    types: [
      F('Tables', 'd365fo-table', ['AxTable']),
      F('Table Extensions', 'd365fo-table', ['AxTableExtension']),
      F('Views', 'd365fo-view', ['AxView']),
      F('View Extensions', 'd365fo-view', ['AxViewExtension']),
      F('Queries', 'variable-group', ['AxQuery']),
      F('Query Extensions', 'variable-group', ['AxQuerySimpleExtension']),
      F('Data Entities', 'd365fo-data-entity', ['AxDataEntityView']),
      F('Data Entity Extensions', 'd365fo-data-entity', ['AxDataEntityViewExtension']),
      F('Composite Data Entities', 'd365fo-data-entity', ['AxCompositeDataEntityView']),
      F('Aggregate Data Entities', 'd365fo-data-entity', ['AxAggregateDataEntity']),
      F('Maps', 'd365fo-maps', ['AxMap']),
      F('Table Collections', 'd365fo-table-collection', ['AxTableCollection']),
    ],
  },
  {
    id: 'code',
    label: 'Code',
    icon: 'code',
    types: [
      F('Classes', 'file-code', ['AxClass']),
      F('Macros', 'd365fo-macros', ['AxMacroDictionary']),
    ],
  },
  {
    id: 'ui',
    label: 'User Interface',
    icon: 'window-compact',
    types: [
      F('Forms', 'window-compact', ['AxForm']),
      F('Form Extensions', 'window-compact', ['AxFormExtension']),
      F('Tiles', 'd365fo-tiles', ['AxTile']),
      F('Menus', 'd365fo-menus', ['AxMenu']),
      F('Menu Extensions', 'd365fo-menus', ['AxMenuExtension']),
      {
        group: 'Menu Items',
        icon: 'd365fo-menu-items',
        types: [
          F('Display', 'open-in-window', ['AxMenuItemDisplay']),
          F('Output', 'code-oss', ['AxMenuItemOutput']),
          F('Action', 'right-panel-hide', ['AxMenuItemAction']),
        ],
      },
      F('Menu Item Extensions', 'd365fo-menu-items', [
        'AxMenuItemActionExtension',
        'AxMenuItemDisplayExtension',
        'AxMenuItemOutputExtension',
      ]),
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    icon: 'graph-line',
    types: [
      {
        group: 'Perspectives',
        icon: 'graph-line',
        types: [
          F('Aggregate Dimensions', 'graph-line', ['AxAggregateDimension']),
          F('Aggregate Measurements', 'package', ['AxAggregateMeasurement']),
          F('Calculated Measure Templates', 'notebook-template', ['AxAggregateCalculatedMeasureTemplate']),
          F('Calculated Measure Period Templates', 'notebook-template', ['AxAggregateCalculatedMeasureTemplateOtherPeriod']),
        ],
      },
      F('Key Performance Indicators (KPI)', 'graph', ['AxKPI']),
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: 'd365fo-reports',
    types: [
      F('Reports', 'd365fo-reports', ['AxReport']),
      {
        group: 'Report Style Templates',
        icon: 'd365fo-report-templates',
        types: [
          F('Layout Templates', 'd365fo-report-templates', ['AxReportLayoutTemplate']),
          F('List Style Templates', 'd365fo-report-templates', ['AxReportListStyleTemplate']),
          F('Matrix Style Templates', 'd365fo-report-templates', ['AxReportMatrixStyleTemplate']),
          F('Pie and Doughnut Chart Style Templates', 'd365fo-report-templates', ['AxReportPieDoughnutChartStyleTemplate']),
          F('Table Style Templates', 'd365fo-report-templates', ['AxReportTableStyleTemplate']),
          F('XY Chart Style Templates', 'd365fo-report-templates', ['AxReportXYChartStyleTemplate']),
        ],
      },
      F('Report DataSources', 'database', ['AxReportExternalDataSource']),
      F('Report Images', 'file-media-compact', ['AxReportEmbeddedImage']),
    ],
  },
  {
    id: 'workflow',
    label: 'Business Process and Workflow',
    icon: 'layers',
    types: [
      F('Workflow Categories', 'ungroup-by-ref-type', ['AxWorkflowCategory']),
      F('Workflow Approvals', 'check', ['AxWorkflowApproval']),
      F('Workflow Approval Extensions', 'check', ['AxWorkflowApprovalExtension']),
      F('Workflow Tasks', 'checklist-compact', ['AxWorkflowTask']),
      F('Workflow Task Extensions', 'checklist-compact', ['AxWorkflowTaskExtension']),
      F('Workflow Automated Tasks', 'checklist-compact', ['AxWorkflowAutomatedTask']),
      F('Workflow Types', 'type-hierarchy-sub', ['AxWorkflowTemplate']),
      F('Workflow Type Extensions', 'type-hierarchy-sub', ['AxWorkflowTemplateExtension']),
      F('Providers', 'group-by-ref-type', [
        'AxWorkflowDueDateCalculationProvider',
        'AxWorkflowHierarchyAssignmentProvider',
        'AxWorkflowParticipantAssignmentProvider',
        'AxWorkflowQueueAssignmentProvider',
      ]),
    ],
  },
  {
    id: 'labels',
    label: 'Label Files',
    icon: 'd365fo-label-files',
    types: [],
    direct: [F('Label Files', 'd365fo-label-files', ['AxLabelFile'])],
  },
  {
    id: 'resources',
    label: 'Resources',
    icon: 'd365fo-resources',
    types: [],
    direct: [F('Resources', 'd365fo-resources', ['AxResource'])],
  },
  {
    id: 'config',
    label: 'Configuration',
    icon: 'gear',
    types: [
      F('License Codes', 'd365fo-license', ['AxLicenseCode']),
      F('Configuration Keys', 'key', ['AxConfigurationKey']),
      F('Configuration Key Groups', 'gear', ['AxConfigurationKeyGroup']),
    ],
  },
  {
    id: 'security',
    label: 'Security',
    icon: 'd365fo-security',
    types: [
      F('Security Roles', 'd365fo-sec-role', ['AxSecurityRole']),
      F('Security Role Extensions', 'd365fo-sec-role', ['AxSecurityRoleExtension']),
      F('Security Duties', 'd365fo-sec-duty', ['AxSecurityDuty']),
      F('Security Duty Extensions', 'd365fo-sec-duty', ['AxSecurityDutyExtension']),
      F('Security Privileges', 'd365fo-sec-priv', ['AxSecurityPrivilege']),
      F('Security Policies', 'd365fo-sec-policy', ['AxSecurityPolicy']),
    ],
  },
  {
    id: 'references',
    label: 'References',
    icon: 'd365fo-references',
    types: [],
    direct: [F('References', 'd365fo-references', ['AxReference'])],
  },
  {
    id: 'services',
    label: 'Services',
    icon: 'd365fo-service',
    types: [
      F('Services', 'd365fo-service', ['AxService']),
      F('Service Groups', 'd365fo-service-group', ['AxServiceGroup']),
    ],
  },
  {
    id: 'sysdoc',
    label: 'System Documentation',
    icon: 'd365fo-sysdoc',
    types: [
      F('Tables', 'd365fo-table', ['AxTable']),
      F('Extended Data Types', 'd365fo-extended-data-types', ['AxEdt']),
      F('Base Enums', 'd365fo-base-enums', ['AxEnum']),
      F('Classes', 'file-code', ['AxClass']),
      F('Views', 'd365fo-view', ['AxView']),
    ].map((d) => ({ ...d, modelPrefix: 'sourcedocumentation' })),
  },
];

/** Lowercase Ax folder name → all (category, type/group) locations using it. */
export const KNOWN_AX_FOLDERS: ReadonlySet<string> = new Set(
  CLASSIC_CATEGORIES.flatMap((c) => [
    ...c.types.flatMap((t) => (isGroup(t) ? t.types : [t]).flatMap((d) => d.folders)),
    ...(c.direct ?? []).flatMap((d) => d.folders),
  ]).map((f) => f.toLowerCase()),
);

/** Strip `.xml` (and a trailing `.Extension`) for the element display name. */
export function elementLabel(fileName: string): string {
  return fileName.replace(/\.xml$/i, '').replace(/\.Extension$/i, '');
}

/** True for folders holding extension elements (`*Extension` folders). */
export function isExtensionFolder(axFolderName: string): boolean {
  return axFolderName.toLowerCase().endsWith('extension');
}

/** Ax folders whose elements expand into child values (parsed live on foldout, never cached). */
export const ENUM_VALUE_FOLDERS: ReadonlySet<string> = new Set(['axenum', 'axenumextension']);

/** Ax folders whose elements expand into VS-style table sections. */
export const TABLE_SECTION_FOLDERS: ReadonlySet<string> = new Set(['axtable', 'axtableextension']);

/** Table sections in VS Application Explorer order, with tree icons. */
export interface TableSectionDef {
  id: string;
  label: string;
  icon: string;
}

export const TABLE_SECTIONS: TableSectionDef[] = [
  { id: 'DeleteActions', label: 'DeleteActions', icon: 'd365fo-delete-actions' },
  { id: 'FieldGroups', label: 'FieldGroups', icon: 'd365fo-field-groups' },
  { id: 'Fields', label: 'Fields', icon: 'd365fo-fields' },
  { id: 'FullTextIndexes', label: 'FullTextIndexes', icon: 'd365fo-fulltext-indexes' },
  { id: 'Indexes', label: 'Indexes', icon: 'd365fo-indexes' },
  { id: 'Mappings', label: 'Mappings', icon: 'd365fo-maps' },
  { id: 'Relations', label: 'Relations', icon: 'references' },
  { id: 'StateMachines', label: 'StateMachines', icon: 'd365fo-state-machines' },
  { id: 'Methods', label: 'Methods', icon: 'd365fo-methods' },
];

/**
 * View sections — same tag shapes as tables minus DeleteActions and
 * FullTextIndexes (verified against live AxView metadata).
 */
export const VIEW_SECTIONS: TableSectionDef[] = [
  { id: 'FieldGroups', label: 'FieldGroups', icon: 'd365fo-field-groups' },
  { id: 'Fields', label: 'Fields', icon: 'd365fo-fields' },
  { id: 'Indexes', label: 'Indexes', icon: 'd365fo-indexes' },
  { id: 'Mappings', label: 'Mappings', icon: 'd365fo-maps' },
  { id: 'Relations', label: 'Relations', icon: 'references' },
  { id: 'StateMachines', label: 'StateMachines', icon: 'd365fo-state-machines' },
  { id: 'Methods', label: 'Methods', icon: 'd365fo-methods' },
];

/**
 * Data entity sections — table-like plus Keys and Ranges
 * (verified against live AxDataEntityView metadata).
 */
export const ENTITY_SECTIONS: TableSectionDef[] = [
  { id: 'DeleteActions', label: 'DeleteActions', icon: 'd365fo-delete-actions' },
  { id: 'FieldGroups', label: 'FieldGroups', icon: 'd365fo-field-groups' },
  { id: 'Fields', label: 'Fields', icon: 'd365fo-fields' },
  { id: 'Keys', label: 'Keys', icon: 'key' },
  { id: 'Mappings', label: 'Mappings', icon: 'd365fo-maps' },
  { id: 'Ranges', label: 'Ranges', icon: 'filter' },
  { id: 'Relations', label: 'Relations', icon: 'references' },
  { id: 'StateMachines', label: 'StateMachines', icon: 'd365fo-state-machines' },
  { id: 'Methods', label: 'Methods', icon: 'd365fo-methods' },
];

/** Map sections — FieldGroups, Fields, Mappings (verified live). */
export const MAP_SECTIONS: TableSectionDef[] = [
  { id: 'FieldGroups', label: 'FieldGroups', icon: 'd365fo-field-groups' },
  { id: 'Fields', label: 'Fields', icon: 'd365fo-fields' },
  { id: 'Mappings', label: 'Mappings', icon: 'd365fo-maps' },
  { id: 'Methods', label: 'Methods', icon: 'd365fo-methods' },
];
