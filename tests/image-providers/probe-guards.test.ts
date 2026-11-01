import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
test('probe r2 uses actual process admission guards and read-only saved evidence; no model calls',t=>{
 // 该脚本是 AGY probe r2 的历史证据，只在主仓未跟踪的 docs/evidence 里，未随代码入库；缺文件时如实标为未运行。
 const script=resolve(root,'.ci-artifacts/evidence/image-provider-agy-01/probe-r2/test_probe_guards.py');
 if(!existsSync(script)){t.skip('probe r2 evidence script is not in this checkout: not_run');return;}
 const python=process.env.WORKBENCH_PYTHON??'python3';
 const available=spawnSync(python,['-c','import PIL'],{cwd:root,encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 if(available.status!==0){t.skip('Python/Pillow unavailable: probe guard fixture not_run in this environment');return;}
 const result=spawnSync(python,[script],{cwd:root,encoding:'utf8',timeout:45000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr||String(result.error));const output=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
 assert.equal(output.status,'passed');assert.equal(output.tests_run,9);assert.equal(output.actual_provider_calls,0);assert.equal(output.private_user_database_reads,0);
 const race=output.checks.find((row:{check:string})=>row.check==='RP1:two_independent_processes_same_operation');assert.equal(race.simulated_submits,1);assert.equal(race.rejected_process_submits,0);assert.equal(new Set(race.worker_pids).size,2);
});
