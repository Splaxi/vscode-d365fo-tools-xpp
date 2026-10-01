import * as fs from 'fs/promises';
import * as path from 'path';

export interface DiscoveredVersion {
  /** Folder name, e.g. "10.0.1935.123" */
  name: string;
  /** Absolute path to the version folder */
  fsPath: string;
}

export interface DiscoveredModel {
  /** Model / module name (folder name) */
  name: string;
  /** Absolute path to the model folder */
  fsPath: string;
  /** Absolute path to the Descriptor/*.xml file */
  descriptorPath: string;
}

/**
 * Expand `%NAME%` (Windows), `$NAME` / `${NAME}` and leading `~`.
 * Unknown variables are left untouched.
 */
export function expandPath(input: string): string {
  if (!input) {
    return input;
  }
  let out = input.trim();
  if (out.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    out = path.join(home, out.slice(1));
  }
  out = out.replace(/%([^%]+)%/g, (_m, name: string) => {
    const v = process.env[name] ?? process.env[name.toUpperCase()] ?? process.env[name.toLowerCase()];
    return v ?? _m;
  });
  out = out.replace(/\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_m, b1: string, b2: string) => {
    const name: string = b1 ?? b2;
    return process.env[name] ?? _m;
  });
  return out;
}

export function defaultRootPath(): string {
  // Keep in sync with package.json default.
  return expandPath('%LocalAppData%\\Microsoft\\Dynamics365');
}

