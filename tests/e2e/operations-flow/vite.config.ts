import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {mergeConfig} from 'vite';
import webConfig from '../../../apps/web/vite.config.ts';
const root=fileURLToPath(new URL('.',import.meta.url)),project=resolve(root,'../../..');
export default mergeConfig(webConfig,{root,publicDir:resolve(project,'apps/web/public'),build:{outDir:resolve(project,'.ci-artifacts/flow-motion-e2e-app'),emptyOutDir:false,rollupOptions:{input:{index:resolve(root,'index.html'),away:resolve(root,'away.html')}}},preview:{host:'127.0.0.1',port:Number(process.env.FLOW_MOTION_E2E_PORT??5197),strictPort:true}});
