import childProcess from 'node:child_process';
import sqlite from 'node:sqlite';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {appendFileSync,realpathSync,existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const project=resolve(fileURLToPath(new URL('../../',import.meta.url))),base=join(project,'runtime/platform-layout-integration-r1/replay'),own=resolve(process.env.PLATFORM_LAYOUT_REPLAY_RUNTIME??base);
if(relative(base,own).startsWith('..')||isAbsolute(relative(base,own)))throw new Error('Replay guard runtime outside assigned namespace');
const temp=join(own,'tmp'),dbPath=join(own,'work/cold/workbench.sqlite'),chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if(process.env.TMPDIR!==temp)throw new Error('Replay guard requires own TMPDIR before startup');
if(realpathSync(own)!==own||realpathSync(temp)!==temp)throw new Error('Replay roots must be canonical');
const inside=(root,path)=>{const rel=relative(root,path);return !rel.startsWith('..')&&!isAbsolute(rel);};
const log=value=>appendFileSync(join(own,'guard-trace.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,...value})+'\n',{mode:0o600});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalSpawn=childProcess.spawn,originalExec=childProcess.execFileSync,OriginalDB=sqlite.DatabaseSync;
childProcess.spawn=function(command,args,options){
 const profile=args?.find(arg=>arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
 if(command!==chrome||!profile||!inside(temp,realpathSync(profile))||!args.includes('--remote-debugging-pipe')){log({action:'blocked_spawn',command:String(command)});throw new Error('Replay guard permits only own default ChromePipe');}
 const child=originalSpawn.call(this,command,args,options);log({action:'default_ChromePipe_spawn',child_pid:child.pid??null,profile,command,args});return child;
};
childProcess.execFileSync=function(command,args,...options){
 if(!['ps','lsof'].includes(String(command))){log({action:'blocked_exec',command:String(command)});throw new Error('Replay guard blocks native/provider executable');}
 return originalExec.call(this,command,args,...options);
};
sqlite.DatabaseSync=class ReplayOwnedDatabase extends OriginalDB {
 constructor(path,options){
  if(String(path)!==dbPath||realpathSync(String(path))!==dbPath||!inside(own,dbPath)){log({action:'blocked_SQL',path:String(path)});throw new Error('Replay SQL must use only the complete own working cold copy');}
  const family=['','-wal','-shm','-journal'].map(suffix=>{const file=dbPath+suffix;return {path:file,present:existsSync(file),sha256:existsSync(file)?hash(readFileSync(file)):null};});
  super(path,options??{});log({action:'own_SQL_open',path:String(path),family});
  const close=this.close.bind(this);this.close=()=>{const result=close();log({action:'own_SQL_close',path:String(path)});return result;};
 }
};
syncBuiltinESMExports();
