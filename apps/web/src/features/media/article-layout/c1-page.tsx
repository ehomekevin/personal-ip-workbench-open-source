import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ArticleLayoutImageSync, ArticleLayoutSnapshot, ArticleStyle, ArticleLayoutVisualStatus } from '../../../../../../packages/contracts/src/article-layout.ts';
import { DEFAULT_ARTICLE_STYLE, articleConfirmationIsCurrent, articleConfirmationRulesOutdated,  editCaptionMain, removeCaptionCredit, restoreCaptionCredit, runLayoutChecks, splitCaption, type LayoutRuleHit, type LayoutRuleResult } from '../../../../../../packages/domain/src/article-layout/index.ts';
import type { ArticleLayoutController } from './controller.ts';
import { Reader } from './reader.tsx';
import { LAYOUT_WIDTHS, LEVEL_LABEL, SAVE_LABEL, STYLE_OPTIONS, TEXT_COLORS, THEME_COLORS, checkSummary, confirmState, imageSyncCopy, layoutBlocks, layoutTime, layoutVersions, moveBlock, visualResultView, type LayoutBlockVM } from './c1-model.ts';
import './c1.css';
// 公众号排版 C1/C2：创作页内全宽面板。左栏图文块大纲，中栏 390 手机预览（正文和图注可直接编辑），右栏「调整排版」（当前块 + 本篇版式）与「排版检查」（15 条本机规则）。
// 完整阅读按公众号阅读样式整篇预览；没有阻断项时可「确认排版」，冻结为排版终稿。AI 审核与提交草稿还没上线，界面上明确标出。
export interface LayoutPageState { topic_title: string; images: { state: ArticleLayoutImageSync; count: number; credit_missing?: string[]; credit_pending?: string[] }; busy: boolean; message: string; visual?: ArticleLayoutVisualStatus; visual_phase?: string }
export interface LayoutPageProps { controller: ArticleLayoutController; state: LayoutPageState; imageUrl(asset_id: string): string | undefined; imageError(asset_id: string): string | undefined; onBack(): void; onClose(): void; onResync(): void; onReloadLatest(): void; onConfirm(): void; onVisualCheck?(): void; onVisualQuery?(): void; onVisualCancel?(): void; onVisualRefresh?(): void }
const Next = ({ text = '待上线' }: { text?: string }) => <small className="alc-next">{text}</small>;
function Steps({ onBack, confirmed }: { onBack(): void; confirmed: boolean }) {
  const steps: Array<[string, 'done' | 'current' | 'next', (() => void) | null]> = [['文案定稿', 'done', null], ['配图', 'done', onBack], ['排版', confirmed ? 'done' : 'current', null], ['AI 审核', confirmed ? 'current' : 'next', null], ['确认提交', 'next', null]];
  return <nav className="iwb-steps alc-steps" aria-label="公众号发布步骤"><ol>{steps.flatMap(([label, kind, action], i) => {
    const dot = <span className="iwb-step-dot" aria-hidden="true">{kind === 'done' ? '✓' : String(i + 1)}</span>, soon = label === 'AI 审核' || label === '确认提交';
    const item = <li key={label} className={'iwb-step is-' + kind} aria-current={kind === 'current' ? 'step' : undefined} aria-disabled={soon ? 'true' : undefined}>{action ? <button type="button" className="alc-step-link" onClick={action}>{dot}<span>{label}</span></button> : <>{dot}<span>{label}</span></>}{soon && <small>待上线</small>}</li>;
    return i ? [<li key={label + '-sep'} className="iwb-step-sep" aria-hidden="true">›</li>, item] : [item];
  })}</ol></nav>;
}
/** 按 390 宽排版，再按容器宽度等比缩放；内容自然增高。 */
function useFit(article: React.RefObject<HTMLElement | null>, box: React.RefObject<HTMLElement | null>, host: React.RefObject<HTMLElement | null>, width: number, gutter: number, active = true) {
  useEffect(() => { const el = article.current, b = box.current, h = host.current; if (!el || !b || !h || !active) return;
    const resize = () => { const room = Math.max(1, b.clientWidth - gutter), scale = Math.min(1, room / width); el.style.transform = 'scale(' + scale + ')'; h.style.width = width * scale + 'px'; h.style.height = el.scrollHeight * scale + 'px'; };
    const observer = new ResizeObserver(resize); observer.observe(el); observer.observe(b); resize(); return () => observer.disconnect();
  }, [width, active]);
}
function CheckRow({ result, names, onJump }: { result: LayoutRuleResult; names: Map<string, string>; onJump(hit: LayoutRuleHit): void }) {
  return <li className={'alc-check is-' + result.level} data-rule={result.id}>
    <div className="alc-check-head"><span className="alc-level">{LEVEL_LABEL[result.level]}</span><b>{result.title}</b></div>
    <p>{result.summary}</p>
    {result.level !== 'pass' && result.hits.length > 0 && <div className="alc-check-hits">{result.hits.map((hit, i) => <button type="button" key={i} className="alc-hit" onClick={() => onJump(hit)}>{hit.target === 'style' ? '到本篇版式' : '定位到 ' + (hit.block_id ? names.get(hit.block_id) ?? '图文块' : '全篇')}<small>{hit.note}</small><span aria-hidden="true">↗</span></button>)}</div>}
  </li>;
}
function VisualCheck({ state, snapshot, saved, onJump, onCheck, onQuery, onCancel, onRefresh }: { state: LayoutPageState; snapshot: import('../../../../../../packages/contracts/src/article-layout.ts').ArticleLayoutSnapshot; saved: boolean; onJump(id: string): void; onCheck?(): void; onQuery?(): void; onCancel?(): void; onRefresh?(): void }) {
  const job = state.visual?.latest, result = job?.result ? visualResultView(snapshot, job.result, !!job.current && saved && job.state === 'completed') : null;
  const current = result?.current ?? (!!job?.current && saved && job.snapshot_version === snapshot.version);
  const active = !!job && ['queued','running','unknown'].includes(job.state);
  const labels: Record<string, string> = { queued: '排队中', running: '正在检查排版', unknown: '原任务结果待查询', completed: '检查已完成', cancelled: '已取消', failed: '检查未完成', stale: '检查对应旧版本' };
  const phases: Record<string, string> = { queued: '等待执行', rendering: '正在渲染当前文章', submitted: '已提交原任务', running: '正在检查当前排版', committing: '正在保存检查结果', completed: '结果已保存', unknown: '原任务结果待查询', reconciling: '正在核对原任务结果' };
  return <div className="alc-section alc-visual" aria-label="AI 视觉排版检查"><span className="alc-label">当前图文 · AI 视觉检查</span><h3>按标准检查排版</h3><p className="alc-help">检查字体、间距、图注和手机阅读效果；保留当前文案与配图。</p>
    {state.visual_phase && <p className="alc-help" role="status">{state.visual_phase}</p>}
    {!state.visual && <p className="alc-help">正在读取检查状态…</p>}
    {state.visual && !state.visual.available && <><p className="alc-help" role="status">{state.visual.reason || '视觉检查暂不可用'}</p>{onRefresh && <button type="button" className="button" disabled={state.busy} onClick={onRefresh}>重新读取检查状态</button>}</>}
    {job && <><p className="alc-help" role="status">{labels[job.state] ?? job.state}{job.phase && phases[job.phase] && phases[job.phase] !== labels[job.state] ? ' · ' + phases[job.phase] : ''}</p>
      {!current && result && <p className="alc-help" role="status">这份结果对应之前的排版；保存后可检查当前版本。</p>}
      {job.error && <p className="alc-help" role="alert">{job.error}</p>}
      {job.state === 'unknown' && <p className="alc-help">原任务可能仍在执行。查询会沿用原任务身份，不会重复提交检查。</p>}
      {result && <div className={'alc-check is-' + (current && result.verdict === 'passed' ? 'pass' : 'warn')}><b>{result.verdict === 'passed' ? (current ? '当前排版未发现视觉问题' : '该版本未发现视觉问题') : result.verdict === 'issues' ? '有需要调整的排版' : '部分排版还不能确定'}</b>
        <ul className="alc-check-list">{result.issues.map(issue => <li key={issue.id}><b>{issue.location}</b><p>{issue.problem}</p><p>标准：{issue.standard_ref}</p><p>建议：{issue.suggestion}</p>{issue.uncertainty && <p>待核实：{issue.uncertainty}</p>}{issue.location_note && <p>{issue.location_note}</p>}{issue.target && <button type="button" className="alc-hit" onClick={() => onJump(issue.target!.id)}>定位到 {issue.target.name} ↗</button>}</li>)}</ul>
        {result.uncertainties.map((text, i) => <p key={i}>待核实：{text}</p>)}</div>}
      <div className="alc-row">{job.can_query && onQuery && <button type="button" className="button" disabled={state.busy} onClick={onQuery}>查询原任务</button>}{active && onCancel && <button type="button" className="button" disabled={state.busy} onClick={onCancel}>取消检查</button>}</div></>}
    <button type="button" className="button primary alc-wide" disabled={state.busy || !state.visual?.available || active || !onCheck} onClick={onCheck}>保存并检查当前排版</button>
  </div>;
}
export function LayoutPage({ controller, state, imageUrl, imageError, onBack, onClose, onResync, onReloadLatest, onConfirm, onVisualCheck, onVisualQuery, onVisualCancel, onVisualRefresh }: LayoutPageProps) {
  const ui = useSyncExternalStore(controller.subscribe, controller.state), snapshot = ui.snapshot, blocks = layoutBlocks(snapshot);
  const [selected, setSelected] = useState(snapshot.order[0] ?? ''), [history, setHistory] = useState(false), [reading, setReading] = useState(false), [restoring, setRestoring] = useState(false), [tab, setTab] = useState<'adjust' | 'check'>('adjust');
  // 「已确认 / 终稿」只认与当前文字、排版、图片一致的确认。
  const confirmation = articleConfirmationIsCurrent(snapshot) ? snapshot.confirmation : null, [unlocked, setUnlocked] = useState<string | null>(null), confirmed = !!confirmation, locked = !!confirmation && unlocked !== confirmation.id;
  const article = useRef<HTMLElement | null>(null), viewport = useRef<HTMLDivElement>(null), wrap = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null), readDialog = useRef<HTMLDialogElement>(null), styleSection = useRef<HTMLDivElement>(null);
  const fullArticle = useRef<HTMLElement | null>(null), fullBox = useRef<HTMLDivElement>(null), fullWrap = useRef<HTMLDivElement>(null);
  const current: LayoutBlockVM | undefined = blocks.find(b => b.id === selected) ?? blocks[0], block = current ? snapshot.blocks.find(b => b.id === current.id) : undefined;
  const missing = state.images.credit_missing ?? [], fillable = state.images.credit_pending ?? [], report = useMemo(() => runLayoutChecks(snapshot, { topic_title: state.topic_title, credit_missing: missing, credit_pending: fillable }), [snapshot, state.topic_title, missing.join('|'), fillable.join('|')]);
  const names = new Map(blocks.map(b => [b.id, b.name])), hasTitle = snapshot.blocks.some(b => b.kind === 'title');
  const confirm = confirmState({ confirmed, status: ui.status, blocking: report.results.filter(r => r.level === 'block') });
  const save = () => { void controller.flush(); };
  const edit = (fn: (s: ArticleLayoutSnapshot) => void) => { if (!locked) controller.edit(fn); };
  const setCaption = (id: string, compose: (b: Extract<ArticleLayoutSnapshot['blocks'][number], { kind: 'image' }>) => string) => edit(s => { const b = s.blocks.find(x => x.id === id); if (b?.kind === 'image') b.caption = compose(b); });
  const setStyle = <K extends keyof ArticleStyle>(key: K, value: ArticleStyle[K]) => edit(s => { s.style[key] = value; });
  useEffect(() => { if (!blocks.some(b => b.id === selected) && blocks[0]) setSelected(blocks[0].id); }, [snapshot.order.join('|')]);
  useFit(article, viewport, wrap, snapshot.style.mobile_width, 24);
  useFit(fullArticle, fullBox, fullWrap, snapshot.style.mobile_width, 0, reading);
  useEffect(() => { if (history && !dialog.current?.open) dialog.current?.showModal?.(); if (!history && dialog.current?.open) dialog.current.close(); }, [history]);
  useEffect(() => { if (reading && !readDialog.current?.open) readDialog.current?.showModal?.(); if (!reading && readDialog.current?.open) readDialog.current.close(); }, [reading]);
  const select = (id: string, jump = false) => { setSelected(id); if (jump) article.current?.querySelector<HTMLElement>('[data-block-id="' + CSS.escape(id) + '"]')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); };
  const jump = (hit: LayoutRuleHit) => { if (hit.target === 'style') { setTab('adjust'); requestAnimationFrame(() => styleSection.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })); return; } if (hit.block_id) select(hit.block_id, true); };
  const sync = imageSyncCopy(state.images.state), versions = layoutVersions(confirmation ? snapshot : { ...snapshot, confirmation: null });
  const restore = async (kind: 'content' | 'layout', id: string) => { setRestoring(true); try { await controller.restore(kind, id); setHistory(false); } finally { setRestoring(false); } };
  // 去掉图源是单独的两步显式操作：先点「去掉图源」，再确认。
  const [creditAsk, setCreditAsk] = useState<string | null>(null);
  const removeCredit = (id: string) => { setCaption(id, removeCaptionCredit); setCreditAsk(null); };
  const sorted = [...report.results].sort((a, b) => ({ block: 0, warn: 1, pass: 2 }[a.level] - { block: 0, warn: 1, pass: 2 }[b.level]) || a.index - b.index);
  const caption = block?.kind === 'image' ? splitCaption(block) : null;
  const styleControl = (key: (typeof STYLE_OPTIONS)[number]['key'], label: string, options: Array<{ value: number | string; label: string }>) => {
    const value = snapshot.style[key], id = 'alc-style-' + key;
    return <div className="alc-style-row" key={key}><label htmlFor={id}>{label}</label><select id={id} className="field" disabled={locked} value={String(value)} onChange={e => setStyle(key, (typeof DEFAULT_ARTICLE_STYLE[key] === 'number' ? Number(e.target.value) : e.target.value) as never)}>
      {!options.some(o => String(o.value) === String(value)) && <option value={String(value)}>{String(value)} · 当前</option>}{options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}</select></div>;
  };
  return <section className={'image-workbench article-layout-c1' + (locked ? ' is-locked' : '')} aria-label="公众号排版">
    <header className="iwb-head"><div className="iwb-title"><p className="iwb-eyebrow">WECHAT · LAYOUT STUDIO</p><h2>让图文，读起来更顺。</h2><p className="iwb-sub">文章：{state.topic_title}</p></div>
      <div className="iwb-head-actions"><span className={'alc-save is-' + ui.status} role="status" aria-live="polite">{SAVE_LABEL[ui.status]}</span>{confirmed && <span className="alc-final-badge">排版终稿</span>}<button type="button" className="button" onClick={() => setHistory(true)}>版本记录</button><button type="button" className="button" onClick={onBack}>返回配图</button><button type="button" className="button" onClick={onClose}>返回平台稿</button></div></header>
    <Steps onBack={onBack} confirmed={confirmed} />
    {sync && <p className="iwb-banner is-warn" role="status">{sync.text}{sync.action === 'resync' ? <button type="button" className="button primary" disabled={state.busy || locked} onClick={onResync}>重新同步配图</button> : sync.action === 'back' ? <button type="button" className="button" onClick={onBack}>返回配图</button> : null}</p>}
    {!sync && fillable.some(id => snapshot.blocks.some(b => b.id === id && b.kind === 'image' && !b.image.credit)) && <p className="iwb-banner is-warn" role="status">{fillable.length} 张网络图的图源还缺原网页链接。重新同步配图可补全图源{locked ? '，先点「修改排版」' : ''}；同步后需要重新确认排版。<button type="button" className="button" disabled={state.busy || locked} onClick={onResync}>重新同步配图</button></p>}
    {ui.status === 'conflict' && <p className="iwb-banner is-warn" role="alert">{ui.error || '别处已经保存了新版本，你的修改还留在本机。'}<button type="button" className="button" disabled={state.busy} onClick={onReloadLatest}>载入最新版本并保留我的修改</button></p>}
    {ui.status === 'offline' && <p className="iwb-banner is-warn" role="alert">{'这次没能保存，修改还留在本机。'}<button type="button" className="button" onClick={save}>重试保存</button></p>}
    {ui.foreign && <p className="iwb-banner is-warn" role="status">另一窗口有未保存的修改。这里的修改不会覆盖它，回到那个窗口保存后再刷新这里。</p>}
    {state.message && <p className="iwb-banner" role="status">{state.message}</p>}
    {!confirmed && articleConfirmationRulesOutdated(snapshot) && <p className="iwb-banner is-warn alc-rules-updated" role="status"><span><b>排版规则已更新，请检查后重新确认</b>。小节标题识别和图源显示方式有调整，之前确认的终稿按新规则需要再看一遍；文字、版式和配图都没有改动。</span></p>}
    {confirmed && (locked
      ? <p className="iwb-banner alc-final" role="status"><span><b>排版已确认为终稿</b>{layoutTime(confirmation.confirmed_at) && ' · ' + layoutTime(confirmation.confirmed_at)}。文字、版式和配图都已冻结。<b className="alc-next-step">下一步：AI 审核（待上线）</b></span><button type="button" className="button" onClick={() => setUnlocked(confirmation.id)}>修改排版</button></p>
      : <p className="iwb-banner is-warn" role="status">正在修改已确认的排版：改动保存后确认会失效，改完需要重新确认。<button type="button" className="button" onClick={() => setUnlocked(null)}>不改了</button></p>)}
    <p className="alc-notice"><span className="alc-tag">文案沿用</span>点正文和图注就能直接改；这里的修改只存在排版里，不改平台稿。</p>
    <div className="alc-grid">
      <aside className="alc-outline" aria-label="本篇图文"><div className="iwb-col-head"><h3>本篇图文</h3><span>{blocks.length} 块 · {state.images.count} 张图</span></div>
        <ol className="alc-outline-list">{blocks.map(b => <li key={b.id}><button type="button" className={'alc-outline-item' + (b.id === current?.id ? ' is-active' : '')} aria-pressed={b.id === current?.id} onClick={() => select(b.id, true)}><span className="alc-icon" aria-hidden="true">{b.icon}</span><span className="alc-outline-text"><b>{b.name}</b><small>{b.meta}</small></span></button></li>)}</ol>
        <button type="button" className="button alc-insert" disabled aria-label="插入配图（下一版开放）">＋ 插入配图<Next text="下一版" /></button></aside>
      <section className="alc-preview" aria-label="手机阅读预览"><div className="alc-preview-bar"><div><b>手机阅读预览</b><small>{snapshot.style.mobile_width}px · 正文 {snapshot.style.mobile_width - snapshot.style.page_padding * 2}px</small></div><button type="button" className="button alc-read" onClick={() => setReading(true)}>完整阅读</button></div>
        <div className="alc-viewport" ref={viewport}><div className="alc-paper" ref={wrap}><Reader snapshot={snapshot} selected={current?.id ?? ''} editable={!locked} onSelect={id => select(id)} onEdit={(id, value) => edit(s => { const b = s.blocks.find(x => x.id === id); if (b && 'text' in b) b.text = value; })} onCaption={(id, main) => setCaption(id, b => editCaptionMain(b, main))} onSave={save} imageUrl={imageUrl} imageError={imageError} articleRef={article} wechatTitle={hasTitle ? null : state.topic_title} /></div></div>
        <div className="alc-preview-foot"><span>图片按原比例显示</span><span>文章高度随内容展开</span></div></section>
      <aside className="alc-side" aria-label="调整排版"><div className="alc-tabs" role="tablist" aria-label="排版工具"><button type="button" role="tab" aria-selected={tab === 'adjust'} onClick={() => setTab('adjust')}>调整排版</button><button type="button" role="tab" aria-selected={tab === 'check'} onClick={() => setTab('check')}>排版检查{report.blocking ? <span className="alc-count is-block">{report.blocking}</span> : report.warnings ? <span className="alc-count">{report.warnings}</span> : <span className="alc-count is-pass">✓</span>}</button></div>
        {tab === 'adjust' ? <>
          {confirmed && <p className="alc-help alc-locked-note" role="note">{locked ? '排版已确认为终稿。要改先点上方「修改排版」，修改后需要重新确认。' : '修改后需要重新确认排版。'}</p>}
          {current && block ? <div className="alc-section"><small className="alc-label">当前图文块</small><h3>{current.name}</h3>
            {'text' in block && <><label className="alc-field-label" htmlFor="alc-block-text">编辑文字</label><textarea id="alc-block-text" className="field alc-textarea" value={block.text} disabled={locked} onChange={e => edit(s => { const b = s.blocks.find(x => x.id === block.id); if (b && 'text' in b) b.text = e.target.value; })} onBlur={save} /><p className="alc-help">停下输入 1 秒或离开输入框就自动保存；文字和排版分别记版本。</p></>}
            {block.kind === 'image' && caption && <><label className="alc-field-label" htmlFor="alc-caption">图注</label><textarea id="alc-caption" className="field alc-textarea alc-caption-input" value={caption.main} disabled={locked} placeholder="写一句图注，说明这张图" onChange={e => setCaption(block.id, b => editCaptionMain(b, e.target.value))} onBlur={save} />
              {caption.web_image && (caption.has_credit
                ? <div className="alc-credit-box"><small className="alc-label">图源（网络图，自动附在图注后）</small><p>{caption.credit}</p>{creditAsk === block.id ? <div className="alc-confirm-row" role="group" aria-label="确认去掉图源"><span>确定去掉这张网络图的图源？排版检查会提醒，之后可以加回来。</span><button type="button" className="button alc-danger" onClick={() => removeCredit(block.id)}>确定去掉</button><button type="button" className="button" onClick={() => setCreditAsk(null)}>取消</button></div> : <button type="button" className="button alc-danger" disabled={locked} onClick={() => setCreditAsk(block.id)}>去掉图源</button>}</div>
                : <div className="alc-credit-box is-removed"><small className="alc-label">图源已去掉</small><p>这是网络找的图，建议保留来源。</p>{block.image.credit ? <button type="button" className="button" disabled={locked} onClick={() => setCaption(block.id, restoreCaptionCredit)}>加回图源</button> : <p className="alc-help">重新同步配图后可以补回图源。</p>}</div>)}
              <div className="alc-field-label" id="alc-width-label">显示宽度</div><div className="alc-segment" role="radiogroup" aria-labelledby="alc-width-label">{LAYOUT_WIDTHS.map(w => <button type="button" key={w} role="radio" aria-checked={block.display_width_percent === w} disabled={locked} className={block.display_width_percent === w ? 'is-on' : ''} onClick={() => edit(s => { const b = s.blocks.find(x => x.id === block.id); if (b?.kind === 'image') b.display_width_percent = w; })}>{w}%</button>)}</div>
              <p className="alc-help">原图 {block.image.pixel_width} × {block.image.pixel_height} px，这里只改文章里的显示宽度。</p></>}
            <div className="alc-move"><button type="button" className="button" disabled={locked || !current.canMoveUp} onClick={() => edit(s => { s.order = moveBlock(s.order, current.id, -1); })}>↑ 上移</button><button type="button" className="button" disabled={locked || !current.canMoveDown} onClick={() => edit(s => { s.order = moveBlock(s.order, current.id, 1); })}>↓ 下移</button></div></div> : <p className="alc-help alc-section">在左边或预览里选一个图文块。</p>}
          <div className="alc-section alc-style" ref={styleSection} id="alc-style-section"><small className="alc-label">本篇版式</small><h3>字号、间距与颜色</h3>
            <div className="alc-style-grid">{STYLE_OPTIONS.map(o => styleControl(o.key, o.label, o.options))}
              <div className="alc-style-row"><label htmlFor="alc-style-text_color">正文颜色</label><select id="alc-style-text_color" className="field" disabled={locked} value={snapshot.style.text_color} onChange={e => setStyle('text_color', e.target.value)}>{!TEXT_COLORS.some(c => c.value === snapshot.style.text_color) && <option value={snapshot.style.text_color}>{snapshot.style.text_color} · 当前</option>}{TEXT_COLORS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></div></div>
            <div className="alc-field-label" id="alc-theme-label">主题色</div><div className="alc-swatches" role="radiogroup" aria-labelledby="alc-theme-label">{THEME_COLORS.map(c => <button type="button" key={c.value} role="radio" aria-checked={snapshot.style.accent_color === c.value} aria-label={c.label} title={c.label} disabled={locked} className={'alc-swatch' + (snapshot.style.accent_color === c.value ? ' is-on' : '')} onClick={() => setStyle('accent_color', c.value)}><i style={{ background: c.value }} aria-hidden="true" /><span>{c.label.replace(' · 标准', '')}</span></button>)}</div>
            <button type="button" className="button alc-wide" disabled={locked || JSON.stringify(snapshot.style) === JSON.stringify(DEFAULT_ARTICLE_STYLE)} onClick={() => edit(s => { s.style = { ...DEFAULT_ARTICLE_STYLE }; })}>恢复公众号标准版式</button>
            <p className="alc-help">版式改动随排版版本保存，在「版本记录」里可以回到之前任一版；不改文字、图片和顺序。</p></div>
        </> : <><VisualCheck state={state} snapshot={snapshot} saved={ui.status === 'saved'} onJump={id => select(id, true)} onCheck={onVisualCheck} onQuery={onVisualQuery} onCancel={onVisualCancel} onRefresh={onVisualRefresh} /><div className="alc-section alc-checks"><small className="alc-label">本机排版检查 · 15 项</small><h3 role="status">{checkSummary(report)}</h3>
          <p className="alc-help">按当前排版实时检查，不调用 AI。点问题下面的按钮可以定位到对应图文块。</p>
          <ol className="alc-check-list">{sorted.map(r => <CheckRow key={r.id} result={r} names={names} onJump={jump} />)}</ol></div></>}
      </aside>
    </div>
    <footer className="alc-foot"><span className="alc-foot-help">{confirm.reason}</span><div className="alc-foot-actions">{confirmed ? <button type="button" className="button" disabled aria-label="下一步：AI 审核（待上线）">下一步：AI 审核<Next text="待上线" /></button> : <button type="button" className="button primary" disabled={confirm.disabled || state.busy} onClick={onConfirm}>{confirm.label}</button>}</div></footer>
    <dialog ref={dialog} className="alc-dialog" aria-label="版本记录" onClose={() => setHistory(false)} onCancel={() => setHistory(false)}><header><h3>版本记录</h3><button type="button" className="button" onClick={() => setHistory(false)}>关闭</button></header>
      <p className="alc-help">文字和排版各自记版本，这里列最近 {versions.length} 个。回到某一版会生成一个新版本，之后的修改不会丢。{locked ? '排版已确认，先点「修改排版」才能回到别的版本。' : ''}</p>
      <ol className="alc-versions">{versions.map(v => <li key={v.kind + v.id}><span><b>{v.label}{v.final && <em className="alc-final-tag">排版终稿</em>}</b><small>{v.scope} · {layoutTime(v.at)}</small></span>{v.current ? <span className="alc-current">{v.scope}当前</span> : <button type="button" className="button" disabled={restoring || locked || ui.status === 'conflict'} onClick={() => void restore(v.kind, v.id)}>回到这一版</button>}</li>)}</ol></dialog>
    <dialog ref={readDialog} className="alc-dialog alc-reading" aria-label="完整阅读" onClose={() => setReading(false)} onCancel={() => setReading(false)}><header><div><h3>完整阅读</h3><small>按公众号手机阅读样式整篇预览 · {snapshot.style.mobile_width}px</small></div><button type="button" className="button" onClick={() => setReading(false)}>关闭</button></header>
      <div className="alc-reading-body" ref={fullBox}>{reading && <div className="alc-paper alc-reading-paper" ref={fullWrap}><Reader snapshot={snapshot} selected="" editable={false} onSelect={() => undefined} onEdit={() => undefined} onCaption={() => undefined} onSave={() => undefined} imageUrl={imageUrl} imageError={imageError} articleRef={fullArticle} label="公众号完整阅读" wechatTitle={hasTitle ? null : state.topic_title} /></div>}</div></dialog>
  </section>;
}
