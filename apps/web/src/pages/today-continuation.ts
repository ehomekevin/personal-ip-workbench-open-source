import type { TodayProjection, TopicView } from '../app/view-model.ts';
import { P } from '../components/metadata.ts';
import { createTemplateHelpers } from '../components/templateHelpers.ts';

const { esc, tag, icon, btn } = createTemplateHelpers([]);

export function renderTodayContinuation(topic: TopicView | undefined, today: TodayProjection): string {
  const versions = Object.values(topic?.versions ?? {});
  const currentVersions = versions.filter(version => version.status === '已保存');
  // 有平台草稿不代表已经排期、发布或复盘，后续阶段仍待实际完成。
  const stage = !topic ? 0 : !topic.confirmed ? 1 : 2;
  const steps = ['选题', '核心稿', '平台版本', '排期', '复盘'];
  const hasCore = !!topic?.core.trim();
  const nextTitle = !topic ? '先选一个值得讲的主题' : !topic.confirmed ? hasCore ? '把这份核心稿确认下来' : '把你的材料和判断写成初稿' : currentVersions.length ? '把平台稿逐一打磨好' : '让这份稿适合不同的平台';
  const nextNote = !topic ? '从一次实测、一条资讯或一个想法开始。' : !topic.confirmed ? '检查事实、自己的判断和讲法，确认后再拆平台版本。' : '保留同一个观点，按平台调整篇幅、讲法和素材。';
  const nextLabel = !topic ? '建立主题' : !topic.confirmed ? hasCore ? '继续修改核心稿' : '开始写核心稿' : currentVersions.length ? '继续编辑平台稿' : '制作平台版本';
  const action = topic ? btn(nextLabel, 'open-create', true, 'data-id="'+esc(topic.id)+'" data-tab="'+(topic.confirmed?'versions':'core')+'"') : btn(nextLabel, 'new-topic', true);
  const job = today.continuation?.topicId === topic?.id ? today.continuation : undefined;
  const stateLabel: Record<string, string> = {queued:'等待开始',running:'处理中',waiting_input:'等待处理',waiting_quota:'额度待恢复',reconciling:'结果待核对',cancel_requested:'取消中'};
  return '<section class="panel continuation-card" aria-labelledby="continuation-heading">'+
    '<div class="panel-head"><h2 id="continuation-heading">继续创作</h2>'+tag(!topic?'等待选题':topic.confirmed?'核心稿已确认':hasCore?'核心稿待确认':'核心稿待起草',topic?.confirmed?'green':'warn')+'</div>'+
    '<div class="panel-body continuation-body"><div class="continuation-meta">'+tag(topic?.category ?? '你的下一条内容')+'<span>一个主题，多种表达</span></div>'+
    '<h3 class="current-title continuation-title">'+esc(topic?.title ?? '今天，先把一个好想法留下来')+'</h3>'+
    '<ol class="continuation-steps" aria-label="本条内容的创作进度">'+steps.map((name,index)=>'<li class="'+(index<stage?'is-done':index===stage?'is-current':'is-next')+'" '+(index===stage?'aria-current="step"':'')+'><span class="continuation-step-mark" aria-hidden="true">'+(index<stage?icon('check'):String(index+1).padStart(2,'0'))+'</span><span>'+name+'</span><span class="screen-reader">'+(index<stage?'已完成':index===stage?'当前阶段':'待完成')+'</span></li>').join('')+'</ol>'+
    '<div class="continuation-next"><div class="continuation-next-copy"><span class="continuation-kicker">下一步</span><h4>'+esc(nextTitle)+'</h4><p>'+esc(nextNote)+'</p></div>'+action+'</div>'+
    '<div class="continuation-platforms"><div class="continuation-platform-heading"><strong>平台稿</strong><span>'+(!topic?.confirmed?'确认核心稿后，按需制作':versions.length?versions.length+' 个已有版本':'还没有平台版本')+'</span></div><ul aria-label="平台稿准备情况">'+Object.entries(P).map(([key,platform])=>{const version=topic?.versions[key],ready=!!version&&topic?.confirmed&&version.status==='已保存';return '<li class="'+(ready?'is-ready':'')+'"><span>'+platform.name+'</span><span>'+(!version?'待制作':ready?'已保存':'待核对')+'</span></li>';}).join('')+'</ul></div>'+
    (job?'<aside class="continuation-task" aria-label="当前主题的相关任务"><span class="continuation-task-icon" aria-hidden="true">'+icon('clock')+'</span><div class="continuation-task-copy"><strong>'+esc(job.label ?? '相关任务')+' <span>· '+esc(stateLabel[job.state] ?? '需要查看')+'</span></strong><p>'+esc(job.note ?? '任务记录已保留，可继续编辑当前内容。')+'</p><details><summary>任务详情</summary><dl><div><dt>任务编号</dt><dd>'+esc(job.id)+'</dd></div><div><dt>状态</dt><dd>'+esc(stateLabel[job.state] ?? job.state)+'</dd></div></dl></details></div></aside>':'')+
    '</div></section>';
}
