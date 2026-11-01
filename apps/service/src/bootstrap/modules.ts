import {createImageStudioModule} from '../routes/image-studio.ts';
import {createArticleLayoutModule} from '../routes/article-layout.ts';
import {createSpeechInputModule} from '../routes/speech-input.ts';
import {createWritingFlowModule} from '../routes/writing-flow.ts';
import { createSkillsModule } from '../routes/skills.ts';
import { createConfigurationModule } from '../routes/configuration.ts';
import type { ModuleFactory } from '@workbench/domain/ports';
import { createDocumentsModule } from '../routes/documents.ts';
import { createTopicsModule } from '../routes/topics.ts';
import { createReaderFeedbackRuntime } from './reader-feedback.ts';
import { createAssetsModule } from '../routes/assets.ts';
import { createWorksModule } from '../routes/works.ts';
import { createMetricsModule } from '../routes/metrics.ts';
import { createOverviewModule } from '../routes/overview.ts';
import { createDailyPlansModule } from '../routes/daily-plans.ts';
import { createRetroModule } from '../routes/retro.ts';
import { createBusinessOutcomesModule } from '../routes/business-outcomes.ts';
import { createSourcesModule } from '../routes/sources.ts';
import { createBenchmarkAccountsModule } from '../routes/benchmark-accounts.ts';
import { createKnowledgeModule } from '../routes/knowledge.ts';
import { createComparisonsModule } from '../routes/comparisons.ts';
import { createSettingsModule } from '../routes/settings.ts';
import { createJobsModule } from '../routes/jobs.ts';
import { HostRuns } from '@workbench/domain/host-runs';
import { Publications } from '@workbench/domain/publications';
import type { ApplicationContext } from '@workbench/domain/ports';
import { createGenerationModule } from '../routes/generation.ts';
import { createRecommendationsModule } from '../routes/recommendations.ts';
import { createHostObserversModule } from '../routes/host-observers.ts';
import { createHostRunsModule } from '../routes/host-runs.ts';
import { createHostCapabilitiesModule } from '../routes/host-capabilities.ts';
import { createContentPlansModule } from '../routes/content-plans.ts';
import { createProductionPlansModule } from '../routes/production-plans.ts';
import { createArtifactsModule } from '../routes/artifacts.ts';
import { createPublicationsModule } from '../routes/publications.ts';
import { createSchedulesModule } from '../routes/schedules.ts';
import { createExecutionModule } from './execution.ts';
import { PublishingSettings } from '@workbench/domain/publishing-settings';
import { createPublishingSettingsModule } from '../routes/publishing-settings.ts';
import { createPublishingRuntime, readLegacyPublishingImport } from './publishing-runtime.ts';
import { createCollectionRuntime } from './collection-runtime.ts';
import { configuredWechatChannel } from './wechat/channel.ts';
import { Metrics } from '@workbench/domain/metrics';
import type { TikHubAdapter } from '@workbench/adapters/tikhub';
const collectionAdapters=new WeakMap<ApplicationContext,TikHubAdapter>();
function collection(context:ApplicationContext){let adapter=collectionAdapters.get(context);if(!adapter){adapter=createCollectionRuntime(context);collectionAdapters.set(context,adapter);}return adapter;}
const hosts=new WeakMap<ApplicationContext,HostRuns>(),publications=new WeakMap<ApplicationContext,Publications>(),publishingSettings=new WeakMap<ApplicationContext,PublishingSettings>();
function host(context:ApplicationContext){let runs=hosts.get(context);if(!runs){runs=new HostRuns(context);hosts.set(context,runs);}return runs;}
function publishing(context:ApplicationContext){let settings=publishingSettings.get(context);if(!settings){const runtime=createPublishingRuntime(context);settings=new PublishingSettings(context,{runtime,legacyImport:readLegacyPublishingImport(context,runtime)});publishingSettings.set(context,settings);}return settings;}
function publication(context:ApplicationContext){let service=publications.get(context);if(!service){service=new Publications(context,{publishingSettings:publishing(context),metrics:new Metrics(context,{adapter:collection(context)})});publications.set(context,service);}return service;}
// 原生 observer 在 jobs recovery 前清除磁盘 readiness；所有原生输出共用同一 finalizer。
export const DEFAULT_MODULE_FACTORIES:ModuleFactory[]=[
 createDocumentsModule,context=>createTopicsModule(context,{feedback:createReaderFeedbackRuntime(context)}),createAssetsModule,createWorksModule,context=>createMetricsModule(context,{adapter:collection(context)}),createOverviewModule,createDailyPlansModule,createRetroModule,createBusinessOutcomesModule,createSettingsModule,createConfigurationModule,createSpeechInputModule,createSkillsModule,context=>createPublishingSettingsModule(context,publishing(context)),
 createHostCapabilitiesModule,context=>createHostObserversModule(context,host(context)),context=>createHostRunsModule(context,host(context)),context=>createJobsModule(context,host(context)),
 createSourcesModule,context=>createBenchmarkAccountsModule(context,{adapter:collection(context),wechat:configuredWechatChannel(context)}),createKnowledgeModule,createComparisonsModule,createGenerationModule,createWritingFlowModule,createRecommendationsModule,createContentPlansModule,createProductionPlansModule,createArtifactsModule,createImageStudioModule,createArticleLayoutModule,
 context=>createSchedulesModule(context,{publications:publication(context)}),context=>createPublicationsModule(context,{publications:publication(context)}),createExecutionModule
];
