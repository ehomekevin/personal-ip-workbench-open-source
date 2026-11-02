import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const manifest = readJson(join(root, 'package.json'));
const nodeVersion = '26.9.0';
// Pinned from https://nodejs.org/dist/v26.9.0/SHASUMS256.txt (ZIP and uncompressed node.exe).
const nodeArchiveSha256 = 'c8af870b5b3e9789a6cbdb30270e7c212e12d76a7afa7fc7f21b6b21cc22a71b';
const nodeExeSha256 = '8490398f5e0082772dfb0ae5a6ebdff98a97696a20cb9778b4f82eec79b6d0a1';
const nodeFolder = `node-v${nodeVersion}-win-x64`;
const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeFolder}.zip`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16_000_000 }).trimEnd();
if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== nodeVersion || manifest.engines.node !== nodeVersion) {
  throw new Error(`Build on Windows x64 with Node ${nodeVersion}`);
}
const output = process.argv[2];
if (!output || !isAbsolute(output)) throw new Error('Usage: node scripts/release/windows/build.mjs ABSOLUTE_OUTPUT_DIRECTORY');
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Build from a clean checkout');
const fileName = `chuangzuoyoushu-${manifest.version}-windows-x64.zip`;
const finalZip = join(output, fileName);
if (existsSync(finalZip)) throw new Error(`Refusing to replace ${finalZip}`);
const scratch = mkdtempSync(join(tmpdir(), 'workbench-windows-'));
const stage = join(scratch, 'package');
const runtime = join(stage, 'runtime');
const app = join(stage, 'app');
const jsonFile = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const copy = (source, target) => { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target); };

function packageDir(from, name) {
  let dir = dirname(createRequire(join(from, 'package.json')).resolve(name));
  while (dirname(dir) !== dir) {
    if (existsSync(join(dir, 'package.json')) && readJson(join(dir, 'package.json')).name === name) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Cannot locate installed dependency ${name}`);
}

async function prepareService() {
  const packages = ['contracts', 'storage', 'domain', 'adapters'];
  const aliases = new Map();
  for (const name of packages) {
    const dir = join(root, 'packages', name);
    for (const [subpath, target] of Object.entries(readJson(join(dir, 'package.json')).exports)) {
      aliases.set(`@workbench/${name}${subpath.slice(1)}`, resolve(dir, target));
    }
  }
  const files = execFileSync('git', ['ls-files', '-z', '--', 'apps/service/src', ...packages.map(n => `packages/${n}/src`),
    'packages/storage/migrations', 'assets', ...['local-server', 'init-workspace', 'collection-setup', 'static-assets'].map(n => `scripts/runtime/${n}.ts`)], { cwd: root }).toString().split('\0').filter(Boolean);
  const sources = files.filter(file => file.endsWith('.ts'));
  for (const file of files.filter(f => !f.endsWith('.ts'))) copy(join(root, file), join(app, file));
  // Compile each module in place. Workers, skills, migrations and presets resolve relative to import.meta.url.
  // Retain .ts entry filenames used by subprocesses; the contents are precompiled ESM JavaScript.
  await build({ absWorkingDir: root, entryPoints: sources, outbase: root, outdir: app, bundle: true, format: 'esm', platform: 'node',
    target: 'node26', outExtension: { '.js': '.ts' }, plugins: [{ name: 'portable-imports', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point') return;
        if (isBuiltin(args.path) || args.path.startsWith('.')) return { path: args.path, external: true };
        const target = args.path === 'undici' ? join(root, 'vendor/undici.mjs') : aliases.get(args.path);
        if (!target) throw new Error(`Unpackaged service dependency: ${args.path}`);
        const path = relative(dirname(args.importer), target).split(sep).join('/');
        return { path: path.startsWith('.') ? path : `./${path}`, external: true };
      });
    } }] });
  const undici = packageDir(join(root, 'apps/service'), 'undici');
  await build({ absWorkingDir: root, entryPoints: [join(undici, 'index.js')], outfile: join(app, 'vendor/undici.cjs'),
    platform: 'node', format: 'cjs', target: 'node26', bundle: true, legalComments: 'eof' });
  writeFileSync(join(app, 'vendor/undici.mjs'), "import client from './undici.cjs';\nexport const { ProxyAgent, Pool, buildConnector, fetch, WebSocket, EnvHttpProxyAgent } = client;\n");
  jsonFile(join(app, 'package.json'), { name: manifest.name, version: manifest.version, type: 'module' });
  return undici;
}

