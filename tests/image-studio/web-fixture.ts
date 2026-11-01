// 网络找图测试夹具：注入式 fetcher/lookup，不发真实请求；按主题预置资讯、X、抖音资料。
import {randomUUID} from 'node:crypto';
import type {NormalizedSourceRecord,RequestContext,Sha256,SourceLocationInput,SourceRecordPayload} from '../../packages/contracts/src/index.ts';
import type {ApplicationContext} from '../../packages/domain/src/ports/index.ts';
import {transaction} from '../../packages/storage/src/connection/index.ts';
import {ensureSource,upsertSourceRecord} from '../../packages/storage/src/sources/index.ts';
import {upsertIndex} from '../../packages/storage/src/knowledge-index/index.ts';
import {solidPng} from '../helpers/png.ts';
export const ARTICLE_URL='https://news.example/a';
export const ARTICLE_HTML='<html><head><title>原文标题 · 新闻</title><meta property="og:site_name" content="Example News"><meta property="og:image" content="/og.png"><meta name="twitter:image" content="https://news.example/tw.png"></head><body><img src="https://news.example/icon.png" width="16" height="16"><img data-src="in2.png" alt="正文图"><img src="http://news.example/plain.png"></body></html>';
export class FakeWeb {
 calls:string[]=[];hosts=new Map<string,string[]>();routes=new Map<string,()=>Response|Promise<Response>>();
 lookup=async(host:string)=>(this.hosts.get(host)??['93.184.216.34']).map(address=>({address,family:address.includes(':')?6:4}));
 fetcher=(async(input:RequestInfo|URL)=>{const url=String(input instanceof Request?input.url:input);this.calls.push(url);const route=this.routes.get(url);return route?await route():new Response('missing',{status:404,headers:{'content-type':'text/plain'}});}) as typeof fetch;
 png(url:string,width=48,height=32,rgb:[number,number,number]=[0,0,128]){const bytes=solidPng(width,height,rgb);this.routes.set(url,()=>new Response(new Uint8Array(bytes),{headers:{"content-type":"image/png","content-length":String(bytes.length)}}));return bytes;}
 html(url:string,html:string){this.routes.set(url,()=>new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}));}
 count(prefix:string){return this.calls.filter(c=>c.startsWith(prefix)).length;}
}
const location=(kind:string,url:string):SourceLocationInput=>({external_id:null,kind,relative_path:null,source_url:url,capture_time:null,sha256:'0'.repeat(64) as Sha256,parser_version:'web-image-test',availability:'available',raw_response_ref:null});
const payload=(p:Partial<SourceRecordPayload>):SourceRecordPayload=>({title:'资料',summary:'',body:null,category:'热点资讯',author_name:null,reply_author_name:null,quoted_author_name:null,external_links:[],media:[],identity_status:'pending',parser_warnings:[],provider_metadata:{},...p});
export function seedWebSources(context:ApplicationContext,request:RequestContext,topic:string,options:{link?:boolean;searchText:string;douyinMedia?:Array<Record<string,string>>}){
 const ws=request.workspace_id;return transaction(context.db,()=>{
  const site=ensureSource(context.db,ws,'personal_site','https://site.example.invalid/','creator-feed'),bench=ensureSource(context.db,ws,'tikhub_benchmark','https://x.com/alice','benchmark');
  const put=(source:string,record:NormalizedSourceRecord,kind:string)=>{const stored=upsertSourceRecord(context.db,ws,source,record,location(kind,record.canonical_url!));upsertIndex(context.db,ws,{path:'test:'+record.external_id,location_id:stored.location_id,mtime:0,size:1,sha256:'0'.repeat(64) as Sha256,parser_version:'web-image-test',payload:record.payload});return stored.record_id;};
  const article=put(site,{external_id:'event_web_'+randomUUID().slice(0,8),canonical_url:'https://site.example.invalid/events/'+randomUUID(),record_kind:'site_event',published_at:'2026-10-01T00:00:00.000Z',identity:null,payload:payload({title:'资讯：模型发布',external_links:[ARTICLE_URL,'https://x.com/someone/status/9']})},'personal_site:creator-feed');
  const x=put(bench,{external_id:'1001',canonical_url:'https://x.com/alice/status/1001',record_kind:'x_post',published_at:'2026-10-02T00:00:00.000Z',identity:null,payload:payload({title:'X 帖子',category:'对标内容',author_name:'Alice',media:[{type:'photo',url:'https://pbs.example/x1.png',preview_url:'https://pbs.example/x1.png',width:'48',height:'32'},{type:'video',url:'https://pbs.example/v.png'}],provider_metadata:{platform:'x',author_handle:'alice',x_post:{quoted_post:{id:'2002',availability:'available',author:{handle:'bob',name:'Bob'},media:[{type:'photo',url:'https://pbs.example/q1.png'}]}}}})},'tikhub_benchmark');
  const douyin=put(bench,{external_id:'3003',canonical_url:'https://www.douyin.com/video/3003',record_kind:'douyin_video',published_at:'2026-10-03T00:00:00.000Z',identity:null,payload:payload({title:'抖音作品',category:'对标内容',author_name:'抖音作者',body:options.searchText,media:options.douyinMedia??[{type:'image',url:'https://douyin.example/old.png?x-expires=1000000000'},{type:'cover',url:'https://douyin.example/cover.png?x-expires=4102444800'}],provider_metadata:{platform:'douyin'}})},'tikhub_benchmark');
  if(options.link!==false)for(const id of [article,x])context.db.prepare("INSERT INTO topic_sources(id,workspace_id,topic_id,source_record_id,usage) VALUES (?,?,?,?,'evidence')").run(randomUUID(),ws,topic,id);
  return{article,x,douyin};
 });
}
