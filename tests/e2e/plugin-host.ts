import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
declare const __E2E_CONTROL__: string;
const frame = document.getElementById('workbench') as HTMLIFrameElement;
const status = document.getElementById('status')!;
async function rpc<T>(operation: string, params: unknown): Promise<T> {
  const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-E2E-Control': __E2E_CONTROL__ }, body: JSON.stringify({ operation, params }) });
  if (!response.ok) throw new Error('隔离 MCP 测试入口失败：' + response.status);
  return response.json();
}
const bridge = new AppBridge(null, { name: 'WP23 internal browser host', version: 'fixture' }, { serverTools: {}, serverResources: {} });
bridge.oncalltool = params => rpc<CallToolResult>('tool', params);
bridge.onreadresource = params => rpc<ReadResourceResult>('resource', params);
bridge.oninitialized = () => { void (async () => {
  await bridge.sendToolInput({ arguments: { page: 'today' } });
  await bridge.sendToolResult(await rpc<CallToolResult>('tool', { name: 'open_workbench', arguments: { page: 'today' } }));
  status.textContent = 'ready';
})().catch(error => { status.textContent = 'failed: ' + String(error); }); };
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
Object.assign(window, {
  notifyWorkbench: async () => bridge.sendToolResult(await rpc<CallToolResult>('tool', { name: 'get_context', arguments: {} })),
  openWorkbench: async (args: Record<string, unknown>) => {
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult(await rpc<CallToolResult>('tool', { name: 'open_workbench', arguments: args }));
  },
});
frame.src = '/workbench';
