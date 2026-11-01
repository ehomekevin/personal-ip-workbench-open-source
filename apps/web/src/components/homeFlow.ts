// 沿用原型的连线动效；真实页面按用户反馈显示平台品牌标识。
export function mountHomeFlow(root:HTMLElement){
 let flowFrame:number|null=null,flowObserver:ResizeObserver|null=null;
 const document=root.ownerDocument;
 const selectedCanvas=root.querySelector<HTMLCanvasElement>('#flow-canvas');if(!selectedCanvas)return ()=>{};const canvas:HTMLCanvasElement=selectedCanvas;
 const selectedContext=canvas.getContext('2d'),hero=root.querySelector<HTMLElement>('#home-hero');if(!selectedContext||!hero)return ()=>{};const context:CanvasRenderingContext2D=selectedContext;
 const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
 const usePlatformLogos=canvas.dataset.platformLogos==='true',logos:HTMLImageElement[]=[];
 const platforms=[
  {src:'/workbench/platforms/xiaohongshu.svg',background:'#ff2442',size:30},
  {src:'/workbench/platforms/wechat.svg',background:'#18d321',size:30},
  {src:'/workbench/platforms/x.svg',background:'#ffffff',size:20},
  {src:'/workbench/platforms/douyin.svg',background:'#000000',size:26},
  {src:'/workbench/platforms/bilibili.svg',background:'#ffffff',size:23},
 ];
 let disposed=false;
 if(usePlatformLogos)for(const {src} of platforms){
  const image=new Image();image.onload=()=>{if(!disposed)draw(now)};image.src=src;logos.push(image);
 }
 let width=0,height=0,px=0,py=0,now=0,visible=true;const dpr=Math.min(2,devicePixelRatio||1);
 function resize(){const rect=canvas.getBoundingClientRect();width=rect.width;height=rect.height;if(!width||!height)return;canvas.width=width*dpr;canvas.height=height*dpr;context.setTransform(dpr,0,0,dpr,0,0);draw(now)}
 function node(x:number,y:number,r:number,label:string,fill:string,ink:string){context.beginPath();context.arc(x,y,r,0,Math.PI*2);context.fillStyle=fill;context.fill();context.lineWidth=1;context.strokeStyle='#c4cae7';context.stroke();context.font=(r>27?'500 11px':'10px')+' -apple-system, PingFang SC, sans-serif';context.fillStyle=ink;context.textAlign='center';context.textBaseline='middle';context.fillText(label,x,y)}
 function platformNode(x:number,y:number,index:number){
  const image=logos[index],platform=platforms[index];
  // 统一白色圆框；品牌底色延伸至圆形边缘，避免方形图标嵌在圆内。
  context.save();context.beginPath();context.arc(x,y,18,0,Math.PI*2);
  context.shadowColor='#0b1f5214';context.shadowBlur=5;context.shadowOffsetY=2;
  context.fillStyle='#ffffff';context.fill();context.restore();
  context.save();context.beginPath();context.arc(x,y,16,0,Math.PI*2);context.clip();
  context.fillStyle=platform.background;context.fillRect(x-16,y-16,32,32);
  context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
  const scale=platform.size/Math.max(image.naturalWidth,image.naturalHeight),w=image.naturalWidth*scale,h=image.naturalHeight*scale;
  context.drawImage(image,x-w/2,y-h/2,w,h);context.restore();
  context.beginPath();context.arc(x,y,18,0,Math.PI*2);context.lineWidth=.75;context.strokeStyle='#c4cae7';context.stroke();
 }
 function line(from:{x:number;y:number},to:{x:number;y:number},time:number,index:number){context.beginPath();context.moveTo(from.x,from.y);const cx=(from.x+to.x)/2;context.bezierCurveTo(cx,from.y,cx,to.y,to.x,to.y);context.strokeStyle='#c4cae7';context.lineWidth=1;context.stroke();if(reduce)return;const t=(time/3200+index*.17)%1,ot=1-t;const x=ot*ot*ot*from.x+3*ot*ot*t*cx+3*ot*t*t*cx+t*t*t*to.x;const y=ot*ot*ot*from.y+3*ot*ot*t*from.y+3*ot*t*t*to.y+t*t*t*to.y;context.beginPath();context.arc(x,y,2.1,0,Math.PI*2);context.fillStyle='#CCF866';context.fill()}
 function draw(time:number){if(!width||!height)return;context.clearRect(0,0,width,height);
 const center={x:width*.46+px*4,y:height*.49+py*4},left=[{x:width*.09,y:height*.21,label:'资讯'},{x:width*.09,y:height*.49,label:'对标'},{x:width*.09,y:height*.77,label:'想法'}];
 const right=[{x:width*.82,y:height*.12,label:'红'},{x:width*.91,y:height*.32,label:'文'},{x:width*.84,y:height*.52,label:'X'},{x:width*.92,y:height*.72,label:'抖'},{x:width*.78,y:height*.9,label:'B'}];
 if(usePlatformLogos)right.forEach(n=>{n.x=Math.max(21,Math.min(width-21,n.x));n.y=Math.max(21,Math.min(height-21,n.y));});
 for(let i=0;i<left.length;i++)line(left[i],center,time,i);for(let i=0;i<right.length;i++)line(center,right[i],time,i+3);
 context.beginPath();context.arc(center.x,center.y,43+Math.sin(time/1600)*1.4,0,Math.PI*2);context.strokeStyle='#c4cae7';context.stroke();
 left.forEach(n=>node(n.x,n.y,18,n.label,'#eef0fa','#4a5580'));
 right.forEach((n,index)=>{
  const image=logos[index],loaded=usePlatformLogos&&image?.complete&&image.naturalWidth>0;
  if(loaded)platformNode(n.x,n.y,index);
  else node(n.x,n.y,usePlatformLogos?18:16,n.label,'#eef0fa','#4a5580');
 });
 node(center.x,center.y,32,'核心稿','#0B1F52','#eef0fa');
 }
 const pointermove=(e:PointerEvent)=>{const r=hero.getBoundingClientRect();px=(e.clientX-r.left)/r.width-.5;py=(e.clientY-r.top)/r.height-.5;hero.style.setProperty('--spot-x',(e.clientX-r.left)+'px');hero.style.setProperty('--spot-y',(e.clientY-r.top)+'px');if(reduce)draw(now)};
 const pointerleave=()=>{px=0;py=0};hero.addEventListener('pointermove',pointermove);hero.addEventListener('pointerleave',pointerleave);
 flowObserver=new ResizeObserver(resize);flowObserver.observe(canvas);resize();
 function tick(time:number){now=time;if(document.visibilityState==='visible'&&visible)draw(time);flowFrame=requestAnimationFrame(tick)}
 if(!reduce)flowFrame=requestAnimationFrame(tick);
 return ()=>{disposed=true;logos.forEach(image=>{image.onload=null;});if(flowFrame)cancelAnimationFrame(flowFrame);flowObserver?.disconnect();hero.removeEventListener('pointermove',pointermove);hero.removeEventListener('pointerleave',pointerleave);};
}
