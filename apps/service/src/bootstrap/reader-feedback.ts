import { createTikHubReaderFeedbackAdapter } from '@workbench/adapters/tikhub';
import type { ApplicationContext, ReaderFeedbackPort } from '@workbench/domain/ports';
import { readTikHubCredential } from './tikhub-credentials.ts';

export function createReaderFeedbackRuntime(context:ApplicationContext,env:NodeJS.ProcessEnv=process.env):ReaderFeedbackPort {
  return createTikHubReaderFeedbackAdapter({token_provider:()=>readTikHubCredential(context.paths.state_root)||env.TIKHUB_API_KEY?.trim()||null});
}
