import type { ArticleBlock, ArticleImageBlock, ArticleLayoutImageSync, ArticleLayoutSnapshot, LayoutCheckIssue, LayoutCheckResult } from '../../../../../../packages/contracts/src/article-layout.ts';
import type { LayoutSaveStatus } from './controller.ts';
import { articleConfirmationIsCurrent, captionDisplayText, layoutBlockKind, layoutCheckIsCurrent } from '../../../../../../packages/domain/src/article-layout/index.ts';
// 公众号排版 C1 的界面投影：图文块名称、大纲说明、版本列表与状态文案。只给用户语言，不显示块 ID、哈希或修订号。
export const LAYOUT_WIDTHS = [50, 75, 100] as const;
export const LAYOUT_VERSION_LIMIT = 40;
const KIND: Record<ArticleBlock['kind'], { icon: string; name: string }> = { title: { icon: 'T', name: '文章标题' }, lead: { icon: '导', name: '导读' }, heading: { icon: '节', name: '小节标题' }, paragraph: { icon: '文', name: '正文' }, opinion: { icon: '观', name: '我的看法' }, image: { icon: '图', name: '配图' }, divider: { icon: 'L', name: '分隔' }, follow: { icon: 'L', name: '关注卡' } };
export interface LayoutBlockVM { id: string; kind: ArticleBlock['kind']; icon: string; name: string; meta: string; excerpt: string; editable: boolean; image: ArticleImageBlock | null; canMoveUp: boolean; canMoveDown: boolean }
const short = (text: string, n: number) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
/** 大纲按显示顺序列出；正文按出现次序编号，配图第一张若在最前视为封面。 */
export function layoutBlocks(snapshot: ArticleLayoutSnapshot): LayoutBlockVM[] {
  let paragraph = 0, figure = 0, coverSeen = false;
  return snapshot.order.flatMap((id, index): LayoutBlockVM[] => {
    const block = snapshot.blocks.find(b => b.id === id); if (!block) return [];
    const kind = layoutBlockKind(block), base = KIND[kind], move = { canMoveUp: index > 0, canMoveDown: index < snapshot.order.length - 1 };
    if (block.kind === 'image') { figure++; const cover = figure === 1 && (index === 0 || (index === 1 && snapshot.blocks.find(b => b.id === snapshot.order[0])?.kind === 'title')); if (cover) coverSeen = true; return [{ id, kind: block.kind, icon: base.icon, name: cover ? '封面' : '配图 ' + (coverSeen ? figure - 1 : figure), meta: block.image.pixel_width + ' × ' + block.image.pixel_height + ' · 显示 ' + block.display_width_percent + '%', excerpt: short(captionDisplayText(block), 28), editable: false, image: block, ...move }]; }
    if ('text' in block) { const name = kind === 'paragraph' ? '正文 · ' + (++paragraph) : base.name; return [{ id, kind, icon: base.icon, name, meta: block.text === block.original_text ? '原文 · 可直接编辑' : '已修改 · 可直接编辑', excerpt: short(block.text, 28), editable: true, image: null, ...move }]; }
    return [{ id, kind: block.kind, icon: base.icon, name: base.name, meta: '品牌元素', excerpt: '', editable: false, image: null, ...move }];
  });
}
const RENDER_FIELD_NAMES: Readonly<Record<string, string>> = {
  font_family: '字体', font_size: '字号', font_weight: '字重', line_height: '行高', letter_spacing: '字距', color: '文字颜色', background_color: '背景色',
  text_align: '对齐方式', margin_bottom: '下边距', padding_top: '上内边距', white_space: '换行方式',
  image_natural_width: '图片原始宽度', image_natural_height: '图片原始高度', image_rendered_width: '图片显示宽度', image_rendered_height: '图片显示高度',
};
const ENGINE_FIELD_NAMES: Readonly<Record<string, string>> = Object.fromEntries([
  ['computed_style', '实际渲染样式'], ['standard_html', '标准 HTML'], ['standard_png', '标准 PNG'],
  ...Object.entries(RENDER_FIELD_NAMES).map(([key, name]) => ['computed_style.' + key, '实际' + name]),
  // 单独出现的明确 CSS/渲染字段可读化；color 等普通单词不作替换。
  ...Object.entries(RENDER_FIELD_NAMES).filter(([key]) => key.includes('_')).map(([key, name]) => [key, name]),
  ...Object.entries(RENDER_FIELD_NAMES).filter(([key]) => key.includes('_') && !key.startsWith('image_')).map(([key, name]) => [key.replaceAll('_', '-'), name]),
]);
export interface VisualIssueVM extends LayoutCheckIssue { target: { id: string; name: string } | null; location_note: string | null }
export interface VisualResultVM extends Omit<LayoutCheckResult, 'issues'> { current: boolean; issues: VisualIssueVM[] }
/** 只投影结果卡文字。原 result、proof、检查与文章不写回；定位只认结构化 block_id。 */
export function visualResultView(snapshot: ArticleLayoutSnapshot, result: LayoutCheckResult, serverCurrentAndSaved: boolean): VisualResultVM {
  const current = serverCurrentAndSaved && layoutCheckIsCurrent(snapshot, result.binding);
  const names = new Map(layoutBlocks(snapshot).map(block => [block.id, block.name]));
  const displayToken = (token: string): string => {
    // 句末点号不是身份的一部分；.suffix、数字、下划线等相似标识仍保持整个 token。
    const identity = token.replace(/\.+$/, ''), punctuation = token.slice(identity.length);
    if (identity === '__topic_title__') return '文章标题' + punctuation;
    if (names.has(identity) || /^(?:text|image)-[a-f0-9]{24}$/.test(identity)) return (current ? names.get(identity) ?? '报告提及的图文块（当前无法定位）' : '检查时的图文块（旧版）') + punctuation;
    return Object.hasOwn(ENGINE_FIELD_NAMES, identity) ? ENGINE_FIELD_NAMES[identity]! + punctuation : token;
  };
  const display = (text: string): string => {
    const fieldAt = (offset: number) => {
      const match = /^([a-zA-Z0-9_.-]+)(\s*:)/.exec(text.slice(offset));
      const opaque = match && !Object.hasOwn(ENGINE_FIELD_NAMES, match[1]!) && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(match[1]!);
      return match && (Object.hasOwn(ENGINE_FIELD_NAMES, match[1]!) || /^--[a-zA-Z0-9_-]+$/.test(match[1]!) || opaque) ? { key: match[1]!, colon: match[2]!, value: offset + match[0].length, opaque } : null;
    };
    const protectedAt = (offset: number) => /^(?:<(?:[^>"']|"[^"]*"|'[^']*')*>|(?:[a-z][a-z0-9+.-]*:|www\.)[^\s<>"'`]+|(?:\/|\.{1,2}\/|[a-z_][a-z0-9_.-]*\/)[^\s<>"'`]+)/i.exec(text.slice(offset))?.[0];
    // 值原样复制；只在引号、括号和 URI 之外识别后继声明，不把值里的字段词当键。
    const valueEnd = (start: number, family: boolean, custom: boolean, protectedUntil: number): number => {
      let quote = '', started = false; const brackets: string[] = [];
      for (let i = start; i < text.length; i++) {
        const char = text[i]!;
        if (char === '\\') { i++; started = true; continue; }
        if (quote) { if (char === quote) quote = ''; continue; }
        if (char === '"' || char === "'") { quote = char; started = true; continue; }
        if (char === '(' || char === '[' || char === '{') { brackets.push(char); started = true; continue; }
        if (brackets.length) { if (char === ')' && brackets.at(-1) === '(' || char === ']' && brackets.at(-1) === '[' || char === '}' && brackets.at(-1) === '{') brackets.pop(); continue; }
        const next = i + 1 + (text.slice(i + 1).match(/^\s*/)?.[0].length ?? 0);
        if ((custom ? char === ';' : ';；\n\r|。！？'.includes(char)) || !custom && ',，、'.includes(char) && fieldAt(next)) {
          // 未知声明也可能是原有 URI；其完整地址内不拆分参数或字段。
          if (i < protectedUntil) continue;
          return i;
        }
        if (/\s/.test(char)) {
          if (!started) continue;
          const after = i + (text.slice(i).match(/^\s*/)?.[0].length ?? 0);
          if (!custom && (!family || fieldAt(after))) return i;
          continue;
        }
        const uri = !custom && (i === start || !/[a-zA-Z0-9_.-]/.test(text[i - 1]!)) ? protectedAt(i) : null;
        if (uri) { i += uri.length - 1; started = true; continue; }
        started = true;
      }
      return text.length;
    };
    let output = '', offset = 0;
    while (offset < text.length) {
      const html = text[offset] === '<' ? protectedAt(offset) : null;
      if (html) { output += html; offset += html.length; continue; }
      const field = fieldAt(offset);
      if (field) {
        const resource = field.opaque ? protectedAt(offset) : null;
        const openFunction = resource && (resource.match(/\(/g)?.length ?? 0) > (resource.match(/\)/g)?.length ?? 0);
        if (resource && !openFunction && !/^[^;\n\r]*["'(]/.test(text.slice(offset + resource.length))) { output += resource; offset += resource.length; continue; }
        const end = valueEnd(field.value, !!field.opaque || /(?:^|[._-])font[_-]family$/.test(field.key), field.key.startsWith('--'), resource ? offset + resource.length : 0);
        output += (ENGINE_FIELD_NAMES[field.key] ?? field.key) + field.colon + text.slice(field.value, end); offset = end; continue;
      }
      const protectedText = !offset || !/[a-zA-Z0-9_.-]/.test(text[offset - 1]!) ? protectedAt(offset) : null;
      if (protectedText) { output += protectedText; offset += protectedText.length; continue; }
      // 参数键立即开始；续字符接纳组合附加符并保留原码点，不跨普通句读借后句等号。
      const query = /^[a-zA-Z0-9_.~%&=+\/#:@!$()*-]*\?\?*[\p{L}\p{N}_.~%+-][\p{L}\p{N}\p{M}_.~%+()\[\]-]*=[^\s<>"'`]*/u.exec(text.slice(offset))?.[0];
      if (query) { output += query; offset += query.length; continue; }
      // 仅完整已知的类型描述可读化；资源地址与 CSS 值已由前面的保护分支保留。
      const kind = /^kind[ \t]*=[ \t]*([a-zA-Z0-9_.-]+)(?=$|[\s,，、;；：。！？!()（）\[\]【】{}“”‘’"'`]|:(?=$|\s)|\?(?=$|[\s,，、;；。！？!()（）\[\]【】{}“”‘’"'`]))/.exec(text.slice(offset));
      if (kind) {
        const identity = kind[1]!.replace(/\.+$/, '');
        if (Object.hasOwn(KIND, identity)) { output += KIND[identity as ArticleBlock['kind']].name + kind[1]!.slice(identity.length); offset += kind[0].length; continue; }
      }
      const token = /^[a-zA-Z0-9_.-]+/.exec(text.slice(offset))?.[0];
      if (token) { output += displayToken(token); offset += token.length; }
      else output += text[offset++];
    }
    return output;
  };
  return { ...result, current, issues: result.issues.map(issue => {
    const target = current && issue.block_id !== '__topic_title__' && issue.block_id && names.has(issue.block_id) ? { id: issue.block_id, name: names.get(issue.block_id)! } : null;
    return { ...issue, location: display(issue.location), problem: display(issue.problem), standard_ref: display(issue.standard_ref), suggestion: display(issue.suggestion), uncertainty: issue.uncertainty === null ? null : display(issue.uncertainty), target,
      location_note: current && !target && issue.block_id !== '__topic_title__' ? (issue.block_id ? '这条建议对应的图文块当前无法定位。' : '这条建议未提供具体图文块位置。') : null };
  }), uncertainties: result.uncertainties.map(display) };
}
/** 交换相邻两块的显示顺序（文字原文顺序不变）。 */
export function moveBlock(order: string[], id: string, direction: -1 | 1): string[] {
  const next = [...order], i = next.indexOf(id), j = i + direction; if (i < 0 || j < 0 || j >= next.length) return next;
  [next[i], next[j]] = [next[j]!, next[i]!]; return next;
}
const REASON: Record<string, string> = { import: '进入排版时的原文', image_adoption: '同步配图', manual_text: '修改文字', reorder: '调整图文顺序', image_width: '调整图片宽度', content_restore: '回到之前的文字', layout_restore: '回到之前的排版', style: '调整版式', brand_block: '加入品牌元素', standard_version: '更新排版标准' };
/** final：这一版是已确认的排版终稿（C2）。 */
export interface LayoutVersionVM { kind: 'content' | 'layout'; id: string; label: string; scope: string; at: string; current: boolean; final: boolean }
/** 文字与排版各自记版本；合并后按时间倒序最多列 40 个，当前在用的不可再回到。 */
export function layoutVersions(snapshot: ArticleLayoutSnapshot): LayoutVersionVM[] {
  // 只有当前有效的确认才标「排版终稿」：内容改过或排版规则更新后的旧确认不算。
  const confirmed = articleConfirmationIsCurrent(snapshot) ? snapshot.confirmation?.binding : undefined, list: LayoutVersionVM[] = [
    ...snapshot.content_history.map(r => ({ kind: 'content' as const, id: r.id, label: REASON[r.reason] ?? '修改文字', scope: '文字', at: r.created_at, current: r.id === snapshot.content_revision_id, final: confirmed?.content_revision_id === r.id })),
    ...snapshot.layout_history.map(r => ({ kind: 'layout' as const, id: r.id, label: REASON[r.reason] ?? '调整排版', scope: '排版', at: r.created_at, current: r.id === snapshot.layout_revision_id, final: confirmed?.layout_revision_id === r.id })),
  ];
  return list.sort((a, b) => b.at.localeCompare(a.at) || (a.kind === b.kind ? 0 : a.kind === 'content' ? -1 : 1)).slice(0, LAYOUT_VERSION_LIMIT);
}
export function layoutTime(at: string): string { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
export const SAVE_LABEL: Record<LayoutSaveStatus, string> = { saved: '已保存', dirty: '修改待保存', saving: '正在保存…', offline: '保存失败 · 修改已保留', conflict: '别处有新版本 · 修改已保留' };
export function imageSyncCopy(state: ArticleLayoutImageSync): { text: string; action: 'resync' | 'back' | null } | null {
  if (state === 'unknown') return { text: '无法确认配图状态，请刷新页面再看；排版里的修改照常保存。', action: null };
  if (state === 'final_updated') return { text: '配图已更新，重新同步后排版里的图片和图源换成最新确认的版本；你改过的文字、图注、图片宽度和位置都保留。', action: 'resync' };
  if (state === 'plan_changed') return { text: '配图在确认后又改过，回到配图确认一次，再回来同步。', action: 'back' };
  return null;
}
/** 读接口错误给用户语言，不露错误码。 */
export function layoutErrorCopy(error: unknown): string {
  const e = error as { response?: { error?: { message?: string; code?: string } }; message?: string };
  const message = e?.response?.error?.message ?? (error instanceof Error ? error.message : '');
  return message && !/[A-Z_]{6,}|[0-9a-f]{8}-[0-9a-f]{4}/.test(message) ? message : '排版暂时读不到，请稍后重试';
}

// ——— C2：版式面板、排版检查、确认排版的界面投影 ———
export type LayoutStyleKey = 'body_size' | 'body_line_height' | 'paragraph_gap' | 'page_padding' | 'letter_spacing' | 'title_size' | 'heading_size' | 'caption_align';
/** 版式面板的可选值（标「标准」的是公众号标准）。 */
export const STYLE_OPTIONS: Array<{ key: LayoutStyleKey; label: string; options: Array<{ value: number | string; label: string }> }> = [
  { key: 'body_size', label: '正文字号', options: [14, 15, 16, 17].map(v => ({ value: v, label: v + 'px' + (v === 15 ? ' · 标准' : '') })) },
  { key: 'body_line_height', label: '正文行距', options: [1.6, 1.8, 2].map(v => ({ value: v, label: v.toFixed(1) + (v === 1.8 ? ' · 标准' : '') })) },
  { key: 'paragraph_gap', label: '段间距', options: [12, 16, 20, 24, 28].map(v => ({ value: v, label: v + 'px' + (v === 20 ? ' · 标准' : '') })) },
  { key: 'page_padding', label: '页边距', options: [12, 16, 20, 24].map(v => ({ value: v, label: v + 'px' + (v === 16 ? ' · 标准' : '') })) },
  { key: 'letter_spacing', label: '字间距', options: [0, 0.5, 1].map(v => ({ value: v, label: v + 'px' + (v === 0.5 ? ' · 标准' : '') })) },
  { key: 'title_size', label: '文章标题', options: [20, 22, 24, 26].map(v => ({ value: v, label: v + 'px' + (v === 22 ? ' · 标准' : '') })) },
  { key: 'heading_size', label: '小节标题', options: [16, 18, 20].map(v => ({ value: v, label: v + 'px' + (v === 18 ? ' · 标准' : '') })) },
  { key: 'caption_align', label: '图注对齐', options: [{ value: 'left', label: '左对齐' }, { value: 'center', label: '居中 · 标准' }, { value: 'right', label: '右对齐' }] },
];
/** 主题色：小节编号、标题下划线和导读竖线的强调色。 */
export const THEME_COLORS: ReadonlyArray<{ value: string; label: string }> = [{ value: '#ccf866', label: '青柠 · 标准' }, { value: '#b5f0d8', label: '薄荷' }, { value: '#ffd59a', label: '暖橙' }, { value: '#d9d0ff', label: '雾紫' }];
export const TEXT_COLORS: ReadonlyArray<{ value: string; label: string }> = [{ value: '#0b1f52', label: '藏青 · 标准' }, { value: '#222222', label: '墨黑' }, { value: '#4b5783', label: '灰蓝' }, { value: '#a0a6bd', label: '浅灰' }];
export const LEVEL_LABEL = { pass: '通过', warn: '提醒', block: '阻断' } as const;
export function checkSummary(report: { blocking: number; warnings: number; passed: number }): string {
  if (report.blocking) return report.blocking + ' 项阻断 · ' + report.warnings + ' 项提醒 · ' + report.passed + ' 项通过';
  if (report.warnings) return '没有阻断项 · ' + report.warnings + ' 项提醒 · ' + report.passed + ' 项通过';
  return '15 项全部通过';
}
export interface ConfirmVM { state: 'confirmed' | 'blocked' | 'unsaved' | 'ready'; disabled: boolean; label: string; reason: string }
/** 「确认排版」按钮：已确认 / 有阻断项 / 修改还没保存 / 可以确认。 */
export function confirmState(input: { confirmed: boolean; status: LayoutSaveStatus; blocking: Array<{ title: string }> }): ConfirmVM {
  if (input.confirmed) return { state: 'confirmed', disabled: true, label: '已确认排版', reason: '排版已冻结为终稿。要再改，先点「修改排版」。' };
  if (input.blocking.length) return { state: 'blocked', disabled: true, label: '确认排版', reason: '还有 ' + input.blocking.length + ' 项阻断：' + input.blocking.map(b => b.title).join('、') + '。在「排版检查」里点问题可以直接定位。' };
  if (input.status !== 'saved') return { state: 'unsaved', disabled: true, label: '确认排版', reason: input.status === 'saving' || input.status === 'dirty' ? '修改正在保存，保存好就能确认。' : '修改还没保存成功，先处理上面的保存提示。' };
  return { state: 'ready', disabled: false, label: '确认排版', reason: '没有阻断项。确认后冻结为排版终稿，下一步是 AI 审核。' };
}
