import test from 'node:test';
import assert from 'node:assert/strict';
import {PublishingSettingsController} from '../../apps/web/src/features/settings/publishing.ts';
import type {PublishingSettingsLocation} from '../../packages/contracts/src/index.ts';

test('平台键盘焦点等待导航完成，晚回执不能抢回相同平台的新入口或其他平台',async()=>{
  const abort=new AbortController(),pending:Array<()=>void>=[];let focus=0;
  class Dialog extends EventTarget {open=false;id='';setAttribute(){}close(){this.open=false;}remove(){}}
  const dialog=new Dialog(),root={ownerDocument:{createElement:()=>dialog},append(){},querySelector:()=>({focus(){focus++;}})} as unknown as HTMLElement;
  let controller:PublishingSettingsController;
  controller=new PublishingSettingsController({root,signal:abort.signal,client:{} as never,identity:()=>undefined,render(){},toast(){},navigate(location){controller.deactivate();controller.setLocation(location as PublishingSettingsLocation);return new Promise<void>(done=>pending.push(done));}});
  const key=()=>({key:'ArrowRight',preventDefault(){},target:{closest:()=>({dataset:{platform:'x'}})}} as unknown as KeyboardEvent);
  controller.handleKey(key());assert.equal(focus,0);
  controller.deactivate();controller.setLocation({page:'settings',settings_view:'publishing',platform:'douyin',account_id:'new-owner'});pending.shift()!();await Promise.resolve();assert.equal(focus,0);
  controller.setLocation({page:'settings',settings_view:'publishing',platform:'x'});controller.handleKey(key());pending.shift()!();await Promise.resolve();assert.equal(focus,1);
  controller.setLocation({page:'settings',settings_view:'publishing',platform:'x'});controller.handleKey(key());controller.setLocation({page:'settings',settings_view:'publishing',platform:'wechat'});pending.shift()!();await Promise.resolve();assert.equal(focus,1);
  abort.abort();controller.dispose();
});
