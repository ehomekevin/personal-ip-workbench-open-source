#!/usr/bin/env node
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const args=process.argv.slice(2),send=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(args.includes('--version')){process.stdout.write('2.1.283 (Claude Code)\n');process.exit(0);}
if(args[0]==='auth'){send({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'fixture'});process.exit(0);}
const value=args[args.indexOf('-p')+1],input=JSON.parse(value.slice(value.indexOf('{'))),control=JSON.parse(input.task_instruction),frozen=input.input_manifest.frozen;
const session=args.includes('--resume')?args[args.indexOf('--resume')+1]:randomUUID(),message=randomUUID();
writeFileSync(join(control.root,control.label+'.started'),JSON.stringify({at:Date.now(),pid:process.pid,thread:session,turn:message,executor:'claude'}));
send({type:'system',subtype:'init',session_id:session,tools:[]});send({type:'assistant',session_id:session,message:{id:message,usage:{input_tokens:1,output_tokens:1}}});
const timer=setInterval(()=>{if(!existsSync(join(control.root,control.label+'.release')))return;clearInterval(timer);send({type:'result',subtype:control.mode==='quota'?'error_during_execution':'success',is_error:control.mode==='quota',errors:control.mode==='quota'?['quota exceeded fixture']:[],uuid:randomUUID(),session_id:session,structured_output:{documents:frozen.targets.map(target=>({document_id:target.document_id,text:'候选 '+control.label})),recommendations:[]}});process.exit(0);},10);
