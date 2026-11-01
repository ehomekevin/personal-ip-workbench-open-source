import {existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {writeSolidPng} from './png.ts';
import {LOCAL_TOOLS,runTool} from '../../packages/adapters/src/media/render/tools.ts';

/** Local synthetic inputs; no captured media, fonts, brand assets, or provider calls. */
export async function syntheticMediaInputs(root:string,video=false):Promise<string>{
 const directory=join(root,'synthetic-media-inputs');mkdirSync(directory,{recursive:true});
 const first=join(directory,'illustration-1.png'),second=join(directory,'illustration-2.png');
 if(!existsSync(first))writeSolidPng(first,640,480,[32,80,160]);
 if(!existsSync(second))writeSolidPng(second,640,480,[160,80,32]);
 const clip=join(directory,'fixture-clip-1.mp4');
 if(video&&!existsSync(clip))await runTool(LOCAL_TOOLS.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=25','-t','5','-an','-c:v','libx264','-pix_fmt','yuv420p','-y',clip]);
 return directory;
}
