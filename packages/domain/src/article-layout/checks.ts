import type { ArticleImageBlock, ArticleLayoutSnapshot, ArticleTextBlock } from '../../../contracts/src/article-layout.ts';
import { captionDisplayText, splitCaption } from './caption.ts';
import { layoutBlockKind } from './headings.ts';
// 公众号排版（C2）本机排版检查：15 条确定性规则，只看当前排版快照（文字、图片事实、版式），不调用 AI 或任何外部接口。
// 每条给出 通过 / 提醒 / 阻断，并指出涉及的图文块（版式类问题指向「本篇版式」）。有阻断项时不能确认排版。
export type LayoutRuleLevel = 'pass' | 'warn' | 'block';
export type LayoutRuleId =
  | 'title_present' | 'title_length' | 'cover_image' | 'image_caption' | 'image_credit'
  | 'empty_paragraph' | 'long_paragraph' | 'text_wall' | 'image_adjacent' | 'image_resolution'
  | 'external_link' | 'word_count' | 'heading_length' | 'body_readability' | 'text_contrast';
/** target：block 定位到图文块；style 定位到「本篇版式」；null 为全篇。 */
export interface LayoutRuleHit { block_id: string | null; target: 'block' | 'style' | null; note: string }
export interface LayoutRuleResult { id: LayoutRuleId; index: number; title: string; level: LayoutRuleLevel; summary: string; hits: LayoutRuleHit[] }
export interface LayoutCheckReport { results: LayoutRuleResult[]; blocking: number; warnings: number; passed: number }
export interface LayoutCheckContext { /** 公众号标题（正文没有「# 标题」时用主题标题）。 */ topic_title?: string | null; /** 在配图终稿里找不到来源的图片块（C1 旧记录），图源无法补齐。 */ credit_missing?: string[]; /** 已确认的旧记录里可补全图源、但没有自动补写的图片块。 */ credit_pending?: string[] }

/** 阈值集中在这里，测试和界面文案共用。 */
export const LAYOUT_RULES = {
  title_max: 64, title_suggest: 30, cover_within: 3, long_paragraph: 300, text_wall: 1200,
  min_image_width: 600, words_min: 300, words_max: 20000, heading_max: 30,
  body_size_min: 14, body_line_min: 1.5, paragraph_gap_min: 8, contrast_block: 3, contrast_warn: 4.5,
} as const;
export const LAYOUT_RULE_TITLES: Record<LayoutRuleId, string> = {
  title_present: '文章标题', title_length: '标题长度', cover_image: '封面图', image_caption: '图片图注', image_credit: '网络图图源',
  empty_paragraph: '空段落', long_paragraph: '超长段落', text_wall: '连续大段文字', image_adjacent: '图片过密', image_resolution: '图片清晰度',
  external_link: '正文外链', word_count: '全文字数', heading_length: '小节标题长度', body_readability: '正文字号与行距', text_contrast: '文字颜色对比度',
};
export const LAYOUT_RULE_ORDER: LayoutRuleId[] = ['title_present', 'title_length', 'cover_image', 'image_caption', 'image_credit', 'empty_paragraph', 'long_paragraph', 'text_wall', 'image_adjacent', 'image_resolution', 'external_link', 'word_count', 'heading_length', 'body_readability', 'text_contrast'];

