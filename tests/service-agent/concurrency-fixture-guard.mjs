#!/usr/bin/env node
// 收到 go 后反复领取直到成功，持有 400ms 后释放，回报槽位与时间区间。
import { acquire } from '../../packages/adapters/src/agent/codex/primitives.ts';
const config=JSON.parse(process.argv[2]);
process.on('message',message=>{
 if(message==='exit'){process.exit(0);}
 if(message!=='go')return;
 const attempt=()=>{let slot;try{slot=acquire(config.root,config.workspace,'codex',{pool:config.pool,task_id:config.label+'-'+Date.now(),resources:[]});}catch{setTimeout(attempt,2);return;}
  const start=Date.now();setTimeout(()=>{const end=Date.now();slot();process.send({slot:slot.id,start,end,pid:process.pid});},config.hold);};
 attempt();
});
process.send({ready:true});