export function resolveRootPath(configured: string | undefined): string {
  if (configured && configured.trim().length > 0) {
    return expandPath(configured);
  }
  return defaultRootPath();
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fast first level: every direct sub-directory of the root is a "version".
 * Uses a single readdir with file types — no recursion, no stats storm.
 */
const EXCLUDED_VERSION_NAMES = new Set([
  // Symlink farm pointing at models that really belong to other versions;
  // would otherwise show up as a duplicate "version".
  'runtimesymlinks',
]);

/**
 * A UDE root holds the versions plus a pile of siblings that are directories but
 * not versions: `Logs`, `XPConfig`, `RuntimeSymLinks`. Listing them is not just
 * noise - each one then costs a `hasAnyModel` probe and a full model scan before
 * it can be pruned as empty, which is exactly the "folders that are not versions"
 * row a user should never see. Testing the name first drops them with no I/O.
 *
 * A real version with no model is still possible (a half-created install), so
 * this is only the first gate: `hasAnyModel` and the scan behind it still decide.
 */
const VERSION_NAME = /^\d+\.\d+\.\d+\.\d+$/;

export async function discoverVersions(root: string): Promise<DiscoveredVersion[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const versions: DiscoveredVersion[] = [];
  for (const e of entries) {
    if (EXCLUDED_VERSION_NAMES.has(e.name.toLowerCase()) || !VERSION_NAME.test(e.name)) {
      continue;
    }
    // Cheap: Dirent check first; fall back to stat for symlinks.
    if (e.isDirectory()) {
      versions.push({ name: e.name, fsPath: path.join(root, e.name) });
    } else if (e.isSymbolicLink()) {
      const full = path.join(root, e.name);
      if (await isDirectory(full)) {
        versions.push({ name: e.name, fsPath: full });
      }
    }
  }
  versions.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return versions;
}

const PACKAGE_DIR_NAMES = ['PackagesLocalDirectory', 'PackagesLocalDirectoryBin'];

function candidatePackageRoots(versionPath: string): string[] {
  // Most common local-dev layouts, checked directly (no tree walk):
  //   <version>/AOSService/PackagesLocalDirectory
  //   <version>/PackagesLocalDirectory
  //   <version>/AOSService/PackagesLocalDirectoryBin
  //   <version>  (fallback: models directly inside)
  return [
    path.join(versionPath, 'AOSService', 'PackagesLocalDirectory'),
    path.join(versionPath, 'AOSService', 'PackagesLocalDirectoryBin'),
    path.join(versionPath, 'PackagesLocalDirectory'),
    ...PACKAGE_DIR_NAMES.map((n) => path.join(versionPath, n)),
    versionPath,
  ];
}

async function findDescriptorXml(modelDir: string): Promise<string | undefined> {
  const descriptorDir = path.join(modelDir, 'Descriptor');
  let entries;
  try {
    entries = await fs.readdir(descriptorDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  // Prefer <ModelName>.xml, else first *.xml (case-insensitive).
  const base = path.basename(modelDir).toLowerCase();
  let fallback: string | undefined;
  for (const e of entries) {
    if (!e.isFile() && !e.isSymbolicLink()) {
      continue;
    }
    if (!e.name.toLowerCase().endsWith('.xml')) {
      continue;
    }
    const full = path.join(descriptorDir, e.name);
    if (e.name.toLowerCase() === `${base}.xml`) {
      return full;
    }
    fallback ??= full;
  }
  return fallback;
}

/**
 * Exit-early probe: does `versionPath` hold at least one valid model
 * (a folder with `Descriptor/*.xml`)? Checks the known package roots first
 * (a few readdirs), then a bounded breadth-first scan — returns on the first
 * hit instead of enumerating everything like `discoverModels` does.
 */
export async function hasAnyModel(versionPath: string, depth = 3): Promise<boolean> {
  const maxDepth = Math.min(Math.max(depth, 1), 5);
  for (const candidate of candidatePackageRoots(versionPath)) {
    if (candidate === versionPath) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(candidate, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) {
        continue;
      }
      if (await findDescriptorXml(path.join(candidate, e.name))) {
        return true;
      }
    }
  }
  // Fallback layouts: breadth-first, one readdir per dir, first hit wins.
  const queue: Array<{ dir: string; level: number }> = [{ dir: versionPath, level: 0 }];
  const seen = new Set<string>([versionPath.toLowerCase()]);
  while (queue.length > 0) {
    const batch = queue.splice(0, 64);
    const listings = await Promise.all(
      batch.map(async (item) => {
        try {
          const entries = await fs.readdir(item.dir, { withFileTypes: true });
          return { item, entries };
        } catch {
          return { item, entries: undefined as undefined };
        }
      }),
    );
    for (const row of listings) {
      if (!row.entries) {
        continue;
      }
      const checks: Array<Promise<boolean>> = [];
      for (const e of row.entries) {
        if (e.name === 'Descriptor' || e.name === 'descriptor') {
          continue;
        }
        if (!e.isDirectory() && !e.isSymbolicLink()) {
          continue;
        }
        const full = path.join(row.item.dir, e.name);
        if (row.item.level + 1 <= maxDepth) {
          checks.push(findDescriptorXml(full).then((hit) => !!hit));
        }
        if (row.item.level + 1 < maxDepth) {
          const key = full.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            queue.push({ dir: full, level: row.item.level + 1 });
          }
        }
      }
      // A hit anywhere in this row proves the version — single-flighted
      // readdirs keep this cheap when racing the full scan.
      for (const check of checks) {
        if (await check) {
          return true;
        }
      }
    }
  }
  return false;
}
/**
 * Fast per-version model scan:
 *  - resolve the PackagesLocalDirectory (if any) with a few direct stat checks
 *  - breadth-first scan up to `depth` levels, one readdir per directory
 *  - a directory is a model iff it contains Descriptor/*.xml
 *  - matched model dirs are not descended into (models don't nest)
 *
 * Designed for thousands of entries: bounded concurrency, no
 * recursive glob, minimal stat calls.
 */
export async function discoverModels(versionPath: string, depth = 3): Promise<DiscoveredModel[]> {
  const roots: string[] = [];
  let fallbackRoot = versionPath;
  for (const candidate of candidatePackageRoots(versionPath)) {
    if (candidate === versionPath) {
      continue;
    }
    if (await isDirectory(candidate)) {
      roots.push(candidate);
    }
  }
  if (roots.length === 0) {
    if (!(await isDirectory(versionPath))) {
      return [];
    }
    roots.push(versionPath);
    fallbackRoot = versionPath;
  }

  const maxDepth = Math.min(Math.max(depth, 1), 5);
  const models = new Map<string, DiscoveredModel>();
  const queue: Array<{ dir: string; level: number }> = roots.map((dir) => ({ dir, level: 0 }));
  const seen = new Set<string>(roots.map((r) => r.toLowerCase()));

  while (queue.length > 0) {
    // Bounded fan-out: process one BFS level in chunks of 64 readdirs.
    const CHUNK = 64;
    const batch = queue.splice(0, CHUNK);

    const listings = await Promise.all(
      batch.map(async (item) => {
        try {
          const entries = await fs.readdir(item.dir, { withFileTypes: true });
          return { item, entries };
        } catch {
          return { item, entries: undefined as undefined };
        }
      }),
    );

    // Check Descriptor/*.xml for direct children first (single extra
    // readdir per child is cheaper than stat-ing everything).
    const childDirs: Array<{ parent: string; name: string; full: string; level: number }> = [];
    for (const row of listings) {
      if (!row.entries) {
        continue;
      }
      for (const e of row.entries) {
        if (e.name === 'Descriptor' || e.name === 'descriptor') {
          continue; // never treat a Descriptor folder itself as a model
        }
        if (e.isDirectory()) {
          childDirs.push({
            parent: row.item.dir,
            name: e.name,
            full: path.join(row.item.dir, e.name),
            level: row.item.level + 1,
          });
        } else if (e.isSymbolicLink() && row.item.level < maxDepth) {
          // Resolve symlinks lazily only when we may descend.
          const full = path.join(row.item.dir, e.name);
          if (await isDirectory(full)) {
            childDirs.push({ parent: row.item.dir, name: e.name, full, level: row.item.level + 1 });
          }
        }
      }
    }

    const descriptorChecks = await Promise.all(
      childDirs.map(async (c) => ({ c, descriptor: await findDescriptorXml(c.full) })),
    );

    for (const { c, descriptor } of descriptorChecks) {
      if (descriptor) {
        const key = c.full.toLowerCase();
        if (!models.has(key)) {
          models.set(key, { name: c.name, fsPath: c.full, descriptorPath: descriptor });
        }
        // Do not descend into a model folder.
      } else if (c.level < maxDepth) {
        const key = c.full.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          queue.push({ dir: c.full, level: c.level });
        }
      }
    }

    // Special case: the version/package root itself could be a model
    // (single-model layout). Check once.
    void fallbackRoot;
  }

  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
