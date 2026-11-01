import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStorageDirectory } from './storage-root.ts';
import { ContractError, type RequestHash, type OutputHash, type InputHash, type Sha256, type JsonValue } from '@workbench/contracts';
export type { DatabaseSync } from 'node:sqlite';
export const MIGRATIONS = [
  { version: 1, name: 'initial', file: '0001_initial.sql', previous: 0 },
  { version: 2, name: 'constraints', file: '0002_constraints.sql', previous: 1 },
  { version: 3, name: 'integrity', file: '0003_integrity.sql', previous: 2 },
  { version: 4, name: 'evidence_polymorphism', file: '0004_evidence_polymorphism.sql', previous: 3 },
  { version: 5, name: 'receipt_payload', file: '0005_receipt_payload.sql', previous: 4 },
  { version: 6, name: 'source_content', file: '0006_source_content.sql', previous: 5 },
  { version: 7, name: 'plan_inputs', file: '0007_plan_inputs.sql', previous: 6 },
  { version: 8, name: 'publishing_settings', file: '0008_publishing_settings.sql', previous: 7 },
  { version: 9, name: 'skills', file: '0009_skills.sql', previous: 8 },
] as const;
const migrationRoot = fileURLToPath(new URL('../../migrations/', import.meta.url));
export function sha256(bytes: string | Uint8Array): Sha256 { return createHash('sha256').update(bytes).digest('hex') as Sha256; }
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  throw new ContractError('VALIDATION_ERROR', '规范 JSON 不接受 undefined 或非有限数值');
}
export function requestHash(request: unknown): RequestHash { return sha256(canonicalJson(request)) as unknown as RequestHash; }
export function outputHash(output: { target: JsonValue; commit_purpose: string; input_hash: InputHash; typed_output: JsonValue }): OutputHash { return sha256(canonicalJson(output)) as unknown as OutputHash; }
export function inputHash(manifest: unknown): InputHash { return sha256(canonicalJson(manifest)) as unknown as InputHash; }
export function assertStorageRoot(path: string): void {
  try { validateStorageDirectory(path); }
  catch { throw new ContractError('STORAGE_UNAVAILABLE', 'Storage must be an existing, writable absolute directory without symlink components or an unmounted external volume'); }
}
export function configureDatabase(db: DatabaseSync): void {
  db.function('decimal_valid', { deterministic: true }, value => typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? 1 : 0);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
}
export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) throw new Error('Nested transaction is not supported; pass the current transaction explicitly');
  db.exec('BEGIN IMMEDIATE');
  try { const value = operation(); if (value && typeof value === 'object' && 'then' in value) throw new Error('SQLite transaction cannot contain asynchronous work'); db.exec('COMMIT'); return value; }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
export interface MigrationResult { from_version: number; to_version: number; applied: number[]; checksums: Record<string, string> }
export function migrateDatabase(db: DatabaseSync, options: { targetVersion?: number } = {}): MigrationResult {
  const target = options.targetVersion ?? MIGRATIONS.at(-1)!.version;
  if (!Number.isSafeInteger(target) || target < 0 || target > MIGRATIONS.at(-1)!.version) throw new Error('Unknown migration target');
  const hasRegistry = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!hasRegistry && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Unversioned nonempty database: unresolved_provenance; automatic upgrade refused');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;');
  const rows = db.prepare('SELECT version,name,sha256 FROM schema_migrations ORDER BY version').all();
  let current = 0; const checksums: Record<string, string> = {};
  for (const row of rows) {
    const migration = MIGRATIONS.find(m => m.version === Number(row.version));
    if (!migration || migration.previous !== current) throw new Error('Migration registry is noncontiguous or newer than this service');
    const checksum = sha256(readFileSync(join(migrationRoot, migration.file)));
    if (row.sha256 !== checksum || row.name !== migration.name) throw new Error('Applied migration checksum mismatch');
    checksums[String(migration.version)] = checksum; current = migration.version;
  }
  if (current > target) throw new Error('Migration downgrade is not supported');
  const from = current; const applied: number[] = [];
  for (const migration of MIGRATIONS.filter(m => m.version > current && m.version <= target)) {
    if (migration.previous !== current) throw new Error('Migration precondition failed');
    const sql = readFileSync(join(migrationRoot, migration.file), 'utf8'); const checksum = sha256(sql);
    transaction(db, () => {
      db.exec(sql);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration produced invalid workspace/provenance foreign keys');
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(migration.version, migration.name, checksum, new Date().toISOString());
      db.exec(`PRAGMA user_version=${migration.version}`);
    });
    current = migration.version; applied.push(current); checksums[String(current)] = checksum;
  }
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== current) throw new Error('user_version does not match migration registry');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Existing database has invalid workspace/provenance foreign keys');
  return { from_version: from, to_version: current, applied, checksums };
}
export interface WorkspaceStorage { db: DatabaseSync; path: string; migration: MigrationResult; close(): void }
export function openWorkspaceStorage(databasePath: string): WorkspaceStorage {
  if (!isAbsolute(databasePath) || resolve(databasePath) !== databasePath) throw new ContractError('STORAGE_UNAVAILABLE', 'Database path must be canonical and absolute');
  assertStorageRoot(dirname(databasePath));
  if (!isAbsolute(databasePath)) throw new ContractError('STORAGE_UNAVAILABLE', 'Database path must be absolute');
  const existing = lstatSync(databasePath, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || realpathSync(databasePath) !== databasePath))
    throw new ContractError('STORAGE_UNAVAILABLE', 'Database must be a physical regular file');
  let db: DatabaseSync | undefined;
  try { db = new DatabaseSync(databasePath, { timeout: 1000 }); configureDatabase(db); const migration = migrateDatabase(db); const connection = db; return { db: connection, path: databasePath, migration, close: () => connection.close() }; }
  catch (error) { db?.close(); throw error; }
}
export * from './idempotency.ts';
