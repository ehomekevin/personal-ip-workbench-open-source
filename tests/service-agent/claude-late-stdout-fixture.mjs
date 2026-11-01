#!/usr/bin/env node
// 父进程立即退出，stdout 由孙进程稍后写完：复现 'exit' 早于 stdout 读完的时序。
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version') || args[0] === 'auth') await import('./fake-claude.mjs');
else {
  const session = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : crypto.randomUUID();
  const script = `const send=v=>process.stdout.write(JSON.stringify(v)+'\\n'),s=${JSON.stringify(session)};setTimeout(()=>{send({type:'system',subtype:'init',session_id:s,tools:[]});send({type:'assistant',session_id:s,message:{id:crypto.randomUUID(),usage:{input_tokens:1,output_tokens:1}}});send({type:'result',subtype:'success',is_error:false,uuid:crypto.randomUUID(),session_id:s,structured_output:{answer:'42'},usage:{input_tokens:1,output_tokens:1},modelUsage:{}});},300);`;
  spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
  process.exit(0);
}
