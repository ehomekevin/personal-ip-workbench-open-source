import { readFileSync, mkdirSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep, relative } from 'node:path';
import { ContractError, MAX_CONCURRENT_GENERATIONS, MAX_IMAGE_GENERATION_LIMIT, type ServiceConfiguration } from '@workbench/contracts';
import { assertStorageRoot } from '@workbench/storage/connection';
import { parseCidr } from '../../../../packages/adapters/src/web/public-fetch.ts';
const keys = ['workspace_id', 'service_instance_id', 'title', 'mode', 'timezone', 'paths', 'listen', 'default_executor', 'api_fallback_enabled', 'max_concurrent_generations', 'image_generation_limits', 'web_fetch'];
const pathKeys = ['source_vault_root', 'managed_notes_root', 'state_root', 'media_root'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(field: string): never { throw new ContractError('VALIDATION_ERROR', '启动配置无效', { field }); }
function physicalPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    // existsSync 会把悬空链接视为不存在；不能跳过它再创建可能被源库指向的写根。
    if (lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) invalid('paths.unresolved_symlink');
    existing = dirname(existing);
  }
  return resolve(realpathSync(existing), relative(existing, absolute));
}
export function validateConfiguration(input: unknown): ServiceConfiguration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('config');
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(key);
  for (const key of ['workspace_id', 'service_instance_id']) if (typeof value[key] !== 'string' || !uuid.test(value[key])) invalid(key);
  if (typeof value.title !== 'string' || !value.title.trim()) invalid('title');
  if (!['real', 'demo'].includes(String(value.mode))) invalid('mode');
  if (typeof value.timezone !== 'string') invalid('timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone as string }); } catch { invalid('timezone'); }
  if (!value.paths || typeof value.paths !== 'object' || Array.isArray(value.paths)) invalid('paths');
  const paths = value.paths as Record<string, unknown>;
  for (const key of Object.keys(paths)) if (!pathKeys.includes(key)) invalid('paths.' + key);
  for (const key of pathKeys) { if (key === 'source_vault_root' && paths[key] === null) continue; if (typeof paths[key] !== 'string' || !isAbsolute(paths[key])) invalid('paths.' + key); }
  const managed = ['managed_notes_root', 'state_root', 'media_root'].map(key => physicalPath(paths[key] as string));
  const all = paths.source_vault_root === null ? managed : [...managed, physicalPath(paths.source_vault_root as string)];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (all[i] === all[j] || all[i]!.startsWith(all[j] + sep) || all[j]!.startsWith(all[i] + sep)) invalid('paths.overlap');
  if (!value.listen || typeof value.listen !== 'object') invalid('listen');
  const listen = value.listen as Record<string, unknown>;
  if (Object.keys(listen).some(key => !['host', 'port'].includes(key)) || listen.host !== '127.0.0.1' || !Number.isSafeInteger(listen.port) || Number(listen.port) < 1 || Number(listen.port) > 65535) invalid('listen');
  if (value.default_executor !== undefined && !['codex', 'claude'].includes(String(value.default_executor))) invalid('default_executor');
  if (value.api_fallback_enabled !== undefined && typeof value.api_fallback_enabled !== 'boolean') invalid('api_fallback_enabled');
  if (value.max_concurrent_generations !== undefined && (!Number.isSafeInteger(value.max_concurrent_generations) || Number(value.max_concurrent_generations) < 1 || Number(value.max_concurrent_generations) > MAX_CONCURRENT_GENERATIONS)) invalid('max_concurrent_generations');
  if (value.image_generation_limits !== undefined) {
    const limits = value.image_generation_limits as Record<string, unknown>;
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) invalid('image_generation_limits');
    for (const [key, limit] of Object.entries(limits)) if (!['codex', 'agy'].includes(key) || (limit !== null && (!Number.isSafeInteger(limit) || Number(limit) < 0 || Number(limit) > MAX_IMAGE_GENERATION_LIMIT))) invalid('image_generation_limits.' + key);
  }
  if (value.web_fetch !== undefined) validateWebFetch(value.web_fetch);
  return value as unknown as ServiceConfiguration;
}
function validateWebFetch(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('web_fetch');
  const web = input as Record<string, unknown>;
  for (const key of Object.keys(web)) if (!['doh_resolvers', 'fake_ip_ranges'].includes(key)) invalid('web_fetch.' + key);
  const list = (key: string, ok: (item: string) => boolean) => { const items = web[key]; if (items === undefined) return; if (!Array.isArray(items) || !items.length || items.length > 8 || items.some(item => typeof item !== 'string' || !ok(item))) invalid('web_fetch.' + key); };
  list('doh_resolvers', item => { try { const url = new URL(item); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } });
  list('fake_ip_ranges', item => parseCidr(item) !== null);
}
export function loadConfiguration(path = process.env.WORKBENCH_CONFIG_PATH): ServiceConfiguration {
  if (!path || !isAbsolute(path)) throw new ContractError('VALIDATION_ERROR', 'WORKBENCH_CONFIG_PATH 必须指向明确的绝对配置路径');
  assertStorageRoot(dirname(path));
  return validateConfiguration(JSON.parse(readFileSync(path, 'utf8')));
}
export function createConfiguredDirectories(config: ServiceConfiguration): void {
  // 只创建显式工作台目录；源库即使已配置也只核对，不创建。
  for (const root of [config.paths.state_root, config.paths.managed_notes_root, config.paths.media_root]) {
    let ancestor = root; while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) throw new ContractError('STORAGE_UNAVAILABLE', '找不到有效存储父路径'); ancestor = parent; }
    assertStorageRoot(ancestor); mkdirSync(root, { recursive: true }); assertStorageRoot(realpathSync(root));
  }
  for (const name of ['staging', 'raw-responses', 'backups']) mkdirSync(resolve(config.paths.state_root, name), { recursive: true });
}
