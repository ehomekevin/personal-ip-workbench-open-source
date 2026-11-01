// 账号研究（手动账号抽屉、研究报告）按需加载：资料页首次读取账号或处理账号动作时才加载模块。
// 两个同步函数只维护本模块内的抽屉代次：已加载时同步调用；未加载时加载后补调（模块可能已被其他入口直接引用而持有抽屉状态）。
import type { FeatureAction, FeatureContext } from '../../../transport/feature-ports.ts';
import { lazyModule } from '../../../app/lazy-features.ts';
const manual = lazyModule(() => import('./index.ts'));
type Manual = typeof import('./index.ts');
function call(run: (loaded: Manual) => void) { if (manual.value) run(manual.value); else void manual.load().then(run, () => undefined); }
export function notifyManualAccountDialogPresentation(client: object, dialog: object): void { call(loaded => loaded.notifyManualAccountDialogPresentation(client, dialog)); }
export function invalidateManualAccountDialog(client: object): void { call(loaded => loaded.invalidateManualAccountDialog(client)); }
export async function listManualAccounts(context: FeatureContext): ReturnType<Manual['listManualAccounts']> { return (await manual.load()).listManualAccounts(context); }
export async function dispatchManualAccount(action: FeatureAction, context: FeatureContext): Promise<boolean> { return (await manual.load()).dispatchManualAccount(action, context); }
