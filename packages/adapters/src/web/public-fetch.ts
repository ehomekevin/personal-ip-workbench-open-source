import {BlockList,isIP} from 'node:net';
import {promises as dns} from 'node:dns';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {ContractError} from '@workbench/contracts';
// 网络找图共用的公网 URL 守卫：仅 https、解析后拒绝私网/环回/链路本地/保留地址、逐跳校验重定向、限时限大小、图片校验 MIME 与魔数。
export type AddressLookup=(hostname:string)=>Promise<Array<{address:string;family:number}>>;
export interface PublicFetchOptions {fetcher:typeof fetch;lookup:AddressLookup;dns?:WebDnsGuard;timeout_ms?:number;max_bytes?:number;max_redirects?:number;signal?:AbortSignal}
export interface PublicFetchResult {url:string;mime:string;bytes:Buffer;truncated:boolean}
export const WEB_IMAGE_MIMES=['image/jpeg','image/png','image/webp','image/gif'] as const;
export const WEB_IMAGE_MAX_BYTES=15*1024*1024,WEB_PAGE_MAX_BYTES=2*1024*1024,WEB_MAX_REDIRECTS=3;
const USER_AGENT='Mozilla/5.0 (compatible; PersonalIPWorkbench/1.0)';
const blocked=new BlockList();
for(const [net,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(net,prefix,'ipv4');
// 2002::/16（6to4）、::ffff:0:0/96 映射、::ffff:0:0:0/96 转换、64:ff9b::/96 NAT64 与兼容地址不在此表：按内嵌 IPv4 判定。
for(const [net,prefix] of [['::',127],['64:ff9b:1::',48],['100::',64],['2001::',23],['2001::',32],['2001:db8::',32],['5f00::',16],['fc00::',7],['fe80::',10],['fec0::',10],['ff00::',8]] as const)blocked.addSubnet(net,prefix,'ipv6');
const fail=(message:string,details:Record<string,unknown>={}):never=>{throw new ContractError('VALIDATION_ERROR',message,{web_guard:true,...details});};
function v6Groups(ip:string):number[]|null{
 let s=ip.toLowerCase().split('%')[0]!;const dotted=/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
 if(dotted){const v=dotted.slice(1).map(Number);if(v.some(n=>n>255))return null;s=s.slice(0,-dotted[0].length)+((v[0]!<<8)|v[1]!).toString(16)+':'+((v[2]!<<8)|v[3]!).toString(16);}
 const parts=s.split('::');if(parts.length>2)return null;const head=parts[0]?parts[0].split(':'):[],tail=parts.length===2&&parts[1]?parts[1].split(':'):[];
 const groups=parts.length===2?[...head,...Array(Math.max(0,8-head.length-tail.length)).fill('0'),...tail]:head;if(groups.length!==8||groups.some(g=>!/^[0-9a-f]{1,4}$/.test(g)))return null;return groups.map(g=>parseInt(g,16));
}
const v4=(hi:number,lo:number)=>[hi>>8,hi&255,lo>>8,lo&255].join('.');
// IPv4 过渡/内嵌形式按内嵌 IPv4 再判一次，避免 ::ffff:127.0.0.1、2002:7f00:1::、64:ff9b::a00:1 等绕过。
export function embeddedIPv4(address:string):string|null {
 const g=v6Groups(address);if(!g)return null;const zero=(from:number,to:number)=>g.slice(from,to).every(n=>n===0);
 if(zero(0,5)&&(g[5]===0xffff||g[5]===0))return v4(g[6]!,g[7]!);                 // ::ffff:a.b.c.d 映射、::a.b.c.d 兼容
 if(zero(0,4)&&g[4]===0xffff&&g[5]===0)return v4(g[6]!,g[7]!);                     // ::ffff:0:a.b.c.d 转换（SIIT）
 if(g[0]===0x64&&g[1]===0xff9b&&zero(2,6))return v4(g[6]!,g[7]!);                  // 64:ff9b::/96 公用 NAT64
 if(g[0]===0x2002)return v4(g[1]!,g[2]!);                                           // 2002::/16 6to4
 return null;
}
export function isPublicAddress(address:string):boolean {
 const family=isIP(address);if(family===4)return !blocked.check(address,'ipv4');if(family!==6)return false;
 const g=v6Groups(address);if(!g)return false;const inner=embeddedIPv4(address);if(inner)return isPublicAddress(inner);
 return !blocked.check(g.map(n=>n.toString(16)).join(':'),'ipv6');
}
export function assertPublicHttpsUrl(raw:string):URL {
 let url:URL;try{url=new URL(raw);}catch{return fail('来源地址无效');}
 if(url.protocol!=='https:')fail('只接受 https 来源地址');if(url.username||url.password)fail('来源地址不能带账号信息');if(url.port&&url.port!=='443')fail('来源地址端口不受支持');
 const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal'))fail('来源地址指向本机或内网');
 if(isIP(host)&&!isPublicAddress(host))fail('来源地址指向内网或保留地址');return url;
}
export async function assertPublicHost(url:URL,lookup:AddressLookup,dns?:WebDnsGuard):Promise<void>{
 const host=url.hostname.replace(/^\[|\]$/g,'');if(isIP(host))return;let addresses:Array<{address:string}>;
 try{addresses=await lookup(host);}catch{return fail('来源域名无法解析');}
 if(!addresses.length)fail('来源域名无法解析');
 // 系统 DNS 答复中只要含 fake-IP 段地址，系统解析结果即不可信：改用 DoH 取真实记录，再对真实地址跑同一套私网/保留校验；
 // 混合答复中的非 fake 地址仍须是公网（连接阶段可能 pin 到它们）。
 if(dns&&dns.hasFakeIp(addresses)){dns.mode='fake_ip_doh';if(addresses.some(a=>!dns.isFakeIp(a.address)&&!isPublicAddress(a.address)))fail('来源域名解析到内网或保留地址',{dns_mode:'fake_ip_doh'});let real:Array<{address:string}>;
  try{real=await dns.resolveReal(host);}catch{return fail(FAKE_IP_UNRESOLVED,{dns_mode:'fake_ip_doh'});}
  if(!real.length)fail(FAKE_IP_UNRESOLVED,{dns_mode:'fake_ip_doh'});if(real.some(a=>!isPublicAddress(a.address)))fail('来源域名解析到内网或保留地址',{dns_mode:'fake_ip_doh'});
  dns.markVerified(host);return;}
 if(dns)dns.mode='system';if(addresses.some(a=>!isPublicAddress(a.address)))fail('来源域名解析到内网或保留地址');
}
// —— 代理 fake-IP 环境（Clash/FlClash TUN + fake-ip）——
// 系统 DNS 对所有域名返回 198.18.0.0/15 等假地址，真实解析在代理远端完成。守卫用 DoH（经系统网络、按域名连接）取真实 A/AAAA 校验，
// 连接时不 pin 真实 IP（大陆直连多半不通），而是连到系统给的 fake-IP 交给 TUN；仅限刚经 DoH 校验过的域名。
export const FAKE_IP_UNRESOLVED='本机 DNS 处于代理 fake-IP 模式且无法二次解析，暂不能抓取';
export const DEFAULT_DOH_RESOLVERS=['https://cloudflare-dns.com/dns-query','https://dns.google/resolve'] as const;
// 默认只认 RFC 2544 基准段；28.0.0.0/8 等自定义段须经 web_fetch.fake_ip_ranges 显式配置。
export const DEFAULT_FAKE_IP_RANGES=['198.18.0.0/15'] as const;
export const DOH_MAX_BYTES=64*1024;
export const DOH_TIMEOUT_MS=3000;
const VERIFIED_TTL_MS=60_000;
export type DnsMode='system'|'fake_ip_doh';
export interface WebDnsGuardOptions {doh_resolvers?:readonly string[];fake_ip_ranges?:readonly string[];doh_fetch?:typeof fetch;doh?:AddressLookup;timeout_ms?:number;now?:()=>number}
export function parseCidr(range:string):{net:string;prefix:number;family:'ipv4'|'ipv6'}|null {
 const m=/^([^/]+)\/(\d{1,3})$/.exec(range.trim());if(!m)return null;const family=isIP(m[1]!),prefix=Number(m[2]);
 if(family===4&&prefix<=32)return{net:m[1]!,prefix,family:'ipv4'};if(family===6&&prefix<=128)return{net:m[1]!,prefix,family:'ipv6'};return null;
}
export const normalizeHost=(host:string)=>host.toLowerCase().replace(/\.+$/,'');
type DohRecord={name?:unknown;type?:unknown;data?:unknown};
interface DohAnswer {Status?:unknown;TC?:unknown;Answer?:unknown;Authority?:unknown}
async function readDohJson(response:Response,signal:AbortSignal):Promise<DohAnswer>{
 const reader=response.body?.getReader();if(!reader)throw new Error('doh empty body');const chunks:Buffer[]=[];let size=0;
 try{while(true){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>DOH_MAX_BYTES)throw new Error('doh response too large');chunks.push(Buffer.from(next.value));}}
 finally{await reader.cancel().catch(()=>{});}
 const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('doh malformed');return body as DohAnswer;
}
// 单族答复校验：Status 必须为 0、不得截断、记录格式完整；沿 CNAME 链取终点名的 A/AAAA。
// 终点无该族记录时，只有 Authority 带 SOA 的明确 NODATA 才算有效（返回空）；仅有 CNAME 而无 SOA、畸形记录、截断一律视为该家失败。
export function parseDohAnswer(host:string,type:'A'|'AAAA',body:DohAnswer):Array<{address:string;family:number}>{
 if(body.Status!==0)throw new Error('doh status '+String(body.Status));if(body.TC===true)throw new Error('doh truncated');
 const list=(v:unknown,label:string):DohRecord[]=>{if(v===undefined)return[];if(!Array.isArray(v)||v.some(r=>!r||typeof r!=='object'))throw new Error('doh malformed '+label);return v as DohRecord[];};
 const answers=list(body.Answer,'answer'),authority=list(body.Authority,'authority'),want=type==='A'?1:28,family=type==='A'?4:6,cnames=new Map<string,string>(),found:Array<{name:string;address:string}>=[];
 for(const r of answers){if(typeof r.type!=='number'||typeof r.name!=='string'||typeof r.data!=='string')throw new Error('doh malformed record');const name=normalizeHost(r.name);
  if(r.type===5){if(!r.data.trim())throw new Error('doh malformed cname');cnames.set(name,normalizeHost(r.data.trim()));}
  else if(r.type===want){if(isIP(r.data)!==family)throw new Error('doh malformed address');found.push({name,address:r.data});}}
 let terminal=normalizeHost(host);for(let i=0;cnames.has(terminal);i++){if(i>16)throw new Error('doh cname loop');terminal=cnames.get(terminal)!;}
 const out=found.filter(r=>r.name===terminal).map(r=>({address:r.address,family}));if(out.length)return out;
 if(authority.some(r=>r.type===6))return[];throw new Error('doh no terminal record');
}
async function dohQuery(resolver:string,host:string,type:'A'|'AAAA',fetcher:typeof fetch,signal:AbortSignal):Promise<Array<{address:string;family:number}>>{
 const url=new URL(resolver);url.searchParams.set('name',normalizeHost(host));url.searchParams.set('type',type);
 const response=await fetcher(url.href,{method:'GET',headers:{accept:'application/dns-json'},signal});if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error('doh http '+response.status);}
 return parseDohAnswer(host,type,await readDohJson(response,signal));
}
// 单家 DoH：A 与 AAAA 都必须拿到有效答复（终点记录或明确 NODATA），任何一条失败即视为该家失败，避免漏检私网 AAAA；两族都为空也算该家失败。
export async function dohResolve(host:string,resolvers:readonly string[]=DEFAULT_DOH_RESOLVERS,fetcher:typeof fetch=fetch,timeout_ms=DOH_TIMEOUT_MS):Promise<Array<{address:string;family:number}>>{
 if(!resolvers.length)throw new Error('no doh resolver');const winner=new AbortController();
 try{return await Promise.any(resolvers.map(async resolver=>{const signal=AbortSignal.any([AbortSignal.timeout(timeout_ms),winner.signal]);const [a,aaaa]=await Promise.all([dohQuery(resolver,host,'A',fetcher,signal),dohQuery(resolver,host,'AAAA',fetcher,signal)]);if(!a.length&&!aaaa.length)throw new Error('doh no address');return[...a,...aaaa];}));}
 finally{winner.abort();}
}
export class WebDnsGuard {
 mode:DnsMode|null=null;readonly resolvers:readonly string[];readonly ranges:readonly string[];private readonly fake=new BlockList();private readonly verified=new Map<string,number>();private readonly options:WebDnsGuardOptions;
 constructor(options:WebDnsGuardOptions={}){this.options=options;this.resolvers=options.doh_resolvers?.length?options.doh_resolvers:DEFAULT_DOH_RESOLVERS;this.ranges=options.fake_ip_ranges?.length?options.fake_ip_ranges:DEFAULT_FAKE_IP_RANGES;
  for(const range of this.ranges){const cidr=parseCidr(range);if(!cidr)throw new Error('invalid fake_ip range '+range);this.fake.addSubnet(cidr.net,cidr.prefix,cidr.family);}}
 private now(){return this.options.now?.()??Date.now();}
 isFakeIp(address:string):boolean{const family=isIP(address);if(family===4)return this.fake.check(address,'ipv4');if(family===6){const inner=embeddedIPv4(address);return inner?this.fake.check(inner,'ipv4'):this.fake.check(address,'ipv6');}return false;}
 isFakeIpSet(addresses:ReadonlyArray<{address:string}>):boolean{return addresses.length>0&&addresses.every(a=>this.isFakeIp(a.address));}
 hasFakeIp(addresses:ReadonlyArray<{address:string}>):boolean{return addresses.some(a=>this.isFakeIp(a.address));}
 resolveReal(host:string){return this.options.doh?this.options.doh(host):dohResolve(host,this.resolvers,this.options.doh_fetch??fetch,this.options.timeout_ms??DOH_TIMEOUT_MS);}
 markVerified(host:string){this.verified.set(normalizeHost(host),this.now()+VERIFIED_TTL_MS);if(this.verified.size>256)for(const [h,until] of this.verified)if(until<=this.now())this.verified.delete(h);}
 isVerified(host:string){const until=this.verified.get(normalizeHost(host));return until!==undefined&&until>this.now();}
}
export function sniffImageMime(bytes:Uint8Array):string|null {
 const b=bytes,at=(i:number)=>b[i]??-1,ascii=(from:number,text:string)=>[...text].every((c,i)=>at(from+i)===c.charCodeAt(0));
 if(at(0)===0xff&&at(1)===0xd8&&at(2)===0xff)return 'image/jpeg';if([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((v,i)=>at(i)===v))return 'image/png';
 if(ascii(0,'GIF87a')||ascii(0,'GIF89a'))return 'image/gif';if(ascii(0,'RIFF')&&ascii(8,'WEBP'))return 'image/webp';return null;
}
async function readBody(response:Response,max:number,truncate:boolean,signal:AbortSignal):Promise<{bytes:Buffer;truncated:boolean}>{
 const reader=response.body?.getReader();if(!reader)return{bytes:Buffer.alloc(0),truncated:false};const chunks:Buffer[]=[];let size=0,truncated=false;
 try{while(true){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>max){if(!truncate)fail('来源文件超过大小上限',{max_bytes:max});chunks.push(Buffer.from(next.value.subarray(0,next.value.byteLength-(size-max))));truncated=true;break;}chunks.push(Buffer.from(next.value));}}
 finally{await reader.cancel().catch(()=>{});}
 return{bytes:Buffer.concat(chunks),truncated};
}
export async function guardedFetch(raw:string,kind:'image'|'html',options:PublicFetchOptions):Promise<PublicFetchResult>{
 const max=options.max_bytes??(kind==='image'?WEB_IMAGE_MAX_BYTES:WEB_PAGE_MAX_BYTES),redirects=options.max_redirects??WEB_MAX_REDIRECTS,deadline=AbortSignal.timeout(options.timeout_ms??(kind==='image'?20000:8000)),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
 let url=assertPublicHttpsUrl(raw);
 for(let hop=0;;hop++){
  await assertPublicHost(url,options.lookup,options.dns);let response:Response;
  try{response=await options.fetcher(url.href,{method:'GET',redirect:'manual',signal,headers:{accept:kind==='image'?'image/webp,image/png,image/jpeg,image/gif;q=0.9':'text/html,application/xhtml+xml;q=0.9','user-agent':USER_AGENT}});}
  catch(error){if(error instanceof ContractError)throw error;return fail(signal.aborted?'来源读取超时':'来源暂时无法读取');}
  if(response.status>=300&&response.status<400){await response.body?.cancel().catch(()=>{});const location=response.headers.get('location');if(!location)fail('来源重定向缺少目标');if(hop>=redirects)fail('来源重定向次数过多');url=assertPublicHttpsUrl(new URL(location!,url).href);continue;}
  if(!response.ok){await response.body?.cancel().catch(()=>{});fail(kind==='image'?'来源页面已打不开，未取得图片':'原文页面已打不开',{http_status:response.status});}
  const declared=Number(response.headers.get('content-length')),mime=(response.headers.get('content-type')??'').split(';')[0]!.trim().toLowerCase();
  if(kind==='image'){if(!(WEB_IMAGE_MIMES as readonly string[]).includes(mime)){await response.body?.cancel().catch(()=>{});fail('来源不是 JPEG/PNG/WebP/GIF 图片',{mime});}if(Number.isFinite(declared)&&declared>max){await response.body?.cancel().catch(()=>{});fail('来源文件超过大小上限',{max_bytes:max});}}
  else if(!['text/html','application/xhtml+xml'].includes(mime)){await response.body?.cancel().catch(()=>{});fail('原文不是网页',{mime});}
  let body:{bytes:Buffer;truncated:boolean};try{body=await readBody(response,max,kind==='html',signal);}catch(error){if(error instanceof ContractError)throw error;return fail(signal.aborted?'来源读取超时':'来源读取中断');}
  if(kind==='image'){if(!body.bytes.length)fail('来源图片为空');const sniffed=sniffImageMime(body.bytes);if(sniffed!==mime)fail('图片内容与声明格式不符',{mime,sniffed});}
  return{url:url.href,mime,...body};
 }
}
// 连接阶段地址选择：全为 fake-IP 且该域名刚经 DoH 校验 → 连 fake-IP 交给 TUN；混合答复 → 丢弃 fake 地址（不直连），其余须全为公网后 pin；否则拒绝（null）。
export function connectAddresses<T extends {address:string}>(hostname:string,resolved:T[],guard?:WebDnsGuard):T[]|null {
 if(!resolved.length)return null;if(guard&&guard.isFakeIpSet(resolved))return guard.isVerified(hostname)?resolved:null;
 const addresses=guard?resolved.filter(a=>!guard.isFakeIp(a.address)):resolved;return addresses.length&&addresses.every(a=>isPublicAddress(a.address))?addresses:null;
}
// 生产传输：连接阶段再次校验解析结果，防止校验与连接之间 DNS 被改指向内网。
// fake-IP 环境：系统解析全为 fake-IP 且该域名刚经 DoH 校验通过时，连到 fake-IP（即按域名交给 TUN/代理），不 pin 真实 IP。
export function createPinnedHttpsFetch(guard?:WebDnsGuard):typeof fetch {return (input,init)=>new Promise<Response>((resolve,reject)=>{
 const url=new URL(input instanceof Request?input.url:String(input)),headers:Record<string,string>={};new Headers(init?.headers).forEach((value,key)=>{headers[key]=value;});
 const request=httpsRequest(url,{method:'GET',headers,...(init?.signal?{signal:init.signal}:{}),lookup:(hostname,options,callback)=>{dns.lookup(hostname,{all:true,verbatim:true}).then(resolved=>{const addresses=connectAddresses(hostname,resolved,guard);if(!addresses){callback(new Error('来源域名解析到内网或保留地址'),'',4);return;}if((options as {all?:boolean}).all)(callback as unknown as (e:null,a:typeof addresses)=>void)(null,addresses);else callback(null,addresses[0]!.address,addresses[0]!.family);},error=>callback(error,'',4));}},response=>{
  const status=response.statusCode??0;if(status<200||status>599){response.destroy();reject(new Error('invalid status'));return;}const out=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)out.set(key,Array.isArray(value)?value.join(', '):String(value));
  resolve(new Response([101,204,205,304].includes(status)?null:Readable.toWeb(response) as ReadableStream,{status,headers:out}));
 });request.on('error',reject);request.end();
});}
export const pinnedHttpsFetch:typeof fetch=createPinnedHttpsFetch();
export const systemLookup:AddressLookup=hostname=>dns.lookup(hostname,{all:true,verbatim:true});
const entity=(text:string)=>text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi,(m,code:string)=>{const c=code.toLowerCase();if(c.startsWith('#x'))return String.fromCodePoint(parseInt(c.slice(2),16)||32);if(c.startsWith('#'))return String.fromCodePoint(Number(c.slice(1))||32);return({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[c]??m;});
function attributes(tag:string):Record<string,string>{const out:Record<string,string>={};for(const m of tag.matchAll(/([^\s=<>"'/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g))out[m[1]!.toLowerCase()]=entity(m[3]??m[4]??m[5]??'').trim();return out;}
export interface ParsedArticle {page_title:string|null;site_name:string|null;author:string|null;images:Array<{url:string;kind:'og'|'twitter'|'inline'}>}
// 只解析 og:image、twitter:image 与正文 <img> 前 N 张；不执行脚本、不读样式。
export function parseArticleImages(html:string,base:string,limit=6):ParsedArticle {
 const meta=new Map<string,string>();for(const m of html.matchAll(/<meta\b[^>]*>/gi)){const a=attributes(m[0]),key=(a.property??a.name??'').toLowerCase();if(key&&a.content&&!meta.has(key))meta.set(key,a.content);}
 const clean=(v:string|undefined|null)=>{const t=v?entity(v).replace(/\s+/g,' ').trim():'';return t?t.slice(0,300):null;};
 const absolute=(v:string|undefined)=>{if(!v||/^data:/i.test(v))return null;try{const u=new URL(v,base);return u.protocol==='https:'&&!u.username&&!u.password&&!/\.svg(\?|$)/i.test(u.pathname)&&u.href.length<=8192?u.href:null;}catch{return null;}};
 const images:ParsedArticle['images']=[],push=(url:string|null,kind:'og'|'twitter'|'inline')=>{if(url&&!images.some(i=>i.url===url))images.push({url,kind});};
 push(absolute(meta.get('og:image:secure_url')??meta.get('og:image')??meta.get('og:image:url')),'og');push(absolute(meta.get('twitter:image')??meta.get('twitter:image:src')),'twitter');
 let inline=0;for(const m of html.matchAll(/<img\b[^>]*>/gi)){if(inline>=limit)break;const a=attributes(m[0]),w=Number(a.width),h=Number(a.height);if(w&&h&&(w<64||h<64))continue;const url=absolute(a['data-src']??a['data-original']??a.src);if(url&&!images.some(i=>i.url===url)){images.push({url,kind:'inline'});inline++;}}
 return{page_title:clean(meta.get('og:title')??meta.get('twitter:title')??/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]),site_name:clean(meta.get('og:site_name')??meta.get('application-name')),author:clean(meta.get('author')??meta.get('article:author')??meta.get('twitter:creator')),images};
}
export function decodeHtml(bytes:Buffer,contentType:string|null):string {const charset=/charset=([^;]+)/i.exec(contentType??'')?.[1]?.trim().toLowerCase()??/<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0,4096).toString('latin1'))?.[1]?.toLowerCase()??'utf-8';try{return new TextDecoder(charset).decode(bytes);}catch{return new TextDecoder('utf-8').decode(bytes);}}
