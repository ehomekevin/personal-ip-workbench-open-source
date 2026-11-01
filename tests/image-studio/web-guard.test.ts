import test from 'node:test';
import assert from 'node:assert/strict';
import {guardedFetch,isPublicAddress,parseArticleImages,sniffImageMime,WebDnsGuard,dohResolve,parseDohAnswer,connectAddresses,DOH_MAX_BYTES,FAKE_IP_UNRESOLVED} from '../../packages/adapters/src/web/public-fetch.ts';
import {signedExpiry} from '../../packages/domain/src/artifact-execution/image-studio/web-images.ts';
import {FakeWeb,ARTICLE_HTML} from './web-fixture.ts';
import {solidPng} from '../helpers/png.ts';
const rejects=async(web:FakeWeb,url:string,pattern:RegExp,kind:'image'|'html'='image',extra:Record<string,unknown>={})=>{await assert.rejects(guardedFetch(url,kind,{fetcher:web.fetcher,lookup:web.lookup,...extra}),(e:Error&{code?:string})=>{assert.equal(e.code,'VALIDATION_ERROR');assert.match(e.message,pattern);return true;});};
test('public address classification covers private, loopback, link-local, mapped and NAT64 forms',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','::','fe80::1','fc00::1','::ffff:127.0.0.1','::ffff:7f00:1','64:ff9b::a00:1','224.0.0.1'])assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['93.184.216.34','8.8.8.8','2606:4700:4700::1111'])assert.equal(isPublicAddress(ip),true,ip);
});
test('IPv6 transition and reserved prefixes are rejected or judged by their embedded IPv4',()=>{
 const blocked:Record<string,string>={'local NAT64 64:ff9b:1::/48':'64:ff9b:1::808:808','NAT64 to loopback':'64:ff9b::7f00:1','IPv4-mapped loopback':'::ffff:127.0.0.1','IPv4-mapped hex':'::ffff:a00:1','IPv4-translated ::ffff:0:0/96':'::ffff:0:7f00:1','IPv4-translated private':'::ffff:0:c0a8:101','6to4 loopback':'2002:7f00:1::1','6to4 private':'2002:a00:1::','Teredo 2001::/32':'2001:0:4136:e378:8000:63bf:3fff:fdd2','ULA fc00::/7':'fd12:3456::1','link-local fe80::/10':'fe80::abcd','unspecified ::/128':'::','loopback ::1':'::1','discard 100::/64':'100::1','documentation 2001:db8::/32':'2001:db8::1','IETF 2001::/23':'2001:2::1','multicast':'ff02::1','IPv4-compatible':'::10.0.0.1'};
 for(const [name,ip] of Object.entries(blocked))assert.equal(isPublicAddress(ip),false,name+' '+ip);
 for(const [name,ip] of Object.entries({'6to4 with public IPv4':'2002:808:808::1','NAT64 well-known public':'64:ff9b::808:808','mapped public':'::ffff:8.8.8.8','global unicast':'2606:4700:4700::1111'}))assert.equal(isPublicAddress(ip),true,name+' '+ip);
});
test('SRv6 SID block 5f00::/16 is rejected at both edges; neighbours are not caught by this rule',()=>{
 for(const ip of ['5f00::','5f00::1','5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff'])assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff','5f01::1'])assert.equal(isPublicAddress(ip),true,ip);
});
test('guard rejects http before any request',async()=>{const web=new FakeWeb();web.png('http://cdn.example/a.png');await rejects(web,'http://cdn.example/a.png',/https/);assert.equal(web.calls.length,0);});
test('guard rejects private IP literals without a request',async()=>{const web=new FakeWeb();for(const url of ['https://10.0.0.1/a.png','https://127.0.0.1/a.png','https://[::1]/a.png','https://[::ffff:127.0.0.1]/a.png','https://169.254.169.254/latest'])await rejects(web,url,/内网|保留/);await rejects(web,'https://localhost/a.png',/本机|内网/);assert.equal(web.calls.length,0);});
test('guard rejects domains that resolve to 127.0.0.1 / 10.* / 169.254.* / ::1',async()=>{const web=new FakeWeb();for(const [host,ip] of [['loop.example','127.0.0.1'],['ten.example','10.9.8.7'],['meta.example','169.254.169.254'],['six.example','::1']] as const){web.hosts.set(host,['93.184.216.34',ip]);web.png('https://'+host+'/a.png');await rejects(web,'https://'+host+'/a.png',/解析到内网/);}assert.equal(web.calls.length,0);});
test('guard re-validates every redirect hop and caps hops',async()=>{
 const web=new FakeWeb();web.hosts.set('internal.example',['10.0.0.5']);web.png('https://internal.example/a.png');
 web.routes.set('https://cdn.example/r.png',()=>new Response(null,{status:302,headers:{location:'https://internal.example/a.png'}}));await rejects(web,'https://cdn.example/r.png',/解析到内网/);assert.deepEqual(web.calls,['https://cdn.example/r.png']);
 web.routes.set('https://cdn.example/h.png',()=>new Response(null,{status:301,headers:{location:'http://cdn.example/a.png'}}));await rejects(web,'https://cdn.example/h.png',/https/);
 for(let i=0;i<5;i++)web.routes.set('https://cdn.example/loop'+i,()=>new Response(null,{status:302,headers:{location:'/loop'+(i+1)}}));web.calls=[];await rejects(web,'https://cdn.example/loop0',/重定向次数过多/);assert.equal(web.calls.length,4);
 const bytes=web.png('https://cdn.example/final.png');web.routes.set('https://cdn.example/ok',()=>new Response(null,{status:302,headers:{location:'/final.png'}}));const ok=await guardedFetch('https://cdn.example/ok','image',{fetcher:web.fetcher,lookup:web.lookup});assert.equal(ok.url,'https://cdn.example/final.png');assert.deepEqual(ok.bytes,bytes);
});
test('guard enforces size limit by header and by stream',async()=>{const web=new FakeWeb();const big=Buffer.concat([solidPng(4,4),Buffer.alloc(4096)]);web.routes.set('https://cdn.example/declared.png',()=>new Response(big,{headers:{'content-type':'image/png','content-length':String(big.length)}}));await rejects(web,'https://cdn.example/declared.png',/大小上限/,'image',{max_bytes:1024});
 web.routes.set('https://cdn.example/stream.png',()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(big));c.close();}}),{headers:{'content-type':'image/png'}}));await rejects(web,'https://cdn.example/stream.png',/大小上限/,'image',{max_bytes:1024});});
