import { ContractError, DEFAULT_CONCURRENT_GENERATIONS } from '@workbench/contracts';
import type { DurableWorker } from '../worker/core/index.ts';
import type { ClaimOptions } from '@workbench/storage/jobs';

export const GENERATION_CONCURRENCY = DEFAULT_CONCURRENT_GENERATIONS;
// claim 同步完成，Promise 只代表已领取的真实任务；空队列不会制造占用槽位。
export class ExecutionScheduler {
  private active = new Map<AbortController, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private pumping = false; private closing = false; private initialized = false;
  private closePromise?: Promise<void>;
  lastError: string | null = null;
  readonly worker: Pick<DurableWorker, 'startNext'>;
  readonly options: { interval_ms?: number; close_timeout_ms?: number; limit?: number; admit?: ClaimOptions['admit']; closeAdapters?(): Promise<void> };
  constructor(worker: Pick<DurableWorker, 'startNext'>, options: ExecutionScheduler['options'] = {}) { this.worker = worker; this.options = options; }
  get activeCount(): number { return this.active.size; }
  get limit(): number { return this.options.limit ?? GENERATION_CONCURRENCY; }
  initialize(): void {
    if (this.initialized || this.closing) return; this.initialized = true;
    this.timer = setInterval(() => this.tick(), this.options.interval_ms ?? 500); this.timer.unref(); this.tick();
  }
  tick(): void {
    if (this.pumping || this.closing) return; this.pumping = true;
    try {
      while (this.active.size < this.limit) {
        const controller = new AbortController(), task = this.worker.startNext({ signal: controller.signal, claim: { service_adapter_limit: this.limit, ...(this.options.admit ? { admit: this.options.admit } : {}) } }); if (!task) break;
        const observed = task.then(() => { this.lastError = null; }).catch(error => { this.lastError = error instanceof ContractError ? error.code : 'EXECUTION_UNAVAILABLE'; })
          .finally(() => { this.active.delete(controller); if (!this.closing) this.tick(); });
        this.active.set(controller, observed);
      }
    } catch (error) { this.lastError = error instanceof ContractError ? error.code : 'EXECUTION_UNAVAILABLE'; }
    finally { this.pumping = false; }
  }
  close(): Promise<void> { return this.closePromise ??= this.stop(); }
  private async stop(): Promise<void> {
    this.closing = true; if (this.timer) clearInterval(this.timer);
    for (const controller of this.active.keys()) controller.abort(new Error('SERVICE_CLOSING'));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([
      Promise.all([Promise.all([...this.active.values()]), this.options.closeAdapters?.()]),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new ContractError('RESULT_UNKNOWN', '关闭等待已到界限；保留未退出任务和原生槽位归属')), this.options.close_timeout_ms ?? 10_000); }),
    ]); } finally { if (timeout) clearTimeout(timeout); }
  }
}
