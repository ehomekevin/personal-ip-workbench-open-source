import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { claimNextJob } from '../../packages/storage/src/jobs/index.ts';
const scenario=JSON.parse(readFileSync(process.argv[2],'utf8')),db=new DatabaseSync(scenario.database,{timeout:5000});db.exec('PRAGMA foreign_keys=ON');
const timer=setInterval(()=>{if(!existsSync(scenario.gate))return;clearInterval(timer);const claim=claimNextJob(db,scenario.workspace,scenario.label,[{kind:'document_modify',execution_mode:'service_adapter',recovery:'read_only'}],Date.now());writeFileSync(scenario.output,JSON.stringify(claim?{id:claim.job.id,resources:JSON.parse(claim.job.input_manifest).targets,attempt:claim.attempt.id}:null));db.close();},5);
