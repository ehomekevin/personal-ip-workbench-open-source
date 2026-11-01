import type {JsonObject,SourceRecordSummary} from '@workbench/contracts';
import {createTemplateHelpers} from './templateHelpers.ts';
import {renderPlatformVideo} from './platform-video.ts';

const {esc}=createTemplateHelpers([]);
const object=(value:unknown):JsonObject=>value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{};
const string=(value:unknown):string=>typeof value==='string'?value:'';
const objects=(value:unknown):JsonObject[]=>Array.isArray(value)?value.map(object):[];
const publicUrl=(value:unknown):string|null=>{try{if(typeof value!=='string')return null;const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}};
const imageUrl=(value:unknown)=>{const url=publicUrl(value);return url?.startsWith('https:')?url:null;};
const date=(value:unknown)=>{const raw=string(value);return raw&&Number.isFinite(Date.parse(raw))?new Date(raw).toLocaleString('zh-CN'):'发布时间未提供';};
const anchor=(url:unknown,label:string,cls='x-post-link')=>{const safe=publicUrl(url);return safe?'<a class="'+cls+'" href="'+esc(safe)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+'</a>':'';};
const shortLabel=(value:string):string=>{try{const url=new URL(value);return url.hostname==='t.co'?'X 短链接 ↗':(url.hostname+decodeURI(url.pathname)).slice(0,100)+(url.search?'…':'')+' ↗';}catch{return '外部链接 ↗';}};

export function xPostPreviewText(value:unknown,links:unknown=[]):string {
 const entities=objects(links);
 return string(value).replace(/https?:\/\/t\.co\/[^\s<>。），、！；！？]+/g,token=>{const entity=entities.find(link=>link.url===token),expanded=publicUrl(entity?.expanded_url);return expanded?shortLabel(expanded):'[X 链接]';});
}

