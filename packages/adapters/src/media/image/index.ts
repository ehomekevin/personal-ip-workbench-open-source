import { ContractError } from '@workbench/contracts';
import { AgyImageProvider, probeAgyAccess, type ImageAccessProbe } from './agy.ts';
import { CodexImageProvider } from './codex.ts';
import type { ImageProviderId, ImageProviderOptions, ImageProviderPort } from './types.ts';
export type * from './types.ts';
export * from './capabilities.ts';
export * from './brief.ts';
export { AgyImageProvider, CodexImageProvider, probeAgyAccess };
export type { ImageAccessProbe };
export function createImageProvider(provider: ImageProviderId, options: ImageProviderOptions = {}): ImageProviderPort {
  if (provider === 'agy') return new AgyImageProvider(options);
  if (provider === 'codex') return new CodexImageProvider(options);
  throw new ContractError('CAPABILITY_UNSUPPORTED', '未配置该图像 provider', { pre_submit_failure: true });
}
