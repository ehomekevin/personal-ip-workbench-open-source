import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { validateStorageDirectory } from '../../packages/storage/src/connection/storage-root.ts';

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[index + 1]!;
}
if (args.some((value, i) => i % 2 === 0 && !['--dir', '--port', '--mode'].includes(value)))
  throw new Error('Usage: pnpm init:workspace [--dir ./runtime/demo] [--port 4318] [--mode demo|real]');
const target = resolve(option('--dir', './runtime/demo'));
const mode = option('--mode', 'demo');
if (!['demo', 'real'].includes(mode)) throw new Error('Mode must be demo or real');
const port = Number(option('--port', '4318'));
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
let ancestor = target;
while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
validateStorageDirectory(ancestor);
// Never create an absent external mount as an ordinary directory.
if (process.platform === 'darwin' && target.startsWith('/Volumes/')) {
  const mount = target.split('/').slice(0, 3).join('/');
  validateStorageDirectory(mount);
}
const configPath = join(target, 'config.json');
if (existsSync(configPath)) throw new Error('Configuration already exists; refusing to overwrite it');
mkdirSync(target, { recursive: true, mode: 0o700 });
const root = realpathSync(target); validateStorageDirectory(root);
const paths = { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') };
const config = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: '我的创作工作台', mode, timezone: 'UTC',
  paths, listen: { host: '127.0.0.1', port }, default_executor: 'codex', api_fallback_enabled: false };
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
console.log('Created an isolated workspace configuration.');
console.log(`WORKBENCH_CONFIG_PATH=${shellQuote(configPath)} pnpm dev:service`);