const chars = (text: string) => Array.from(text.replace(/\s+/g, '')).length;
const URL_PATTERN = /https?:\/\/[^\s）)]+|www\.[a-z0-9-]+\.[a-z]{2,}[^\s）)]*/i;
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 对比度（文章底色为白）。 */
export function contrastOnWhite(hex: string): number { if (!/^#[0-9a-f]{6}$/i.test(hex)) return 1; return 1.05 / (luminance(hex) + 0.05); }
/** 占位图注：配图流程的默认值（如「正文配图」「手动加图：第 3 段」）和常见占位词。比较时去掉空白和标点。 */
const PLACEHOLDER_CAPTIONS = new Set(['正文配图', '配图', '图片', '图', '插图', '文章配图', '封面', '封面图', '文章封面', '示意图', '图片说明', '图注', '说明', '图片描述', '此处配图', '这里放图', '待补充', '待定', 'image', 'img', 'picture', 'photo', 'caption']);
export function isPlaceholderCaption(text: string): boolean {
  const t = text.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase(); if (!t) return false;
  return PLACEHOLDER_CAPTIONS.has(t) || /^(?:配图|图片?|插图|image|img)\d{0,3}$/.test(t) || /^手动加图第\d+段$/.test(t) || /^(?:正文|文章)配图\d+$/.test(t);
}
type Ordered = { id: string; block: ArticleLayoutSnapshot['blocks'][number] };
const result = (id: LayoutRuleId, level: LayoutRuleLevel, summary: string, hits: LayoutRuleHit[] = []): Omit<LayoutRuleResult, 'index'> => ({ id, title: LAYOUT_RULE_TITLES[id], level, summary, hits });
const at = (block_id: string, note: string): LayoutRuleHit => ({ block_id, target: 'block', note });
const style = (note: string): LayoutRuleHit => ({ block_id: null, target: 'style', note });

export function runLayoutChecks(snapshot: Pick<ArticleLayoutSnapshot, 'blocks' | 'order' | 'style'>, context: LayoutCheckContext = {}): LayoutCheckReport {
  const byId = new Map(snapshot.blocks.map(b => [b.id, b]));
  // 旧记录里被存成正文的中文序号小节按小节标题检查（与预览一致）。
  const ordered: Ordered[] = snapshot.order.flatMap(id => { const block = byId.get(id); return block ? [{ id, block: layoutBlockKind(block) === block.kind ? block : { ...block, kind: layoutBlockKind(block) } as typeof block }] : []; });
  const texts = ordered.filter((o): o is { id: string; block: ArticleTextBlock } => 'text' in o.block);
  const images = ordered.filter((o): o is { id: string; block: ArticleImageBlock } => o.block.kind === 'image');
  const titleBlock = texts.find(o => o.block.kind === 'title');
  const title = titleBlock ? titleBlock.block.text.trim() : (context.topic_title ?? '').trim();
  const L = LAYOUT_RULES, out: Array<Omit<LayoutRuleResult, 'index'>> = [];

  // 1 文章标题
  if (!title) out.push(result('title_present', 'block', '没有文章标题，公众号草稿需要标题', titleBlock ? [at(titleBlock.id, '标题是空的')] : []));
  else out.push(result('title_present', 'pass', titleBlock ? '正文里有文章标题' : '正文没有单独的标题，按主题标题作为公众号标题'));
  // 2 标题长度
  // 每个一级标题都检查长度（正文里有多个「# 」时逐个指出）；没有标题块时检查主题标题。
  const titles = texts.filter(o => o.block.kind === 'title').map(o => ({ id: o.id as string | null, length: Array.from(o.block.text.trim()).length }));
  if (!titles.length && title) titles.push({ id: null, length: Array.from(title).length });
  const tooLong = titles.filter(t => t.length > L.title_max), longish = titles.filter(t => t.length > L.title_suggest && t.length <= L.title_max);
  const titleHits = (list: typeof titles) => list.flatMap(t => t.id ? [at(t.id, '标题 ' + t.length + ' 字')] : []);
  if (tooLong.length) out.push(result('title_length', 'block', (tooLong.length > 1 ? tooLong.length + ' 个标题' : '标题 ' + tooLong[0]!.length + ' 字') + '超过公众号上限 ' + L.title_max + ' 字', titleHits(tooLong)));
  else if (longish.length) out.push(result('title_length', 'warn', (longish.length > 1 ? longish.length + ' 个标题' : '标题 ' + longish[0]!.length + ' 字') + '超过 ' + L.title_suggest + ' 字，在消息列表里会被折叠', titleHits(longish)));
  else out.push(result('title_length', 'pass', titles.length ? (titles.length > 1 ? titles.length + ' 个标题都' : '标题 ' + titles[0]!.length + ' 字，') + '在 ' + L.title_suggest + ' 字以内' : '没有标题可检查'));
  // 3 封面图
  if (!images.length) out.push(result('cover_image', 'block', '全文没有图片，公众号草稿需要一张封面图'));
  else { const first = ordered.findIndex(o => o.block.kind === 'image'); out.push(first < L.cover_within ? result('cover_image', 'pass', '开头有封面图') : result('cover_image', 'warn', '第一张图在第 ' + (first + 1) + ' 块，开头没有封面图', [at(images[0]!.id, '第一张图')])); }
  // 4 图片图注
  // 没有说明、或说明还是占位文字（配图流程的默认值、「正文配图」之类）都提醒。
  const noCaption = images.filter(o => !splitCaption(o.block).main.trim()), placeholder = images.filter(o => isPlaceholderCaption(splitCaption(o.block).main));
  out.push(noCaption.length || placeholder.length ? result('image_caption', 'warn', [noCaption.length ? noCaption.length + ' 张图没有说明文字' : '', placeholder.length ? placeholder.length + ' 张图的图注还是占位文字，写一句说明这张图讲什么' : ''].filter(Boolean).join('；'), [...noCaption.map(o => at(o.id, '图注缺说明')), ...placeholder.map(o => at(o.id, '图注是占位文字「' + splitCaption(o.block).main.trim() + '」'))]) : result('image_caption', 'pass', images.length ? '每张图都有说明' : '没有图片'));
  // 5 网络图图源
  const web = images.filter(o => splitCaption(o.block).web_image), noCredit = web.filter(o => !splitCaption(o.block).has_credit);
  const missing = new Set(context.credit_missing ?? []), unknown = images.filter(o => missing.has(o.id) && !o.block.image.credit);
  const fill = new Set(context.credit_pending ?? []), fillable = images.filter(o => fill.has(o.id) && !o.block.image.credit && !missing.has(o.id));
  const creditHits = [...noCredit.map(o => at(o.id, '图源已去掉')), ...unknown.filter(o => !noCredit.includes(o)).map(o => at(o.id, '找不到配图来源，重新同步配图')), ...fillable.filter(o => !noCredit.includes(o)).map(o => at(o.id, '重新同步配图可补全图源'))];
  if (creditHits.length) out.push(result('image_credit', 'warn', [noCredit.length ? noCredit.length + ' 张网络图的图注里没有图源' : '', unknown.length ? unknown.length + ' 张图在配图终稿里找不到来源，重新同步配图后补上图源' : '', fillable.length ? fillable.length + ' 张网络图的图源缺链接，重新同步配图可补全图源' : ''].filter(Boolean).join('；'), creditHits));
  else out.push(result('image_credit', 'pass', web.length ? web.length + ' 张网络图都标了图源' : '没有网络图'));
  // 6 空段落
  const empty = texts.filter(o => o.block.kind !== 'title' && !o.block.text.trim());
  out.push(empty.length ? result('empty_paragraph', 'warn', empty.length + ' 处空段落会在文章里留出空白', empty.map(o => at(o.id, '空段落'))) : result('empty_paragraph', 'pass', '没有空段落'));
  // 7 超长段落
  const long = texts.filter(o => (o.block.kind === 'paragraph' || o.block.kind === 'lead') && chars(o.block.text) > L.long_paragraph);
  out.push(long.length ? result('long_paragraph', 'warn', long.length + ' 段超过 ' + L.long_paragraph + ' 字，手机上一屏读不完', long.map(o => at(o.id, chars(o.block.text) + ' 字'))) : result('long_paragraph', 'pass', '每段都在 ' + L.long_paragraph + ' 字以内'));
  // 8 连续大段文字：标题、小节、图片或品牌块之间的正文累计
  const walls: LayoutRuleHit[] = []; let run: Ordered[] = [], total = 0;
  const close = () => { if (total > L.text_wall && run[0]) walls.push(at(run[0].id, '连续 ' + run.length + ' 段共 ' + total + ' 字')); run = []; total = 0; };
  for (const o of ordered) { if (o.block.kind === 'paragraph' || o.block.kind === 'lead') { run.push(o); total += chars((o.block as ArticleTextBlock).text); } else close(); } close();
  out.push(walls.length ? result('text_wall', 'warn', walls.length + ' 处连续正文超过 ' + L.text_wall + ' 字，没有小节或配图隔开', walls) : result('text_wall', 'pass', '正文有小节或配图隔开'));
  // 9 图片过密：两张图之间没有文字
  const adjacent: LayoutRuleHit[] = [];
  for (let i = 1; i < ordered.length; i++) if (ordered[i]!.block.kind === 'image' && ordered[i - 1]!.block.kind === 'image') adjacent.push(at(ordered[i]!.id, '和上一张图紧挨着'));
  out.push(adjacent.length ? result('image_adjacent', 'warn', adjacent.length + ' 处图片紧挨着，中间没有文字', adjacent) : result('image_adjacent', 'pass', '图片之间都有文字'));
  // 10 图片清晰度：按显示宽度（正文宽 × 显示比例 × 2 倍屏）要求的最少像素
  const contentWidth = snapshot.style.mobile_width - snapshot.style.page_padding * 2;
  const blurry = images.filter(o => o.block.image.pixel_width < Math.min(L.min_image_width, Math.round(contentWidth * o.block.display_width_percent / 100 * 2)));
  out.push(blurry.length ? result('image_resolution', 'warn', blurry.length + ' 张图像素偏低，手机上可能发虚', blurry.map(o => at(o.id, '原图宽 ' + o.block.image.pixel_width + ' px'))) : result('image_resolution', 'pass', images.length ? '图片清晰度够用' : '没有图片'));
  // 11 正文外链（公众号正文里的链接点不开）
  // 正文与图注（读者看到的图注文字：说明 + 图源）都检查；图源按「来源名（域名）」显示，不算外链。
  const links = texts.filter(o => URL_PATTERN.test(o.block.text)), captionLinks = images.filter(o => URL_PATTERN.test(captionDisplayText(o.block)));
  const linkSummary = [links.length ? links.length + ' 段正文带网址' : '', captionLinks.length ? captionLinks.length + ' 张图的图注带网址' : ''].filter(Boolean).join('、');
  out.push(linkSummary ? result('external_link', 'warn', linkSummary + '，公众号正文里的外链点不开', [...links.map(o => at(o.id, '含网址')), ...captionLinks.map(o => at(o.id, '图注含网址'))]) : result('external_link', 'pass', '正文和图注都没有外链'));
  // 12 全文字数
  // 全文字数：所有文字块（含各级标题）都计入。
  const words = texts.reduce((n, o) => n + chars(o.block.text), 0);
  if (words > L.words_max) out.push(result('word_count', 'block', '全文 ' + words + ' 字，超过公众号 ' + L.words_max + ' 字上限'));
  else if (words < L.words_min) out.push(result('word_count', 'warn', '全文只有 ' + words + ' 字，少于 ' + L.words_min + ' 字'));
  else out.push(result('word_count', 'pass', '全文 ' + words + ' 字'));
  // 13 小节标题长度
  const longHeadings = texts.filter(o => o.block.kind === 'heading' && Array.from(o.block.text.trim()).length > L.heading_max);
  out.push(longHeadings.length ? result('heading_length', 'warn', longHeadings.length + ' 个小节标题超过 ' + L.heading_max + ' 字，手机上会折成多行', longHeadings.map(o => at(o.id, Array.from(o.block.text.trim()).length + ' 字'))) : result('heading_length', 'pass', '小节标题都在 ' + L.heading_max + ' 字以内'));
  // 14 正文字号与行距
  const s = snapshot.style, small: LayoutRuleHit[] = [];
  if (s.body_size < L.body_size_min) small.push(style('正文 ' + s.body_size + 'px，建议不小于 ' + L.body_size_min + 'px'));
  if (s.body_line_height < L.body_line_min) small.push(style('行距 ' + s.body_line_height + '，建议不小于 ' + L.body_line_min));
  if (s.paragraph_gap < L.paragraph_gap_min) small.push(style('段间距 ' + s.paragraph_gap + 'px，段落挤在一起'));
  out.push(small.length ? result('body_readability', 'warn', '正文排得偏紧，手机上不好读', small) : result('body_readability', 'pass', '正文 ' + s.body_size + 'px · 行距 ' + s.body_line_height));
  // 15 文字颜色对比度
  const ratio = contrastOnWhite(s.text_color), shown = Math.round(ratio * 10) / 10;
  if (ratio < L.contrast_block) out.push(result('text_contrast', 'block', '正文颜色太浅（对比度 ' + shown + '），白底上看不清', [style('换一个更深的正文颜色')]));
  else if (ratio < L.contrast_warn) out.push(result('text_contrast', 'warn', '正文颜色偏浅（对比度 ' + shown + '），长时间阅读吃力', [style('建议用更深的正文颜色')]));
  else out.push(result('text_contrast', 'pass', '正文颜色清楚（对比度 ' + shown + '）'));

  const results = LAYOUT_RULE_ORDER.map((id, index) => ({ ...out.find(r => r.id === id)!, index: index + 1 }));
  return { results, blocking: results.filter(r => r.level === 'block').length, warnings: results.filter(r => r.level === 'warn').length, passed: results.filter(r => r.level === 'pass').length };
}
