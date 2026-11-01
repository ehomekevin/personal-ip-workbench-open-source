import {P} from '../components/metadata.ts';
import type {TodayProjection,RetroProjection,UiState} from '../app/view-model.ts';

// 批准原型的示例值只在 demo 命名空间构造；真实模块必须给出服务投影。
export function demoProjections(ui:Readonly<UiState>):{today:TodayProjection;retro:RetroProjection} {
  const scale=[1,1.7,3.5,2.7,2.2][Object.keys(P).indexOf(ui.retroPlatform)]!*(ui.period/7);
  const current=[1200,1500,1300,2100,1800,2400,2200].map(n=>Math.round(n*scale));
  const previous=[1100,1300,1400,1500,1600,1700,1800].map(n=>Math.round(n*scale));
  const total=current.reduce((a,b)=>a+b,0),prior=previous.reduce((a,b)=>a+b,0);
  return {
    today:{dateHeading:'FRIDAY / OCTOBER 09, 2026',budgetMinutes:120,favoritePercent:4.8,favoriteDelta:'+0.9',comparableWorks:8,next:{time:'20:00',platform:'wechat',title:'工作流思考 · 平台草稿'},spark:{previousPath:'M0 70 40 57 80 62 120 44 160 39 200 36 240 46 280 24',currentPath:'M0 69 40 63 80 44 120 54 160 26 200 37 240 20 280 9'}},
    retro:{current,previous,total,deltaPercent:(total/prior-1)*100,currentWorks:ui.period===7?8:16,previousWorks:ui.period===7?7:14,snapshots:{at24h:Math.round(1800*scale),at72h:Math.round(3200*scale)},peer:{ownRatio:1.1,benchmarkRatio:1.3},works:[{id:'w1',title:'用一个真实任务测试 AI',metric:Math.round(3200*scale),interactionRate:'6.2%'},{id:'w2',title:'先看结果，再看工具',metric:Math.round(4600*scale),interactionRate:'7.1%'},{id:'w3',title:'让 AI 进入日常工作流',metric:null,interactionRate:null}]}
  };
}
