import {build} from 'vite';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,statSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
const root=process.cwd(),web=join(root,'apps/web'),runtime=join(root,'runtime/platform-layout-integration-r1/ui-combined');
const evidence=join(resolve(process.env.PLATFORM_LAYOUT_EVIDENCE??join(runtime,'evidence')),'ui-combined');
mkdirSync(runtime,{recursive:true});mkdirSync(evidence,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(join(p,d.name)):[join(p,d.name)]);
const snapshot=p=>({path:relative(root,p),bytes:statSync(p).size,sha256:sha(readFileSync(p)),mode:statSync(p).mode&0o777});
const beforeFiles=[...walk(join(web,'src')),...walk(join(web,'public')),join(web,'index.html'),join(web,'vite.config.ts'),join(web,'package.json'),join(root,'package.json'),join(root,'pnpm-lock.yaml'),join(root,'pnpm-workspace.yaml')];
const before=beforeFiles.map(snapshot);const transformed=new Map(),graph=[],chunks=[];
const audit={name:'integration-read-only-build-audit',enforce:'pre',
 transform(code,id){transformed.set(id,{id,transform_input_bytes:Buffer.byteLength(code),transform_input_sha256:sha(code)});return null;},
 generateBundle(_options,bundle){
  for(const id of this.getModuleIds()){const m=this.getModuleInfo(id);graph.push({id,isEntry:m.isEntry,isExternal:m.isExternal,importedIds:m.importedIds,dynamicallyImportedIds:m.dynamicallyImportedIds,importers:m.importers,dynamicImporters:m.dynamicImporters});}
  for(const [file,b]of Object.entries(bundle))chunks.push(b.type==='chunk'?{file,type:b.type,isEntry:b.isEntry,imports:b.imports,dynamicImports:b.dynamicImports,facadeModuleId:b.facadeModuleId,moduleIds:b.moduleIds,modules:b.modules}:{file,type:b.type,names:b.names,originalFileNames:b.originalFileNames});
 }
};
const started=new Date().toISOString();
await build({root:web,configFile:join(web,'vite.config.ts'),plugins:[audit]});
for(const previous of before){const current=snapshot(join(root,previous.path));if(current.sha256!==previous.sha256)throw new Error('WEB_INPUT_CHANGED_DURING_BUILD '+previous.path);}
const inputs=[];
for(const id of new Set([...transformed.keys(),...graph.map(g=>g.id)])){
 const clean=id.split('?')[0];let file=clean;
 if(file.startsWith('/@fs/'))file=file.slice(4);
 if(!id.includes('\0')&&existsSync(file)&&statSync(file).isFile()){
  const info=snapshot(file);inputs.push({id,...info});const dest=join(evidence,'build-inputs',info.path);mkdirSync(resolve(dest,'..'),{recursive:true});copyFileSync(file,dest);
 }else inputs.push({id,virtual_or_external:true,...transformed.get(id)});
}
for(const p of beforeFiles){const info=snapshot(p),dest=join(evidence,'web-inputs',info.path);mkdirSync(resolve(dest,'..'),{recursive:true});copyFileSync(p,dest);}
const dist=join(web,'dist'),files=walk(dist).sort().map(p=>({...snapshot(p),path:relative(dist,p)}));
const compression=[];
for(const item of files){const p=join(dist,item.path),dest=join(evidence,'dist',item.path);mkdirSync(resolve(dest,'..'),{recursive:true});copyFileSync(p,dest);
 if(/\.(?:gz|br)$/.test(item.path)){const raw=readFileSync(p),decoded=item.path.endsWith('.gz')?gunzipSync(raw):brotliDecompressSync(raw),original=readFileSync(p.replace(/\.(?:gz|br)$/, ''));if(!decoded.equals(original))throw new Error('COMPRESSION_MISMATCH '+item.path);compression.push({path:item.path,decoded_bytes:decoded.length,decoded_sha256:sha(decoded),same_bytes:true});}
}
const canonical=JSON.stringify(files.map(({path,bytes,sha256,mode})=>({path,bytes,sha256,mode})))+'\n';
writeFileSync(join(evidence,'dist-canonical.json'),canonical);
const binding={task:'PLATFORM-LAYOUT-INTEGRATION-01/r1.1',started,finished:new Date().toISOString(),root,dist,normal_vite_config:join(web,'vite.config.ts'),additional_plugin:'read-only transform/module/output audit; no replacement entry or output mutation',canonical_algorithm:'sha256 UTF8 JSON.stringify(sorted [{path,bytes,sha256,mode}]) plus LF',dist_canonical_sha256:sha(canonical),files,actual_inputs:inputs,web_public_config_inputs:before,graph,output_graph:chunks,transformed:[...transformed.values()],compression,all_web_inputs_unchanged_during_build:true};
writeFileSync(join(evidence,'build-binding.json'),JSON.stringify(binding,null,2)+'\n');
console.log(JSON.stringify({dist,dist_canonical_sha256:binding.dist_canonical_sha256,files:files.length,actual_inputs:inputs.length,graph:graph.length,compressed_verified:compression.length,evidence}));
