import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture,evidence } from './harness.ts';
async function launch(path:string) {
  const child=spawn(process.execPath,[join(import.meta.dirname,'service-child.ts'),path],{stdio:['ignore','pipe','pipe','ipc']});let output='';child.stdout!.on('data',value=>{output+=value;});child.stderr!.on('data',value=>{output+=value;});
  const ready=await new Promise<{port:number;pid:number;boot_id:string}>((resolve,reject)=>{child.once('message',message=>{if(typeof message==='object'&&message!==null&&'kind'in message&&message.kind==='ready'&&'port'in message&&typeof message.port==='number'&&'pid'in message&&typeof message.pid==='number'&&'boot_id'in message&&typeof message.boot_id==='string')resolve({port:message.port,pid:message.pid,boot_id:message.boot_id});else reject(new Error(JSON.stringify(message)));});child.once('error',reject);child.once('exit',code=>reject(new Error(`子服务启动失败 ${code}: ${output}`)));});
  return {...ready,async close(){if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');await exited;assert.equal(child.exitCode,0,output);}};
}
test('T33-T40-real-process-restart-HTTP-adoption-plan-business',async()=>{
  const f=fixture(),startedAt=new Date().toISOString();let service:Awaited<ReturnType<typeof launch>>|undefined;
  try {
    const seeded=await f.report(),path=join(f.root,'config.json');writeFileSync(path,JSON.stringify(f.config));service=await launch(path);
    let base=`http://127.0.0.1:${service.port}`,headers={'content-type':'application/json','x-workspace-id':f.identity.workspace_id,'x-service-instance-id':f.identity.service_instance_id,'idempotency-key':randomUUID()};
    const adoptionInput={create_topic:{title:'child进程采用的主题',category:'个人思考',audience:'',source_ids:[]},observation_plan:seeded.plan};
    let response=await fetch(base+'/api/v1/retro-actions/'+seeded.action.id+'/adoptions',{method:'POST',headers,body:JSON.stringify(adoptionInput)});assert.equal(response.status,201);const adoption=await response.json();
    const planInput={timezone:f.config.timezone,expected_version:0,budget_min:135,items:[{topic_id:adoption.topic_id,effort_min:55,status:'in_progress'}]};
    response=await fetch(base+'/api/v1/daily-plans/2026-10-09',{method:'PUT',headers:{...headers,'idempotency-key':randomUUID()},body:JSON.stringify(planInput)});assert.equal(response.status,200);const plan=await response.json();
    response=await fetch(base+'/api/v1/business-events',{method:'POST',headers:{...headers,'idempotency-key':randomUUID()},body:JSON.stringify({kind:'consultation',time:'2026-10-09T12:00:00.000Z',count:'3',note:'未知来源',attribution:'unknown'})});assert.equal(response.status,201);const business=await response.json();
    const before={pid:service.pid,boot_id:service.boot_id,port:service.port};await service.close();service=await launch(path);const after={pid:service.pid,boot_id:service.boot_id,port:service.port};assert.notEqual(before.pid,after.pid);assert.notEqual(before.boot_id,after.boot_id);base=`http://127.0.0.1:${service.port}`;headers={...headers,'idempotency-key':randomUUID()};
    response=await fetch(base+'/api/v1/retro-actions/'+seeded.action.id+'/adoptions',{method:'POST',headers,body:JSON.stringify(adoptionInput)});assert.equal(response.status,201);assert.equal((await response.json()).id,adoption.id);
    response=await fetch(base+'/api/v1/daily-plans/2026-10-09',{method:'PUT',headers:{...headers,'idempotency-key':randomUUID()},body:JSON.stringify(planInput)});assert.equal(response.status,200);assert.deepEqual(await response.json(),plan);
    response=await fetch(base+'/api/v1/overview?date=2026-10-09&timezone='+encodeURIComponent(f.config.timezone),{headers});assert.equal(response.status,200);const overview=await response.json();assert.equal(overview.plan.id,plan.id);assert.equal(overview.effort_min,55);assert.equal(overview.budget_min,135);
    response=await fetch(base+'/api/v1/business-events',{headers});assert.equal(response.status,200);assert.equal((await response.json()).items[0].id,business.id);
    evidence('T33-T40-real-process-restart-HTTP',{scope:'internal_rule',startedAt,before,after,adoption,plan,business,overview,input_hash:adoption.observation_plan.adoption_request_hash,result:'passed'});
  }catch(error){evidence('T33-T40-real-process-restart-failure',{scope:'internal_rule',startedAt,result:'failed',error:error instanceof Error?{message:error.message,stack:error.stack}:String(error)});throw error;}finally{await service?.close();f.cleanup();}
});
