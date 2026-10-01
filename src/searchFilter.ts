import { CLASSIC_CATEGORIES, isGroup, type ClassicCategoryDef } from './classic';

/**
 * Search filter model, shared by the search page and the tree.
 *
 * One state, two inputs, exactly like the Extensions view: free text plus a set
 * of type tokens. The funnel toggles tokens by checkbox, and typing `@` in the
 * input resolves to the same tokens, so both always agree. The grammar follows
 * the workbench's own Extensions input (token characters `@`, a `:`
 * distinguishing a namespaced token, and a sort key that floats plain kinds
 * above namespaced ones).
 */

/** What one filter option selects: the leaf type labels it covers. */
export interface FilterOption {
  /** Stable key, also the token spelling. */
  key: string;
  label: string;
  icon: string;
  catId: string;
  /** Leaf type labels, as `SearchEntry.typeLabel` spells them. */
  typeLabels: string[];
}

export interface AotSearchFilter {
  /** Free text, lowercased. */
  text: string;
  /** Selected option keys, in the order they were picked. */
  keys: string[];
}

/**
 * The slice of a filter the tree needs. `counts` is present once the search
 * index exists, which is what lets a text-only filter hide a branch outright
 * instead of showing it with nothing under it.
 */
export interface ElementFilterState {
  text: string;
  typeLabels: Set<string>;
  counts?: Map<string, number>;
}

export const EMPTY_FILTER: AotSearchFilter = { text: '', keys: [] };

function leafLabels(cat: ClassicCategoryDef): { label: string; icon: string; typeLabels: string[] }[] {
  const out: { label: string; icon: string; typeLabels: string[] }[] = [];
  for (const entry of [...cat.types, ...(cat.direct ?? [])]) {
    if (isGroup(entry)) {
      out.push({
        label: entry.group,
        icon: entry.icon ?? 'folder',
        typeLabels: entry.types.map((t) => t.label),
      });
    } else {
      out.push({ label: entry.label, icon: entry.icon, typeLabels: [entry.label] });
    }
  }
  return out;
}

const BY_LABEL = new Map<string, { cat: ClassicCategoryDef; typeLabels: string[] }>();
for (const cat of CLASSIC_CATEGORIES) {
  for (const child of leafLabels(cat)) {
    for (const label of child.typeLabels) {
      if (!BY_LABEL.has(label.toLowerCase())) {
        BY_LABEL.set(label.toLowerCase(), { cat, typeLabels: child.typeLabels });
      }
    }
  }
}

/**
 * Tokens are machine-inserted, so a key never has to be typeable: strip the
 * spaces out of a label and `@Data Model:Tables` can be written `@DataModel:Tables`.
 */
const slug = (label: string): string => label.replace(/\s+/g, '');

/** A first-level tree node (Data Model, Code, ...). */
export function nodeOption(cat: ClassicCategoryDef): FilterOption {
  return {
    key: slug(cat.label),
    label: cat.label,
    icon: cat.icon,
    catId: cat.id,
    typeLabels: leafLabels(cat).flatMap((c) => c.typeLabels),
  };
}

/** The 14 first-level nodes, in tree order. */
export function nodeOptions(): FilterOption[] {
  return CLASSIC_CATEGORIES.map(nodeOption);
}

/** A node's children (types, or groups whose types stand in for them). */
export function typeOptions(catId: string): FilterOption[] {
  const cat = CLASSIC_CATEGORIES.find((c) => c.id === catId);
  if (!cat) {
    return [];
  }
  return leafLabels(cat).map((child) => ({
    key: `${slug(cat.label)}:${slug(child.label)}`,
    label: child.label,
    icon: child.icon,
    catId: cat.id,
    typeLabels: child.typeLabels,
  }));
}

/**
 * The funnel's first section: the handful of kinds worth one click. Each
 * resolves to the leaf types it stands for, so "Table" selects the Tables type
 * without caring which category it lives in.
 */
const QUICK: { label: string; typeLabel: string }[] = [
  { label: 'Table', typeLabel: 'Tables' },
  { label: 'View', typeLabel: 'Views' },
  { label: 'Class', typeLabel: 'Classes' },
  { label: 'Form', typeLabel: 'Forms' },
];

export function quickOptions(): FilterOption[] {
  return QUICK.map((q) => {
    const hit = BY_LABEL.get(q.typeLabel.toLowerCase());
    return {
      key: q.label,
      label: q.label,
      icon: hit ? nodeOption(hit.cat).icon : 'symbol-type-parameter',
      catId: hit?.cat.id ?? '',
      typeLabels: hit ? hit.typeLabels : [q.typeLabel],
    };
  });
}

