import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {mkdirSync,appendFileSync} from 'node:fs';
const project=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const own=join(project,'runtime/platform-layout-integration-r1/native/guard');mkdirSync(own,{recursive:true});
const fixture=join(project,'tests/platform-original-recovery/native-fixture.mjs');
const log=value=>appendFileSync(join(own,'trace.jsonl'),JSON.stringify({pid:process.pid,...value})+'\n',{mode:0o600});
const execFileSync=childProcess.execFileSync,spawn=childProcess.spawn;
childProcess.execFileSync=function(command,args,...options){
 if(command==='python3'&&Array.isArray(args)&&args[0]==='-c'&&typeof args[1]==='string'&&args[1].includes('mcp_names')&&args.length===3){
  log({action:'redirect_config_probe',target:join(own,'absent.toml')});return execFileSync.call(this,command,[args[0],args[1],join(own,'absent.toml')],...options);
 }
 if(command===fixture){log({action:'controlled_cli_exec',mode:args?.includes('--version')?'version':'schema'});return execFileSync.call(this,command,args,...options);}
 throw new Error('Native integration guard blocked unexpected executable: '+String(command));
};
childProcess.spawn=function(command,...args){
 if(command!==fixture)throw new Error('Native integration guard blocked unexpected spawn: '+String(command));
 const child=spawn.call(this,command,...args);log({action:'controlled_stdio_spawn',child_pid:child.pid??null});return child;
};
syncBuiltinESMExports();
