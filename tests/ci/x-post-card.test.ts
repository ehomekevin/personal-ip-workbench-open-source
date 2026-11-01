import test from 'node:test';
import assert from 'node:assert/strict';
import {renderXPostCard,renderXPostText} from '../../apps/web/src/components/x-post-card.ts';
import {renderBenchmarkExtras} from '../../apps/web/src/components/benchmarkMaterials.ts';

test('X short links use only saved safe expansion and preserve complete surrounding text',()=>{
 const html=renderXPostText('文件版解读：https://t.co/example123。\n<script>内容</script>',[{url:'https://t.co/example123',expanded_url:'https://articles.example.invalid/posts/sample-design'}]);
 assert.ok(html.includes('href="https://articles.example.invalid/posts/sample-design"'));
 assert.ok(!html.includes('t.co/KOf0FuPkyY'));assert.ok(html.includes('。\n&lt;script&gt;内容&lt;/script&gt;'));
 const unsafe=renderXPostText('https://t.co/u',[{url:'https://t.co/u',expanded_url:'javascript:alert(1)'}]);
 assert.ok(unsafe.includes('href="https://t.co/u"'));assert.ok(unsafe.includes('X 短链接'));assert.ok(!unsafe.includes('javascript:'));
});

test('quote preserves outer and original attribution, original full text and media without folding metrics',()=>{
 const html=renderXPostCard({benchmark:{platform:'x',x_post:{kind:'quote',author:{name:'对标账号',handle:'benchmark'},text:'外层观点',canonical_url:'https://x.com/benchmark/status/123',quoted_post:{availability:'available',author:{name:'原作者',handle:'original'},text:'完整正文\n'.repeat(100),canonical_url:'https://x.com/original/status/456',media:[{type:'photo',url:'https://images.example.com/1.jpg',alt_text:'细节图'}],metrics:{likes:'999'}}}},body:'历史短正文'},'<span>外层指标 7</span>');
 assert.ok(html.indexOf('对标账号')<html.indexOf('外层观点'));assert.ok(html.indexOf('原作者')<html.indexOf('完整正文'));
 assert.ok(html.includes('完整正文\n'.repeat(100)));assert.ok(html.includes('查看细节图'));assert.ok(!html.includes('999'));
 assert.ok(!html.includes('历史短正文'));
});

test('unavailable original and unsafe media remain honest text with a safe original entry',()=>{
 const html=renderXPostCard({benchmark:{x_post:{kind:'repost',author:{name:'对标账号'},reposted_post:{availability:'unavailable',author:{name:'原作者'},text:'不得展示的猜测正文',media:[{type:'photo',url:'javascript:bad'}],canonical_url:'https://x.com/i/status/456'}}}});
 assert.ok(html.includes('转发记录'));assert.ok(html.includes('原作品当前不可用'));assert.ok(!html.includes('不得展示'));
 assert.ok(html.includes('https://x.com/i/status/456'));assert.ok(!html.includes('javascript:'));
 const image=renderXPostCard({benchmark:{x_post:{media:[{type:'photo',url:'https://user:secret@example.com/p.jpg'},{type:'video',play_url:'javascript:alert(1)'}]}}});
 assert.ok(!image.includes('secret'));assert.ok(image.includes('视频暂时无法播放'));assert.ok(!image.includes('<video'));
});

test('reader renders the saved native card rather than the truncated human field',()=>{
 const html=renderBenchmarkExtras({body:'外层旧摘要 https://t.co/s',benchmark:{platform:'x',x_post:{author:{name:'本人'},text:'保存的完整文本',links:[],media:[]},metrics:{likes:'0'}}});
 assert.ok(html.includes('保存的完整文本'));assert.ok(!html.includes('旧摘要'));assert.ok(html.includes('<b>0</b> 点赞'));
});

test('a repost containing a quote retains every author and media ownership without using a video cover as its stream',()=>{
 const html=renderXPostCard({benchmark:{x_post:{kind:'repost',author:{name:'转发者'},reposted_post:{availability:'available',author:{name:'被转发作者'},text:'原推评论',media:[{type:'video',url:'https://images.example.com/cover.jpg',preview_url:'https://images.example.com/cover.jpg',play_url:null}],quoted_post:{availability:'available',author:{name:'引用作者'},text:'最内层原文',media:[{type:'photo',url:'https://images.example.com/quote.jpg'}]}}}}});
 assert.ok(html.indexOf('转发者')<html.indexOf('被转发作者'));assert.ok(html.indexOf('被转发作者')<html.indexOf('引用作者'));
 assert.ok(html.includes('最内层原文'));assert.ok(html.includes('https://images.example.com/quote.jpg'));
 assert.ok(html.includes('视频暂时无法播放'));assert.ok(!html.includes('<video'));
});
