import { homedir } from 'node:os';
import { join,extname } from 'node:path';
import {spawn} from 'node:child_process';
import { readFileSync,realpathSync,existsSync,lstatSync,writeFileSync,mkdirSync } from 'node:fs';
import { digest,freezeVoiceProfile } from '@workbench/adapters/media/h3';
let stage='请求参数';let input='';for await(const chunk of process.stdin)input+=chunk;
try{
  const {endpoint,reference_path,reference_filename,staging,cache}=JSON.parse(input);
  stage='本机 H3 Skill';const root=[join(homedir(),'.agents/skills/h3-voice-production'),join(homedir(),'.codex/skills/h3-voice-production')].find(path=>existsSync(join(path,'SKILL.md')));
  if(!root)throw new Error();const skillRoot=realpathSync(root);stage='本人参考文件';const source=realpathSync(reference_path),info=lstatSync(source);
  if(!info.isFile()||info.size<1||info.size>32*1024*1024||!reference_filename||/[\\/:\x00-\x1f]/.test(reference_filename))throw new Error();
  stage='参考音频格式';const bytes=readFileSync(source);const probe=await new Promise<{streams:Array<{codec_type:string}>}>((resolve,reject)=>{const child=spawn('ffprobe',['-v','error','-show_streams','-of','json',source],{stdio:['ignore','pipe','ignore']});let output='';const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('音频检查超时'));},3000);child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>1024*1024){child.kill('SIGKILL');reject(new Error('音频检查结果过大'));}});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('close',code=>{clearTimeout(timeout);try{if(code!==0)throw new Error('音频检查失败');resolve(JSON.parse(output));}catch(error){reject(error);}});});if(!probe.streams.some((s:{codec_type:string})=>s.codec_type==='audio'))throw new Error();
  stage='本机参考缓存';const hash=digest(bytes);mkdirSync(cache,{recursive:true,mode:0o700});const reference=join(cache,hash+(extname(source)||'.wav'));
  if(!existsSync(reference))writeFileSync(reference,bytes,{flag:'wx',mode:0o600});
  stage='Skill 与模板文件';const skill=join(skillRoot,'SKILL.md'),manual=join(skillRoot,'references/production.md'),template=join(skillRoot,'assets/approved-d-api.json');
  const profile={id:'xiaoliu-h3-reference/1',endpoint,reference_filename,reference_path:reference,source_reference_path:source,reference_sha256:hash,skill_path:skill,skill_sha256:digest(readFileSync(skill)),manual_path:manual,manual_sha256:digest(readFileSync(manual)),template_path:template,template_sha256:digest(readFileSync(template))};
  stage='声音模板校验';writeFileSync(staging,JSON.stringify(profile,null,2)+'\n',{flag:'wx',mode:0o600});freezeVoiceProfile(staging);process.stdout.write(JSON.stringify({valid:true}));
}catch(error){const e=error as {code?:string;status?:number};const code=['ENOENT','EACCES','ETIMEDOUT'].includes(e.code??'')?e.code:typeof e.status==='number'?'tool_exit_'+e.status:'unverified';process.stdout.write(JSON.stringify({error:'声音配置未保存：'+stage+'检查未通过（'+code+'），请核对后重试'}));}
