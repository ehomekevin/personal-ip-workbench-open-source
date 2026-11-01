import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hash } from '../../packages/adapters/src/agent/codex/primitives.ts';
import { projectRoot } from './harness.ts';
export function sourceSnapshot() {
 const files: Array<{ path: string; bytes: number; sha256: string }> = [];
 const visit = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const next = join(path, entry.name); if (entry.isDirectory()) { if (!entry.name.startsWith('.')) visit(next); } else if (/\.(ts|mjs|json)$/.test(entry.name)) { const bytes = readFileSync(next); files.push({ path: relative(projectRoot, next), bytes: bytes.length, sha256: hash(bytes) }); } } };
 for (const path of ['packages/adapters/src/agent/codex', 'packages/adapters/src/agent/claude', 'packages/domain/src/service-agent', 'apps/service/src/worker/handlers/agent', 'tests/service-agent']) visit(join(projectRoot, path));
 return { at: new Date().toISOString(), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
