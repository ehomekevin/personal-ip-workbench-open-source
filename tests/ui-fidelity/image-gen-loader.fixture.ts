// 生图加载态浏览器夹具：生产 ImageWorkbench + 生产加载器挂载层（img-fx 真实 WebGL），方案与版本状态由页面脚本直接驱动，不连服务。
import { ImageWorkbench, type ImagePlanLoad, type ImagePlanPort, type WorkbenchHost } from '../../apps/web/src/features/media/image-studio/workbench.ts';
import { mountImageLoader } from '../../apps/web/src/components/image-generation-loader-mount.ts';
import '../../apps/web/src/styles/approved.css';
import '../../apps/web/src/features/media/image-studio/styles.css';
import '../../apps/web/src/styles/generation-progress.css';

// editing / edited：基于已有第 1 版修改（第 2 版进行中 / 已完成）；reconciling / unknown：结果待核对；cancelled：已取消。
type Phase = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'reconciling' | 'unknown' | 'editing' | 'edited';
const ids = ['a', 'b', 'c', 'd', 'e', 'f'], aspects = ['16:9', '4:3', '1:1', '3:4', '16:9', '4:3'];
const sizes: Record<string, { width: number; height: number }> = { '16:9': { width: 1600, height: 900 }, '4:3': { width: 1200, height: 900 }, '1:1': { width: 1024, height: 1024 }, '3:4': { width: 900, height: 1200 } };
const phases = new Map<string, Phase>(ids.map(id => [id, 'idle']));
// mock 渠道推送的进度（阶段、中间图张数、已运行时间、历史均值）：模拟服务端快照里的 progress，received_at 取本地收到的时刻。
type MockProgress = { stage: 'queued' | 'starting' | 'generating' | 'saving' | 'checking'; previews?: number; runningMs?: number | null; totalMs?: number; typicalMs?: number };
const progress = new Map<string, MockProgress>();
const progressOf = (id: string) => { const p = progress.get(id); if (!p) return {}; return { progress: { stage: p.stage, total_ms: p.totalMs ?? p.runningMs ?? 0, running_ms: p.runningMs ?? null, typical_ms: p.typicalMs ?? 60000, typical_source: 'history', typical_samples: 3, previews: Array.from({ length: p.previews ?? 0 }, (_, k) => '/fixture-img/preview-' + id + '-' + (k + 1) + '.png'), received_at: Date.now() } }; };
const paragraphs = ids.map((id, i) => ({ id: 'p' + id, label: '第 ' + (i + 1) + ' 段', text: '第 ' + (i + 1) + ' 段正文：这一段讲工作台把资讯、写稿和配图放在一个地方完成，读者在手机上往下滑时，每隔几段就能看到一张和内容相关的图。' }));
const ACTIVE = ['queued', 'running', 'reconciling'];
function version(id: string, phase: Phase, aspect: string, vid = 'v-' + id, parent: string | null = null) {
  const size = sizes[aspect]!, done = phase === 'succeeded';
  return { id: vid, slot_id: 'slot-' + id, asset_id: done ? 'final-' + vid.slice(2) : '', provider: 'agy', description: '品牌配色的流程示意图，从左到右，箭头连接。', title: '', requested: size, accepted: null, actual: size, mime: 'image/png', sha256: '', size_bytes: 0, created_at: '2026-10-15T00:00:00Z', job_id: 'job-' + vid, parent_version_id: parent, reference_assets: [], actual_verified: done, state: phase, warning: null, error: phase === 'failed' ? '失败' : null, accepted_parameters: null, document_revision_id: 'r', paragraph_id: 'p' + id, placement: 'after:p' + id, operation: 'generate', ...(ACTIVE.includes(phase) ? progressOf(id) : {}) };
}
function snapshot(): ImagePlanLoad {
  const items = ids.map((id, i) => {
    const phase = phases.get(id)!, aspect = aspects[i]!, edit = phase === 'editing' || phase === 'edited', cur = phase === 'succeeded' ? 'v-' + id : edit ? (phase === 'edited' ? 'v-' + id + '2' : 'v-' + id) : null;
    return { id, slot_id: 'slot-' + id, role: 'body', paragraph_id: 'p' + id, placement_paragraph_id: 'p' + id, position: 'after', seq: i, purpose: '示意图 ' + (i + 1) + '：工作台流程', source_strategy: 'ai_generate', aspect, prompt_draft: '品牌配色的流程示意图，从左到右，箭头连接。', candidate_id: null, skipped: false, auto: { state: 'none', candidate_id: null, error: null }, current_version_id: cur, cleared: false, seen_versions: 0,
      status: ACTIVE.includes(phase) || phase === 'editing' ? 'generating' : phase === 'succeeded' || phase === 'edited' ? 'filled' : ['failed', 'cancelled', 'unknown'].includes(phase) ? 'failed' : 'awaiting_generation', paragraph_excerpt: '第 ' + (i + 1) + ' 段', paragraph_index: i, current_version: cur ? { id: cur, index: cur.endsWith('2') ? 2 : 1, auto_selected: false, credit_label: null } : null, issue: phase === 'failed' ? '这张没有生成成功，可以重试' : null };
  });
  const slots = ids.map((id, i) => ({ id: 'slot-' + id, title: '', description: '', placement: 'after:p' + id, adopted_version_id: null, versions: phases.get(id) === 'idle' ? [] : ['editing', 'edited'].includes(phases.get(id)!) ? [version(id, 'succeeded', aspects[i]!), version(id, phases.get(id) === 'edited' ? 'succeeded' : 'running', aspects[i]!, 'v-' + id + '2', 'v-' + id)] : [version(id, phases.get(id)!, aspects[i]!)] }));
  const cap = { provider: 'agy', label: 'AGY', enabled: true, available: true, sizes: Object.entries(sizes).map(([key, s]) => ({ id: key, label: key, ...s })), custom: null, reference_limit: 1, reference_edit: true, mask: false, text_edit: false, limitations: [], availability: { selectable: true, block: null, message: '', detail: null, unverified: true, remaining: 6, limit: 6 } };
  const plan = { topic_id: 'topic', topic_title: '把 AI 资讯接进工作台', version: 1, state: 'ready', run: null, stale: false, items, budget: { codex: { used: 0, limit: 0, remaining: 0 }, agy: { used: 0, limit: 6, remaining: 6 } }, studio: {} };
  return { plan, studio: { topic_id: 'topic', document_revision_id: 'r', version: 1, title: '', article: '', paragraphs, slots, references: [], capabilities: [cap] }, executors: [], default_executor: 'codex' } as unknown as ImagePlanLoad;
}
const root = document.getElementById('root')!;
const context = { identity: { workspace_id: 'w', service_instance_id: 's' }, ui: { topic: 'topic' }, signal: new AbortController().signal, surface: { presentDialog() {}, dialogBusy() {}, closeDialog() {} } } as never;
const host: WorkbenchHost = { root, context: () => context, active: () => true, signal: new AbortController().signal, toast() {},
  submit: async () => ({ job_id: 'job', input_hash: 'h' }), webImport: async () => { throw new Error('unused'); },
  imageUrl: v => v.asset_id ? '/fixture-img/' + v.asset_id + '.png' : undefined, setStudio() {}, openAdd() {}, imageLoader: () => ({ mount: mountImageLoader }) };
