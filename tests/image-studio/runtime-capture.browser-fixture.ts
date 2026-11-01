import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {chromium,type Browser,type Page} from '@playwright/test';
import {managedFiniteCapture} from './runtime-capture.ts';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
test('own actual loopback server, browser and page close after a delayed newPage return',{timeout:15000},async()=>{
 const entered=deferred(),release=deferred();let server:Server|undefined,browser:Browser|undefined,page:Page|undefined,frames=0;
 const controller=new AbortController(),capture=managedFiniteCapture<{},Server,Browser,Page>({
  build:async()=>({}),createServer(){return server=createServer((_req,res)=>res.end('owned resource fixture'));},listen:server=>new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)),
  async launch(){return browser=await chromium.launch({headless:true,timeout:10000});},
  async newPage(browser){page=await browser.newPage();entered.resolve();await release.promise;return page;},capture:async()=>{frames++;},
  closePage:page=>page.close(),closeBrowser:browser=>browser.close(),closeServer:server=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());})
 });
 const pending=capture.capture(0,controller.signal);void pending.catch(()=>{});
 try{
  await Promise.race([entered.promise,pending.then(()=>{throw new Error('Capture completed before its own page fixture');})]);assert.equal(server?.listening,true);assert.equal(browser?.isConnected(),true);assert.equal(page?.isClosed(),false);
  controller.abort(new Error('Owned fixture stop during delayed newPage'));let closed=false;const closing=capture.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  release.resolve();await assert.rejects(pending);await closing;assert.equal(server?.listening,false);assert.equal(browser?.isConnected(),false);assert.equal(page?.isClosed(),true);assert.equal(frames,0);assert.equal(capture.snapshot().fully_closed,true);
 }finally{release.resolve();await capture.close();}
});
