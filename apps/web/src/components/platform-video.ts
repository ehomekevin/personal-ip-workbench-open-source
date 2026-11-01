import type {JsonObject} from '@workbench/contracts';
import {createTemplateHelpers} from './templateHelpers.ts';

const {esc}=createTemplateHelpers([]);
const platforms:Record<string,{name:string;hosts:string[];path:RegExp}>={
 douyin:{name:'抖音',hosts:['douyin.com','www.douyin.com'],path:/^\/(?:video|note)\/\d{1,30}\/?$/},
 x:{name:'X',hosts:['x.com','www.x.com','twitter.com','www.twitter.com'],path:/^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/\d{1,30}\/?$/},
 xiaohongshu:{name:'小红书',hosts:['xiaohongshu.com','www.xiaohongshu.com'],path:/^\/(?:explore|discovery\/item)\/[A-Za-z0-9]+\/?$/},
 bilibili:{name:'B 站',hosts:['bilibili.com','www.bilibili.com'],path:/^\/video\/(?:BV[A-Za-z0-9]+|av\d+)\/?$/},
 wechat:{name:'公众号',hosts:['mp.weixin.qq.com'],path:/^\/s(?:\/[^/]+)?$/},
};
const mediaUrl=(value:unknown):string|null=>{try{if(typeof value!=='string'||value.length>8192)return null;const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};

export function originalPlatformLink(value:unknown,platform?:string):{url:string;name:string}|null{
 const safe=mediaUrl(value);if(!safe)return null;const url=new URL(safe);
 const match=platform?platforms[platform]:Object.values(platforms).find(item=>item.hosts.includes(url.hostname));
 return match&&!url.port&&match.hosts.includes(url.hostname)&&match.path.test(url.pathname)?{url:safe,name:match.name}:null;
}
export function platformVideoExpired(media:JsonObject,now=Date.now()):boolean{
 // Only an explicit, parsed platform expiry is authoritative. Do not guess from URL query parameters.
 return typeof media.expires_at==='string'&&Number.isFinite(Date.parse(media.expires_at))&&Date.parse(media.expires_at)<=now;
}
export function renderPlatformVideo(media:JsonObject,options:{platform?:string;originalUrl?:unknown;className?:string;caption?:string;now?:number}={}):string{
 const play=mediaUrl(media.play_url??(media.preview_url!==media.url?media.url:null)),poster=mediaUrl(media.preview_url);
 const original=originalPlatformLink(options.originalUrl,options.platform),link=original?'<a class="inline-link benchmark-video-original" href="'+esc(original.url)+'" target="_blank" rel="noopener noreferrer">在'+esc(original.name)+'查看 ↗</a>':'';
 const expired=platformVideoExpired(media,options.now),message=expired?'视频地址已过期，请到平台查看。':'视频暂时无法播放，请到平台查看。';
 const unavailable='<div class="benchmark-video-unavailable" data-video-state="'+(expired?'expired':'unavailable')+'">'+(poster?'<img data-platform-image src="'+esc(poster)+'" alt="作品视频封面" loading="lazy" referrerpolicy="no-referrer">':'')+'<p class="fine">'+message+'</p>'+link+'</div>';
 const player='<video data-platform-video controls playsinline preload="none"'+(poster?' poster="'+esc(poster)+'"':'')+' src="'+esc(play)+'"></video><p class="fine benchmark-media-error" role="status" hidden>'+message+'</p>'+link;
 return '<figure'+(options.className?' class="'+esc(options.className)+'"':'')+'>'+(expired||!play?unavailable:player)+(options.caption?'<figcaption>'+esc(options.caption)+'</figcaption>':'')+'</figure>';
}
