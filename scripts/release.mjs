#!/usr/bin/env node
/**
 * Canonical release script for vscode-d365fo-tools-xpp.
 *
 * Usage (preferred via npm wrappers):
 *   npm run release               # patch bump (bug fixes, default)
 *   npm run release:minor         # new backwards-compatible features
 *   npm run release:major         # breaking changes
 *
 * Direct:
 *   node ./scripts/release.mjs --bump patch|minor|major|none [--keep] [--no-package] [--if-changed]
 *
 * What it does, in order:
 *   1. (optionally) exits early with --if-changed when no source changes are detected
 *   2. `npm run compile` (tsc must pass)
 *   3. bumps semver in package.json (+ package-lock.json if present)
 *   4. `npm run package` (vsce → .vsix named with the NEW version)
 *   5. deletes stale *.vsix files, keeping only the new one (unless --keep)
 *   6. prints the install command for the VS Code extension manager
 *
 * Why auto-bump: VS Code treats a VSIX reinstall as an *update* only when the
 * version number increased. Every user-facing change therefore needs a bump,
 * otherwise testers installing the new .vsix see no update.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');

// Files whose changes count as "a change" for --if-changed.
const TRACKED_PATHS = ['src', 'resources', 'package.json', 'package-lock.json', 'tsconfig.json', 'scripts'];

function help() {
  console.log(`release.mjs -- bump version, build VSIX

Options:
  --bump <patch|minor|major|none>  semver part to increment (default: patch)
  --no-bump                        same as --bump none
  --keep                           keep older *.vsix files (default: delete them)
  --no-package                     bump only, skip vsce packaging
  --if-changed                     exit 0 without doing anything when no source
                                   changes are detected (git working tree clean
                                   for ${TRACKED_PATHS.join(', ')})
  -h, --help                       show this help
`);
}

function parseArgs(argv) {
  const opts = { bump: 'patch', keep: false, noPackage: false, ifChanged: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bump') {
      opts.bump = argv[++i];
    } else if (a.startsWith('--bump=')) {
      opts.bump = a.slice('--bump='.length);
    } else if (a === '--no-bump') {
      opts.bump = 'none';
    } else if (a === '--keep') {
      opts.keep = true;
    } else if (a === '--no-package') {
      opts.noPackage = true;
    } else if (a === '--if-changed') {
      opts.ifChanged = true;
    } else if (a === '-h' || a === '--help') {
      help();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}\n`);
      help();
      process.exit(1);
    }
  }
  if (!['patch', 'minor', 'major', 'none'].includes(opts.bump)) {
    console.error(`Invalid --bump value: ${opts.bump} (expected patch|minor|major|none)`);
    process.exit(1);
  }
  return opts;
}

function run(cmd, extra = {}) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true, ...extra });
}

function gitOutput(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, stdio: 'pipe', shell: true }).toString().trim();
  } catch {
    return '';
  }
}

function hasSourceChanges() {
  const status = gitOutput(`status --porcelain -- ${TRACKED_PATHS.join(' ')}`);
  return status.length > 0;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function bumpSemver(version, part) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim());
  if (!m) {
    throw new Error(`Cannot bump non-semver version: ${version}`);
  }
  let [, major, minor, patch] = m.map(Number);
  if (part === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (part === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function writeJsonPreserveStyle(p, obj) {
  // Repo style is 2-space JSON with trailing newline.
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function updatePackageLock(newVersion) {
  if (!existsSync(LOCK_PATH)) {
    return;
  }
  const lock = readJson(LOCK_PATH);
  let touched = false;
  if (typeof lock.version === 'string') {
    lock.version = newVersion;
    touched = true;
  }
  if (lock.packages && lock.packages[''] && typeof lock.packages[''].version === 'string') {
    lock.packages[''].version = newVersion;
    touched = true;
  }
  if (touched) {
    writeJsonPreserveStyle(LOCK_PATH, lock);
    console.log(`Updated package-lock.json → ${newVersion}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.ifChanged && !hasSourceChanges()) {
    console.log('No source changes detected — skipping release (bump/package).');
    process.exit(0);
  }

  const pkg = readJson(PKG_PATH);
  const oldVersion = pkg.version;
  console.log(`Current version: ${oldVersion}`);

  console.log('\nStep 1/4 — compile (tsc)');
  run('npm run compile --silent');

  let newVersion = oldVersion;
  if (opts.bump !== 'none') {
    newVersion = bumpSemver(oldVersion, opts.bump);
    pkg.version = newVersion;
    writeJsonPreserveStyle(PKG_PATH, pkg);
    updatePackageLock(newVersion);
    console.log(`\nStep 2/4 — version bump (${opts.bump}): ${oldVersion} → ${newVersion}`);
  } else {
    console.log('\nStep 2/4 — version bump skipped (--bump none)');
  }

  if (!opts.noPackage) {
    console.log('\nStep 3/4 — package VSIX (vsce)');
    run('npm run package --silent');
  } else {
    console.log('\nStep 3/4 — packaging skipped (--no-package)');
  }

  const expectedVsix = `${pkg.name}-${newVersion}.vsix`;
  if (!opts.noPackage && !opts.keep) {
    console.log('\nStep 4/4 — remove stale *.vsix');
    for (const f of readdirSync(ROOT).filter((f) => f.endsWith('.vsix'))) {
      if (f !== expectedVsix) {
        rmSync(path.join(ROOT, f));
        console.log(`  deleted ${f}`);
      }
    }
  }

  console.log('\nDone.');
  console.log(`  version : ${newVersion}`);
  if (!opts.noPackage) {
    console.log(`  vsix    : ${expectedVsix}`);
    console.log(`  install : code --install-extension ${expectedVsix}`);
    console.log('  (or Extensions view → "..." → Install from VSIX...)');
  }
}

main();
