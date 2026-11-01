// 公众号排版 C2：本机 15 条排版检查（每条至少一例通过、一例触发，触发项定位到对应图文块）；网络图图注的图源拆分与显式去掉；确认排版按钮状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArticleImageBlock, ArticleImageCredit, ArticleLayoutSnapshot } from '../../packages/contracts/src/index.ts';
import { createArticleLayout, editArticleText, replaceArticleImages, backfillArticleImageCredits, recreditCaption, updateArticleStyle, runLayoutChecks, contrastOnWhite, LAYOUT_RULE_ORDER, LAYOUT_RULES, splitCaption, joinCaption, editCaptionMain, removeCaptionCredit, restoreCaptionCredit, creditText, type LayoutRuleId, type LayoutCheckContext } from '../../packages/domain/src/article-layout/index.ts';
import { layoutCaption } from '../../packages/domain/src/article-layout/plan-final-source.ts';
import { LAYOUT_RULES_VERSION, serializeArticleText, parseArticleText, layoutBlockKind, captionDisplayText, isPlaceholderCaption, stripCaptionUrls } from '../../packages/domain/src/article-layout/index.ts';
import { checkSummary, confirmState, layoutVersions } from '../../apps/web/src/features/media/article-layout/c1-model.ts';

const hash = 'a'.repeat(64);
const para = (n: number, seed = '正文') => Array.from({ length: n }, (_, i) => seed[i % seed.length]).join('');
const CREDIT: ArticleImageCredit = { label: '图源：Example News', url: 'https://news.example/a' };
type Img = { id: string; width?: number; caption?: string; credit?: ArticleImageCredit; anchor: string | null; position?: 'before' | 'after' };
/** 一篇默认全部通过的文章：标题、封面、两节正文、一张网络图（带图源）。 */
const GOOD = ['# 把 AI 资讯接进个人工作台', para(150, '这是一段正常长度的正文内容'), '## 先说资讯本身', para(160, '第二段正文也在正常范围之内'), '## 再说流程', para(140, '第三段正文讲工作台的处理流程')].join('\n\n');
function article(text = GOOD, images?: (s: ArticleLayoutSnapshot) => Img[]): ArticleLayoutSnapshot {
  let s = createArticleLayout({ article_id: 'wechat-layout:t', document_id: 'd', document_revision_id: 'r', text });
  const list = images ? images(s) : [{ id: 'cover', caption: '封面：工作台全景', anchor: s.order[0]! }, { id: 'web', caption: joinCaption('官方配图', CREDIT), credit: CREDIT, anchor: s.order[2]! }];
  s = replaceArticleImages(s, list.map(i => ({ id: i.id, image: { asset_id: 'asset-' + i.id, version_id: 'v-' + i.id, sha256: hash, url: '/api/v1/assets/asset-' + i.id + '/content', pixel_width: i.width ?? 1600, pixel_height: 900, source_sha256: hash, ...(i.credit ? { credit: i.credit } : {}) }, caption: i.caption ?? '', anchor_block_id: i.anchor, position: i.position ?? 'after' })));
  return s;
}
const rule = (s: ArticleLayoutSnapshot, id: LayoutRuleId, context: LayoutCheckContext = {}) => runLayoutChecks(s, context).results.find(r => r.id === id)!;
const textId = (s: ArticleLayoutSnapshot, kind: string, nth = 0) => s.order.filter(id => s.blocks.find(b => b.id === id)?.kind === kind)[nth]!;