function includeLicenses(undici) {
  const seen = new Set();
  function include(dir) {
    const pkg = readJson(join(dir, 'package.json'));
    const id = `${pkg.name}-${pkg.version}`;
    if (seen.has(id)) return;
    seen.add(id);
    const licenses = readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && /^(licen[sc]e|notice|copying)(?:$|[.-])/i.test(f.name));
    if (!licenses.length) throw new Error(`Missing license for ${id}`);
    for (const license of licenses) copy(join(dir, license.name), join(stage, 'licenses', id, license.name));
    for (const dep of Object.keys(pkg.dependencies ?? {})) include(packageDir(dir, dep));
  }
  include(undici);
  const web = join(root, 'apps/web');
  for (const name of Object.keys(readJson(join(web, 'package.json')).dependencies).filter(name => !name.startsWith('@workbench/'))) include(packageDir(web, name));
  return [...seen].sort();
}

try {
  mkdirSync(runtime, { recursive: true });
  const download = await fetch(nodeUrl, { signal: AbortSignal.timeout(120000) });
  if (!download.ok) throw new Error(`Node distribution HTTP ${download.status}`);
  const archive = Buffer.from(await download.arrayBuffer());
  if (sha(archive) !== nodeArchiveSha256) throw new Error('Node distribution ZIP checksum mismatch');
  const archivePath = join(scratch, 'node.zip'); writeFileSync(archivePath, archive);
  execFileSync('tar.exe', ['-xf', archivePath, '-C', scratch, `${nodeFolder}/node.exe`, `${nodeFolder}/LICENSE`]);
  const exe = join(scratch, nodeFolder, 'node.exe');
  if (sha(readFileSync(exe)) !== nodeExeSha256) throw new Error('Node executable checksum mismatch');
  copy(exe, join(runtime, 'node.exe'));
  copy(join(scratch, nodeFolder, 'LICENSE'), join(stage, 'licenses/node', 'LICENSE'));
  const undici = await prepareService();
  const thirdParty = includeLicenses(undici);
  const web = join(root, 'apps/web/dist');
  if (!existsSync(join(web, 'index.html'))) throw new Error('Build the frontend with pnpm build:web first');
  cpSync(web, join(stage, 'web'), { recursive: true });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'GETTING_STARTED.md']) copy(join(root, file), join(stage, file));
  for (const [source, branded] of [['Start.cmd', '创作有数.cmd'], ['Stop.cmd', '退出创作有数.cmd']]) {
    const text = readFileSync(join(here, source), 'utf8').replace(/\r?\n/g, '\r\n');
    for (const name of [source, branded]) writeFileSync(join(stage, name), text);
  }
  copy(join(here, 'launcher.mjs'), join(runtime, 'launcher.mjs'));
  jsonFile(join(stage, 'release.json'), { version: manifest.version, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    platform: 'win32', arch: 'x64', nodeVersion, nodeUrl, nodeArchiveSha256, nodeExeSha256, thirdParty });
  const zip = join(scratch, fileName);
  execFileSync('python', ['-m', 'zipfile', '-c', zip, ...readdirSync(stage)], { cwd: stage });
  mkdirSync(output, { recursive: true });
  copyFileSync(zip, finalZip, constants.COPYFILE_EXCL);
  console.log(`${sha(readFileSync(finalZip))}  ${fileName}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
