import type { DocumentSnapshot, SaveRevisionResponse, ServiceIdentity } from '@workbench/contracts';
import type { WorkbenchClient } from './workbench-client.ts';

export type DraftStatus='committed'|'dirty'|'saving'|'offline'|'conflict';
export interface PendingSaveCommand { text:string; expected_revision_id:string|null; idempotency_key:string; generation:number }
export interface UnsubmittedDraft { identity:ServiceIdentity; document_id:string; base_revision_id:string|null; text:string; generation:number; pending_command:PendingSaveCommand|null; edited_at:string }
export interface DraftStorage { getItem(key:string):string|null; setItem(key:string,value:string):void; removeItem(key:string):void }
export class DocumentDraft {
  private text:string;
  private acknowledgedText:string;
  private revision:string|null;
  private generation=0;
  private committedGeneration=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private saving:Promise<void>|null=null;
  private blocked=false;
  private pending:PendingSaveCommand|null=null;
  private readonly key:string;
  private readonly client:WorkbenchClient;
  private readonly identity:ServiceIdentity;
  private readonly snapshot:DocumentSnapshot;
  private readonly storage:DraftStorage;
  private notify:(status:DraftStatus,text:string)=>void;
  status:DraftStatus='committed';
  constructor(client:WorkbenchClient,identity:ServiceIdentity,snapshot:DocumentSnapshot,storage:DraftStorage,notify:(status:DraftStatus,text:string)=>void=()=>{}){
    this.client=client;this.identity=identity;this.snapshot=snapshot;this.storage=storage;this.notify=notify;
    this.key=['flowo-unsubmitted-v1',identity.service_instance_id,identity.workspace_id,snapshot.document_id].map(encodeURIComponent).join(':');
    this.text=snapshot.text;this.acknowledgedText=snapshot.text;this.revision=snapshot.head_revision_id;
    try{
      const saved=JSON.parse(storage.getItem(this.key)||'null') as UnsubmittedDraft|null;
      if(saved&&typeof saved.text==='string'&&saved.identity.workspace_id===identity.workspace_id&&saved.identity.service_instance_id===identity.service_instance_id&&saved.document_id===snapshot.document_id){
        this.text=saved.text;this.generation=saved.generation??1;this.pending=saved.pending_command??null;
        // ACK丢失时，远端head变化可能正是本命令提交的结果；先重放原key取回收据。
        if(this.pending){this.revision=saved.base_revision_id;this.status='dirty';}
        else if(saved.base_revision_id!==snapshot.head_revision_id){this.status='conflict';this.blocked=true;}else this.status='dirty';
      }
    }catch{this.status='offline';}
    this.notify(this.status,this.text);
  }
  value(){return this.text;}
  acknowledged(){return {revision_id:this.revision,text:this.acknowledgedText,generation:this.committedGeneration};}
  markConflict(){this.blocked=true;this.generation++;this.status='conflict';this.cache();this.notify(this.status,this.text);}
  // 仅显式对照冲突后允许以最新已读 head 重存本机输入；CAS 仍会阻止再次变化。
  resolveConflict(snapshot:DocumentSnapshot){if(this.status!=='conflict'||snapshot.document_id!==this.snapshot.document_id)throw new Error('先对照当前文稿的版本冲突');this.revision=snapshot.head_revision_id;this.pending=null;this.blocked=false;this.edit(this.text);}
  // 同一草稿持续保存，但界面订阅跟随当前读取，不能保留离页时的回调。
  bindNotify(notify:(status:DraftStatus,text:string)=>void=()=>{}){this.notify=notify;this.notify(this.status,this.text);}
  syncSnapshot(snapshot:DocumentSnapshot){
    // 仅已确认且无待提交命令时接收服务端新 head，避免采用后继续写旧 base。
    if(this.status!=='committed'||this.saving||this.pending||this.generation!==this.committedGeneration)return;
    this.revision=snapshot.head_revision_id;this.text=snapshot.text;this.acknowledgedText=snapshot.text;this.notify(this.status,this.text);
  }
  edit(text:string){this.text=text;this.generation++;this.status=this.blocked?'conflict':'dirty';this.cache();this.notify(this.status,text);clearTimeout(this.timer);if(!this.blocked)this.timer=setTimeout(()=>void this.flush(),1000);}
  private cache(){
    try{this.storage.setItem(this.key,JSON.stringify({identity:this.identity,document_id:this.snapshot.document_id,base_revision_id:this.revision,text:this.text,generation:this.generation,pending_command:this.pending,edited_at:new Date().toISOString()} satisfies UnsubmittedDraft));}
    catch{this.status='offline';}
  }
  async flush():Promise<void>{
    clearTimeout(this.timer);
    if(this.saving)return this.saving;
    if(this.blocked||this.generation===this.committedGeneration)return;
    this.saving=(async()=>{
      while(!this.blocked&&this.generation!==this.committedGeneration){
        const command=this.pending??{generation:this.generation,text:this.text,expected_revision_id:this.revision,idempotency_key:crypto.randomUUID()};
        this.pending=command;this.cache();
        this.status='saving';this.notify(this.status,this.text);
        try{
          const result:SaveRevisionResponse=await this.client.saveDocument(this.snapshot.document_id,{text:command.text,origin:'human',expected_revision_id:command.expected_revision_id},{idempotencyKey:command.idempotency_key});
          if(result.save_state!=='committed')throw new Error('服务尚未确认修订');
          this.revision=result.revision_id;this.acknowledgedText=command.text;this.committedGeneration=command.generation;this.pending=null;
          if(command.generation===this.generation){this.status='committed';try{this.storage.removeItem(this.key);}catch{this.status='offline';}}
          else{this.status='dirty';this.cache();}
          this.notify(this.status,this.text);
        }catch(error){
          const code=error&&typeof error==='object'&&'response' in error?String((error as {response:{error:{code:string}}}).response.error.code):'';
          this.blocked=code==='REVISION_CONFLICT'||code==='VERSION_CONFLICT';this.status=this.blocked?'conflict':'offline';this.cache();this.notify(this.status,this.text);break;
        }
      }
    })().finally(()=>{this.saving=null;});
    return this.saving;
  }
  // 离页先保留未提交副本；后台生命周期与用户关闭任务弹窗分别处理。
  leave(){if(this.generation!==this.committedGeneration)this.cache();return this.flush();}
  dispose(){clearTimeout(this.timer);if(this.generation!==this.committedGeneration)this.cache();this.notify=()=>{};}
}

export class DraftRegistry {
  private readonly documents=new Map<string,DocumentDraft>();
  private readonly client:WorkbenchClient;
  private readonly identity:ServiceIdentity;
  private readonly storage:DraftStorage;
  constructor(client:WorkbenchClient,identity:ServiceIdentity,storage:DraftStorage){this.client=client;this.identity=identity;this.storage=storage;}
  status(documentId:string){return this.documents.get(documentId)?.status;}
  attach(snapshot:DocumentSnapshot,notify?:(status:DraftStatus,text:string)=>void){
    let draft=this.documents.get(snapshot.document_id);
    if(!draft){draft=new DocumentDraft(this.client,this.identity,snapshot,this.storage,notify);this.documents.set(snapshot.document_id,draft);}
    else {draft.bindNotify(notify);draft.syncSnapshot(snapshot);}
    return draft;
  }
  async leave(){await Promise.allSettled([...this.documents.values()].map(draft=>draft.leave()));}
  dispose(){for(const draft of this.documents.values())draft.dispose();this.documents.clear();}
}
