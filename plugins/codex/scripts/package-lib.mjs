import { mkdir, readFile, writeFile, copyFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseBuildArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--runtime-root', '--server', '--ui', '--skills', '--out'].includes(key) || !argv[i + 1] || options[key.slice(2)]) throw new Error('Usage: [--runtime-root <shared runtime>] [--server <server.mjs>] [--ui <workbench.html>] [--skills <shared skills>] --out <new directory>');
    options[key.slice(2)] = resolve(argv[i + 1]);
  }
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const runtime = options['runtime-root'] ?? join(repository, '.ci-artifacts/plugins/shared');
  options.server ??= join(runtime, 'server/server.mjs');
  options.ui ??= join(runtime, 'ui/workbench.html');
  options.skills ??= join(repository, 'plugins/shared/skills');
  if (!options.out) throw new Error('Missing --out');
  return options;
}

export async function filesBelow(root, relative = '') {
  const result = [];
  for (const name of (await readdir(join(root, relative))).sort()) {
    const path = join(relative, name), stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Package symlink is forbidden: ${path}`);
    if (stat.isDirectory()) result.push(...await filesBelow(root, path));
    else if (stat.isFile()) result.push(path.replaceAll('\\', '/'));
    else throw new Error(`Package special file is forbidden: ${path}`);
  }
  return result;
}

export async function stageRuntime(root, options) {
  await mkdir(join(root, 'server'), { recursive: true });
  await mkdir(join(root, 'ui'), { recursive: true });
  if (!options.server.endsWith('.mjs') || !options.ui.endsWith('.html')) throw new Error('Require compiled server.mjs and shared workbench.html');
  await copyFile(options.server, join(root, 'server/server.mjs'));
  await copyFile(options.ui, join(root, 'ui/workbench.html'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'personal-ip-workbench', version: '0.1.0', private: true, type: 'module', engines: { node: '>=24.0.0' } }, null, 2) + '\n');
  for (const path of await filesBelow(options.skills)) {
    if (!/^[a-z][a-z0-9-]*\/SKILL\.md$/.test(path)) throw new Error(`Only reviewed shared Skills are packaged: ${path}`);
    const target = join(root, 'skills', path); await mkdir(dirname(target), { recursive: true }); await copyFile(join(options.skills, path), target);
  }
}

export async function copyTemplate(source, root) {
  for (const path of await filesBelow(source)) {
    const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await copyFile(join(source, path), target);
  }
}

export async function inspectPackage(root, form) {
  const files = await filesBelow(root);
  const expected = form === 'codex' ? ['plugin.json', 'mcp.json'] : form === 'claude' ? ['.claude-plugin/plugin.json', '.mcp.json'] : ['manifest.json'];
  for (const path of [...expected, 'server/server.mjs', 'ui/workbench.html', 'package.json', 'README.md', 'LICENSE']) if (!files.includes(path)) throw new Error(`Package file missing: ${path}`);
  if (!files.some(path => /^[a-z0-9/-]+\/SKILL\.md$/.test(path))) throw new Error('Shared Skills missing');
  const inventory = [];
  for (const path of files) {
    if (/(?:^|\/)(?:connection(?:s)?|descriptor|state|data|node_modules|\.git)(?:\/|\.)|\.(?:sqlite|db|pem|key|env|map)$/i.test(path)) throw new Error(`Private/runtime state file forbidden: ${path}`);
    if (!/^(?:plugin\.json|mcp\.json|\.mcp\.json|\.claude-plugin\/plugin\.json|manifest\.json|package\.json|README\.md|LICENSE|server\/server\.mjs|ui\/workbench\.html|skills\/[a-z][a-z0-9-]*\/SKILL\.md)$/.test(path)) throw new Error(`Unreviewed package file: ${path}`);
    const bytes = await readFile(join(root, path));
    if (/\/Users\/|\/Volumes\/|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString('utf8'))) throw new Error(`Nonportable path or private key forbidden: ${path}`);
    inventory.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const identity = JSON.parse(await readFile(join(root, expected[0]), 'utf8'));
  if (identity.name !== 'personal-ip-workbench' || identity.version !== '0.1.0') throw new Error('Stable plugin identity/version mismatch');
  return inventory;
}

// ZIP32 / deflate entries: fixed timestamps, UTF-8 names, sorted content; no shell or host state.
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function crc32(bytes) { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export async function archivePackage(root, file, form) {
  const inventory = await inspectPackage(root, form), local = [], central = []; let offset = 0;
  for (const { path } of inventory) {
    const name = Buffer.from(path), data = await readFile(join(root, path)), compressed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    if (data.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP32 size limit exceeded');
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(0x81a40000, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(inventory.length, 8); end.writeUInt16LE(inventory.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, directory, end]); await writeFile(file, bytes);
  return { file: file.split(/[\\/]/).at(-1), bytes: bytes.length, sha256: hash(bytes), inventory };
}
