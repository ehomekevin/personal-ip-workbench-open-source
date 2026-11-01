import '../../../apps/web/src/styles/configuration.css';
import { App } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';
import { Workbench } from '../../../apps/web/src/app/Workbench.tsx';
import { createHostClient } from '../../../apps/web/src/transport/workbench-client.ts';
import { createDataFeaturePorts } from '../../../apps/web/src/transport/data-features.ts';
import { parsePage, type FeaturePorts, type WorkbenchInjection } from '../../../apps/web/src/transport/feature-ports.ts';
import { createMcpHostBridge, resolveWorkbenchRoute, WORKBENCH_RESOURCE_URI } from '../../../packages/host-bridge/src/core/index.ts';
import type { Platform, ServiceIdentity, JsonObject } from '@workbench/contracts';
import { locationFromToolResult, workbenchLocationHash } from '../../../apps/web/src/transport/workbench-location.ts';
import type { OpenWorkbenchRequest } from '@workbench/contracts';
import '../../../apps/web/src/styles/approved.css';
import '../../../apps/web/src/styles/today-continuation.css';

const app = new App({ name: 'personal-ip-workbench', version: '0.1.0' }, {});
let opened: { page?: string; topic_id?: string; variant?: JsonObject; identity?: ServiceIdentity } = {};
let openedLocation: OpenWorkbenchRequest | undefined;
let mounted = false;
let selectionVersion = 0;
let appliedVersion = -1;
let boundIdentity: ServiceIdentity | undefined;
app.ontoolresult = result => {
  const envelope = result.structuredContent as { identity?: ServiceIdentity; data?: typeof opened & { resource_uri?: string } } | undefined;
  if (result.isError || envelope?.data?.resource_uri !== WORKBENCH_RESOURCE_URI) return;
  if (boundIdentity && (envelope.identity?.workspace_id !== boundIdentity.workspace_id || envelope.identity?.service_instance_id !== boundIdentity.service_instance_id || envelope.identity?.contract_version !== boundIdentity.contract_version)) return;
  const location = locationFromToolResult(result, boundIdentity);
  if (!location) return;
  openedLocation = location;
  opened = { ...envelope.data, identity: envelope.identity };
  selectionVersion++;
  // 只处理明确的打开命令；保存、候选和任务通知不重挂载编辑器。
  if (mounted && opened.page) { history.replaceState(null, '', workbenchLocationHash(location)); window.dispatchEvent(new HashChangeEvent('hashchange')); }
};
async function initialize() {
await app.connect();
const bridge = await createMcpHostBridge({ app, expectedIdentity: opened.identity });
boundIdentity = (await bridge.describeCapabilities()).identity;
const client = createHostClient(bridge, resolveWorkbenchRoute);
if (bridge.uploadAsset) client.upload = async <T,>(path: string, file: File, fields: Readonly<Record<string, string>>, options?: { signal?: AbortSignal; idempotencyKey?: string }) => {
  if (path !== '/api/v1/assets') throw new Error('宿主上传路由未登记');
  return await bridge.uploadAsset!(file, fields, options) as T;
};
const features: FeaturePorts = createDataFeaturePorts();
for (const feature of Object.values(features)) if (feature) {
  const load = feature.load;
  feature.load = async context => {
    if (selectionVersion === appliedVersion) return load(context);
    const selection = opened; appliedVersion = selectionVersion;
    const ui = { ...context.ui, ...(selection.topic_id ? { topic: selection.topic_id } : {}), ...(typeof selection.variant?.platform === 'string' ? { platform: selection.variant.platform as Platform } : {}) };
    return load({ ...context, ui });
  };
}
const injection: WorkbenchInjection = { mode: 'real', client, hostBridge: bridge, features, ...(openedLocation ? { initialLocation: openedLocation } : { initialPage: parsePage(opened.page) }) };
createRoot(document.getElementById('root')!).render(<Workbench injection={injection} />);
mounted = true;
}
void initialize().catch(error => {
  const root = document.getElementById('root')!;
  const message = document.createElement('div'); message.className = 'empty';
  message.textContent = '工作台连接未完成：' + (error instanceof Error ? error.message : '请核对当前宿主与主服务连接');
  root.replaceChildren(message);
});
