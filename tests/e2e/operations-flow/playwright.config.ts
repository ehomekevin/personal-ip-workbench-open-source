import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const port=Number(process.env.FLOW_MOTION_E2E_PORT??5197),baseURL='http://127.0.0.1:'+port;
const report=resolve('.ci-artifacts/flow-motion-e2e');
export default defineConfig({
 testDir:'.',testMatch:'operations-flow.spec.ts',workers:1,retries:0,timeout:45000,
 outputDir:resolve(report,'test-results'),reporter:[['list'],['json',{outputFile:resolve(report,'results.json')}],['html',{outputFolder:resolve(report,'html'),open:'never'}]],
 use:{baseURL,viewport:{width:1275,height:900},browserName:'chromium',channel:'chromium',locale:'zh-CN',reducedMotion:'no-preference',trace:'retain-on-failure',screenshot:'only-on-failure',launchOptions:{ignoreDefaultArgs:['--disable-back-forward-cache']}},
 webServer:{cwd:resolve(fileURLToPath(new URL('.',import.meta.url)),'../../..'),command:'pnpm exec vite build --config tests/e2e/operations-flow/vite.config.ts && pnpm exec vite preview --config tests/e2e/operations-flow/vite.config.ts',url:baseURL,reuseExistingServer:false,timeout:45000}
});
