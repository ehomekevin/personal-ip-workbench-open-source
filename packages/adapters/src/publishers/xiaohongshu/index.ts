import { ContractError, type CapabilityDescription, type JsonObject, type PublishInput, type PublishResult } from '@workbench/contracts';
export const XIAOHONGSHU_PUBLISHER_VERSION='wp21-xiaohongshu/1.0.0-blocked';
export class XiaohongshuPublisher {
  async describe():Promise<CapabilityDescription[]>{return [{operation:'automatic_publish',status:'unverified',limitations:['未取得当前后台公开发布及持久草稿/结果查询合同；分享回调不证明公开'],verified_at:null,evidence_ref: null},{operation:'auto_fill_text',status:'unsupported',limitations:['WP06官方分享SDK交接明确不支持自动填标题、正文与话题'],verified_at:null,evidence_ref: null}];}
  private blocked(input:PublishInput):never{throw new ContractError(input.platform==='xiaohongshu'&&['image_post','short_video'].includes(input.format)?'CAPABILITY_UNVERIFIED':'CAPABILITY_UNSUPPORTED','小红书自动发布合同未核对，需明确人工发布后核对稳定作品身份',{adapter_version:XIAOHONGSHU_PUBLISHER_VERSION,network_calls:0});}
  async validateInput(input:PublishInput):Promise<JsonObject>{return this.blocked(input);}
  async prepareDraft(input:PublishInput):Promise<PublishResult>{return this.blocked(input);}
  async submit(input:PublishInput):Promise<PublishResult>{return this.blocked(input);}
  async queryResult(input:PublishInput):Promise<PublishResult>{return this.blocked(input);}
}
export const createXiaohongshuPublisher=():XiaohongshuPublisher=>new XiaohongshuPublisher();