/** Links come only from the saved response. Rendering never resolves a short URL. */
export function renderXPostText(value:unknown,links:unknown=[]):string {
 const text=string(value),entities=objects(links);
 return text.split(/(https?:\/\/[^\s<>]+)/g).map(part=>{
  if(!/^https?:\/\//.test(part))return esc(part);
  const suffix=part.match(/[。），、！；！？]+$/)?.[0]??'',token=suffix?part.slice(0,-suffix.length):part;
  const entity=entities.find(link=>link.url===token),expanded=publicUrl(entity?.expanded_url)??publicUrl(token);
  return expanded?anchor(expanded,shortLabel(expanded))+esc(suffix):esc(part);
 }).join('');
}

function authorHeader(post:JsonObject,fallback:string,small=false):string {
 const author=object(post.author),name=string(author.name)||fallback||'作者未提供',handle=string(author.handle),avatar=imageUrl(author.avatar_url);
 return '<div class="x-post-author'+(small?' x-post-author-small':'')+'"><span class="x-post-avatar"><span aria-hidden="true">'+esc(Array.from(name)[0]??'?')+'</span>'+(avatar?'<img data-platform-image src="'+esc(avatar)+'" alt="'+esc(name)+'的头像" loading="lazy" decoding="async" referrerpolicy="no-referrer">':'')+'</span><span class="x-post-identity"><strong>'+esc(name)+'</strong>'+(handle?'<span class="x-post-handle">@'+esc(handle.replace(/^@/,''))+'</span>':'')+'<time'+(string(post.published_at)?' datetime="'+esc(post.published_at)+'"':'')+'>'+esc(date(post.published_at))+'</time></span><span class="x-post-platform" aria-label="X"><img src="/workbench/platforms/x.svg" alt="" width="16" height="16"></span></div>';
}

function mediaMarkup(value:unknown,canonical:unknown):string {
 const media=objects(value),images=media.filter(item=>item.type==='photo'||item.type==='image'),videos=media.filter(item=>item.type==='video'||item.type==='animated_gif');
 const imageGrid=images.length?'<div class="x-post-images" data-x-gallery data-x-original="'+esc(publicUrl(canonical)??'')+'" data-count="'+Math.min(images.length,4)+'">'+images.map((item,index)=>{
  const preview=imageUrl(item.url??item.preview_url??item.media_url_https),alt=string(item.alt_text)||'作品图片 '+(index+1);
  return '<button type="button" class="x-post-image" data-x-image aria-label="查看'+esc(alt)+'"><span class="x-image-fallback">图片暂不可读<br>可打开平台原文查看</span>'+(preview?'<img data-platform-image src="'+esc(preview)+'" alt="'+esc(alt)+'" loading="lazy" decoding="async" referrerpolicy="no-referrer">':'')+'</button>';
 }).join('')+'</div>':'';
 const videoMarkup=videos.map(item=>renderPlatformVideo(item,{platform:'x',originalUrl:canonical,className:'x-post-video'})).join('');
 return imageGrid+videoMarkup;
}

function embeddedPost(post:JsonObject,relation:string,depth=0):string {
 const unavailable=post.availability!=='available',quoted=object(post.quoted_post),reposted=object(post.reposted_post),related=Object.keys(reposted).length?reposted:quoted;
 return '<section class="x-post-embedded"><p class="x-post-relation">'+esc(relation)+'</p>'+authorHeader(post,'原作者未提供',true)+(unavailable?'<p class="x-post-unavailable" role="status">'+(post.availability==='unavailable'?'原作品当前不可用；保留已保存的作者与原文入口。':'本次响应未提供原作品正文或媒体；可打开原文核对。')+'</p>':'<div class="x-post-text">'+renderXPostText(post.text,post.links)+'</div>'+mediaMarkup(post.media,post.canonical_url)+(depth<2&&Object.keys(related).length?embeddedPost(related,Object.keys(reposted).length?'转发的原作品':'引用的原作品',depth+1):''))+anchor(post.canonical_url,'打开原作品 ↗')+'</section>';
}

export interface XPostCardData {benchmark?:JsonObject|null;media?:JsonObject[];body?:string|null;summary?:string;author_name?:string|null;published_at?:string|null;canonical_url?:string|null}
export function renderXPostCard(data:XPostCardData,metrics=''):string {
 const meta=object(data.benchmark),saved=object(meta.x_post),kind=string(saved.kind)||'post';
 const post:JsonObject=Object.keys(saved).length?saved:{author:{name:data.author_name??''},text:data.body??data.summary??'',published_at:data.published_at??null,canonical_url:data.canonical_url??null,media:data.media??[]};
 const nested=kind==='repost'?object(saved.reposted_post):object(saved.quoted_post),legacy=string(meta.quoted_text);
 const nestedPost:JsonObject|null=Object.keys(nested).length?nested:legacy?{author:{name:meta.quoted_author??''},text:legacy,availability:'available'}:null;
 const original=post.canonical_url??data.canonical_url;
 const nestedMarkup=nestedPost?embeddedPost(nestedPost,kind==='repost'?'转发的原作品':'引用的原作品'):'';
 const content=post.availability==='unavailable'?'<p class="x-post-unavailable" role="status">作品当前不可用；保留已保存的作者与原文入口。</p>':(string(post.text)?'<div class="x-post-text">'+renderXPostText(post.text,post.links)+'</div>':'')+mediaMarkup(post.media??data.media,original);
 return '<article class="x-post-card" aria-label="X 完整作品">'+(kind==='repost'?'<p class="x-post-relation">转发记录 · 下方内容归原作者</p>':'')+authorHeader(post,data.author_name??'')+content+nestedMarkup+(metrics?'<div class="x-post-metrics">'+(kind==='repost'?'<p class="fine">以下为转发记录返回的指标；不与原作品合计。</p>':'')+metrics+'</div>':'')+'<div class="x-post-footer">'+anchor(original,'打开 X 原文 ↗')+(meta.collected_at?'<span>读取 · '+esc(date(meta.collected_at))+'</span>':'')+'</div></article>';
}

export function renderXPostSummary(row:SourceRecordSummary,options:{action:string;accountId?:string},metrics=''):string {
 const preview=imageUrl(row.preview_url),label=row.media_type==='video'?'视频':row.media_type==='image'?'图片':'文字';
 // A summary is a single button; links and gallery controls appear in the detail only.
 const text=xPostPreviewText(row.summary||row.title);
 return '<button type="button" id="'+esc('benchmark-material-'+row.id)+'" class="benchmark-work x-post-summary" data-action="'+esc(options.action)+'"'+(options.accountId?' data-account="'+esc(options.accountId)+'"':'')+' data-id="'+esc(row.id)+'">'+(preview?'<span class="x-summary-cover"><span class="x-image-fallback">图片暂不可读</span><img data-platform-image src="'+esc(preview)+'" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>':'')+'<span class="benchmark-work-content"><span class="x-summary-author">'+esc(row.author_name??'X 作品')+'</span><strong class="benchmark-work-title">'+esc(text)+'</strong><span class="benchmark-work-meta">'+label+' · 发布 '+esc(date(row.published_at))+'</span>'+metrics+'<span class="benchmark-work-open">查看完整作品 ↗</span></span></button>';
}

/** The viewer reuses the existing image node and request, including a pending load. */
export function mountXPostCards(root:HTMLElement):()=>void {
 const document=root.ownerDocument,controller=new AbortController(),signal=controller.signal;
 const viewer=document.createElement('dialog');viewer.className='x-image-viewer';viewer.setAttribute('aria-label','作品图片查看器');
 viewer.innerHTML='<div class="x-viewer-head"><span class="x-viewer-counter" aria-live="polite"></span><button type="button" class="x-viewer-close" aria-label="关闭图片查看器">关闭 <span aria-hidden="true">×</span></button></div><div class="x-viewer-stage"><p class="x-viewer-status" role="status" aria-live="polite" hidden>图片正在加载…</p><p class="x-viewer-error" hidden>图片暂不可读，可打开平台原文查看。</p></div><div class="x-viewer-foot"><button type="button" data-x-prev aria-label="上一张图片">← 上一张</button><a class="x-viewer-original" target="_blank" rel="noopener noreferrer">打开平台原文 ↗</a><button type="button" data-x-next aria-label="下一张图片">下一张 →</button></div>';
 const stage=viewer.querySelector<HTMLElement>('.x-viewer-stage')!,counter=viewer.querySelector<HTMLElement>('.x-viewer-counter')!,error=viewer.querySelector<HTMLElement>('.x-viewer-error')!,previous=viewer.querySelector<HTMLButtonElement>('[data-x-prev]')!,next=viewer.querySelector<HTMLButtonElement>('[data-x-next]')!,original=viewer.querySelector<HTMLAnchorElement>('.x-viewer-original')!;
 const loading=viewer.querySelector<HTMLElement>('.x-viewer-status')!;
 let items:HTMLButtonElement[]=[],index=0,trigger:HTMLButtonElement|null=null,moved:{image:HTMLImageElement;parent:Node;next:Node|null;hidden:HTMLImageElement['hidden']}|null=null,generation=0,releaseImage:(()=>void)|null=null;
 const state=(value:'pending'|'ready'|'error')=>{stage.dataset.state=value;loading.hidden=value!=='pending';error.hidden=value!=='error';};
 const restore=()=>{
  generation++;releaseImage?.();releaseImage=null;
  if(moved){moved.image.hidden=moved.image.complete?moved.image.naturalWidth===0:moved.hidden;if(moved.parent.isConnected)moved.parent.insertBefore(moved.image,moved.next?.parentNode===moved.parent?moved.next:null);else moved.image.remove();moved=null;}
 };
 const display=()=>{
  restore();const item=items[index],image=item?.querySelector<HTMLImageElement>('img');
  counter.textContent='图片 '+(index+1)+' / '+items.length;previous.disabled=index===0;next.disabled=index===items.length-1;
  if(!image){state('error');return;}
  const version=generation,current=index;
  const active=()=>!signal.aborted&&viewer.open&&generation===version&&index===current&&items[current]===item&&moved?.image===image&&item.isConnected;
  const loaded=()=>{if(active()){if(image.naturalWidth>0)image.hidden=false;state(image.naturalWidth>0?'ready':'error');}};
  const failed=()=>{if(active())state('error');};
  image.addEventListener('load',loaded);image.addEventListener('error',failed);
  releaseImage=()=>{image.removeEventListener('load',loaded);image.removeEventListener('error',failed);};
  moved={image,parent:image.parentNode!,next:image.nextSibling,hidden:image.hidden};stage.append(image);
  if(image.complete)loaded();else state('pending');
 };
 const close=()=>{restore();if(viewer.open)viewer.close();if(trigger?.isConnected)trigger.focus({preventScroll:true});items=[];trigger=null;};
 root.addEventListener('click',event=>{
  const target=event.target instanceof Element?event.target.closest<HTMLButtonElement>('[data-x-image]'):null;if(!target||!root.contains(target))return;
  event.preventDefault();event.stopPropagation();const gallery=target.closest<HTMLElement>('[data-x-gallery]');if(!gallery)return;
  trigger=target;items=Array.from(gallery.querySelectorAll<HTMLButtonElement>('[data-x-image]'));index=items.indexOf(target);
  const url=publicUrl(gallery.dataset.xOriginal);original.hidden=!url;if(url)original.href=url;else original.removeAttribute('href');
  if(!viewer.isConnected)document.body.append(viewer);viewer.showModal();display();viewer.querySelector<HTMLButtonElement>('.x-viewer-close')!.focus();
 },{capture:true,signal});
 viewer.querySelector('.x-viewer-close')!.addEventListener('click',close,{signal});
 previous.addEventListener('click',()=>{if(index>0){index--;display();}},{signal});next.addEventListener('click',()=>{if(index<items.length-1){index++;display();}},{signal});
 viewer.addEventListener('cancel',event=>{event.preventDefault();close();},{signal});
 viewer.addEventListener('keydown',event=>{
  if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();event.stopPropagation();index=Math.max(0,Math.min(items.length-1,index+(event.key==='ArrowRight'?1:-1)));display();}
  if(event.key==='Tab'){const controls=Array.from(viewer.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')).filter(element=>!element.hidden),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
 },{signal});
 viewer.addEventListener('click',event=>{if(event.target===viewer){const box=viewer.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)close();}},{signal});
 const observer=new MutationObserver(()=>{if(viewer.open&&trigger&&!trigger.isConnected)close();});observer.observe(root,{childList:true,subtree:true});
 return ()=>{observer.disconnect();close();controller.abort();viewer.remove();};
}
