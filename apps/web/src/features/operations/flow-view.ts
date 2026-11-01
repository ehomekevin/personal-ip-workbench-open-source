import type { OperationsProjection } from '../../app/view-model.ts';
import { createTemplateHelpers } from '../../components/templateHelpers.ts';

const { esc } = createTemplateHelpers([]);
export type OperationsStepState = 'confirmed' | 'recorded' | 'candidate' | 'pending';
export interface OperationsStep { label:string; state:OperationsStepState; detail:string; current:boolean }

// 这里只投影已持久化的状态。生成平台稿并不代表核对或发布已完成。
export function operationsSteps(p:OperationsProjection):OperationsStep[] {
  const data=p.snapshot.data,candidate=p.snapshot.automation?.state==='candidate'&&p.snapshot.automation.candidate?.status==='pending';
  const current=!p.snapshot.document?0:!p.coreConfirmed?1:!p.variantCount?2:!p.publishedWorks.length?3:!data.feedback.length?4:5;
  const rows:[string,OperationsStepState,string][]=[
    ['运营简报',p.snapshot.document?'confirmed':candidate?'candidate':'pending',p.snapshot.document?'已确认':candidate?'候选待确认':'待确认'],
    ['核心稿',p.coreConfirmed?'confirmed':'pending',p.coreConfirmed?'已确认':'待核对'],
    ['平台稿',p.variantCount?'recorded':'pending',p.variantCount?'已生成 · 待核对':'待制作'],
    ['实际发布',p.publishedWorks.length?'recorded':'pending',p.publishedWorks.length?'已记录实际发布':'待发布'],
    ['读者反馈',data.feedback.length?'confirmed':'pending',data.feedback.length?'已确认反馈':'待收集'],
    ['后续选题',data.followups.length?'confirmed':'pending',data.followups.length?'已确认题目':'待确认']
  ];
  return rows.map(([label,state,detail],i)=>({label,state,detail,current:i===current&&state!=='confirmed'}));
}

export function renderOperationsFlow(p:OperationsProjection,primaryAction:string):string {
  const steps=operationsSteps(p),current=steps.find(s=>s.current);
  return '<div class="operations-flow-slot" data-operations-slot><div class="operations-flow" data-operations-flow data-flow-topic="'+esc(p.topicId)+'">'+
    '<div class="operations-flow-heading"><div class="operations-flow-title"><h2 tabindex="-1">账号运营流程</h2><p class="fine operations-topic">'+esc(p.title)+'</p></div><div class="operations-flow-actions"><span class="operations-flow-current">'+esc(current?'当前 · '+current.label:'本轮记录已齐备')+'</span><div class="operations-flow-dock-action">'+primaryAction+'</div><button type="button" class="operations-flow-return" data-operations-return aria-label="展开并返回账号运营流程" title="展开并返回流程"><span>展开流程</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 14 5-5 5 5"/></svg></button></div></div>'+
    '<div class="operations-flow-track"><svg class="operations-flow-lines" aria-hidden="true" focusable="false"></svg><ol class="operations-steps">'+steps.map((step,i)=>'<li aria-label="'+esc(step.label+' · '+step.detail)+'" title="'+esc(step.detail)+'" data-flow-step="'+i+'" data-flow-state="'+step.state+'" class="'+step.state+(step.current?' current':'')+'"'+(step.current?' aria-current="step"':'')+'><span class="operations-step-mark">'+(step.state==='confirmed'?'<svg class="operations-step-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12 4 4 8-8"/></svg>':step.state==='recorded'?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h7l3 3v13H7zM10 10h4M10 14h4"/></svg>':String(i+1))+'</span><strong>'+step.label+'</strong><small>'+esc(step.detail)+'</small></li>').join('')+'</ol></div></div></div>';
}
