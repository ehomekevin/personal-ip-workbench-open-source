import type { FeatureContext } from '../../../transport/feature-ports.ts';
import type { ArticleLayoutSaveResult, ArticleLayoutSnapshot, ArticleLayoutView, ArticleLayoutVisualRenderView, ArticleLayoutVisualJobView, ArticleLayoutVisualStatus } from '../../../../../../packages/contracts/src/article-layout.ts';
// 公众号排版 C1/C2 的服务端口：进入（按配图终稿初始化）、读取、保存块版本、重新同步配图、确认排版；图片经受控资产接口读取并核对文件摘要。
export interface LayoutPagePort {
  open(topic: string, c: FeatureContext): Promise<ArticleLayoutView>;
  load(topic: string, c: FeatureContext): Promise<ArticleLayoutView>;
  save(topic: string, input: { expected_version: number; snapshot: ArticleLayoutSnapshot; idempotency_key: string }, c: FeatureContext): Promise<ArticleLayoutSaveResult>;
  syncImages(topic: string, expected_version: number, c: FeatureContext): Promise<ArticleLayoutView>;
  /** C2：确认排版（服务端重跑 15 条检查，有阻断项时拒绝）。 */
  confirm(topic: string, expected_version: number, c: FeatureContext): Promise<ArticleLayoutView>;
  visualStatus?(topic: string, c: FeatureContext): Promise<ArticleLayoutVisualStatus>;
  visualRender?(topic: string, version: number, c: FeatureContext): Promise<ArticleLayoutVisualRenderView>;
  visualCheck?(topic: string, version: number, render: string, c: FeatureContext): Promise<ArticleLayoutVisualJobView>;
  visualQuery?(topic: string, job: string, c: FeatureContext): Promise<ArticleLayoutVisualJobView>;
  visualCancel?(topic: string, job: string, c: FeatureContext): Promise<ArticleLayoutVisualJobView>;
  image(asset: { asset_id: string; sha256: string }, c: FeatureContext): Promise<string>;
}
const path = encodeURIComponent;
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
export function layoutHttpPort(): LayoutPagePort {
  return {
    open: (topic, c) => c.client.request('POST', '/api/v1/article-layout', { topic_id: topic }, { signal: c.signal, idempotencyKey: crypto.randomUUID() }),
    load: (topic, c) => c.client.request('GET', '/api/v1/article-layout?topic_id=' + path(topic), undefined, { signal: c.signal }),
    save: (topic, input, c) => c.client.request('POST', '/api/v1/article-layout/saves', { topic_id: topic, expected_version: input.expected_version, snapshot: input.snapshot }, { signal: c.signal, idempotencyKey: input.idempotency_key }),
    syncImages: (topic, expected_version, c) => c.client.request('POST', '/api/v1/article-layout/image-syncs', { topic_id: topic, expected_version }, { signal: c.signal, idempotencyKey: crypto.randomUUID() }),
    confirm: (topic, expected_version, c) => c.client.request('POST', '/api/v1/article-layout/confirmations', { topic_id: topic, expected_version }, { signal: c.signal, idempotencyKey: crypto.randomUUID() }),
    visualStatus: (topic, c) => c.client.request('GET', '/api/v1/article-layout/visual-status?topic_id=' + path(topic), undefined, { signal: c.signal }),
    visualRender: (topic, version, c) => c.client.request('POST', '/api/v1/article-layout/visual-renders', { topic_id: topic, expected_version: version }, { signal: c.signal, idempotencyKey: crypto.randomUUID() }),
    visualCheck: (topic, version, render, c) => c.client.request('POST', '/api/v1/article-layout/visual-checks', { topic_id: topic, expected_version: version, render_id: render }, { signal: c.signal, idempotencyKey: crypto.randomUUID() }),
    visualQuery: (topic, job, c) => c.client.request('POST', '/api/v1/article-layout/visual-queries', { topic_id: topic, job_id: job }, { signal: c.signal, idempotencyKey: crypto.randomUUID() }),
    visualCancel: (topic, job, c) => c.client.request('POST', '/api/v1/article-layout/visual-cancellations', { topic_id: topic, job_id: job }, { signal: c.signal, idempotencyKey: crypto.randomUUID() }),
    async image(asset, c) {
      if (!c.client.assetContent) throw new Error('图片暂时读不到');
      const blob = await c.client.assetContent(asset.asset_id, c.signal), digest = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      if (digest !== asset.sha256) throw new Error('图片文件和确认时不一致');
      return URL.createObjectURL(blob);
    },
  };
}