test('the clean article passes all 15 rules in a fixed order', () => {
  const report = runLayoutChecks(article());
  assert.equal(report.results.length, 15); assert.deepEqual(report.results.map(r => r.id), LAYOUT_RULE_ORDER); assert.deepEqual(report.results.map(r => r.index), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.deepEqual(report.results.filter(r => r.level !== 'pass').map(r => r.id + ':' + r.summary), []); assert.equal(report.blocking, 0); assert.equal(report.passed, 15);
});
test('1 title_present: title block or topic title passes; neither blocks', () => {
  assert.equal(rule(article(), 'title_present').level, 'pass');
  const untitled = article(para(400), s => [{ id: 'c', caption: '封面', anchor: s.order[0]!, position: 'before' }]);
  assert.equal(rule(untitled, 'title_present', { topic_title: '主题标题' }).level, 'pass');
  assert.equal(rule(untitled, 'title_present').level, 'block');
  const empty = editArticleText(article(), textId(article(), 'title'), '  ');
  const r = rule(empty, 'title_present'); assert.equal(r.level, 'block'); assert.equal(r.hits[0]!.block_id, textId(empty, 'title'), '定位到标题块');
});
test('2 title_length: ≤30 passes, 31–64 warns, >64 blocks and points to the title', () => {
  const s = article(), title = textId(s, 'title');
  assert.equal(rule(s, 'title_length').level, 'pass');
  assert.equal(rule(editArticleText(s, title, para(LAYOUT_RULES.title_suggest + 1, '长')), 'title_length').level, 'warn');
  const long = rule(editArticleText(s, title, para(LAYOUT_RULES.title_max + 1, '长')), 'title_length'); assert.equal(long.level, 'block'); assert.equal(long.hits[0]!.block_id, title);
});
test('3 cover_image: image near the top passes; late first image warns; no image blocks', () => {
  assert.equal(rule(article(), 'cover_image').level, 'pass');
  const late = article(GOOD, s => [{ id: 'late', caption: '晚到的图', anchor: s.order.at(-1)! }]); const r = rule(late, 'cover_image'); assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, 'late');
  assert.equal(rule(article(GOOD, () => []), 'cover_image').level, 'block');
});
test('4 image_caption: every image needs a description; a credit alone is not a description', () => {
  assert.equal(rule(article(), 'image_caption').level, 'pass');
  const s = article(GOOD, x => [{ id: 'cover', caption: '', anchor: x.order[0]! }, { id: 'web', caption: creditText(CREDIT), credit: CREDIT, anchor: x.order[2]! }]);
  const r = rule(s, 'image_caption'); assert.equal(r.level, 'warn'); assert.deepEqual(r.hits.map(h => h.block_id), ['cover', 'web']);
});
test('5 image_credit: web images keep their credit; an explicitly removed credit warns at that image', () => {
  assert.equal(rule(article(), 'image_credit').level, 'pass');
  const s = article(), web = s.blocks.find(b => b.id === 'web')!; assert.equal(web.kind, 'image');
  const removed = editArticleText(s, 'web', removeCaptionCredit(web as never)); const r = rule(removed, 'image_credit');
  assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, 'web');
});
test('6 empty_paragraph: an emptied paragraph warns at that block', () => {
  const s = article(); assert.equal(rule(s, 'empty_paragraph').level, 'pass');
  const p = textId(s, 'paragraph', 1), r = rule(editArticleText(s, p, ''), 'empty_paragraph'); assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, p);
});
test('7 long_paragraph: over 300 characters warns', () => {
  const s = article(), p = textId(s, 'paragraph'); assert.equal(rule(editArticleText(s, p, para(LAYOUT_RULES.long_paragraph)), 'long_paragraph').level, 'pass');
  const r = rule(editArticleText(s, p, para(LAYOUT_RULES.long_paragraph + 1)), 'long_paragraph'); assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, p);
});
test('8 text_wall: consecutive body text over 1200 characters without a heading or image warns at its first paragraph', () => {
  assert.equal(rule(article(), 'text_wall').level, 'pass');
  const text = ['# 标题', ...Array.from({ length: 5 }, () => para(250))].join('\n\n'), s = article(text, x => [{ id: 'c', caption: '封面', anchor: x.order[0]! }]);
  const r = rule(s, 'text_wall'); assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, textId(s, 'paragraph'));
});
test('9 image_adjacent: two images with no text between them warn at the second image', () => {
  assert.equal(rule(article(), 'image_adjacent').level, 'pass');
  const s = article(GOOD, x => [{ id: 'a', caption: '图一', anchor: x.order[0]! }, { id: 'b', caption: '图二', anchor: x.order[0]! }]);
  const r = rule(s, 'image_adjacent'); assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, 'b');
});
test('10 image_resolution: pixel width is judged against the displayed width', () => {
  const small = (w: number) => article(GOOD, x => [{ id: 'c', caption: '封面', anchor: x.order[0]!, width: 400 }]).blocks.map(b => b.kind === 'image' ? { ...b, display_width_percent: w } : b);
  const s = article(GOOD, x => [{ id: 'c', caption: '封面', anchor: x.order[0]!, width: 400 }]);
  const r = rule(s, 'image_resolution'); assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, 'c');
  assert.equal(rule({ ...s, blocks: small(50) }, 'image_resolution').level, 'pass', '50% 显示时 400px 够用');
  assert.equal(rule(article(), 'image_resolution').level, 'pass');
});
test('11 external_link: body text with a URL warns; the image credit link does not count', () => {
  const s = article(); assert.equal(rule(s, 'external_link').level, 'pass', '图注里的图源链接不算正文外链');
  const p = textId(s, 'paragraph'), r = rule(editArticleText(s, p, '详见 https://example.com/post 。'), 'external_link'); assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, p);
});
test('12 word_count: under 300 warns, over 20000 blocks, in range passes', () => {
  const s = article(), p = textId(s, 'paragraph'); assert.equal(rule(s, 'word_count').level, 'pass');
  const short = article('# 标题\n\n短短一段', x => [{ id: 'c', caption: '封面', anchor: x.order[0]! }]); assert.equal(rule(short, 'word_count').level, 'warn');
  assert.equal(rule(editArticleText(s, p, para(LAYOUT_RULES.words_max + 1)), 'word_count').level, 'block');
});
test('13 heading_length: a heading over 30 characters warns at that heading', () => {
  const s = article(), h = textId(s, 'heading'); assert.equal(rule(s, 'heading_length').level, 'pass');
  const r = rule(editArticleText(s, h, para(LAYOUT_RULES.heading_max + 1, '节')), 'heading_length'); assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, h);
});
test('14 body_readability: small body size, tight line height or gap warns and points to the style panel', () => {
  const s = article(); assert.equal(rule(s, 'body_readability').level, 'pass');
  const r = rule(updateArticleStyle(s, { body_size: 13, body_line_height: 1.4 }), 'body_readability'); assert.equal(r.level, 'warn'); assert.equal(r.hits.length, 2); assert.ok(r.hits.every(h => h.target === 'style' && h.block_id === null));
  assert.equal(rule(updateArticleStyle(s, { paragraph_gap: 4 }), 'body_readability').level, 'warn');
});
test('15 text_contrast: dark text passes, mid grey warns, light grey blocks', () => {
  const s = article(); assert.equal(rule(s, 'text_contrast').level, 'pass'); assert.ok(contrastOnWhite('#0b1f52') > 15);
  assert.equal(rule(updateArticleStyle(s, { text_color: '#888888' }), 'text_contrast').level, 'warn');
  const r = rule(updateArticleStyle(s, { text_color: '#a0a6bd' }), 'text_contrast'); assert.equal(r.level, 'block'); assert.equal(r.hits[0]!.target, 'style');
  assert.equal(runLayoutChecks(updateArticleStyle(s, { text_color: '#a0a6bd' })).blocking, 1);
});
test('captions: web image credit has name and link; editing the description keeps it; removing it is a separate explicit step', () => {
  assert.equal(creditText(CREDIT), '图源：Example News（news.example）'); assert.equal(creditText({ label: 'X @a', url: null }), '图源：X @a');
  assert.equal(layoutCaption('官方配图', '图源：Example News', 'https://news.example/a'), '官方配图 · 图源：Example News（news.example）'); assert.equal(layoutCaption('官方配图', 'Example'), '官方配图 · 图源：Example');
  const block = { caption: joinCaption('官方配图', CREDIT), image: { credit: CREDIT } } as never;
  assert.deepEqual(splitCaption(block), { main: '官方配图', credit: '图源：Example News（news.example）', has_credit: true, web_image: true, legacy: false });
  const edited = editCaptionMain(block, '发布会现场'); assert.equal(edited, '发布会现场 · 图源：Example News（news.example）', '改说明时图源保留');
  assert.equal(editCaptionMain(block, ''), '图源：Example News（news.example）', '清空说明也不会删掉图源');
  const removed = removeCaptionCredit(block); assert.equal(removed, '官方配图');
  const after = { caption: removed, image: { credit: CREDIT } } as never; assert.equal(splitCaption(after).has_credit, false); assert.equal(editCaptionMain(after, '新说明'), '新说明', '去掉图源后改说明不会自己加回来');
  assert.equal(restoreCaptionCredit(after), joinCaption('官方配图', CREDIT));
  const ai = { caption: '封面', image: {} } as never; assert.deepEqual(splitCaption(ai), { main: '封面', credit: null, has_credit: false, web_image: false, legacy: false }); assert.equal(editCaptionMain(ai, '新封面'), '新封面');
});
test('confirm button: blocked with reasons, waits for saving, confirmed shows the next step; version list marks the final', () => {
  const blocked = confirmState({ confirmed: false, status: 'saved', blocking: [{ title: '文字颜色对比度' }] }); assert.equal(blocked.disabled, true); assert.match(blocked.reason, /还有 1 项阻断：文字颜色对比度/);
  assert.equal(confirmState({ confirmed: false, status: 'saving', blocking: [] }).disabled, true); assert.equal(confirmState({ confirmed: false, status: 'saved', blocking: [] }).disabled, false);
  assert.equal(confirmState({ confirmed: true, status: 'saved', blocking: [] }).state, 'confirmed');
  assert.equal(checkSummary({ blocking: 0, warnings: 0, passed: 15 }), '15 项全部通过'); assert.match(checkSummary({ blocking: 2, warnings: 1, passed: 12 }), /^2 项阻断/);
  const s = article(), confirmed = { ...s, confirmation: { id: 'c', actor: 'me', human_decision_ref: 'x', confirmed_at: '2099-01-01T00:00:00Z', binding: { article_id: s.article_id, content_revision_id: s.content_revision_id, layout_revision_id: s.layout_revision_id, text_hash: s.text_hash, images_hash: s.images_hash, standard_version: s.standard.version, standard_png_sha256: s.standard.png_sha256, standard_html_sha256: s.standard.html_sha256, rules_version: LAYOUT_RULES_VERSION } } };
  const finals = layoutVersions(confirmed).filter(v => v.final); assert.equal(finals.length, 2, '文字与排版各标一个终稿版本'); assert.ok(finals.every(v => v.current));
  assert.equal(layoutVersions(s).some(v => v.final), false);
});
test('2/12 multiple top-level titles: every title is length-checked and all titles count toward the word total', () => {
  const many = ['# 第一个标题', para(10, '正'), ...Array.from({ length: 40 }, (_, i) => '# ' + para(500, '长篇标题内容' + i))].join('\n\n');
  const s = article(many, x => [{ id: 'c', caption: '封面', anchor: x.order[0]! }]), titles = s.order.filter(id => s.blocks.find(b => b.id === id)?.kind === 'title');
  assert.equal(titles.length, 41);
  const length = rule(s, 'title_length'); assert.equal(length.level, 'block'); assert.equal(length.hits.length, 40, '每个超长标题都指出'); assert.ok(length.hits.every(h => titles.slice(1).includes(h.block_id!)));
  const words = rule(s, 'word_count'); assert.equal(words.level, 'block', '标题里的字也计入全文字数'); assert.match(words.summary, /全文 20015 字/);
  const two = article('# 短标题\n\n' + para(320) + '\n\n# ' + para(40, '第二个标题偏长'), x => [{ id: 'c', caption: '封面', anchor: x.order[0]! }]);
  const r = rule(two, 'title_length'); assert.equal(r.level, 'warn'); assert.equal(r.hits[0]!.block_id, two.order.filter(id => two.blocks.find(b => b.id === id)?.kind === 'title')[1]);
});
test('5 image_credit: images whose source cannot be found in the image final warn and ask to re-sync', () => {
  const s = article(), r = rule(s, 'image_credit', { credit_missing: ['cover'] });
  assert.equal(r.level, 'warn'); assert.match(r.summary, /重新同步配图/); assert.equal(r.hits[0]!.block_id, 'cover'); assert.equal(rule(s, 'image_credit', { credit_missing: ['web'] }).level, 'pass', '已有图源事实的不算');
});
test('legacy captions: credit text without credit facts is protected; backfill adds name + link once and keeps the description', () => {
  const legacy = { caption: '官方配图 · 图源：Example News', image: {} } as never;
  assert.deepEqual(splitCaption(legacy), { main: '官方配图', credit: '图源：Example News', has_credit: true, web_image: true, legacy: true, credit_source: '图源：Example News' });
  assert.equal(editCaptionMain(legacy, '新说明'), '新说明 · 图源：Example News'); assert.equal(editCaptionMain(legacy, ''), '图源：Example News');
  assert.equal(recreditCaption(legacy, CREDIT), '官方配图 · 图源：Example News（news.example）');
  let s = article(GOOD, x => [{ id: 'web', caption: '官方配图 · 图源：Example News', anchor: x.order[0]! }]);
  s = editArticleText(s, 'web', '我改的说明 · 图源：Example News');
  const filled = backfillArticleImageCredits(s, { web: CREDIT }), b = filled.blocks.find(x => x.id === 'web')!;
  assert.equal(b.kind, 'image'); if (b.kind !== 'image') return;
  assert.deepEqual(b.image.credit, CREDIT); assert.equal(b.caption, '我改的说明 · 图源：Example News（news.example）'); assert.equal(b.original_caption, '官方配图 · 图源：Example News（news.example）');
  assert.equal(filled.events.at(-1)!.kind, 'image_credit'); assert.equal(backfillArticleImageCredits(filled, { web: CREDIT }), filled, '已有图源的不再改');
});
test('re-sync keeps a manually edited caption (credit follows the newest final); untouched captions take the final caption', () => {
  let s = article(); const anchor = s.order[0]!, web2: ArticleImageCredit = { label: '图源：Other', url: 'https://other.example/b' };
  s = editArticleText(s, 'web', editCaptionMain(s.blocks.find(b => b.id === 'web') as never, '我改过的说明'));
  const next = replaceArticleImages(s, [
    { id: 'cover', image: structuredClone((s.blocks.find(b => b.id === 'cover') as ArticleImageBlock).image), caption: '终稿新封面图注', anchor_block_id: anchor, position: 'after' },
    { id: 'web', image: { asset_id: 'asset-web2', version_id: 'v2', sha256: hash, url: '/x', pixel_width: 1600, pixel_height: 900, source_sha256: hash, credit: web2 }, caption: joinCaption('终稿说明', web2), anchor_block_id: anchor, position: 'after' },
  ]);
  const cover = next.blocks.find(b => b.id === 'cover')!, web = next.blocks.find(b => b.id === 'web')!;
  assert.equal(cover.kind === 'image' && cover.caption, '终稿新封面图注', '没改过的换成终稿图注');
  assert.equal(web.kind === 'image' && web.caption, '我改过的说明 · 图源：Other（other.example）', '改过的说明保留，图源换成新终稿');
  assert.equal(web.kind === 'image' && web.original_caption, joinCaption('终稿说明', web2));
  // 显式去掉图源的，同步后仍保持去掉。
  const removed = editArticleText(s, 'web', '只要说明'), again = replaceArticleImages(removed, [{ id: 'web', image: { asset_id: 'asset-web2', version_id: 'v2', sha256: hash, url: '/x', pixel_width: 1600, pixel_height: 900, source_sha256: hash, credit: web2 }, caption: joinCaption('终稿说明', web2), anchor_block_id: anchor, position: 'after' }]);
  const w = again.blocks.find(b => b.id === 'web')!; assert.equal(w.kind === 'image' && w.caption, '只要说明');
});

