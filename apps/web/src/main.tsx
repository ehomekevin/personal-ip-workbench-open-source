import './styles/configuration.css';
import {createRoot} from 'react-dom/client';
import packageInfo from '../../../package.json';
import {Workbench} from './app/Workbench.tsx';
import {createHttpClient} from './transport/workbench-client.ts';
import {createDataFeaturePorts} from './transport/data-features.ts';
import type {WorkbenchInjection} from './transport/feature-ports.ts';
import './styles/approved.css';
import './styles/skills.css';
import './styles/today-continuation.css';

declare global {interface Window {__WORKBENCH_INJECTION__?:WorkbenchInjection}}
const selectedMode=new URLSearchParams(location.search).get('mode')??document.querySelector<HTMLMetaElement>('meta[name="workbench-mode"]')?.content;
const mode=selectedMode==='real'?'real':'demo';
const injection:WorkbenchInjection=window.__WORKBENCH_INJECTION__??{mode,client:mode==='real'?createHttpClient():undefined,features:mode==='real'?createDataFeaturePorts():undefined};
createRoot(document.getElementById('root')!).render(<Workbench injection={injection} releaseVersion={packageInfo.version}/>);
import './features/operations/operations.css';
