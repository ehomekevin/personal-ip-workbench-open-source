import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createRef } from 'react';
import type { ArticleLayoutSnapshot, LayoutRenderedBlock } from '../../../../../../packages/contracts/src/article-layout.ts';
import { Reader } from './reader.tsx';
import { readArticleRenderStructure } from './render.ts';

export interface ReaderRenderResult { width: number; height: number; blocks: LayoutRenderedBlock[]; images: Array<{ id: string; width: number; height: number; source: string }>; captions: Record<string, string>; texts: Record<string, string> }
declare global { interface Window { __articleLayoutRender?: (snapshot: ArticleLayoutSnapshot, title: string, images: Record<string, string>) => Promise<ReaderRenderResult> } }
/** Internal automation seam. The server never accepts this client's output as proof; it runs its own empty-profile Chrome and verifies the actual DOM, pixels and saved inputs. No product route or second panel. */
if (typeof window !== 'undefined') window.__articleLayoutRender = async (snapshot, title, images) => {
  const node = document.createElement('div'); node.dataset.articleLayoutRender = 'c1-reader.v3';
  document.body.replaceChildren(node); document.body.style.cssText = 'margin:0;padding:0;overflow:visible;background:white';
  const articleRef = createRef<HTMLElement>(), noop = () => undefined;
  flushSync(() => createRoot(node).render(<Reader snapshot={snapshot} selected="" editable={false} onSelect={noop} onEdit={noop} onCaption={noop} onSave={noop} imageUrl={id => images[id]} imageError={() => undefined} articleRef={articleRef} wechatTitle={snapshot.blocks.some(b => b.kind === 'title') ? null : title} label="服务端公众号连续渲染" />));
  await document.fonts.ready;
  const article = articleRef.current; if (!article) throw new Error('C1 Reader 未挂载');
  await Promise.all([...article.querySelectorAll('img')].map(image => image.decode()));
  await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  const origin = article.getBoundingClientRect(), captions: Record<string, string> = {}, texts: Record<string, string> = {};
  const blocks = await readArticleRenderStructure(article, snapshot);
  for (const el of article.querySelectorAll<HTMLElement>('[data-block-id]')) {
    const id = el.dataset.blockId!; captions[id] = el.querySelector('figcaption')?.textContent ?? '';
    const value = el.querySelector<HTMLElement>('[data-text-block]')?.textContent ?? (id === '__topic_title__' ? el.querySelector('h1')?.textContent : undefined);
    if (value !== undefined && value !== null) texts[id] = value;
  }
  return { width: origin.width, height: Math.ceil(Math.max(origin.height, article.scrollHeight)), blocks, captions, texts,
    images: [...article.querySelectorAll('img')].map(image => ({ id: image.closest<HTMLElement>('[data-block-id]')!.dataset.blockId!, width: image.naturalWidth, height: image.naturalHeight, source: image.currentSrc })) };
};
