import type {TopicSummary,TopicReadState} from '@workbench/contracts';
import type {DatabaseSync} from '@workbench/storage/connection';

// Metadata only: a saved head is not proof of nonempty text or a finished draft.
// Approval always refers to the current core head, never a historical revision.
export function withTopicReadState(db:DatabaseSync,workspace:string,topics:TopicSummary[]):TopicSummary[]{
 if(!topics.length)return topics;
 const placeholders=topics.map(()=>'?').join(','),ids=topics.map(topic=>topic.id);
 const cores=db.prepare(`SELECT t.id,d.head_revision_id,d.version,EXISTS(SELECT 1 FROM core_approvals a WHERE a.workspace_id=t.workspace_id AND a.topic_id=t.id AND a.revision_id=d.head_revision_id) AS confirmed FROM topics t JOIN documents d ON d.workspace_id=t.workspace_id AND d.id=t.core_document_id WHERE t.workspace_id=? AND t.id IN(${placeholders})`).all(workspace,...ids);
 const variants=db.prepare(`SELECT v.id,v.topic_id,v.platform,v.format,v.document_id,v.based_on_core_revision_id,d.head_revision_id,d.version AS document_version,r.parent_revision_id FROM variants v JOIN documents d ON d.workspace_id=v.workspace_id AND d.id=v.document_id LEFT JOIN document_revisions r ON r.workspace_id=d.workspace_id AND r.document_id=d.id AND r.id=d.head_revision_id WHERE v.workspace_id=? AND v.topic_id IN(${placeholders}) ORDER BY v.platform,v.format,v.id`).all(workspace,...ids);
 const states=new Map<string,TopicReadState>();for(const core of cores)states.set(String(core.id),{core_revision_id:core.head_revision_id as string|null,core_version:Number(core.version),core_confirmed:core.confirmed===1,variants:[]});
 for(const variant of variants){const {topic_id,...row}=variant;states.get(String(topic_id))?.variants.push(row as unknown as TopicReadState['variants'][number]);}
 return topics.map(topic=>({...topic,read_state:states.get(topic.id)}));
}
