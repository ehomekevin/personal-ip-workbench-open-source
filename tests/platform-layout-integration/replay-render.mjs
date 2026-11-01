import { readFile, writeFile, mkdir, readdir, lstat, copyFile, realpath, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import sqlite from 'node:sqlite';
import { join, resolve, relative, isAbsolute, extname, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { decodePNG, comparePixels } from './replay-png.mjs';

const root = resolve(import.meta.dirname, '../..'), own = resolve(process.env.PLATFORM_LAYOUT_REPLAY_RUNTIME ?? resolve(root, 'runtime/platform-layout-integration-r1/replay'));
assertOwnReplayRoot(own);
function assertOwnReplayRoot(path) { const parent=resolve(root,'runtime/platform-layout-integration-r1/replay'),rel=relative(parent,path);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Replay runtime must stay in its assigned namespace'); }
process.umask(0o077);
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); };
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const within = (base, path) => path === base || (!relative(base, path).startsWith('..') && !isAbsolute(relative(base, path)));
const differences = (a, b, path = '$', out = []) => {
  if (canonical(a) === canonical(b)) return out;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) { out.push({ path, before: a, after: b }); return out; }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], path + '.' + key, out);
  return out;
};
async function files(base) {
  const out = [];
  async function walk(dir) { for (const name of await readdir(dir)) { const path = join(dir, name), s = await lstat(path); assert(!s.isSymbolicLink(), 'No symlink in bundle: ' + path); if (s.isDirectory()) await walk(path); else if (s.isFile()) out.push({ path: relative(base, path), sha256: sha(await readFile(path)), size_bytes: s.size, mode: s.mode & 0o777 }); } }
  await walk(base); return out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function main() {
  // Gate is read before any SQL/HTTP/browser/renderer start. Parent writes it only after its explicit final-newbuild-ready message.
  const readyPath = join(own, 'newbuild-ready.json'), ready = JSON.parse(await readFile(readyPath, 'utf8'));
  assert(ready.authorized_message === '最终newbuild ready' && ready.source_root === root, 'Explicit accurate final build readiness is required');
  const temp = join(own, 'tmp');
  assert(process.env.TMPDIR === temp && tmpdir() === temp, 'Absolute own TMPDIR must be supplied before Node starts');
  assert(await realpath(own) === own && await realpath(temp) === temp, 'Own roots must be canonical');
  assert((await readdir(temp)).length === 0, 'Own TMPDIR is not initially empty');
  const prep = JSON.parse(await readFile(join(own, 'prepared-inputs.json'), 'utf8'));
  const started = new Date().toISOString(), result = { task: 'PLATFORM-LAYOUT-INTEGRATION-01/r1.1/replay', started_at: started, ready, source_root: root, own, default_renderer: true, original_SQL_connections: 0, own_SQL_connections: 0, real_native_calls: 0, model_calls: 0, provider_calls: 0, account_calls: 0, cases: [], errors: [] };
  const paths = [], requests = [], processSamples = [], profileEvents = [], profiles = new Map(), ownedChildPIDs = new Set();
  let db, server, renderer, timer, monitor = Promise.resolve();
  const closure = { TMPDIR: temp, temp_before: [], original_SQL_connections: 0, own_SQL_closed: false, HTTP_closed: false, renderer_close_returned: false, monitor_stopped: false, sampling_limit: 'ps/lsof are bounded observations of this owned process/profile set, not proof of whole-machine absence or remote cancellation.' };
  const sample = async () => {
    const now = new Date().toISOString(), names = await readdir(temp);
    for (const name of names.filter(name => name.startsWith('workbench-layout-chrome-'))) {
      const path = join(temp, name); if (!profiles.has(path)) { profiles.set(path, { path, first_seen: now, PIDs: [] }); profileEvents.push({ at: now, event: 'first_profile_path_seen', path }); }
    }
    const rows = execFileSync('ps', ['-axo', 'pid,ppid,pgid,command'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').slice(1).map(line => { const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m ? { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] } : null; }).filter(Boolean);
    const roots = rows.filter(row => [...profiles.keys()].some(path => row.command.includes('--user-data-dir=' + path)));
    const groups = new Set(roots.map(row => row.pgid)), tree = new Set(roots.map(row=>row.pid));
    for(let changed=true;changed;){changed=false;for(const row of rows)if(tree.has(row.ppid)&&!tree.has(row.pid)){tree.add(row.pid);changed=true;}}
    const owned = rows.filter(row => groups.has(row.pgid) || tree.has(row.pid) || row.pid === process.pid);
    if (roots.length) { processSamples.push({ at: now, processes: owned }); for (const row of owned) if (row.pid !== process.pid) ownedChildPIDs.add(row.pid); }
    for (const [path, info] of profiles) for (const row of roots.filter(row => row.command.includes('--user-data-dir=' + path))) if (!info.PIDs.includes(row.pid)) { info.PIDs.push(row.pid); profileEvents.push({ at: now, event: 'actual_user_data_dir_and_PID', path, ...row }); }
  };
  try {
    const dist = join(root, 'apps/web/dist'), bundle = await files(dist);
    const index = bundle.find(row => row.path === 'index.html'); assert(index && index.sha256 === ready.expected_index_sha256, 'Actual final index does not match ready binding');
    const boundRows=bundle.map(row=>({path:row.path,bytes:row.size_bytes,sha256:row.sha256,mode:row.mode}));
    result.bundle = { root: dist, files: bundle, canonical_algorithm: ready.canonical_algorithm, canonical_sha256: sha(JSON.stringify(boundRows)+'\n'), index_sha256: index.sha256, served_copy: join(own, 'served-dist') };
    if (ready.expected_bundle_sha256) assert(result.bundle.canonical_sha256 === ready.expected_bundle_sha256, 'Final bundle hash changed');
    for (const row of bundle) { const target = join(own, 'served-dist', row.path); await mkdir(dirname(target), { recursive: true }); await copyFile(join(dist, row.path), target); assert(sha(await readFile(target)) === row.sha256, 'Served bundle copy differs'); }
    const rendererSource = join(root, 'apps/service/src/bootstrap/article-layout-renderer.ts');
    result.renderer_source_sha256 = sha(await readFile(rendererSource));
    const { ArticleLayoutRenderer, ARTICLE_LAYOUT_RENDERER_VERSION } = await import(pathToFileURL(rendererSource).href);
    const { layoutRenderSnapshotHash, layoutBlockStructureHash } = await import(pathToFileURL(join(root, 'packages/adapters/src/media/layout-check/input.ts')).href);
    result.renderer_version = ARTICLE_LAYOUT_RENDERER_VERSION;
    assert(ARTICLE_LAYOUT_RENDERER_VERSION === 'c1-reader.v3', 'Renderer must remain v3');
    const cold = prep.inputs.filter(row => /workbench\.sqlite(?:-(?:wal|shm|journal))?$/.test(row.original));
    assert(cold.some(row => row.original.endsWith('workbench.sqlite')), 'Complete main cold DB required');
    await mkdir(join(own, 'work/cold'), { recursive: true });
    for (const row of cold) { const bytes = await readFile(row.own); assert(sha(bytes) === row.sha256, 'Own pristine cold copy changed'); const target = join(own, 'work/cold', row.original.split('/').at(-1)); await writeFile(target, bytes, { flag: 'wx' }); paths.push({ kind: 'complete_cold_family_raw_copy', original: row.original, packet: row.packet, pristine_own: row.own, adapted_own: target, sha256: row.sha256 }); }
    const dbPath = join(own, 'work/cold/workbench.sqlite'); assert(within(own, await realpath(dbPath)), 'SQL must be own physical copy');
    db = new sqlite.DatabaseSync(dbPath); result.own_SQL_connections++;
    const media = join(own, 'work/media'); await mkdir(media, { recursive: true });
    const ws = Object.values(prep.cases)[0].workspace_id;
    for (const id of new Set(Object.values(prep.cases).flatMap(c => c.asset_ids))) {
      const row = db.prepare('SELECT id,file_path,sha256,size_bytes,mime,status FROM assets WHERE workspace_id=? AND id=?').get(ws, id); assert(row && row.status === 'ready', 'Frozen asset missing/not ready');
      const source = prep.inputs.find(input => input.original === row.file_path); assert(source && source.sha256 === row.sha256, 'Explicit packet path mapping missing for asset');
      const bytes = await readFile(source.own); assert(sha(bytes) === row.sha256 && bytes.length === Number(row.size_bytes), 'Frozen asset bytes differ');
      const target = join(media, id, 'original'); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
      db.prepare('UPDATE assets SET file_path=? WHERE workspace_id=? AND id=?').run(target, ws, id);
      paths.push({ kind: 'own_DB_asset_file_path_adaptation', asset_id: id, original: row.file_path, packet: source.packet, own: target, sha256: row.sha256, bytes: bytes.length, original_proof_untouched: true });
    }
    server = createServer(async (req, res) => {
      const request = { at: new Date().toISOString(), method: req.method, url: req.url };
      try {
        const pathname = decodeURIComponent(new URL(req.url || '/', 'http://owned').pathname);
        assert(req.method === 'GET' && !pathname.startsWith('/api') && (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/assets/') || pathname.startsWith('/workbench/')), 'Static-only HTTP request denied');
        const path = resolve(own, 'served-dist', pathname === '/' ? 'index.html' : pathname.slice(1)); assert(within(join(own, 'served-dist'), path), 'Static path escape');
        const bytes = await readFile(path); request.status = 200; request.sha256 = sha(bytes); request.size_bytes = bytes.length;
        res.setHeader('content-type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' })[extname(path)] || 'application/octet-stream'); res.end(bytes);
      } catch (error) { request.status = 403; request.error = String(error); res.statusCode = 403; res.end('blocked'); } finally { requests.push(request); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done)); result.static_HTTP = server.address();
    closure.HTTP_port = server.address().port;
    await sample(); timer = setInterval(() => { monitor = monitor.then(sample).catch(error => { processSamples.push({ error: String(error) }); }); }, 50);
    for (const [name, c] of Object.entries(prep.cases)) {
      const snapshotBytes = await readFile(join(c.render_directory, 'snapshot.json')), contextBytes = await readFile(join(c.render_directory, 'visual-context.json'));
      const snapshot = JSON.parse(snapshotBytes), context = JSON.parse(contextBytes), old = JSON.parse(await readFile(join(c.render_directory, 'visual-input.json'), 'utf8'));
      assert(sha(snapshotBytes) === c.snapshot_sha256 && sha(contextBytes) === c.context_sha256, 'Original frozen snapshot/context changed');
      assert(context.renderer_version === ARTICLE_LAYOUT_RENDERER_VERSION && context.rules_version === 'wechat-layout-rules.3', 'Frozen version not inherited');
      renderer = new ArticleLayoutRenderer({ identity: { workspace_id: context.workspace_id }, db, paths: { media_root: media } }, { web_url: 'http://127.0.0.1:' + server.address().port, standard_png: join(c.render_directory, 'original-standard.png'), standard_html: join(c.render_directory, 'original-standard.html') });
      const directory = join(own, 'output', name), fresh = await renderer.render(snapshot, context, directory, new AbortController().signal);
      await renderer.close(); renderer = undefined;
      const caseResult = { case: name, original_render_id: c.render_id, snapshot_sha256: sha(snapshotBytes), context_sha256: sha(contextBytes), PNG: [], resource_address_differences: [], semantic_differences: [], renderer_rules_preserved: true };
      result.cases.push(caseResult);
      const derived = structuredClone(old);
      const replaceAddress = async (location, oldPath, newPath, kind) => {
        const src = prep.inputs.find(row => row.original === oldPath); assert(src, 'Unmapped original address: ' + oldPath);
        const beforeBytes = await readFile(src.own), afterBytes = await readFile(newPath);
        const entry = { field: location, kind, old_path: oldPath, old_packet: src.packet, old_own: src.own, new_path: newPath, old_sha256: sha(beforeBytes), new_sha256: sha(afterBytes), bytes_equal: beforeBytes.equals(afterBytes) };
        caseResult.resource_address_differences.push(entry); paths.push(entry); return entry;
      };
      derived.work_directory = fresh.work_directory;
      caseResult.resource_address_differences.push({ field: 'work_directory', kind: 'owned_output_directory_only', old_path: old.work_directory, new_path: fresh.work_directory });
      for (const field of ['standard_png', 'standard_html']) { const entry = await replaceAddress(field + '.path', old[field].path, fresh[field].path, 'same_bytes_standard'); assert(entry.bytes_equal, 'Original standard bytes differ'); derived[field].path = fresh[field].path; }
      assert(old.render_pngs.length === fresh.render_pngs.length, 'PNG slice count differs');
      for (let i = 0; i < old.render_pngs.length; i++) {
        const before = old.render_pngs[i], after = fresh.render_pngs[i], mapped = prep.inputs.find(row => row.original === before.path); assert(mapped, 'Original PNG mapping missing');
        const a = await readFile(mapped.own), b = await readFile(after.path), rawEqual = a.equals(b);
        const decoded = rawEqual ? { pixels_equal: true, method: 'identical PNG raw bytes prove identical pixels', differing_pixels: 0 } : comparePixels(decodePNG(a), decodePNG(b));
        caseResult.PNG.push({ index: i, original_path: before.path, original_own: mapped.own, new_path: after.path, old_sha256: sha(a), new_sha256: sha(b), raw_equal: rawEqual, ...decoded });
        assert(canonical({ ...before, path: undefined, sha256: undefined }) === canonical({ ...after, path: undefined, sha256: undefined }), 'PNG range/dimensions/block coverage differs');
        derived.render_pngs[i] = { ...before, path: after.path, sha256: after.sha256 };
      }
      for (let i = 0; i < old.blocks.length; i++) if (old.blocks[i].image?.path) { const entry = await replaceAddress('blocks[' + i + '].image.path', old.blocks[i].image.path, fresh.blocks[i]?.image?.path, 'same_bytes_original_asset'); assert(entry.bytes_equal, 'Adopted image bytes differ'); derived.blocks[i].image.path = fresh.blocks[i].image.path; }
      // Only explicitly verified resource addresses and, if necessary, byte-encoding hashes are derived. Original proof stays immutable.
      derived.binding.block_structure_sha256 = layoutBlockStructureHash(derived.blocks);
      derived.binding.render_snapshot_sha256 = layoutRenderSnapshotHash(derived.render_pngs);
      caseResult.derived_hashes = { original_block_structure: old.binding.block_structure_sha256, derived_block_structure: derived.binding.block_structure_sha256, new_block_structure: fresh.binding.block_structure_sha256, original_render_snapshot: old.binding.render_snapshot_sha256, derived_render_snapshot: derived.binding.render_snapshot_sha256, new_render_snapshot: fresh.binding.render_snapshot_sha256 };
      caseResult.semantic_differences = differences(derived, fresh);
      caseResult.snapshot_and_context_written_unchanged = (await readFile(join(directory, 'snapshot.json'))).equals(snapshotBytes) && (await readFile(join(directory, 'visual-context.json'))).equals(contextBytes);
      caseResult.passed = caseResult.semantic_differences.length === 0 && caseResult.snapshot_and_context_written_unchanged && caseResult.PNG.every(row => row.raw_equal && row.pixels_equal);
      await put(join(own, name + '-pixel-semantic.json'), caseResult);
    }
    result.bundle_unchanged_during_run = canonical(await files(dist)) === canonical(result.bundle.files);
    assert(result.bundle_unchanged_during_run, 'Actual final dist changed during render');
    result.passed = result.cases.length === 2 && result.cases.every(c => c.passed);
  } catch (error) { result.errors.push({ at: new Date().toISOString(), stack: error.stack || String(error) }); result.passed = false; console.error(error.stack || String(error)); }
  finally {
    if (renderer) { try { await renderer.close(); } catch (error) { closure.renderer_close_error = String(error); } }
    closure.renderer_close_returned = !closure.renderer_close_error;
    clearInterval(timer); await monitor; closure.monitor_stopped = true;
    if (server) { closure.HTTP_before_close_address = server.address(); closure.HTTP_before_close_at = new Date().toISOString(); closure.HTTP_before_close_listening = server.listening; try { closure.lsof_HTTP_before_close = { output: execFileSync('lsof', ['-nP', '-iTCP:' + closure.HTTP_port, '-sTCP:LISTEN'], { encoding: 'utf8' }) }; } catch (error) { closure.lsof_HTTP_before_close = { status: error.status, output: String(error.stdout || ''), stderr: String(error.stderr || '') }; } await new Promise(done => server.close(done)); closure.HTTP_closed = true; closure.HTTP_after_close_address = server.address(); closure.HTTP_after_close_listening = server.listening; try { closure.lsof_HTTP_after_close = { output: execFileSync('lsof', ['-nP', '-iTCP:' + closure.HTTP_port, '-sTCP:LISTEN'], { encoding: 'utf8' }) }; } catch (error) { closure.lsof_HTTP_after_close = { status: error.status, output: String(error.stdout || ''), stderr: String(error.stderr || '') }; } }
    if (db) { db.close(); closure.own_SQL_closed = true; }
    closure.profile_observations = [...profiles.values()];
    closure.profiles_removed = await Promise.all([...profiles.keys()].map(async path => ({ path, absent: !(await exists(path)) })));
    closure.temp_after = await readdir(temp);
    closure.profile_PID_capture_complete = profiles.size >= 2 && [...profiles.values()].every(info => info.PIDs.length > 0);
    closure.owned_child_PIDs = [...ownedChildPIDs].sort((a, b) => a - b);
    closure.ps_after = (() => { const ids = closure.owned_child_PIDs; if (!ids.length) return { not_observed: true }; try { return { output: execFileSync('ps', ['-p', ids.join(','), '-o', 'pid,ppid,pgid,command'], { encoding: 'utf8' }) }; } catch (error) { return { status: error.status, output: String(error.stdout || '') }; } })();
    closure.lsof_own_SQL_after = (() => { try { return { output: execFileSync('lsof', ['-nP', join(own, 'work/cold/workbench.sqlite')], { encoding: 'utf8' }) }; } catch (error) { return { status: error.status, output: String(error.stdout || ''), stderr: String(error.stderr || '') }; } })();
    closure.closed_at = new Date().toISOString();
    result.completed_at = closure.closed_at; result.closure = closure;
    result.inheritance_recommendation = result.passed ? 'Both actual default-renderer outputs preserve identical PNG raw bytes, pixels and full non-path semantics; retain original r3 model results under this exact source/build binding. Raw originals/proof not rewritten. Internal evidence only, independent QA required.' : 'Do not claim inheritance; report the exact captured difference/first error. No new model or source expansion is authorized.';
    await put(join(own, 'resource-pathmap.json'), paths); await put(join(own, 'HTTP-requests.json'), requests); await put(join(own, 'profile-events.json'), profileEvents); await put(join(own, 'process-samples.json'), processSamples); await put(join(own, 'closure.json'), closure); await put(join(own, 'pixel-semantic-result.json'), result);
  }
  console.log(JSON.stringify({ passed: result.passed, cases: result.cases.map(c => ({ case: c.case, passed: c.passed, PNG: c.PNG.map(p => ({ raw_equal: p.raw_equal, pixels_equal: p.pixels_equal })) })), bundle_sha256: result.bundle?.canonical_sha256, profile_PID_capture_complete: closure.profile_PID_capture_complete, temp_after: closure.temp_after, original_SQL_connections: 0, real_native_calls: 0 }));
  if (!result.passed || !closure.profile_PID_capture_complete || closure.temp_after.length || !closure.own_SQL_closed || !closure.HTTP_closed) process.exitCode = 1;
}
await main();