const OPTIONS: FilterOption[] = [...quickOptions(), ...nodeOptions()];
for (const cat of CLASSIC_CATEGORIES) {
  OPTIONS.push(...typeOptions(cat.id));
}
// Later entries never displace an earlier one, so the four quick kinds and the
// first node keep the keys a collision would otherwise take.
const BY_KEY = new Map<string, FilterOption>();
for (const option of OPTIONS) {
  const key = option.key.toLowerCase();
  if (!BY_KEY.has(key)) {
    BY_KEY.set(key, option);
  }
}

/** Every selectable option, first section first, then nodes, then their types. */
export function allOptions(): FilterOption[] {
  return OPTIONS;
}

export function optionForKey(key: string): FilterOption | undefined {
  return BY_KEY.get(key.trim().toLowerCase());
}

/**
 * Split an input value into free text and `@` tokens. A token runs to the next
 * space; anything unclaimed is text, so `cust @Table` is text `cust` + Table.
 */
export function parseQuery(value: string): { text: string; keys: string[] } {
  const keys: string[] = [];
  const words: string[] = [];
  for (const word of value.split(/\s+/)) {
    if (!word) {
      continue;
    }
    if (word.startsWith('@') && word.length > 1) {
      keys.push(word.slice(1));
    } else {
      words.push(word);
    }
  }
  return { text: words.join(' ').toLowerCase(), keys };
}

/**
 * Workbench-style sort key for the `@` suggestions: a bare kind first, then
 * namespaced tokens, so `@Table` is offered above `@Data Model:Tables`.
 */
export function suggestionSortKey(key: string): string {
  if (!key.includes(':')) {
    return 'a';
  }
  return /\bnode\b|\bcategory\b/i.test(key) ? 'b' : 'c';
}

/** Suggestions for a partially typed token, best first. */
export function suggestions(partial: string, limit = 40): FilterOption[] {
  const q = partial.replace(/^@/, '').trim().toLowerCase();
  const scored = OPTIONS.filter((o) => !q || o.key.toLowerCase().includes(q))
    .map((o) => ({ o, rank: o.key.toLowerCase().indexOf(q), sort: suggestionSortKey(o.key) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.sort.localeCompare(b.sort) || a.rank - b.rank || a.o.label.length - b.o.label.length);
  return scored.slice(0, limit).map((r) => r.o);
}

/** The type labels a filter selects, lowercased and de-duplicated. */
export function selectedTypeLabels(filter: AotSearchFilter): Set<string> {
  const out = new Set<string>();
  for (const key of filter.keys) {
    const option = optionForKey(key);
    if (option) {
      for (const label of option.typeLabels) {
        out.add(label.toLowerCase());
      }
    }
  }
  return out;
}

/**
 * The leaf type labels under one tree node, lowercased — what the tree needs to
 * decide whether a category, group or type row can hold a match.
 */
export function typeLabelsUnder(catId: string, group?: string): string[] {
  const cat = CLASSIC_CATEGORIES.find((c) => c.id === catId);
  if (!cat) {
    return [];
  }
  const all = leafLabels(cat);
  if (group === undefined) {
    return all.flatMap((c) => c.typeLabels.map((l) => l.toLowerCase()));
  }
  const hit = all.find((c) => c.label === group);
  return (hit ?? all.find((c) => c.typeLabels.includes(group)) ?? { typeLabels: [] }).typeLabels.map((l) =>
    l.toLowerCase(),
  );
}

/**
 * Whether a tree node can still contain a match. A type filter prunes on the
 * selected type labels; when the index is warm, `counts` prunes a branch whose
 * types have no matching element at all, so nothing is left showing empty.
 */
export function nodeSurvives(
  state: ElementFilterState | undefined,
  typeLabels: string[],
): boolean {
  if (!state) {
    return true;
  }
  if (state.typeLabels.size > 0) {
    return typeLabels.some((l) => state.typeLabels.has(l));
  }
  if (state.counts) {
    return typeLabels.some((l) => (state.counts?.get(l) ?? 0) > 0);
  }
  return true;
}

/** Whether one element row matches the filter's text. */
export function labelSurvives(state: ElementFilterState | undefined, labelLower: string): boolean {
  return !state || state.text.length === 0 || labelLower.includes(state.text);
}

/** True when the filter would keep every element. */
export function isEmptyFilter(filter: AotSearchFilter): boolean {
  return filter.text.length === 0 && filter.keys.length === 0;
}