test('captions never show a bare URL: credit shows source name + domain; old full-link captions are still recognised and normalised', () => {
  assert.equal(creditText({ label: 'Google', url: 'https://www.blog.google/products/x?utm=1' }), '图源：Google（blog.google）', '只放域名，去掉 www');
  assert.equal(creditText({ label: '图源：news.example', url: 'https://news.example/a' }), '图源：news.example', '来源名里已有域名不重复');
  assert.equal(creditText({ label: 'Bad', url: 'not a url' }), '图源：Bad', '链接无效时只放来源名');
  // C2 早期写进图注的旧格式「图源：来源名（完整链接）」：仍算带图源，显示与再保存都换成域名。
  const old = { caption: '官方配图 · 图源：Example News（https://news.example/a）', image: { credit: CREDIT } } as never;
  const parts = splitCaption(old); assert.equal(parts.has_credit, true); assert.equal(parts.main, '官方配图'); assert.equal(parts.credit, '图源：Example News（news.example）');
  assert.equal(captionDisplayText(old), '官方配图 · 图源：Example News（news.example）'); assert.equal(editCaptionMain(old, '新说明'), '新说明 · 图源：Example News（news.example）');
  // C1 旧记录（没有图源事实）里的链接：显示成域名，原文保留。
  const c1 = { caption: '说明 · 图源：Google（https://blog.google/a）', image: {} } as never;
  assert.equal(captionDisplayText(c1), '说明 · 图源：Google（blog.google）'); assert.equal(editCaptionMain(c1, '改'), '改 · 图源：Google（https://blog.google/a）');
  assert.equal(stripCaptionUrls('见 https://a.example/x 与 http://www.b.example'), '见 a.example 与 b.example');
  const s = article(); assert.ok(s.blocks.every(b => b.kind !== 'image' || !/https?:\/\//.test(captionDisplayText(b))), '默认图注不带裸链接');
});
test('11 external_link also checks image captions (what readers see), not only body text', () => {
  assert.equal(rule(article(), 'external_link').level, 'pass', '图源按「来源名（域名）」显示，不算外链');
  const typed = editArticleText(article(), 'web', editCaptionMain(article().blocks.find(b => b.id === 'web') as never, '图源：Google（https://blog.google/a）'));
  const r = rule(typed, 'external_link'); assert.equal(r.level, 'warn'); assert.match(r.summary, /1 张图的图注带网址/); assert.deepEqual(r.hits.map(h => h.block_id), ['web']); assert.equal(r.hits[0]!.note, '图注含网址');
  const www = editArticleText(article(), 'cover', '详见 www.example.com'); assert.equal(rule(www, 'external_link').level, 'warn', '不带 http 的 www 网址也算');
  const both = editArticleText(typed, textId(typed, 'paragraph'), '正文里 https://x.example 也有'); assert.match(rule(both, 'external_link').summary, /1 段正文带网址、1 张图的图注带网址/);
});
test('4 image_caption warns on placeholder captions (workflow defaults and common filler words)', () => {
  for (const placeholder of ['正文配图', '配图', '图片', ' 图片。', '配图 2', '手动加图：第 3 段', 'Image']) assert.equal(isPlaceholderCaption(placeholder), true, placeholder);
  for (const real of ['封面：工作台全景', '发布会现场与参数对比', '配图流程六步示意', '']) assert.equal(isPlaceholderCaption(real), false, real);
  const s = editArticleText(article(), 'cover', '正文配图'), r = rule(s, 'image_caption');
  assert.equal(r.level, 'warn'); assert.match(r.summary, /1 张图的图注还是占位文字/); assert.equal(r.hits[0]!.block_id, 'cover'); assert.match(r.hits[0]!.note, /占位文字「正文配图」/);
  // 网络图：说明是占位、图源保留，也提醒。
  const web = editArticleText(article(), 'web', editCaptionMain(article().blocks.find(b => b.id === 'web') as never, '配图'));
  assert.deepEqual(rule(web, 'image_caption').hits.map(h => h.block_id), ['web']);
  const none = editArticleText(s, 'web', joinCaption('', CREDIT)); assert.match(rule(none, 'image_caption').summary, /1 张图没有说明文字；1 张图的图注还是占位文字/);
});
test('section headings: Chinese numbered lines import as headings (source bytes kept); old records show them as headings without rewriting', () => {
  const text = '# 标题\n\n三、值不值得付费？\n\n正文一段。\n\n**第二部分：怎么选**\n正文紧跟。\n\n（一）小点\n\n一、这一句是很长的正文开头，虽然以序号开头，但它是完整的一句话，并且已经超过了四十个字的限制。\n\n二、以句号结尾的句子。\n';
  const blocks = parseArticleText(text, 'a'), kinds = blocks.map(b => b.kind + ':' + b.text);
  assert.deepEqual(kinds.slice(0, 6), ['title:标题', 'heading:三、值不值得付费？', 'paragraph:正文一段。', 'heading:第二部分：怎么选', 'paragraph:正文紧跟。', 'heading:（一）小点']);
  assert.equal(blocks[3]!.source_prefix, '**', '加粗记号留在前后缀里'); assert.equal(blocks.at(-2)!.kind, 'paragraph', '超长的序号句仍是正文'); assert.equal(blocks.at(-1)!.kind, 'paragraph', '句号结尾仍是正文');
  const s = createArticleLayout({ article_id: 'x', document_id: 'd', document_revision_id: 'r', text }); assert.equal(serializeArticleText(s), text, '原文字节不变');
  // 旧记录：小节存成了正文段落 → 显示和检查按小节标题。
  const legacy = { id: 'p', kind: 'paragraph', text: '三、值不值得付费？', original_text: '三、值不值得付费？', source_prefix: '', source_suffix: '\n\n' } as const;
  assert.equal(layoutBlockKind(legacy), 'heading'); assert.equal(layoutBlockKind({ ...legacy, text: '三、一句话。' }), 'paragraph'); assert.equal(layoutBlockKind({ ...legacy, text: '普通正文' }), 'paragraph');
  const old = article(['# 标题', '三、' + para(35, '小节标题很长很长'), para(320)].join('\n\n'));
  const asParagraph = { ...old, blocks: old.blocks.map(b => b.kind === 'heading' ? { ...b, kind: 'paragraph' as const } : b) };
  assert.equal(rule(asParagraph, 'heading_length').level, 'warn', '旧记录里的序号小节也按小节标题检查长度');
});

test('rules version is part of the confirmation: a pre-change confirmation is no longer current and asks to re-check; re-confirming makes it current', async () => {
  const { confirmArticleLayout, articleConfirmationIsCurrent, articleConfirmationRulesOutdated, LAYOUT_RULES_VERSION } = await import('../../packages/domain/src/article-layout/index.ts');
  const s = article(), confirmed = confirmArticleLayout(s, { actor: 'me', human_decision_ref: 'd1', layout_only: true });
  assert.equal(confirmed.confirmation!.binding.rules_version, LAYOUT_RULES_VERSION); assert.equal(articleConfirmationIsCurrent(confirmed), true); assert.equal(articleConfirmationRulesOutdated(confirmed), false);
  // C2 早期的确认：没有规则版本（或旧版本），文字排版图片都没变。
  const { rules_version: _v, ...legacyBinding } = confirmed.confirmation!.binding;
  for (const binding of [legacyBinding, { ...legacyBinding, rules_version: 'wechat-layout-rules.1' }]) {
    const old = { ...confirmed, confirmation: { ...confirmed.confirmation!, binding } };
    assert.equal(articleConfirmationIsCurrent(old), false, '规则更新后旧确认不再是当前终稿'); assert.equal(articleConfirmationRulesOutdated(old), true, '提示规则已更新，而不是已修改');
    const again = confirmArticleLayout(old, { actor: 'me', human_decision_ref: 'd2', layout_only: true }); assert.equal(articleConfirmationIsCurrent(again), true); assert.equal(articleConfirmationRulesOutdated(again), false);
    // 内容也变了：不是「规则已更新」，而是普通的确认失效。
    const edited = { ...old, content_revision_id: 'content-other' }; assert.equal(articleConfirmationRulesOutdated(edited), false);
  }
});

test('an outdated confirmation (layout rules changed) is never shown as the final: version list has no 排版终稿 mark until re-confirmed', async () => {
  const { confirmArticleLayout } = await import('../../packages/domain/src/article-layout/index.ts');
  const confirmed = confirmArticleLayout(article(), { actor: 'me', human_decision_ref: 'd1', layout_only: true });
  assert.equal(layoutVersions(confirmed).filter(v => v.final).length, 2, '当前确认标出文字与排版两个终稿版本');
  const { rules_version: _v, ...binding } = confirmed.confirmation!.binding, old = { ...confirmed, confirmation: { ...confirmed.confirmation!, binding } };
  assert.equal(layoutVersions(old).some(v => v.final), false, '规则更新后的旧确认不标排版终稿');
  assert.equal(layoutVersions(confirmArticleLayout(old, { actor: 'me', human_decision_ref: 'd2', layout_only: true })).filter(v => v.final).length, 2, '重新确认后再标出');
});
