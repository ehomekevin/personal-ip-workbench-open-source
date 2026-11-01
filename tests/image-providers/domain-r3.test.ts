import test from '../helpers/media-tools.ts'; // 依赖真实图像解码；缺 ffmpeg/ffprobe 时跳过
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, seeded, FakeImageProvider } from './harness.ts';
import { ImageGenerationWorkflow, imageReceiptPath, readImageReceipt } from '../../packages/domain/src/artifact-execution/image.ts';
import { ResultCommit, type TypedOutput } from '../../packages/domain/src/result-commit/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { ImageProviderSettings } from '../../packages/domain/src/settings/image-providers.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { createMediaHandlers } from '../../apps/service/src/worker/handlers/media/index.ts';
import { getJob, type ClaimedJob } from '../../packages/storage/src/jobs/index.ts';
import { sha256 } from '../../packages/storage/src/connection/index.ts';
import { AssetGenerationSchema, type ImageGenerationRequest, type JsonObject } from '../../packages/contracts/src/index.ts';
import { WORKBENCH_TOOL_ROUTES, routeRequest } from '../../packages/host-bridge/src/core/tools.ts';

function submit(f: ReturnType<typeof fixture>, claim: ClaimedJob, typed: unknown) {
  return new ResultCommit(f.context).submit(f.request(), claim.job.id, { attempt_id: claim.attempt.id, attempt_generation: claim.attempt.attempt_generation, expected_version: getJob(f.context.db, f.config.workspace_id, claim.job.id).version, input_hash: claim.job.input_hash, typed_output: typed as TypedOutput }, claim.fence.lease_owner);
}
function noSuccess(f: ReturnType<typeof fixture>, id: string) {
  assert.notEqual(getJob(f.context.db, f.config.workspace_id, id).state, 'succeeded');
  assert.equal(f.context.db.prepare("SELECT count(*) n FROM assets WHERE status='ready'").get()!.n, 0);
  assert.equal(f.context.db.prepare("SELECT count(*) n FROM result_receipts WHERE state='committed'").get()!.n, 0);
}
async function prepared(f: ReturnType<typeof fixture>) {
  const { input } = await seeded(f), provider = new FakeImageProvider(), workflow = new ImageGenerationWorkflow(f.context, { provider: () => provider });
  workflow.enqueue(f.request(), input); const jobs = new Jobs(f.context), claim = jobs.claim('r3-finalizer')!;
  const image = await workflow.execute(claim, new AbortController().signal, value => jobs.checkpoint(claim.fence, value));
  return { workflow, provider, claim, image };
}
for (const generated of [undefined, null, [], {}, ['invalid'], [null], [{ asset_id: 'x', manifest_path: 'x', sha256: 'x' }, {}]]) {
  test('IP01 rejects missing/empty/malformed/multiple image output: ' + JSON.stringify(generated), async () => {
    const f = fixture(); try { const { input } = await seeded(f), workflow = new ImageGenerationWorkflow(f.context); workflow.enqueue(f.request(), input); const claim = new Jobs(f.context).claim('r3-empty')!;
      assert.throws(() => submit(f, claim, { documents: [], recommendations: [], ...(generated === undefined ? {} : { generated_assets: generated }) }), { code: 'VALIDATION_ERROR' }); noSuccess(f, claim.job.id);
    } finally { f.cleanup(); }
  });
}
test('IP01 refuses artifact substitutes/mixed image output and a real image without its provider receipt', async () => {
  const f = fixture(); try { const { claim, image } = await prepared(f);
    for (const typed of [{ documents: [], recommendations: [], artifacts: [] }, { documents: [], recommendations: [], generated_assets: [image], artifacts: [] }]) assert.throws(() => submit(f, claim, typed), { code: 'VALIDATION_ERROR' });
    rmSync(imageReceiptPath(f.context, claim.job.id)); const receipt = submit(f, claim, { documents: [], recommendations: [], generated_assets: [image] }); assert.equal(receipt.state, 'pending'); noSuccess(f, claim.job.id);
  } finally { f.cleanup(); }
});
test('IP01 retains legal empty non-image programmatic results', async () => {
  const f = fixture(); try { const queued = new Jobs(f.context).enqueue(f.request(), { kind: 'source_sync', entrypoint: 'standalone_web', execution_mode: 'programmatic', input_manifest: { schema_version: 'fixture', mode: 'none', targets: [], source_ids: [] }, presentation: 'background' }); const claim = new Jobs(f.context).claim('r3-non-image')!; assert.equal(claim.job.id, queued.id); assert.equal(submit(f, claim, { documents: [], recommendations: [] }).state, 'committed'); } finally { f.cleanup(); }
});
for (const variant of ['original_attempt', 'original_generation', 'nested_binding', 'nested_input', 'result_binding', 'checkpoint_identity', 'sql_authority'] as const) {
  test('IP02 rejects forged original identity at ' + variant, async () => {
    const f = fixture(); try { const { claim, image } = await prepared(f), path = imageReceiptPath(f.context, claim.job.id), receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (variant === 'original_attempt') receipt.original_binding.attempt_id = 'wrong-original-attempt';
      if (variant === 'original_generation') receipt.original_binding.attempt_generation += 10;
      if (variant === 'nested_binding') receipt.checkpoint.original_binding.attempt_generation += 10;
      if (variant === 'nested_input') receipt.checkpoint.original_input.binding.attempt_generation += 10;
      if (variant === 'result_binding') receipt.result.native.original_binding.attempt_generation += 10;
      if (variant === 'checkpoint_identity') receipt.checkpoint.conversation_id = 'different-native';
      if (variant === 'sql_authority') { const row = f.context.db.prepare('SELECT checkpoint FROM job_attempts WHERE id=?').get(claim.attempt.id)!; const cp = JSON.parse(String(row.checkpoint)); cp.image_submit_binding.attempt_generation += 10; f.context.db.prepare('UPDATE job_attempts SET checkpoint=? WHERE id=?').run(JSON.stringify(cp), claim.attempt.id); }
      writeFileSync(path, JSON.stringify(receipt)); const result = submit(f, claim, { documents: [], recommendations: [], generated_assets: [image] }); assert.notEqual(result.state, 'committed'); noSuccess(f, claim.job.id);
    } finally { f.cleanup(); }
  });
}
test('IP02 query recovery binds original submit attempt while finalizing through a later attempt', async () => {
  const f = fixture(); try { const { input } = await seeded(f), provider = new FakeImageProvider(); provider.disconnect = true; const workflow = new ImageGenerationWorkflow(f.context, { provider: () => provider }), q = workflow.enqueue(f.request(), input), worker = new DurableWorker(f.context, createMediaHandlers(f.context, { image: workflow })); await worker.runOnce(); const original = readImageReceipt(f.context, q.job_id, q.input_hash).original_binding; provider.disconnect = false; workflow.recover(f.request(), q.job_id, getJob(f.context.db, f.config.workspace_id, q.job_id).version); assert.equal((await worker.runOnce())!.state, 'committed'); const current = getJob(f.context.db, f.config.workspace_id, q.job_id), receipt = readImageReceipt(f.context, q.job_id, q.input_hash); assert.equal(receipt.original_binding.attempt_id, original.attempt_id); assert.equal(receipt.original_binding.attempt_generation, 1); assert(current.attempt_generation > original.attempt_generation); assert.equal(f.context.db.prepare('SELECT count(*) n FROM job_attempts WHERE job_id=?').get(q.job_id)!.n, 2); assert.notEqual(current.current_attempt_id, original.attempt_id); assert.equal(provider.submits, 1); assert.equal(provider.queries, 1);
  } finally { f.cleanup(); }
});
test('IP02 cannot relabel the submit receipt as a valid later SQLite query attempt', async () => {
  const f=fixture(); try {
    const {input}=await seeded(f),provider=new FakeImageProvider();provider.disconnect=true;
    const workflow=new ImageGenerationWorkflow(f.context,{provider:()=>provider}),q=workflow.enqueue(f.request(),input),jobs=new Jobs(f.context);
    await new DurableWorker(f.context,createMediaHandlers(f.context,{image:workflow})).runOnce();
    workflow.recover(f.request(),q.job_id,getJob(f.context.db,f.config.workspace_id,q.job_id).version);
    const query=jobs.claim('r3-valid-other-attempt')!,path=imageReceiptPath(f.context,q.job_id),record=JSON.parse(readFileSync(path,'utf8'));
    record.original_binding.attempt_id=query.attempt.id;record.original_binding.attempt_generation=query.attempt.attempt_generation;
    record.checkpoint.original_binding=record.original_binding;record.checkpoint.original_input.binding=record.original_binding;
    writeFileSync(path,JSON.stringify(record));provider.disconnect=false;
    await assert.rejects(workflow.execute(query,new AbortController().signal,v=>jobs.checkpoint(query.fence,v)),{code:'RESULT_UNKNOWN'});
    assert.equal(provider.submits,1);assert.equal(provider.queries,0);noSuccess(f,q.job_id);
  }finally{f.cleanup();}
});
const route = WORKBENCH_TOOL_ROUTES.find(r => r.name === 'generate_asset')!;
test('IP03 H3 branch keeps 0/1/2/32 refs and long prompt/purpose; image branch remains strict', () => {
  for (const count of [0, 1, 2, 32]) { const body = { generator: 'h3', topic_id: 'topic', prompt: 'p'.repeat(8001), purpose: 'u'.repeat(301), input_asset_ids: Array.from({ length: count }, (_, i) => 'asset-' + i) }; assert.deepEqual(routeRequest(route, { ...body, idempotency_key: 'r3-h3-' + count }).body, AssetGenerationSchema.parse(body)); }
  assert.throws(() => routeRequest(route, { generator: 'h3', topic_id: 'topic', purpose: 'p', prompt: 'p', input_asset_ids: Array(33).fill('a'), idempotency_key: 'bad' }));
  const body = { generator: 'image', provider: 'agy', operation: 'generate', topic_id: 'topic', purpose: 'p', prompt: 'p', input_asset_ids: [], parent_asset_id: null, document_revision_id: null, plan_revision_id: null };
  assert.deepEqual(routeRequest(route, { ...body, idempotency_key: 'r3-image' }).body, AssetGenerationSchema.parse(body));
  const edit = { ...body, operation: 'reference_edit', input_asset_ids: ['a'], parent_asset_id: 'a' }; assert.deepEqual(routeRequest(route, { ...edit, idempotency_key: 'r3-edit' }).body, AssetGenerationSchema.parse(edit));
  for (const bad of [{ ...edit, input_asset_ids: ['a', 'b'] }, { ...edit, parent_asset_id: 'b' }, { ...body, prompt: 'p'.repeat(8001) }, { ...body, purpose: 'u'.repeat(301) }, { ...body, extra: true }]) assert.throws(() => routeRequest(route, { ...bad, idempotency_key: 'bad' } as JsonObject));
  assert.throws(() => routeRequest(route, body as JsonObject)); assert.throws(() => routeRequest(route, { ...body, idempotency_key: 'x'.repeat(201) }));
});
test('IP04 six fresh keys/replays and two workers create one active job/submit/asset; succeeded permits a new version', async () => {
  const f = fixture(); try { const { input } = await seeded(f), provider = new FakeImageProvider(), workflow = new ImageGenerationWorkflow(f.context, { provider: () => provider }); const accepted = await Promise.all(Array.from({ length: 12 }, async (_, i) => workflow.enqueue(f.request('r3-fresh-' + i % 6), input))); assert.equal(new Set(accepted.map(q => q.job_id)).size, 1); assert.equal(f.context.db.prepare('SELECT count(*) n FROM jobs').get()!.n, 1); await Promise.all(['a', 'b'].map(owner => new DurableWorker(f.context, createMediaHandlers(f.context, { image: workflow }), { owner }).runOnce())); assert.equal(provider.submits, 1); assert.equal(f.context.db.prepare('SELECT count(*) n FROM assets').get()!.n, 1); const later = workflow.enqueue(f.request('explicit-new-version'), input); assert.notEqual(later.job_id, accepted[0]!.job_id); assert.equal(f.context.db.prepare('SELECT count(*) n FROM jobs').get()!.n, 2);
  } finally { f.cleanup(); }
});
test('IP04 original unknown without native ID cannot be bypassed by a fresh key', async () => {
  const f = fixture(); try { const { input } = await seeded(f), provider = new FakeImageProvider(); provider.noId = true; const workflow = new ImageGenerationWorkflow(f.context, { provider: () => provider }), first = workflow.enqueue(f.request(), input), worker = new DurableWorker(f.context, createMediaHandlers(f.context, { image: workflow })); await worker.runOnce(); const second = workflow.enqueue(f.request('different-new-key'), input); assert.equal(second.job_id, first.job_id); assert.equal(second.state, 'reconciling'); assert.equal(await worker.runOnce(), null); assert.equal(provider.submits, 1); } finally { f.cleanup(); }
});
test('IP04 provider/prompt/reference SHA/workbench/revision/config freeze creates distinct inputs', async () => {
  const f = fixture(); try { const { input, topic } = await seeded(f), provider = new FakeImageProvider(), workflow = new ImageGenerationWorkflow(f.context, { provider: () => provider }), first = workflow.enqueue(f.request(), input); await new DurableWorker(f.context, createMediaHandlers(f.context, { image: workflow })).runOnce(); const asset = f.context.db.prepare('SELECT id,file_path FROM assets').get()!;
    const accepted = [workflow.enqueue(f.request(), input), workflow.enqueue(f.request(), { ...input, provider: 'codex' }), workflow.enqueue(f.request(), { ...input, prompt: input.prompt + ' changed' })];
    const edit: ImageGenerationRequest = { ...input, operation: 'reference_edit', input_asset_ids: [String(asset.id)], parent_asset_id: String(asset.id) }; accepted.push(workflow.enqueue(f.request(), edit));
    chmodSync(String(asset.file_path), 0o600); writeFileSync(String(asset.file_path), Buffer.concat([readFileSync(String(asset.file_path)), Buffer.from('changed-reference')])); const bytes = readFileSync(String(asset.file_path)); f.context.db.prepare('UPDATE assets SET sha256=?,size_bytes=? WHERE id=?').run(sha256(bytes), bytes.length, asset.id); accepted.push(workflow.enqueue(f.request(), edit));
    const brand = join(f.root, 'brand.json'); writeFileSync(brand, JSON.stringify({ version: 'brand-r3' })); accepted.push(new ImageGenerationWorkflow(f.context, { brand_path: brand }).enqueue(f.request(), input));
    const saved = await new Documents(f.context).save(f.request(), topic.core_document_id, { expected_revision_id: null, text: 'new referenced draft', origin: 'human' }); accepted.push(workflow.enqueue(f.request(), { ...input, document_revision_id: saved.revision_id }));
    const settings = new ImageProviderSettings(f.context), state = settings.get(f.request()); settings.save(f.request(), { expected_version: state.version, default_provider: 'agy', enabled: { agy: true, codex: true } }); accepted.push(workflow.enqueue(f.request(), input));
    assert.equal(new Set(accepted.map(q => q.job_id)).size, accepted.length); assert.notEqual(accepted[0]!.job_id, first.job_id);
  } finally { f.cleanup(); }
});
test('IP04 distinct OS processes contend for one frozen input in production SQLite', async () => {
  const f = fixture(); try { const { input } = await seeded(f), file = join(f.root, 'input.json'); writeFileSync(file, JSON.stringify(input));
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise<{ job_id: string }>((resolve, reject) => execFile(process.execPath, ['--experimental-test-module-mocks', '--import', './tests/helpers/portable-storage.ts', 'tests/image-providers/enqueue-process.ts', f.configPath, file, 'r3-process-key-' + i], { cwd: process.cwd(), timeout: 15000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))))));
    assert.equal(new Set(results.map(row => row.job_id)).size, 1); assert.equal(f.context.db.prepare('SELECT count(*) n FROM jobs').get()!.n, 1); const provider = new FakeImageProvider(), workflow = new ImageGenerationWorkflow(f.context, { provider: () => provider }); await Promise.all(['a', 'b'].map(owner => new DurableWorker(f.context, createMediaHandlers(f.context, { image: workflow }), { owner }).runOnce())); assert.equal(provider.submits, 1);
  } finally { f.cleanup(); }
});
