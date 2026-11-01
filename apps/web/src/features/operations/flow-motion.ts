interface MountedFlow {
  slot:HTMLElement; surface:HTMLElement; track:HTMLElement; svg:SVGSVGElement;
  observer:ResizeObserver; docked:boolean; animations:Animation[]; arrivalTimer:number|undefined; arrivalStarted:number; normalWidth:number;
}
const svgNs='http://www.w3.org/2000/svg';

/** One controller per shared Workbench: polling replacements, topic changes and host unmounts share cleanup. */
export function mountOperationsFlow(root:HTMLElement):()=>void {
  const win=root.ownerDocument.defaultView;if(!win)return ()=>{};
  const abort=new AbortController(),reduce=win.matchMedia('(prefers-reduced-motion: reduce)');
  const seen=new Map<string,string[]>();let mounted:MountedFlow|undefined,frame:number|undefined,disposed=false,pendingReturnTopic:string|undefined;
  function schedule(){if(!disposed&&frame===undefined)frame=win!.requestAnimationFrame(()=>{frame=undefined;update();});}
  function cancelAnimations(flow:MountedFlow){for(const animation of flow.animations)animation.cancel();flow.animations=[];}
  function release(){
    if(!mounted)return;const flow=mounted;mounted=undefined;flow.observer.disconnect();win!.clearTimeout(flow.arrivalTimer);cancelAnimations(flow);
    flow.surface.classList.remove('is-docked');flow.surface.removeAttribute('style');flow.slot.style.removeProperty('height');
    if(flow.slot.isConnected)flow.slot.append(flow.surface);else flow.surface.remove();
  }
  function reconcile(){
    if(disposed)return;
    const slot=root.querySelector<HTMLElement>('[data-operations-slot]');
    if(mounted?.slot===slot)return;release();if(!slot){pendingReturnTopic=undefined;return;}
    const surface=slot.querySelector<HTMLElement>('[data-operations-flow]'),track=surface?.querySelector<HTMLElement>('.operations-flow-track'),svg=surface?.querySelector<SVGSVGElement>('.operations-flow-lines');
    if(!surface||!track||!svg)return;
    const key=surface.dataset.flowTopic??'';if(pendingReturnTopic!==key)pendingReturnTopic=undefined;const previous=seen.get(key)??[],steps=[...surface.querySelectorAll<HTMLElement>('[data-flow-step]')];
    steps.forEach((step,i)=>{if(step.dataset.flowState==='confirmed'&&previous[i]!=='confirmed')step.classList.add('is-newly-confirmed');step.style.setProperty('--flow-delay',i*90+'ms');});
    seen.set(key,steps.map(step=>step.dataset.flowState??'pending'));
    const observer=new ResizeObserver(schedule);mounted={slot,surface,track,svg,observer,docked:false,animations:[],arrivalTimer:undefined,arrivalStarted:win!.performance.now(),normalWidth:slot.getBoundingClientRect().width};
    const flow=mounted;flow.arrivalTimer=win!.setTimeout(()=>{flow.arrivalTimer=undefined;for(const step of steps)step.classList.remove('is-newly-confirmed');schedule();},1600);
    observer.observe(slot);observer.observe(surface);schedule();
  }
  function draw(flow:MountedFlow){
    const bounds=flow.track.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
    const steps=[...flow.surface.querySelectorAll<HTMLElement>('[data-flow-step]')];
    const points=steps.map(step=>{const rect=step.querySelector<HTMLElement>('.operations-step-mark')!.getBoundingClientRect();return {x:Math.round((rect.left-bounds.left+rect.width/2)*100)/100,y:Math.round((rect.top-bounds.top+rect.height/2)*100)/100};});
    flow.svg.setAttribute('viewBox','0 0 '+bounds.width+' '+bounds.height);
    const lines:SVGPathElement[]=[];
    for(let i=1;i<points.length;i++){
      const from=points[i-1]!,to=points[i]!;let d:string;
      if(Math.abs(from.y-to.y)>42){const bend=Math.min(bounds.width-3,Math.max(from.x,to.x)+32),middle=(from.y+to.y)/2;d=`M ${from.x} ${from.y} C ${bend} ${from.y}, ${bend} ${middle}, ${from.x} ${middle} S ${to.x} ${middle}, ${to.x} ${to.y}`;}
      else {const middle=(from.x+to.x)/2;d=`M ${from.x} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x} ${to.y}`;}
      const a=steps[i-1]!.dataset.flowState,b=steps[i]!.dataset.flowState;
      const state=a==='confirmed'&&(b==='confirmed'||b==='recorded')?'confirmed':a==='recorded'&&(b==='confirmed'||b==='recorded')?'recorded':'pending';
      const line=root.ownerDocument.createElementNS(svgNs,'path');line.setAttribute('d',d);line.setAttribute('class',state);lines.push(line);
      // A single arrival glint only traverses a known segment when a real confirmation appears.
      if(!reduce.matches&&state==='confirmed'&&(steps[i-1]!.classList.contains('is-newly-confirmed')||steps[i]!.classList.contains('is-newly-confirmed'))){
        const light=root.ownerDocument.createElementNS(svgNs,'path');light.setAttribute('d',d);light.setAttribute('pathLength','120');light.setAttribute('class','operations-line-light');light.style.setProperty('--flow-delay',((i-1)*90-(win!.performance.now()-flow.arrivalStarted))+'ms');lines.push(light);
      }
    }
    // Keep existing paths when geometry is unchanged so a scroll event cannot restart completion motion.
    const signature=lines.map(line=>line.getAttribute('d')+'|'+line.getAttribute('class')).join(';');
    if(flow.svg.dataset.geometry!==signature){flow.svg.dataset.geometry=signature;flow.svg.replaceChildren(...lines);}
  }
  function morph(flow:MountedFlow,dock:boolean){
    const before=flow.surface.getBoundingClientRect(),marks=[...flow.surface.querySelectorAll<HTMLElement>('.operations-step-mark')],positions=marks.map(mark=>mark.getBoundingClientRect());
    cancelAnimations(flow);
    if(dock){flow.slot.style.height=flow.slot.getBoundingClientRect().height+'px';root.append(flow.surface);flow.surface.classList.add('is-docked');flow.docked=true;positionDock(flow);}
    else {flow.docked=false;flow.surface.classList.remove('is-docked');flow.surface.removeAttribute('style');flow.slot.append(flow.surface);}
    const after=flow.surface.getBoundingClientRect(),nextPositions=marks.map(mark=>mark.getBoundingClientRect());draw(flow);
    if(!dock){const borders=win!.getComputedStyle(flow.slot);flow.slot.style.height=(after.height+parseFloat(borders.borderTopWidth)+parseFloat(borders.borderBottomWidth))+'px';}
    if(reduce.matches){if(!dock)flow.slot.style.removeProperty('height');return;}
    const deltaX=before.left-after.left,deltaY=before.top-after.top;
    // FLIP retains the original card's place; a brief rounded waist gives the liquid merge its soft handoff.
    const animation=flow.surface.animate([
      {transform:`translate(${deltaX}px, ${deltaY}px)`,width:before.width+'px',height:before.height+'px',borderRadius:'14px',clipPath:'inset(0% 0% 0% 0% round 14px)'},
      {offset:.48,clipPath:'inset(0% 1.2% 0% 1.2% round 32px)'},
      {transform:'translate(0px, 0px)',width:after.width+'px',height:after.height+'px',borderRadius:dock?'24px':'14px',clipPath:'inset(0% 0% 0% 0% round '+(dock?'24':'14')+'px)'}
    ],{duration:520,easing:'cubic-bezier(.22,.8,.25,1)'});
    flow.animations.push(animation);
    // Labels reflow at their native size; only the node marks follow their old position into the compact rail.
    marks.forEach((mark,i)=>{const next=nextPositions[i]!,old=positions[i]!;flow.animations.push(mark.animate([{transform:`translate(${old.left-before.left-(next.left-after.left)}px, ${old.top-before.top-(next.top-after.top)}px)`},{transform:'translate(0px, 0px)'}],{duration:520,easing:'cubic-bezier(.22,.8,.25,1)'}));});
    animation.onfinish=()=>{flow.animations=[];if(!flow.docked)flow.slot.style.removeProperty('height');schedule();};
  }
  function topbarBottom(){const rect=root.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect();return rect?Math.max(0,rect.bottom):0;}
  function positionDock(flow:MountedFlow){const rect=flow.slot.getBoundingClientRect();
    if(Math.abs(rect.width-flow.normalWidth)>.5){
      // A hidden inert measurement preserves the expanded card's place across responsive row/title changes.
      const measure=flow.surface.cloneNode(true) as HTMLElement;measure.classList.remove('is-docked');measure.removeAttribute('data-operations-flow');measure.removeAttribute('style');measure.inert=true;
      Object.assign(measure.style,{position:'absolute',left:'0px',top:'0px',width:rect.width+'px',visibility:'hidden',pointerEvents:'none'});root.append(measure);
      const borders=win!.getComputedStyle(flow.slot);flow.slot.style.height=(measure.getBoundingClientRect().height+parseFloat(borders.borderTopWidth)+parseFloat(borders.borderBottomWidth))+'px';measure.remove();flow.normalWidth=rect.width;
    }
    flow.surface.style.left=(rect.left+8)+'px';flow.surface.style.top=(topbarBottom()+8)+'px';flow.surface.style.width=Math.max(0,rect.width-16)+'px';}
  function update(){
    reconcile();const flow=mounted;if(!flow)return;
    const top=flow.slot.getBoundingClientRect().top,bottom=topbarBottom();
    if(!flow.docked&&top<bottom-2)morph(flow,true);
    else if(flow.docked&&top>=bottom+2)morph(flow,false);
    if(flow.docked)positionDock(flow);draw(flow);
    if(!flow.docked&&pendingReturnTopic===flow.surface.dataset.flowTopic){pendingReturnTopic=undefined;flow.surface.querySelector<HTMLElement>('h2')?.focus({preventScroll:true});}
  }
  const mutations=new MutationObserver(reconcile);mutations.observe(root,{childList:true,subtree:true});
  win.addEventListener('scroll',schedule,{capture:true,passive:true,signal:abort.signal});win.addEventListener('resize',schedule,{passive:true,signal:abort.signal});
  reduce.addEventListener('change',()=>{if(mounted)cancelAnimations(mounted);schedule();},{signal:abort.signal});
  root.addEventListener('click',event=>{const target=event.target as Element;if(!target.closest('[data-operations-return]')||!mounted)return;event.preventDefault();pendingReturnTopic=mounted.surface.dataset.flowTopic;const slot=mounted.slot;slot.style.scrollMarginTop=(topbarBottom()+12)+'px';slot.scrollIntoView({block:'start',behavior:reduce.matches?'instant':'smooth'});},{signal:abort.signal});
  function dispose(){if(disposed)return;disposed=true;abort.abort();mutations.disconnect();if(frame!==undefined)win!.cancelAnimationFrame(frame);release();seen.clear();}
  win.addEventListener('pagehide',event=>{if(event.persisted){if(mounted)cancelAnimations(mounted);if(frame!==undefined)win!.cancelAnimationFrame(frame);frame=undefined;}else dispose();},{signal:abort.signal});
  win.addEventListener('pageshow',schedule,{signal:abort.signal});reconcile();return dispose;
}
