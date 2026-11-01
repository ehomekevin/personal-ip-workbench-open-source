// 纯 Node 生成最小合法 PNG（IHDR + IDAT + IEND），不依赖 ffmpeg 等本机工具；用于各平台一致的测试图片。
import {deflateSync} from 'node:zlib';
import {writeFileSync} from 'node:fs';
const table=new Uint32Array(256).map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes:Uint8Array){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&0xff]!^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(type:string,data:Buffer){const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'ascii'),data]),crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);}
/** 纯色 RGB PNG；默认海军蓝（与原 ffmpeg lavfi color=c=navy 一致）。 */
export function solidPng(width:number,height:number,rgb:readonly [number,number,number]=[0,0,128]):Buffer {
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw new RangeError('PNG size must be positive integers');
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
 const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++){row[1+x*3]=rgb[0];row[2+x*3]=rgb[1];row[3+x*3]=rgb[2];}
 const raw=Buffer.alloc(row.length*height);for(let y=0;y<height;y++)row.copy(raw,y*row.length);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function writeSolidPng(path:string,width:number,height:number,rgb?:readonly [number,number,number]):void {writeFileSync(path,solidPng(width,height,rgb));}
/** 逐像素 RGB PNG（测试用的有纹理画面，例如模拟渠道的中间图与终图）。 */
export function pixelPng(width:number,height:number,color:(x:number,y:number)=>readonly [number,number,number]):Buffer {
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw new RangeError('PNG size must be positive integers');
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 const stride=1+width*3,raw=Buffer.alloc(stride*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const [r,g,b]=color(x,y),i=y*stride+1+x*3;raw[i]=r;raw[i+1]=g;raw[i+2]=b;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
