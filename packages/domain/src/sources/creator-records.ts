import type { JsonObject, NormalizedSourceRecord } from '@workbench/contracts';
import { readSourcePayload } from '@workbench/storage/sources';
import type { DatabaseSync } from '@workbench/storage/connection';
const object=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
const mapping=(w:string,id:string)=>'creator-record.v1:'+w+':'+id;
export function findCreatorRecords(db:DatabaseSync,workspace:string,record:NormalizedSourceRecord):{existing_record_id?:string;other_ids:string[];candidate_ids:string[]}{
  const meta=object(record.payload.provider_metadata.creator_feed),ids=object(meta.ids),current=String(meta.candidate_id),aliases=Array.isArray(ids.aliases)?ids.aliases.filter((a):a is string=>typeof a==='string'):[],candidateIds=[current,...aliases.map(a=>'event_'+a)];
  const mapped=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(mapping(workspace,current));
  const rows=db.prepare("SELECT r.* FROM source_records r JOIN sources s ON s.workspace_id=r.workspace_id AND s.id=r.source_id WHERE r.workspace_id=? AND s.kind='personal_site' AND r.record_kind=? ORDER BY r.created_at,r.id").all(workspace,record.record_kind);
  const matched=rows.filter(row=>{const p=readSourcePayload(row),old=object(p.provider_metadata.creator_feed);return candidateIds.includes(String(old.candidate_id))||meta.type==='event'&&[ids.eventId,...aliases].includes(String(p.provider_metadata.event_id));});
  const mappedId=mapped?String(JSON.parse(String(mapped.value)).record_id):undefined;
  const chosen=matched.find(r=>r.id===mappedId)??matched.find(r=>object(readSourcePayload(r).provider_metadata.creator_feed).candidate_id===current||readSourcePayload(r).provider_metadata.event_id===ids.eventId)??matched[0];
  return {...(chosen?{existing_record_id:String(chosen.id)}:{}),other_ids:matched.filter(r=>r!==chosen).map(r=>String(r.id)),candidate_ids:candidateIds};
}
export function storeCreatorRecords(db:DatabaseSync,workspace:string,recordId:string,record:NormalizedSourceRecord,matches:ReturnType<typeof findCreatorRecords>){
  const current=db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(workspace,recordId)!,currentPayload=readSourcePayload(current);
  if(currentPayload.provider_metadata.creator_feed_merge){delete currentPayload.provider_metadata.creator_feed_merge;currentPayload.parser_warnings=currentPayload.parser_warnings.filter(w=>w!=='此历史事件已并入新的候选；原资料和已有引用保留。');db.prepare('UPDATE source_records SET payload=? WHERE workspace_id=? AND id=?').run(JSON.stringify(currentPayload),workspace,recordId);}
  for(const id of matches.candidate_ids)db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(mapping(workspace,id),JSON.stringify({record_id:recordId}));
  // 不删除历史记录、不改稿件的冻结引用；本期只展示规范记录，旧记录保留合并关系和原文。
  for(const oldId of matches.other_ids){const row=db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(workspace,oldId)!;const p=readSourcePayload(row);p.provider_metadata.creator_feed_merge={record_id:recordId,candidate_id:record.external_id,site_url:record.canonical_url};p.parser_warnings=[...new Set([...p.parser_warnings,'此历史事件已并入新的候选；原资料和已有引用保留。'])];if(record.canonical_url)p.external_links=[...new Set([...p.external_links,record.canonical_url])];db.prepare('UPDATE source_records SET payload=? WHERE workspace_id=? AND id=?').run(JSON.stringify(p),workspace,oldId);}
}
