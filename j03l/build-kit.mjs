#!/usr/bin/env node
/**
 * Builds drizzle-kit from this checkout into a publishable `@j03l/drizzle-kit`
 * tarball, smoke-tests it, and prints the publish command.
 *
 *   node j03l/build-kit.mjs [--no-install] [--skip-orm] [--allow-dirty]
 *
 * Output lands beside this script as `j03l-drizzle-kit-<version>.tgz`, where
 * the version is drizzle-kit's own plus the short sha of HEAD, the same scheme
 * as upstream's branch releases. Everything written here is ignored by the
 * folder's .gitignore except this file.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PNPM = ['--yes', 'pnpm@10.15.0'];
const SCOPED_NAME = '@j03l/drizzle-kit';
const ORM_FOR_SMOKE = 'drizzle-orm@rc5';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const kitDir = join(root, 'drizzle-kit');
const args = new Set(process.argv.slice(2));

const run = (cmd, cmdArgs, opts = {}) => {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}${opts.cwd ? `   (in ${opts.cwd})` : ''}`);
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
};
const capture = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...opts }).trim();
const pnpm = (cmdArgs, opts) => run('npx', [...PNPM, ...cmdArgs], opts);
const fail = (msg) => {
  console.error(`\nFAILED: ${msg}`);
  process.exit(1);
};

// 1. Where we are building from.
const dirty = capture('git', ['status', '--porcelain'], { cwd: root });
if (dirty && !args.has('--allow-dirty')) {
  fail(`working tree is not clean; the version suffix would name a commit that is not what gets built:\n${dirty}`);
}
const sha = capture('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
const branch = capture('git', ['branch', '--show-current'], { cwd: root });
const kitPkg = JSON.parse(readFileSync(join(kitDir, 'package.json'), 'utf8'));
const version = `${kitPkg.version}-${sha}`;
console.log(`Building ${SCOPED_NAME}@${version} from ${branch} (${sha})`);

// 2. Dependencies and the workspace drizzle-orm the kit's devDependency points at.
if (!args.has('--no-install')) pnpm(['install', '--frozen-lockfile'], { cwd: root });
if (!args.has('--skip-orm') || !existsSync(join(root, 'drizzle-orm/dist/package.json'))) {
  pnpm(['build:orm'], { cwd: root });
}

// 3. The kit: typecheck first, because the bundler will not.
pnpm(['exec', 'tsc', '-p', 'tsconfig.json', '--noEmit'], { cwd: kitDir });
pnpm(['run', 'build'], { cwd: kitDir });
pnpm(['run', 'pack'], { cwd: kitDir });

// 4. Repack under the scoped name, as upstream's publish step does, minus
//    provenance, which npm only grants to a CI runner with OIDC.
const work = join(here, 'tmp');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
run('tar', ['-xzf', join(kitDir, 'package.tgz'), '-C', work]);
const pkgPath = join(work, 'package/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.name = SCOPED_NAME;
pkg.version = version;
delete pkg.publishConfig;
writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
const tarball = join(here, `j03l-drizzle-kit-${version}.tgz`);
rmSync(tarball, { force: true });
run('tar', ['-czf', tarball, '-C', work, 'package']);

const bin = readFileSync(join(work, 'package/bin.cjs'), 'utf8');
const eager = bin.match(/^(?:let|var|const) \w+ = require\("(pg|postgres|mysql2|better-sqlite3|@libsql\/client)"\);$/gm);
if (eager) fail(`bin.cjs requires a driver at load, so it will not start without it installed:\n${eager.join('\n')}`);

// 5. Smoke test in a scratch project, beside the published drizzle-orm, with
//    the tarball linked under the unscoped name the way an npm alias installs it.
const smoke = join(here, 'smoke');
rmSync(smoke, { recursive: true, force: true });
mkdirSync(smoke, { recursive: true });
writeFileSync(join(smoke, 'package.json'), '{ "name": "smoke", "private": true }\n');
run('npm', ['install', '--no-audit', '--no-fund', '--silent', tarball, ORM_FOR_SMOKE], { cwd: smoke });
symlinkSync(join('@j03l', 'drizzle-kit'), join(smoke, 'node_modules/drizzle-kit'));
if (existsSync(join(smoke, 'node_modules/pg'))) fail('smoke project got pg installed; the eager-require check above is no longer meaningful');

const smokeScript = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('t.db');
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, code TEXT NOT NULL, status TEXT);");
db.exec("CREATE INDEX i ON t (lower(code), id) WHERE status = 'active';");
db.close();
`;
writeFileSync(join(smoke, 'seed.mjs'), smokeScript);
run('node', ['seed.mjs'], { cwd: smoke });
const config = (out) =>
  `import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ dialect: 'sqlite', dbCredentials: { url: 'file:t.db' }, out: '${out}' });\n`;
writeFileSync(join(smoke, 'ok.config.ts'), config('./out-ok'));
writeFileSync(join(smoke, 'eisdir.config.ts'), config('./out-eisdir'));
mkdirSync(join(smoke, 'out-eisdir/schema.ts'), { recursive: true });

const kit = (kitArgs) =>
  spawnSync('node', [join(smoke, 'node_modules/@j03l/drizzle-kit/bin.cjs'), ...kitArgs], { cwd: smoke, encoding: 'utf8' });

const versionOut = kit(['--version']);
if (versionOut.status !== 0) fail(`drizzle-kit --version exited ${versionOut.status}:\n${versionOut.stderr}`);
console.log(`\n${versionOut.stdout.trim()}`);

const ok = kit(['pull', '--config', 'ok.config.ts']);
const schema = existsSync(join(smoke, 'out-ok/schema.ts')) ? readFileSync(join(smoke, 'out-ok/schema.ts'), 'utf8') : '';
const wantIndex = 'index("i").on(sql`lower(code)`, table.id).where(sql`status = \'active\'`)';
if (ok.status !== 0 || !schema.includes(wantIndex)) {
  fail(`pull of an expression + partial index did not round-trip (exit ${ok.status}).\nwanted: ${wantIndex}\nstderr: ${ok.stderr}\nschema.ts: ${schema}`);
}
console.log(`pull round-trips: ${wantIndex}`);

const eisdir = kit(['pull', '--config', 'eisdir.config.ts', '--output', 'json']);
const envelope = eisdir.stdout.trim().split('\n').at(-1) ?? '';
if (!envelope.includes('EISDIR')) {
  fail(`an error after the connection is still being masked. Last JSON line:\n${envelope}\nstderr:\n${eisdir.stderr}`);
}
console.log(`error after connection keeps its message: ${envelope}`);

rmSync(work, { recursive: true, force: true });
console.log(`
Built and smoke-tested: ${tarball}

Publish with:
  npm publish --access public ${tarball}

Then in apps/backend/package.json:
  "drizzle-kit": "npm:${SCOPED_NAME}@${version}"
`);
