#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
const args=process.argv.slice(2);
if(args.includes('--version')||args[0]==='auth'){await import('./fake-claude.mjs');}
else{const session=args.includes('--resume')?args[args.indexOf('--resume')+1]:randomUUID();process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:session,tools:[]})+'\n');setInterval(()=>{},1000);}
