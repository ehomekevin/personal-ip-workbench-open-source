import { ContractError, type CapabilityDescription, type JsonObject, type PublishInput, type PublishResult } from '@workbench/contracts';
export const BILIBILI_PUBLISHER_VERSION='wp22-bilibili/1.0.0-blocked';
export class BilibiliPublisher {
  async describe():Promise<CapabilityDescription[]>{return ['prepareDraft','submit','queryResult'].map(operation=>({operation,status:'unverified' as const,limitations:['当前官方页面只有文档壳；预处理、合片、投稿、查询及终态枚举未建立完整合同'],verified_at:null,evidence_ref: null}));}
  private blocked(input:PublishInput):never{throw new ContractError(input.platform==='bilibili'&&input.format==='long_video'?'CAPABILITY_UNVERIFIED':'CAPABILITY_UNSUPPORTED','B站当前自动投稿与结果查询合同未核对，需补官方正文及账号实证',{adapter_version:BILIBILI_PUBLISHER_VERSION,network_calls:0});}
  async validateInput(input:PublishInput):Promise<JsonObject>{return this.blocked(input);}
  async prepareDraft(input:PublishInput):Promise<PublishResult>{return this.blocked(input);}
  async submit(input:PublishInput):Promise<PublishResult>{return this.blocked(input);}
  async queryResult(input:PublishInput):Promise<PublishResult>{return this.blocked(input);}
}
export const createBilibiliPublisher=():BilibiliPublisher=>new BilibiliPublisher();
