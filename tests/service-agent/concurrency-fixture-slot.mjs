#!/usr/bin/env node
import { acquire } from '../../packages/adapters/src/agent/codex/primitives.ts';
const config=JSON.parse(process.argv[2]);let slot;
const timer=setInterval(()=>{if(slot)return;try{slot=acquire(config.root,config.workspace,config.executor,{capacity:config.legacy?1:5,task_id:config.label,resources:[]});process.send?.({label:config.label,pid:process.pid,state:'acquired'});}catch{}},5);
process.on('message',message=>{if(message==='release'){clearInterval(timer);slot?.();process.exit(0);}});
