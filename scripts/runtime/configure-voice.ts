import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { readFileSync,realpathSync,existsSync,mkdirSync,writeFileSync } from 'node:fs';
import { digest,freezeVoiceProfile,type VoiceProfile } from '../../packages/adapters/src/media/h3/voice.ts';

// 只整理现有本机输入，不上传参考，也不提交远端任务。
const option=(key:string)=>{const index=process.argv.indexOf('--'+key);return index===-1?undefined:process.argv[index+1];};
const endpoint=option('endpoint'),reference=option('reference'),filename=option('filename'),out=option('out');
if(!endpoint||!reference||!filename||!out)throw new Error('需要 --endpoint、--reference、--filename 和 --out');
const skillRoot=[join(homedir(),'.agents/skills/h3-voice-production'),join(homedir(),'.codex/skills/h3-voice-production')].find(path=>existsSync(join(path,'SKILL.md')));
if(!skillRoot)throw new Error('本地 h3-voice-production 未安装');
const root=realpathSync(skillRoot),path=realpathSync(reference),skill=join(root,'SKILL.md'),manual=join(root,'references/production.md'),template=join(root,'assets/approved-d-api.json');
const profile:VoiceProfile={id:'xiaoliu-h3-d-reference/1',endpoint,reference_filename:filename,reference_path:path,reference_sha256:digest(readFileSync(path)),skill_path:skill,skill_sha256:digest(readFileSync(skill)),manual_path:manual,manual_sha256:digest(readFileSync(manual)),template_path:template,template_sha256:digest(readFileSync(template))};
mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(resolve(out),JSON.stringify(profile,null,2)+'\n',{flag:'wx',mode:0o600});freezeVoiceProfile(resolve(out));
console.log(JSON.stringify({profile:resolve(out),skill_name:'h3-voice-production',reference_sha256:profile.reference_sha256,remote_calls:0}));