test('guard rejects non-image MIME and magic-number mismatch',async()=>{const web=new FakeWeb();web.routes.set('https://cdn.example/page.png',()=>new Response('<html></html>',{headers:{'content-type':'text/html'}}));await rejects(web,'https://cdn.example/page.png',/不是 JPEG/);web.routes.set('https://cdn.example/svg',()=>new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}}));await rejects(web,'https://cdn.example/svg',/不是 JPEG/);
 web.routes.set('https://cdn.example/fake.png',()=>new Response(Buffer.from('GIF89a-not-a-png'),{headers:{'content-type':'image/png'}}));await rejects(web,'https://cdn.example/fake.png',/声明格式不符/);web.routes.set('https://cdn.example/text.jpg',()=>new Response('hello',{headers:{'content-type':'image/jpeg'}}));await rejects(web,'https://cdn.example/text.jpg',/声明格式不符/);
 assert.equal(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')),'image/webp');assert.equal(sniffImageMime(Buffer.from([0xff,0xd8,0xff,0xe0])),'image/jpeg');});
test('article parser keeps og/twitter/inline https images, skips icons/http/data, resolves relative URLs',()=>{const parsed=parseArticleImages(ARTICLE_HTML,'https://news.example/a');assert.deepEqual(parsed.images,[{url:'https://news.example/og.png',kind:'og'},{url:'https://news.example/tw.png',kind:'twitter'},{url:'https://news.example/in2.png',kind:'inline'}]);assert.equal(parsed.site_name,'Example News');assert.equal(parsed.page_title,'原文标题 · 新闻');
 assert.equal(parseArticleImages('<img src="data:image/png;base64,AA"><img src="/a.svg">','https://e.example/').images.length,0);});
test('signed expiry is read from x-expires only',()=>{assert.equal(signedExpiry('https://d.example/a?x-expires=1000000000'),'2001-09-09T01:46:40.000Z');assert.equal(signedExpiry('https://d.example/a'),null);});

// —— 代理 fake-IP（TUN + fake-ip）环境 ——
const fakeIpGuard=(real:Record<string,string[]>|'fail',log:string[]=[])=>new WebDnsGuard({doh:async host=>{log.push(host);if(real==='fail')throw new Error('doh down');return(real[host]??[]).map(address=>({address,family:address.includes(':')?6:4}));}});
test('fake-IP: system DNS 198.18.0.55 + DoH public IP is allowed and connects by domain',async()=>{
 const web=new FakeWeb(),log:string[]=[];web.hosts.set('www.theverge.com',['198.18.0.55']);const bytes=web.png('https://www.theverge.com/a.png');const dns=fakeIpGuard({'www.theverge.com':['151.101.1.52']},log);
 const ok=await guardedFetch('https://www.theverge.com/a.png','image',{fetcher:web.fetcher,lookup:web.lookup,dns});
 assert.deepEqual(ok.bytes,bytes);assert.deepEqual(web.calls,['https://www.theverge.com/a.png']);assert.deepEqual(log,['www.theverge.com']);assert.equal(dns.mode,'fake_ip_doh');assert.equal(dns.isVerified('www.theverge.com'),true);
 assert.equal(dns.isFakeIp('28.0.0.9'),false,'28/8 不在默认段');assert.equal(dns.isFakeIp('8.8.8.8'),false);assert.equal(new WebDnsGuard({fake_ip_ranges:['28.0.0.0/8']}).isFakeIp('28.0.0.9'),true,'显式配置才生效');
});
test('fake-IP: DoH returning a private address is still rejected',async()=>{
 const web=new FakeWeb();web.hosts.set('evil.example',['198.18.0.60']);web.png('https://evil.example/a.png');
 for(const ip of ['10.0.0.1','127.0.0.1','198.18.0.1','::1']){const dns=fakeIpGuard({'evil.example':['93.184.216.34',ip]});await rejects(web,'https://evil.example/a.png',/解析到内网/,'image',{dns});assert.equal(dns.isVerified('evil.example'),false);}
 assert.equal(web.calls.length,0);
});
test('fake-IP: both DoH resolvers failing rejects with the fake-IP message and is cached as a page failure',async()=>{
 const web=new FakeWeb();web.hosts.set('blog.google',['198.18.0.53']);web.html('https://blog.google/',ARTICLE_HTML);
 await rejects(web,'https://blog.google/',new RegExp(FAKE_IP_UNRESOLVED),'html',{dns:fakeIpGuard('fail')});assert.equal(web.calls.length,0);
 // 真实 DoH 解析器实现：两家都失败（HTTP 错误 / 网络错误）→ 拒绝；一家成功即可。
 const calls:string[]=[];const doh=(fail:(u:string)=>boolean)=>(async(input:RequestInfo|URL,init?:RequestInit)=>{const u=String(input);calls.push(u);assert.equal(new Headers(init?.headers).get('accept'),'application/dns-json');if(fail(u))throw new Error('net');const type=new URL(u).searchParams.get('type');return Response.json(type==='A'?{Status:0,Answer:[{name:'blog.google.',type:5,data:'g.example.'},{name:'g.example.',type:1,data:'142.250.1.1'}]}:{Status:0,Authority:[{name:'google.',type:6,data:'ns1.google.com. dns-admin.google.com. 1 900 900 1800 60'}]});}) as typeof fetch;
 await assert.rejects(dohResolve('blog.google',['https://a.example/dns-query','https://b.example/resolve'],doh(()=>true)));
 assert.deepEqual(await dohResolve('blog.google',['https://a.example/dns-query','https://b.example/resolve'],doh(u=>u.startsWith('https://a.'))),[{address:'142.250.1.1',family:4}]);
 assert.ok(calls.some(u=>u.startsWith('https://b.example/resolve?name=blog.google&type=AAAA')));
});
test('fake-IP: redirect to another domain re-runs DoH on the second hop',async()=>{
 const web=new FakeWeb(),log:string[]=[];web.hosts.set('t.co',['198.18.0.70']);web.hosts.set('internal.example',['198.18.0.71']);web.hosts.set('cdn.example',['198.18.0.72']);
 web.routes.set('https://t.co/r',()=>new Response(null,{status:302,headers:{location:'https://internal.example/a.png'}}));web.png('https://internal.example/a.png');
 await rejects(web,'https://t.co/r',/解析到内网/,'image',{dns:fakeIpGuard({'t.co':['104.244.42.1'],'internal.example':['10.0.0.5']},log)});assert.deepEqual(log,['t.co','internal.example']);assert.deepEqual(web.calls,['https://t.co/r']);
 web.routes.set('https://t.co/ok',()=>new Response(null,{status:302,headers:{location:'https://cdn.example/b.png'}}));web.png('https://cdn.example/b.png');log.length=0;
 const ok=await guardedFetch('https://t.co/ok','image',{fetcher:web.fetcher,lookup:web.lookup,dns:fakeIpGuard({'t.co':['104.244.42.1'],'cdn.example':['93.184.216.34']},log)});assert.equal(ok.url,'https://cdn.example/b.png');assert.deepEqual(log,['t.co','cdn.example']);
});
test('non fake-IP environment keeps the system path: no DoH, mode system',async()=>{
 const web=new FakeWeb(),log:string[]=[];web.png('https://cdn.example/a.png');const dns=fakeIpGuard({},log);await guardedFetch('https://cdn.example/a.png','image',{fetcher:web.fetcher,lookup:web.lookup,dns});assert.equal(dns.mode,'system');assert.deepEqual(log,[]);
 assert.throws(()=>new WebDnsGuard({fake_ip_ranges:['not-a-cidr']}));
});
test('web_fetch configuration is optional; resolvers must be https URLs and ranges valid CIDRs',async()=>{
 const {validateConfiguration}=await import('../../apps/service/src/bootstrap/config.ts');const {randomUUID}=await import('node:crypto');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const base={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'t',mode:'demo',timezone:'UTC',paths:{source_vault_root:null,managed_notes_root:join(tmpdir(),'__wf_notes'),state_root:join(tmpdir(),'__wf_state'),media_root:join(tmpdir(),'__wf_media')},listen:{host:'127.0.0.1',port:1}};
 assert.equal(validateConfiguration(base).web_fetch,undefined);
 assert.deepEqual(validateConfiguration({...base,web_fetch:{doh_resolvers:['https://dns.example/dns-query'],fake_ip_ranges:['198.18.0.0/15','28.0.0.0/8','fdfe:dcba:9876::/48']}}).web_fetch,{doh_resolvers:['https://dns.example/dns-query'],fake_ip_ranges:['198.18.0.0/15','28.0.0.0/8','fdfe:dcba:9876::/48']});
 for(const bad of [{doh_resolvers:['http://dns.example/q']},{doh_resolvers:[]},{fake_ip_ranges:['198.18.0.0']},{fake_ip_ranges:['1.2.3.4/33']},{proxy:'x'},[],null])assert.throws(()=>validateConfiguration({...base,web_fetch:bad}),{code:'VALIDATION_ERROR'});
});
const dohRecord=(name:string,type:number,data:string)=>({name,type,data}),soa={name:'example.',type:6,data:'ns. host. 1 1 1 1 1'};
test('fake-IP mixed answer (fake + public) is treated as fake-IP: DoH decides, and the connection never dials the fake address',async()=>{
 const web=new FakeWeb(),log:string[]=[];web.hosts.set('mixed.example',['93.184.216.34','198.18.0.5']);web.png('https://mixed.example/a.png');
 await rejects(web,'https://mixed.example/a.png',/解析到内网/,'image',{dns:fakeIpGuard({'mixed.example':['10.0.0.1']},log)});assert.deepEqual(log,['mixed.example'],'混合答复必须走 DoH');
 await rejects(web,'https://mixed.example/a.png',new RegExp(FAKE_IP_UNRESOLVED),'image',{dns:fakeIpGuard('fail')});
 web.hosts.set('mixpriv.example',['10.0.0.1','198.18.0.5']);web.png('https://mixpriv.example/a.png');await rejects(web,'https://mixpriv.example/a.png',/解析到内网/,'image',{dns:fakeIpGuard({'mixpriv.example':['93.184.216.34']})});assert.equal(web.calls.length,0);
 const dns=fakeIpGuard({'mixed.example':['93.184.216.34']});await guardedFetch('https://mixed.example/a.png','image',{fetcher:web.fetcher,lookup:web.lookup,dns});assert.equal(dns.isVerified('mixed.example'),true);
 const at=(...ips:string[])=>ips.map(address=>({address,family:4}));
 assert.deepEqual(connectAddresses('mixed.example',at('93.184.216.34','198.18.0.5'),dns),at('93.184.216.34'),'混合集只连公网地址');
 assert.equal(connectAddresses('mixed.example',at('10.0.0.1','198.18.0.5'),dns),null);
 assert.deepEqual(connectAddresses('mixed.example',at('198.18.0.5'),dns),at('198.18.0.5'),'全 fake 且已校验：交给 TUN');
 assert.equal(connectAddresses('other.example',at('198.18.0.5'),dns),null,'未经 DoH 校验的域名不放行 fake-IP');
 assert.equal(connectAddresses('mixed.example',at('198.18.0.5')),null,'无 guard 保持原规则');
});
test('DoH answers must reach a terminal record or explicit NODATA; truncation, non-zero status and malformed records fail',async()=>{
 assert.deepEqual(parseDohAnswer('a.example','A',{Status:0,Answer:[dohRecord('a.example.',5,'b.example.'),dohRecord('b.example.',1,'93.184.216.34'),dohRecord('a.example.',1,'10.0.0.1')]}),[{address:'93.184.216.34',family:4}],'只取 CNAME 链终点记录');
 assert.deepEqual(parseDohAnswer('a.example','AAAA',{Status:0,Authority:[soa]}),[],'明确 NODATA');
 const bad:Record<string,[('A'|'AAAA'),Record<string,unknown>]>={'CNAME without terminal':['AAAA',{Status:0,Answer:[dohRecord('a.example.',5,'b.example.')]}],'truncated':['A',{Status:0,TC:true,Answer:[dohRecord('a.example.',1,'93.184.216.34')]}],'NXDOMAIN':['A',{Status:3,Authority:[soa]}],'SERVFAIL':['A',{Status:2}],'missing status':['A',{Answer:[]}],'empty without SOA':['A',{Status:0}],'malformed address':['A',{Status:0,Answer:[dohRecord('a.example.',1,'not-an-ip')]}],'wrong family':['AAAA',{Status:0,Answer:[dohRecord('a.example.',28,'93.184.216.34')]}],'record without name':['A',{Status:0,Answer:[{type:1,data:'93.184.216.34'}]}],'answer not array':['A',{Status:0,Answer:{}}],'cname loop':['A',{Status:0,Answer:[dohRecord('a.example.',5,'b.example.'),dohRecord('b.example.',5,'a.example.')]}]};
 for(const [name,[type,body]] of Object.entries(bad))assert.throws(()=>parseDohAnswer('a.example',type,body as never),Error,name);
 const both=(async()=>Response.json({Status:0,Authority:[soa]})) as typeof fetch;await assert.rejects(dohResolve('a.example',['https://a.example/dns-query'],both),Error,'双族都为空视为失败');
 const cnameOnly=(async(input:RequestInfo|URL)=>Response.json(new URL(String(input)).searchParams.get('type')==='A'?{Status:0,Answer:[dohRecord('a.example.',1,'93.184.216.34')]}:{Status:0,Answer:[dohRecord('a.example.',5,'b.example.')]})) as typeof fetch;await assert.rejects(dohResolve('a.example',['https://a.example/dns-query'],cnameOnly),Error,'AAAA 仅有 CNAME 无终点');
});
test('DoH response body is capped and oversize answers count as failure',async()=>{
 let cancelled=false;const big=(async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(16*1024).fill(32));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/dns-json'}})) as typeof fetch;
 await assert.rejects(dohResolve('a.example',['https://a.example/dns-query'],big));assert.equal(cancelled,true,'超限后取消读取');assert.equal(DOH_MAX_BYTES,64*1024);
 const web=new FakeWeb();web.hosts.set('a.example',['198.18.0.9']);web.png('https://a.example/x.png');await rejects(web,'https://a.example/x.png',new RegExp(FAKE_IP_UNRESOLVED),'image',{dns:new WebDnsGuard({doh_fetch:big,doh_resolvers:['https://a.example/dns-query','https://b.example/resolve']})});
});
test('verified host keys normalize case and trailing dot',async()=>{
 const dns=new WebDnsGuard();dns.markVerified('Blog.Google.');assert.equal(dns.isVerified('blog.google'),true);assert.equal(dns.isVerified('BLOG.GOOGLE.'),true);
 const web=new FakeWeb();web.lookup=async()=>[{address:'198.18.0.53',family:4}];web.png('https://blog.google./a.png');const guard=fakeIpGuard({'blog.google.':['216.239.32.21']});
 await guardedFetch('https://Blog.Google./a.png','image',{fetcher:web.fetcher,lookup:web.lookup,dns:guard});assert.equal(guard.isVerified('blog.google'),true);
 assert.deepEqual(connectAddresses('blog.google',[{address:'198.18.0.53',family:4}],guard),[{address:'198.18.0.53',family:4}]);
});
