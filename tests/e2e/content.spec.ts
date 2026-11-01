import { writeSolidPng } from '../helpers/png.ts';
import {test,expect,identity,headers,action,newTopic,runtime} from './fixtures.ts';
import type {TopicDetail,DocumentSnapshot} from '../../packages/contracts/src/index.ts';
for(const viewport of [{width:1440,height:1000},{width:1280,height:900},{width:768,height:1024},{width:390,height:844}])test('真实核心稿保存、确认与刷新 · '+viewport.width,async({page,request},testInfo)=>{
 const id=await identity(request);await page.setViewportSize(viewport);await page.goto('/?mode=real#create');await expect(action(page,'new-topic')).toBeVisible();
 const title='WP16 浏览器保存 '+viewport.width+' '+testInfo.testId;await newTopic(page,title);
 const text='人工核心稿：浏览器验收使用构造材料，保留版本和真实保存收据。';await page.locator('#core-editor').fill(text);await page.locator('#core-editor').blur();await expect(page.locator('#save-state')).toHaveText('已保存');
 const confirmation=page.waitForResponse(r=>r.url().includes('/core-approvals')&&r.request().method()==='POST');await action(page,'confirm-core').click();expect((await confirmation).status()).toBe(200);
 const response=await request.get('/api/v1/topics',{headers:headers(id)});const topics=(await response.json()).items as Array<{id:string;title:string}>;const topicId=topics.find(t=>t.title===title)!.id;
 const detail=await request.get('/api/v1/topics/'+topicId,{headers:headers(id)});const topic=await detail.json() as TopicDetail;expect(topic.core.text).toBe(text);expect(topic.core_approval?.revision_id).toBe(topic.core.head_revision_id);
 await page.reload();await expect(page.locator('.editor-top h2')).toHaveText(title);await expect(page.locator('#core-editor')).toHaveValue(text);await expect(page.locator('#core-status')).toContainText('已确认');
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await testInfo.attach('core-'+viewport.width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});
test('五平台人工稿独立回读；排期缺少已核对账号时保留输入',async({page,request})=>{
 const id=await identity(request),create=await request.post('/api/v1/topics',{headers:headers(id),data:{title:'WP16 五平台人工验收',category:'个人思考',audience:'AI用户',source_ids:[]}});expect(create.status()).toBe(201);const topic=await create.json() as TopicDetail;
 const saved=await request.post('/api/v1/documents/'+topic.core_document_id+'/revisions',{headers:headers(id),data:{expected_revision_id:null,text:'测试核心稿，无模型或平台请求。',origin:'human'}});const core=(await saved.json()).revision_id;
 expect((await request.post('/api/v1/topics/'+topic.id+'/core-approvals',{headers:headers(id),data:{revision_id:core}})).status()).toBe(200);
 const formats={xiaohongshu:'image_post',wechat:'article',x:'text',douyin:'short_video',bilibili:'long_video'};
 for(const [platform,format] of Object.entries(formats)){const result=await request.post('/api/v1/topics/'+topic.id+'/variants',{headers:headers(id),data:{platform,format}});expect(result.status()).toBe(201);const v=await result.json();const docResponse=await request.get('/api/v1/documents/'+v.document_id,{headers:headers(id)});const doc=await docResponse.json() as DocumentSnapshot;
  const write=await request.post('/api/v1/documents/'+v.document_id+'/revisions',{headers:headers(id),data:{expected_revision_id:doc.head_revision_id,text:'# '+platform+' 专属稿\n\n'+platform+' 人工正文',origin:'human'}});expect(write.status()).toBe(201);
 }
 await page.goto('/?mode=real#create');await page.locator('[data-action="select-topic"][data-id="'+topic.id+'"]').click();await page.locator('[data-action="edit-tab"][data-value="versions"]').click();
 for(const platform of Object.keys(formats)){await page.locator('[data-action="platform-tab"][data-value="'+platform+'"]').click();await expect(page.locator('#version-text')).toHaveValue(platform+' 人工正文');}
 await page.locator('[data-action="platform-tab"][data-value="x"]').click();await action(page,'schedule-topic').click();await page.locator('#schedule-time').fill('2026-12-10T20:00');
 for(const platform of Object.keys(formats))await page.locator('#dialog input[name="platform"][value="'+platform+'"]').setChecked(platform==='x');
 await action(page,'save-schedule',true).click();await expect(page.locator('.toast')).toContainText('已核对');await expect(page.locator('#schedule-time')).toHaveValue('2026-12-10T20:00');await expect(page.locator('#dialog input[value="x"]')).toBeChecked();
 await action(page,'close-dialog',true).first().click();const boot=await runtime(request);const next=await runtime(request,true);expect(next.boot_id).not.toBe(boot.boot_id);await page.reload();await page.locator('[data-action="select-topic"][data-id="'+topic.id+'"]').click();await page.locator('[data-action="edit-tab"][data-value="versions"]').click();await page.locator('[data-action="platform-tab"][data-value="x"]').click();await expect(page.locator('#version-text')).toHaveValue('x 人工正文');
});

test('真实素材上传回读、四视口与H3缺少输入状态，不产生假素材',async({page,request},testInfo)=>{
 const id=await identity(request),response=await request.post('/api/v1/topics',{headers:headers(id),data:{title:'WP19 构造素材浏览器验收',category:'个人思考',audience:'',source_ids:[]}});expect(response.status()).toBe(201);const topic=await response.json() as TopicDetail;
 await page.goto('/?mode=real#create');await page.locator('[data-action="select-topic"][data-id="'+topic.id+'"]').click();await action(page,'open-assets').click();
 await expect(page.locator('#content')).toContainText('本主题素材');
 const uploading=page.waitForResponse(r=>r.url().endsWith('/api/v1/assets')&&r.request().method()==='POST');
 const image = testInfo.outputPath('synthetic-upload.png'); writeSolidPng(image,640,480,[32,80,160]);
 await page.locator('#file-input').setInputFiles(image);expect((await uploading).status()).toBe(201);
 await expect(page.locator('.asset-row')).toHaveCount(1);const before=await request.get('/api/v1/assets?topic_id='+topic.id,{headers:headers(id)});const assets=await before.json();expect(assets.items).toHaveLength(1);await expect(page.locator('.asset-row')).toContainText(assets.items[0].id.slice(0,8));
 for(const width of [1440,1280,768,390]){await page.setViewportSize({width,height:width===390?844:1000});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await testInfo.attach('assets-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});}
 await action(page,'h3-task').click();await expect(page.locator('#h3-prompt')).toHaveValue('');await page.locator('#h3-prompt').fill('构造辅助画面，用于验证任务等待输入，不是本人实测。');
 const accepted=page.waitForResponse(r=>r.url().endsWith('/api/v1/asset-generations')&&r.request().method()==='POST');await action(page,'do-h3',true).click();const jobResponse=await accepted;expect(jobResponse.status()).toBe(202);const job=await jobResponse.json();
 await expect.poll(async()=>{const r=await request.get('/api/v1/jobs/'+job.job_id,{headers:headers(id)});return (await r.json()).job.state;}).toBe('waiting_input');
 await expect(page.locator('#dialog')).not.toBeVisible();const after=await request.get('/api/v1/assets?topic_id='+topic.id,{headers:headers(id)});expect((await after.json()).items.map((a:{id:string})=>a.id)).toEqual(assets.items.map((a:{id:string})=>a.id));
 await page.reload();await page.locator('[data-action="select-topic"][data-id="'+topic.id+'"]').click();await action(page,'open-assets').click();await expect(page.locator('.asset-row')).toHaveCount(1);
});

test('镜头连续编辑后切主题，队列仍保存原主题且新主题可立即编辑',async({page,request})=>{
 const id=await identity(request),create=async(title:string)=>{const response=await request.post('/api/v1/topics',{headers:headers(id),data:{title,category:'个人思考',audience:'',source_ids:[]}});expect(response.status()).toBe(201);return await response.json() as TopicDetail;};
 const a=await create('镜头队列 A'),b=await create('镜头队列 B');
 let release:(()=>void)|undefined,accepted:(()=>void)|undefined,handled:(()=>void)|undefined;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{accepted=resolve;}),finished=new Promise<void>(resolve=>{handled=resolve;});let first=true;
 await page.route('**/api/v1/production-plans/'+a.preparation_plan_id,async route=>{
  if(route.request().method()==='PATCH'&&first){first=false;try{const response=await route.fetch();accepted!();await held;await route.fulfill({response});}finally{handled!();}}else await route.continue();
 });
 try{
  await page.goto('/?mode=real#create');await page.locator('[data-action="select-topic"][data-id="'+a.id+'"]').click();await expect(page.locator('.editor-top h2')).toHaveText(a.title);await page.locator('[data-action="edit-tab"][data-value="assets"]').click();await expect(page.locator('.shot-duration').first()).toHaveValue('0');
  await page.locator('.shot-duration').first().fill('3');await started;await page.locator('.shot-duration').first().fill('9');
  await page.locator('[data-action="select-topic"][data-id="'+b.id+'"]').click();await expect(page.locator('.editor-top h2')).toHaveText(b.title);await expect(page.locator('.shot-duration').first()).toHaveValue('0');
  await page.locator('.shot-duration').first().fill('4');
  const duration=async(planId:string)=>{const response=await request.get('/api/v1/production-plans/'+planId,{headers:headers(id)});expect(response.status()).toBe(200);return (await response.json()).shots[0].duration_ms;};
  await expect.poll(()=>duration(b.preparation_plan_id)).toBe(4000);release!();
  await expect.poll(()=>duration(a.preparation_plan_id)).toBe(9000);expect(await duration(b.preparation_plan_id)).toBe(4000);await expect(page.locator('.editor-top h2')).toHaveText(b.title);await expect(page.locator('.shot-duration').first()).toHaveValue('4');
 }finally{release!();if(!first)await finished;await page.unroute('**/api/v1/production-plans/'+a.preparation_plan_id);}
});
