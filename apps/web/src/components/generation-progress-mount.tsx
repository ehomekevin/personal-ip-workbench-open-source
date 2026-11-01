import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { GenerationProgressView } from '../transport/feature-ports.ts';
import { GenerationProgress } from './GenerationProgress.tsx';

// 轮询只更新同一个 React root，避免重建 Canvas、GPU context 和动画时间轴。
export class GenerationProgressMount {
  private root: Root | undefined;
  private jobId: string | undefined;

  isMountedFor(jobId: string): boolean { return !!this.root && this.jobId === jobId; }

  mount(container: HTMLElement, jobId: string, view: GenerationProgressView): void {
    this.dispose();
    this.jobId = jobId;
    this.root = createRoot(container);
    this.update(view);
  }

  update(view: GenerationProgressView): void { this.root?.render(<GenerationProgress view={view} />); }

  dispose(): void {
    this.root?.unmount();
    this.root = undefined;
    this.jobId = undefined;
  }
}
