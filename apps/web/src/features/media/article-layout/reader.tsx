import type { CSSProperties } from 'react';
import type { ArticleLayoutSnapshot, ArticleStyle } from '../../../../../../packages/contracts/src/article-layout.ts';
import { headingHasNumber, layoutBlockKind, splitCaption } from '../../../../../../packages/domain/src/article-layout/index.ts';
import { EditableText } from './editable.tsx';
import { layoutBlocks } from './c1-model.ts';
import './c1.css';
function readerStyle(s: ArticleStyle): CSSProperties {
  return { '--alc-title-size': s.title_size + 'px', '--alc-title-line': s.title_line_height, '--alc-heading-size': s.heading_size + 'px', '--alc-heading-line': s.heading_line_height, '--alc-body-size': s.body_size + 'px', '--alc-body-line': s.body_line_height, '--alc-letter': s.letter_spacing + 'px', '--alc-gap': s.paragraph_gap + 'px', '--alc-section': s.section_gap + 'px', '--alc-caption-size': s.caption_size + 'px', '--alc-caption-align': s.caption_align, '--alc-text': s.text_color, '--alc-accent': s.accent_color, '--alc-muted': s.muted_color, '--alc-panel': s.panel_color, width: s.mobile_width, paddingLeft: s.page_padding, paddingRight: s.page_padding } as CSSProperties;
}
export interface ReaderProps { snapshot: ArticleLayoutSnapshot; selected: string; editable: boolean; onSelect(id: string): void; onEdit(id: string, value: string): void; onCaption(id: string, main: string): void; onSave(): void; imageUrl(id: string): string | undefined; imageError(id: string): string | undefined; articleRef: React.RefObject<HTMLElement | null>; label?: string; wechatTitle?: string | null }
export function Reader({ snapshot, selected, editable, onSelect, onEdit, onCaption, onSave, imageUrl, imageError, articleRef, label = '公众号文章编辑画布', wechatTitle = null }: ReaderProps) {
  const names = new Map(layoutBlocks(snapshot).map(b => [b.id, b.name])); let heading = 0;
  return <article ref={articleRef} className={'alc-reader' + (editable ? ' is-editable' : '')} style={readerStyle(snapshot.style)} aria-label={label}>
    {wechatTitle && <header data-block-id="__topic_title__" data-block-kind="title" className="alc-block alc-title alc-wechat-title"><h1>{wechatTitle}</h1></header>}
    {snapshot.order.map(id => {
      const block = snapshot.blocks.find(b => b.id === id); if (!block) return null;
      const name = names.get(id) ?? '图文块', text = 'text' in block ? <EditableText id={id} value={block.text} label={'编辑' + name} editable={editable} onSelect={() => onSelect(id)} onEdit={value => onEdit(id, value)} onSave={onSave} /> : null;
      const caption = block.kind === 'image' ? splitCaption(block) : null, kind = layoutBlockKind(block);
      // 小节标题：「## 」与中文序号小节（含旧记录里存成正文的）都按标题样式；自带序号的不再加 01/02。
      return <section key={id} className={'alc-block alc-' + kind + (selected === id ? ' is-selected' : '')} data-block-id={id} data-block-kind={kind} onClick={() => onSelect(id)}>
        {kind === 'title' && <h1>{text}</h1>}
        {kind === 'heading' && 'text' in block && <h2>{headingHasNumber(block.text) ? null : <span className="alc-section-number">{String(++heading).padStart(2, '0')}</span>}{text}</h2>}
        {(kind === 'lead' || kind === 'paragraph') && text}
        {block.kind === 'opinion' && <><h2>我的看法</h2>{text}</>}
        {block.kind === 'image' && caption && <figure style={{ width: block.display_width_percent + '%' }}>{imageUrl(block.image.asset_id) ? <img src={imageUrl(block.image.asset_id)} width={block.image.pixel_width} height={block.image.pixel_height} alt={caption.main || '文章配图'} /> : <span className="alc-img-wait" style={{ aspectRatio: block.image.pixel_width + '/' + block.image.pixel_height }} role="status">{imageError(block.image.asset_id) ?? '正在读取图片…'}</span>}
          {(editable || block.caption) && <figcaption>{(editable || (caption.has_credit ? caption.main.trim() : caption.main)) && <EditableText id={id + ':caption'} value={caption.main} label={'编辑' + name + '的图注'} className="alc-caption-main" editable={editable} onSelect={() => onSelect(id)} onEdit={value => onCaption(id, value)} onSave={onSave} />}{caption.has_credit && <span className="alc-credit">{caption.main.trim() ? ' · ' : ''}{caption.credit}</span>}</figcaption>}</figure>}
      </section>;
    })}</article>;
}