const port: ImagePlanPort = { load: async () => snapshot(), run: async () => snapshot().plan, update: async () => snapshot().plan, create: async () => snapshot().plan, assetVersion: async () => ({ slot_id: 'slot-a', version_id: 'v', asset_id: 'a', version: 1 }), candidates: async () => ({ items: [], capture: { refreshing: false, note: '', retry: false, tone: 'none' as const } }) };
// 实例上限验证：在舞台之外用同一生产挂载层同时挂 n 个 running 加载器（单图舞台一次只显示一张图）。
const capHandles: Array<{ dispose(): void }> = [];
function cap(n: number) { let box = document.getElementById('cap-test'); if (!box) { box = document.createElement('div'); box.id = 'cap-test'; box.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:8px'; document.body.append(box); } while (capHandles.length > n) { capHandles.pop()!.dispose(); box.lastElementChild?.remove(); } while (capHandles.length < n) { const el = document.createElement('div'); box.append(el); capHandles.push(mountImageLoader(el, { state: 'running', images: [], width: 1600, height: 900, label: '正在生成' })); } }
const workbench = new ImageWorkbench(host, port);
workbench.open('topic');
(window as unknown as { fixture: unknown }).fixture = {
  cap,
  set(next: Record<string, Phase>, nextProgress: Record<string, MockProgress | null> = {}) { for (const [id, phase] of Object.entries(next)) phases.set(id, phase); for (const [id, p] of Object.entries(nextProgress)) { if (p) progress.set(id, p); else progress.delete(id); } return workbench.reload(); },
};
