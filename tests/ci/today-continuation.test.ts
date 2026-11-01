import test from 'node:test';
import assert from 'node:assert/strict';
import type { OverviewResponse, TopicDetail } from '../../packages/contracts/src/index.ts';
import { createTodayFeaturePort, projectToday } from '../../apps/web/src/features/today/index.ts';
import { emptyIngestView } from '../../apps/web/src/features/sources/read/index.ts';
import { createHttpClient } from '../../apps/web/src/transport/workbench-client.ts';
import { initialUi } from '../../apps/web/src/app/view-model.ts';
import type { FeatureContext } from '../../apps/web/src/transport/feature-ports.ts';
import { renderTodayContinuation } from '../../apps/web/src/pages/today-continuation.ts';

test('首页只读取当前主题的任务和实际稿件；旧核心稿的平台版本保留待核对', async () => {
  const identity={workspace_id:'internal-workspace',service_instance_id:'internal-service',contract_version:'0.1.1'} as const;
  const topic:TopicDetail={id:'topic-a',title:'一个可复核的任务 <script>',category:'AI 实测',audience:'',angle:'',expected_effort_min:30,core_document_id:'core-a',status:'active',version:1,source_ids:[],core:{document_id:'core-a',head_revision_id:'core-r2',version:2,text:'当前母稿',hash:null,save_state:'committed'},core_approval:{revision_id:'core-r2'},variants:[{platform:'wechat',format:'article',document_id:'variant-a',based_on_core_revision_id:'core-r1'}],assets:[],preparation_plan_id:'preparation-a',preparation_head_revision_id:'preparation-r1',shots:[]};
  const overview:OverviewResponse={local_date:'2026-10-12',timezone:'America/Los_Angeles',updated_at:'2026-10-12T12:00:00Z',budget_min:120,effort_min:0,plan:null,items:[],topics:[topic],actions:[],recent_news:[],jobs:[{id:'job-other',target_id:'topic-other',kind:'publication',state:'reconciling',version:1},{id:'job-voice',target_id:'topic-a',kind:'media_generate',state:'waiting_input',version:2}]};
  assert.equal(projectToday(overview,'topic-a').continuation?.id,'job-voice');
  assert.equal(projectToday(overview,'no-topic').continuation,undefined);
  const reads:string[]=[];
  const client=createHttpClient('',identity,async input=>{
    const path=String(input);reads.push(path);let result:unknown;
    if(path==='/api/v1/identity')result=identity;
    else if(path==='/api/v1/overview')result=overview;
    else if(path==='/api/v1/topics/topic-a')result=topic;
    else if(path==='/api/v1/documents/variant-a')result={document_id:'variant-a',head_revision_id:'variant-r1',version:1,text:'旧版平台稿',hash:null,save_state:'committed'};
    else if(path==='/api/v1/jobs/job-voice')result={job:{id:'job-voice',target_id:'topic-a',kind:'media_generate',state:'waiting_input',version:2,input_manifest:'{"operation":"h3_voice"}'},attempts:[],receipts:[],artifacts:[],checkpoint:null,error:{message:'声音服务未连接，请检查设备和服务'}};
    else throw new Error('Unexpected read '+path);
    return new Response(JSON.stringify(result));
  });
  const context={client,identity,signal:new AbortController().signal,ui:{...initialUi(),topic:'topic-a'}} as FeatureContext;
  const port=createTodayFeaturePort({loadBase:async context=>emptyIngestView(context)}),view=await port.load(context);
  assert.equal(view.projections.today?.continuation?.label,'声音试听');
  assert.equal(view.projections.today?.continuation?.note,'声音服务未连接，请检查设备和服务');
  assert.equal(view.state.topics[0]!.versions.wechat?.status,'核心稿已变化');
  assert.ok(!reads.some(path=>path.includes('job-other')));
  const html=renderTodayContinuation(view.state.topics[0],view.projections.today!);
  assert.match(html,/&lt;script&gt;/);
  assert.match(html,/>公众号<\/span><span>待核对/);
  assert.ok(!html.includes('waiting_input'));
  assert.ok(html.indexOf('<details>')<html.indexOf('job-voice'));
});

test('空主题与未确认母稿不显示后续阶段完成；主操作指向已有稿件', () => {
  const today=projectToday({local_date:'2026-10-12',timezone:'UTC',updated_at:'',budget_min:120,effort_min:0,plan:null,items:[],topics:[],jobs:[],actions:[],recent_news:[]},'');
  const empty=renderTodayContinuation(undefined,today);assert.match(empty,/等待选题/);assert.match(empty,/data-action="new-topic"/);assert.ok(!empty.includes('is-done'));
  const topic={id:'topic-a',title:'已保存的母稿',category:'个人思考',source:'',confirmed:false,coreRev:2,core:'正文',versions:{},assets:[],shots:[]};
  const html=renderTodayContinuation(topic,today);assert.match(html,/核心稿待确认/);assert.match(html,/data-id="topic-a" data-tab="core"/);assert.match(html,/确认核心稿后，按需制作/);assert.equal((html.match(/class="is-done"/g)??[]).length,1);
});
