import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertExternalVolume} from '../probes/runtime/mount-guard.ts';
const project=resolve(fileURLToPath(new URL('../../',import.meta.url)));
if(process.platform==='darwin')assertExternalVolume(project);
const startedAt=new Date().toISOString();
const result=spawnSync(process.platform==='win32'?'pnpm.cmd':'pnpm',['exec','playwright','test','--config','tests/e2e/operations-flow/playwright.config.ts'],{cwd:project,stdio:'inherit',env:process.env});
const report=resolve(project,'.ci-artifacts/flow-motion-e2e');mkdirSync(report,{recursive:true});let stats:unknown;
try{stats=JSON.parse(readFileSync(resolve(report,'results.json'),'utf8')).stats;}catch{}
writeFileSync(resolve(report,'receipt.json'),JSON.stringify({result:result.status===0?'passed':'failed',startedAt,finishedAt:new Date().toISOString(),stats,scope:'isolated shared Workbench with fake client',serviceCalls:false,providerCalls:false,liveWrites:false},null,2));
if(result.error)throw result.error;process.exitCode=result.status??1;
