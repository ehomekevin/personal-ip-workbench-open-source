import {useLayoutEffect,useRef} from 'react';
import {mountReleaseNotice} from './release-notice.ts';
import {approvedShell} from '../components/approvedShell.ts';
import type {WorkbenchInjection} from '../transport/feature-ports.ts';
import {mountReal} from './real-controller.ts';
import '../styles/publishing-settings.css';
import '../styles/benchmark-research.css';
import '../styles/x-post-card.css';
import {mountXPostCards} from '../components/x-post-card.ts';
import '../styles/writing-flow.css';
import '../styles/speech-input.css';
import '../styles/generation-progress.css';
import '../features/operations/operations.css';
import '../features/operations/flow-motion.css';

// 独立页面与未来插件只注入transport/feature ports，共用这一个React组件。
export function Workbench({injection,releaseVersion}:{injection:WorkbenchInjection;releaseVersion?:string}){
  const root=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    let dispose:(()=>void)|undefined,cancelled=false;
    if(!root.current)return;
    const element=root.current;
    const disposeReleaseNotice=releaseVersion && mountReleaseNotice(element,releaseVersion);
    const disposeXPostCards=mountXPostCards(element);
    if(injection.mode==='demo')void import('../demo/controller.ts').then(({mountDemo})=>{if(!cancelled)dispose=mountDemo(element).dispose;});
    else dispose=mountReal(element,injection).dispose;
    return()=>{cancelled=true;if(disposeReleaseNotice)disposeReleaseNotice();disposeXPostCards();dispose?.();};
  },[injection,releaseVersion]);
  return <div ref={root} dangerouslySetInnerHTML={{__html:approvedShell}}/>;
}
