import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
type Binding={product_candidate:string;prompt:string;output_directory:string;run_id:string};
export function admitReal(approval:Record<string,unknown>,manifest:{candidate_id:string;source_files:Array<{path:string;sha256:string}>},root:string,binding?:Binding){
 if(!binding || Object.values(binding).some(value=>typeof value!=='string'||!value.trim()))throw new Error('Explicit candidate, prompt, output and run binding required');
 if(approval.task_id!=='IMAGE-CODEX-VALIDATION-RUN'||approval.requirement_version!=='r1'||approval.authorized!==true||approval.codex_budget!==1||approval.agy_budget!==0||approval.native_old_query_budget!==0||approval.product_candidate!==binding.product_candidate||approval.prep_candidate!==manifest.candidate_id||approval.run_id!==binding.run_id||approval.prompt!==binding.prompt||approval.output_directory!==binding.output_directory||typeof approval.human_approval_reference!=='string'||!approval.human_approval_reference.trim())throw new Error('Missing bound single-Codex authorization');
 for(const row of manifest.source_files)if(createHash('sha256').update(readFileSync(join(root,row.path))).digest('hex')!==row.sha256)throw new Error('Prepared source changed');
}
function main(){
 const args=process.argv.slice(2);
 if(args.includes('--run-real'))throw new Error('This entry only validates saved preparation offline. Historical execution runner is not a portable provider entry.');
 const values=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('Expected explicit option/value pairs');values.set(args[i]!,args[i+1]!);}
 const required=['--root','--prep-manifest','--product-manifest','--authorization','--binding'];
 if(required.some(key=>!values.has(key))||[...values.keys()].some(key=>!required.includes(key)))throw new Error('Usage: run.ts --root ROOT --prep-manifest FILE --product-manifest FILE --authorization FILE --binding FILE (offline only)');
 const read=(key:string)=>JSON.parse(readFileSync(resolve(values.get(key)!),'utf8')),root=resolve(values.get('--root')!),manifest=read('--prep-manifest'),product=read('--product-manifest'),binding=read('--binding') as Binding;
 const rows=manifest.payload_files.map((r:{bytes:number;path:string;sha256:string})=>({bytes:r.bytes,path:r.path,sha256:r.sha256}));
 if('sha256:'+createHash('sha256').update(JSON.stringify(rows)).digest('hex')!==manifest.candidate_id)throw new Error('Prep candidate canonical mismatch');
 for(const row of rows)if(createHash('sha256').update(readFileSync(join(root,row.path))).digest('hex')!==row.sha256)throw new Error('Prepared payload changed');
 admitReal(read('--authorization'),manifest,root,binding);
 if(product.candidate_id!==binding.product_candidate)throw new Error('Product candidate changed');
 for(const row of product.payload_files)if(createHash('sha256').update(readFileSync(join(root,row.path))).digest('hex')!==row.sha256)throw new Error('Frozen product payload changed');
 console.log(JSON.stringify({validation:'supplied_saved_preparation_consistency',provider_calls:0,current_acceptance:'not_run'}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try{main();}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=2;}
