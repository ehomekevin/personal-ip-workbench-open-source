import assert from 'node:assert/strict';
import test from 'node:test';
import {emptyTopicOperations} from '../../packages/contracts/src/operations.ts';
import type {OperationsProjection} from '../../apps/web/src/app/view-model.ts';
import {operationsSteps,renderOperationsFlow} from '../../apps/web/src/features/operations/flow-view.ts';
function fixture():OperationsProjection {return {topicId:'topic',title:'本人实测',snapshot:{topic_id:'topic',document:null,data:emptyTopicOperations()},coreConfirmed:false,variantCount:0,publishedWorks:[]};}
test('运营候选和已有核心稿不冒充本人确认',()=>{
 const p=fixture();p.snapshot.automation={state:'candidate',candidate:{status:'pending'}} as any;
 assert.deepEqual(operationsSteps(p).map(step=>step.state),['candidate','pending','pending','pending','pending','pending']);
 assert.doesNotMatch(renderOperationsFlow(p,''),/operations-step-check/);
});
test('平台稿和实际发布保留已生成、已记录状态，仅有确认事实的节点画勾',()=>{
 const p=fixture();p.snapshot.document={head_revision_id:'confirmed'} as any;p.coreConfirmed=true;p.variantCount=2;p.publishedWorks=[{id:'work',url:'https://example.org/work',platform:'x'}];
 p.snapshot.data.feedback=[{id:'real',text:'怎么继续？'} as any];p.snapshot.data.followups=[{topic_id:'next',title:'下一条',new_help:'继续帮助'}];
 assert.deepEqual(operationsSteps(p).map(step=>step.state),['confirmed','confirmed','recorded','recorded','confirmed','confirmed']);
 const html=renderOperationsFlow(p,'');assert.equal((html.match(/operations-step-check/g)??[]).length,4);assert.match(html,/已生成 · 待核对/);assert.match(html,/已记录实际发布/);
});
