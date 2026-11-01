// 固定计划读取 port 保留服务内校验路径；HTTP 只暴露实体引用与 hash。
export function planReferenceView(value:unknown):unknown {
  if(Array.isArray(value))return value.map(planReferenceView);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='file_path'&&key!=='resolved_texts').map(([key,item])=>[key,planReferenceView(item)]));
  return value;
}
