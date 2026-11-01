import { captionDisplayText } from '../../../../../../packages/domain/src/article-layout/index.ts';
import type { ArticleLayoutSnapshot, LayoutRenderedBlock } from '../../../../../../packages/contracts/src/article-layout.ts';

/** Reads the visible rendered article, including resolved image geometry and computed typography. */
export async function readArticleRenderStructure(article: HTMLElement, snapshot: ArticleLayoutSnapshot): Promise<LayoutRenderedBlock[]> {
  await document.fonts.ready;
  for (const img of article.querySelectorAll('img')) { if (!img.complete) await new Promise<void>((resolve, reject) => { img.addEventListener('load', () => resolve(), { once: true }); img.addEventListener('error', () => reject(new Error('文章中的图片尚未加载，保留当前稿件。')), { once: true }); }); if (!img.naturalWidth) throw new Error('文章中的图片无法读取，保留当前稿件。'); }
  const articleRect = article.getBoundingClientRect(), scale = articleRect.width / article.offsetWidth;
  const blocks: LayoutRenderedBlock[] = snapshot.order.map(id => {
    const block = snapshot.blocks.find(b => b.id === id), el = article.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    if (!block || !el) throw new Error('渲染图文块与当前文章不一致。');
    const copy = (block.kind === 'image' ? el.querySelector<HTMLElement>('figcaption') : el.querySelector<HTMLElement>('.al-editable')) ?? el, computed = getComputedStyle(copy), rect = el.getBoundingClientRect(), image = el.querySelector<HTMLImageElement>('figure img');
    const expectedText = 'text' in block ? block.text : block.kind === 'image' ? captionDisplayText(block) : null;
    if (expectedText !== null && (block.kind === 'image' ? (el.querySelector('figcaption')?.textContent ?? '') : copy.textContent ?? '').replace(/\r\n/g, '\n') !== expectedText) throw new Error('当前渲染文字尚未同步，保留当前稿件。');
    if (block.kind === 'image' && (!image || image.naturalWidth !== block.image.pixel_width || image.naturalHeight !== block.image.pixel_height)) throw new Error('文章图片的实际像素与采用版本不一致。');
    const imageRect = image?.getBoundingClientRect();
    return { id, kind: el.dataset.blockKind ?? block.kind, ...(expectedText === null ? {} : { text: expectedText }), ...(block.kind === 'image' ? { image: { ...block.image, caption: block.caption, caption_display: captionDisplayText(block), source_caption: block.original_caption } } : {}),
      computed_style: { font_family: computed.fontFamily, font_size: computed.fontSize, font_weight: computed.fontWeight, line_height: computed.lineHeight, letter_spacing: computed.letterSpacing, color: computed.color, background_color: getComputedStyle(el).backgroundColor,
        text_align: computed.textAlign, margin_bottom: getComputedStyle(el).marginBottom, padding_top: getComputedStyle(el).paddingTop, white_space: computed.whiteSpace,
        image_natural_width: image?.naturalWidth ?? null, image_natural_height: image?.naturalHeight ?? null, image_rendered_width: imageRect ? imageRect.width / scale : null, image_rendered_height: imageRect ? imageRect.height / scale : null },
      bounds: { x: (rect.x - articleRect.x) / scale, y: (rect.y - articleRect.y) / scale, width: rect.width / scale, height: rect.height / scale } };
  });
  const title = article.querySelector<HTMLElement>('[data-block-id="__topic_title__"]');
  if (title && !snapshot.blocks.some(b => b.kind === 'title')) { const rect = title.getBoundingClientRect(), style = getComputedStyle(title.querySelector('h1') ?? title); blocks.unshift({ id: '__topic_title__', kind: 'title', text: title.textContent ?? '', computed_style: { font_family: style.fontFamily, font_size: style.fontSize, line_height: style.lineHeight, color: style.color }, bounds: { x: (rect.x - articleRect.x) / scale, y: (rect.y - articleRect.y) / scale, width: rect.width / scale, height: rect.height / scale } }); }
  return blocks;
}
