import fs, { readFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import type { RunningApplication } from '../../apps/service/src/bootstrap/application.ts';

// 只在测试子进程中把实际 rename 暂停，重现读取 dead owner 后被另一启动者抢先的时间窗口。
if (process.env.WORKBENCH_TEST_RECLAIM_RELEASE) {
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    process.send?.({ kind: 'before_reclaim' });
    const deadline = Date.now() + 12000;
    while (!existsSync(process.env.WORKBENCH_TEST_RECLAIM_RELEASE!)) {
      if (Date.now() > deadline) throw new Error('test reclaim barrier timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    original(from, to);
  };
  syncBuiltinESMExports();
}
let app: RunningApplication | undefined;
process.once('SIGTERM', () => { void (async () => {
  try { await app?.close(); process.exit(0); }
  catch (error) { console.error(error); process.exit(2); }
})(); });
try {
  const { startApplication } = await import('../../apps/service/src/bootstrap/application.ts');
  app = await startApplication(JSON.parse(readFileSync(process.env.WORKBENCH_CONFIG_PATH!, 'utf8')) as ServiceConfiguration, { port: 0 });
  process.send?.({ kind: 'ready', boot_id: app.boot_id, identity: app.identity, address: app.address });
} catch (error) {
  process.send?.({ kind: 'rejected', code: (error as { code?: string }).code, message: String(error) }, () => process.exit(1));
  if (!process.connected) process.exit(1);
}
