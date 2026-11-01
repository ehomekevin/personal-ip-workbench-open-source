/** Real PNG/files, synthetic pixels/native proof; never a real AI invocation. */
import {writeFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import type {ArticleLayoutSnapshot,LayoutVisualInput} from '../../../packages/contracts/src/article-layout.ts';
import {createLayoutCheckBinding,digest} from '../../../packages/domain/src/article-layout/index.ts';
import {newLayoutCheckExecution,layoutRenderSnapshotHash,layoutBlockStructureHash,WECHAT_LAYOUT_STANDARD} from '../../../packages/adapters/src/media/layout-check/index.ts';
import type {LayoutCheckExecution} from '../../../packages/adapters/src/media/layout-check/types.ts';

function chunk(type:string,data:Buffer):Buffer{
 const body=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),sum=Buffer.alloc(4);let crc=0xffffffff;
 for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}
 size.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,body,sum]);
}
function png(width:number,height:number):Buffer{
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const stride=width*3+1,raw=Buffer.alloc(stride*height,240);for(let row=0;row<height;row++)raw[row*stride]=0;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function fixtureLayoutExecution(snapshot:ArticleLayoutSnapshot,directory:string,job='fixture-job',attempt='fixture-attempt'):LayoutCheckExecution{
 const work=realpathSync(directory),height=Math.max(100,snapshot.blocks.length*70+20),bytes=png(390,height),path=join(work,'check-render-'+attempt+'.png');writeFileSync(path,bytes);
 const blocks=snapshot.blocks.map((block,index)=>({id:block.id,kind:block.kind,
  ...('text' in block?{text:block.text}:{}),...('image' in block?{image:{sha256:block.image.sha256,adopted_version:block.image.version_id,decoded_width:block.image.pixel_width,decoded_height:block.image.pixel_height,display_width:358}}:{}),
  computed_style:{font_size:15,line_height:27},bounds:{x:16,y:10+index*70,width:358,height:50}}));
 const slices=[{path,sha256:createHash('sha256').update(bytes).digest('hex'),width:390,height,offset_y:0,block_ids:blocks.map(block=>block.id)}];
 const input:LayoutVisualInput={work_directory:work,render_pngs:slices,blocks,
  standard_png:{path:resolve(import.meta.dirname,'../visual/fixtures/original-standard.png'),sha256:WECHAT_LAYOUT_STANDARD.png_sha256},
  standard_html:{path:resolve(import.meta.dirname,'../visual/fixtures/original-standard.html'),sha256:WECHAT_LAYOUT_STANDARD.html_sha256},
  binding:createLayoutCheckBinding(snapshot,{snapshot_sha256:layoutRenderSnapshotHash(slices),block_structure_sha256:layoutBlockStructureHash(blocks)})};
 return newLayoutCheckExecution(input,{id:'check-'+job,job_id:job,attempt_id:attempt},true);
}
export function completeFixtureLayoutExecution(intent:LayoutCheckExecution):LayoutCheckExecution{
 const done=structuredClone(intent);done.submit_count=1;done.attempt.state='completed';done.attempt.native={provider:'fixture',thread_id:'fixture-thread',turn_id:'fixture-turn'};
 done.attempt.result={binding:done.attempt.binding,verdict:'passed',issues:[],uncertainties:[]};done.proof.original_input_verified=true;done.proof.output_sha256=digest(done.attempt.result);return done;
}
