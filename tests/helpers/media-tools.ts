// 真实图像解码校验依赖 ffmpeg/ffprobe（生产在本机用 Homebrew 路径，其他环境按 PATH 查找）。
// 环境缺少这些工具时，依赖解码的用例如实标为跳过并写明原因，而不是以 ENOENT 失败。
import nodeTest,{type TestContext,type TestOptions} from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {LOCAL_TOOLS} from '../../packages/adapters/src/media/render/tools.ts';
const missing=[LOCAL_TOOLS.ffmpeg,LOCAL_TOOLS.ffprobe].filter(tool=>spawnSync(tool,['-version'],{stdio:'ignore'}).status!==0);
export const MEDIA_TOOLS_SKIP:string|false=missing.length?'需要 ffmpeg/ffprobe 做真实图像解码校验，本环境缺少：'+missing.join(', '):false;
type Fn=(context:TestContext)=>void|Promise<void>;
function mediaTest(name:string,optionsOrFn?:TestOptions|Fn,maybeFn?:Fn){
 const options:TestOptions=typeof optionsOrFn==='function'?{}:optionsOrFn??{},fn=typeof optionsOrFn==='function'?optionsOrFn:maybeFn;
 return nodeTest(name,{...options,...(MEDIA_TOOLS_SKIP?{skip:MEDIA_TOOLS_SKIP}:{})},fn);
}
export default mediaTest;

let renderSkip:string|false|undefined;
function rendererToolsSkip():string|false{
 if(renderSkip!==undefined)return renderSkip;
 const unavailable=[LOCAL_TOOLS.chrome,LOCAL_TOOLS.python].filter(tool=>spawnSync(tool,['--version'],{stdio:'ignore'}).status!==0);
 return renderSkip=MEDIA_TOOLS_SKIP||(unavailable.length?'unsupported：本机渲染测试缺少工具：'+unavailable.join(', '):false);
}
export function renderTest(name:string,optionsOrFn?:TestOptions|Fn,maybeFn?:Fn){
 const options:TestOptions=typeof optionsOrFn==='function'?{}:optionsOrFn??{},fn=typeof optionsOrFn==='function'?optionsOrFn:maybeFn,skip=rendererToolsSkip();
 return nodeTest(name,{...options,...(skip?{skip}:{})},fn);
}
export function renderVoiceTest(name:string,optionsOrFn?:TestOptions|Fn,maybeFn?:Fn){
 const options:TestOptions=typeof optionsOrFn==='function'?{}:optionsOrFn??{},fn=typeof optionsOrFn==='function'?optionsOrFn:maybeFn;
 const skip=rendererToolsSkip()||(!existsSync(LOCAL_TOOLS.say)?'unsupported：本机语音渲染测试缺少系统TTS工具':false);
 return nodeTest(name,{...options,...(skip?{skip}:{})},fn);
}
