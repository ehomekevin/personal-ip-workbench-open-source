import type { ArticleImageBlock, ArticleImageCredit } from '../../../contracts/src/article-layout.ts';
// 公众号排版（C2）图注与图源：网络图的图注 = 说明 + 「 · 」+ 图源（来源名 + 原网页域名）。
// 图源来自图片事实（image.credit），界面只让人改说明部分；去掉图源要走单独的显式操作，打字不会把它删掉。
// 公众号正文里的链接点不开，图注里只放来源名和域名（如「图源：Google（blog.google）」），完整原网页链接留在图片事实里，不进正文。
export const CAPTION_SEPARATOR = ' · ';
const URL_IN_TEXT = /https?:\/\/[^\s）)·]+/gi;
/** 链接 → 域名（去掉 www.）；不是合法链接时返回 null。 */
export function creditDomain(url: string | null | undefined): string | null {
  const raw = url?.trim(); if (!raw) return null;
  try { const host = new URL(raw).hostname.replace(/^www\./i, '').toLowerCase(); return host || null; } catch { return null; }
}
const creditName = (label: string) => label.startsWith('图源') ? label : '图源：' + label;
/** 图源文字：「图源：来源名（域名）」；来源名已带「图源」前缀时不重复；来源名里已有域名时不再重复。 */
export function creditText(credit: ArticleImageCredit): string {
  const name = creditName(credit.label.trim()), domain = creditDomain(credit.url);
  return domain && !name.toLowerCase().includes(domain) ? name + '（' + domain + '）' : name;
}
/** C2 早期写进图注的旧格式：「图源：来源名（完整链接）」。读到时仍算带图源，显示与再保存时换成新格式。 */
function creditTextWithUrl(credit: ArticleImageCredit): string | null {
  const url = credit.url?.trim(); return url ? creditName(credit.label.trim()) + '（' + url + '）' : null;
}
/** 把文字里的裸链接换成域名（旧记录里的图源文字）。 */
export function stripCaptionUrls(text: string): string { return text.replace(URL_IN_TEXT, url => creditDomain(url) ?? url); }
/** 说明 + 图源。说明为空时只放图源。 */
export function joinCaption(main: string, credit: ArticleImageCredit | null | undefined): string {
  if (!credit || !credit.label.trim()) return main;
  const text = creditText(credit);
  return main.trim() ? main + CAPTION_SEPARATOR + text : text;
}
/** legacy：C1 旧记录没有图源事实，图源只是图注末尾的「图源：…」文字；仍按图源保护，编辑说明时不会被删掉。 */
export interface CaptionParts { main: string; credit: string | null; has_credit: boolean; web_image: boolean; legacy: boolean; /** 图注里实际存的图源原文（旧记录可能带完整链接）；只用于原样保留，展示用 credit。 */ credit_source?: string }
const LEGACY_CREDIT = /(?:^| · )(图源：[^·]*\S)$/;
/** 拆出说明和图源：只有图注末尾正是这张图的图源时才算「带图源」。 */
export function splitCaption(block: Pick<ArticleImageBlock, 'caption' | 'image'>): CaptionParts {
  const credit = block.image.credit;
  if (!credit || !credit.label.trim()) {
    const legacy = block.caption.match(LEGACY_CREDIT);
    if (legacy) return { main: block.caption.slice(0, block.caption.length - legacy[0].length), credit: stripCaptionUrls(legacy[1]!), has_credit: true, web_image: true, legacy: true, credit_source: legacy[1]! };
    return { main: block.caption, credit: null, has_credit: false, web_image: false, legacy: false };
  }
  const text = creditText(credit);
  for (const stored of [text, creditTextWithUrl(credit)]) {
    if (!stored) continue;
    if (block.caption === stored) return { main: '', credit: text, has_credit: true, web_image: true, legacy: false };
    if (block.caption.endsWith(CAPTION_SEPARATOR + stored)) return { main: block.caption.slice(0, -(CAPTION_SEPARATOR + stored).length), credit: text, has_credit: true, web_image: true, legacy: false };
  }
  return { main: block.caption, credit: text, has_credit: false, web_image: true, legacy: false };
}
/** 读者实际看到的图注：说明 + 图源（图源只显示来源名和域名）。排版检查与预览都按这份文字。 */
export function captionDisplayText(block: Pick<ArticleImageBlock, 'caption' | 'image'>): string {
  const parts = splitCaption(block);
  return parts.has_credit && parts.credit ? withCredit(parts.main, parts.credit) : parts.main;
}
const withCredit = (main: string, credit: string) => main.trim() ? main + CAPTION_SEPARATOR + credit : credit;
/** 改说明：原来带图源的继续带图源（含旧记录里的图源文字）。 */
export function editCaptionMain(block: Pick<ArticleImageBlock, 'caption' | 'image'>, main: string): string {
  const parts = splitCaption(block);
  // 旧 C1 记录没有图源事实，图源原文是唯一记录，原样保留；有图源事实的统一写成新格式（只放域名）。
  return parts.has_credit && parts.credit ? withCredit(main, parts.legacy ? parts.credit_source ?? parts.credit : parts.credit) : main;
}
/** 显式去掉图源（只留说明）。 */
export function removeCaptionCredit(block: Pick<ArticleImageBlock, 'caption' | 'image'>): string { return splitCaption(block).main; }
/** 把图源加回来（需要图源事实）。 */
export function restoreCaptionCredit(block: Pick<ArticleImageBlock, 'caption' | 'image'>): string {
  const parts = splitCaption(block);
  return parts.has_credit ? block.caption : joinCaption(parts.main, block.image.credit);
}
/** 换成新的图源事实（补齐旧记录 / 重新同步）：保留说明；原来带图源的换成新图源，显式去掉过的保持去掉。 */
export function recreditCaption(block: Pick<ArticleImageBlock, 'caption' | 'image'>, credit: ArticleImageCredit | null | undefined): string {
  const parts = splitCaption(block);
  if (parts.web_image && !parts.has_credit) return parts.main;
  return joinCaption(parts.main, credit);
}
