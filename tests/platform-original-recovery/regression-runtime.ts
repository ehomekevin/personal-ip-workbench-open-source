// 仅测试进程的临时目录适配：既有harness的mkdtemp也放本任务own runtime，不改变应用实现。
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {basename,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../runtime/platform-original-recovery-r2/regression/',import.meta.url)));
const original=fs.mkdtempSync;
fs.mkdirSync(root,{recursive:true});
fs.mkdtempSync=((prefix:any,options:any)=>{
 const path=String(prefix);
 return original(path.startsWith(root)?path:join(root,basename(path)),options);
}) as typeof fs.mkdtempSync;
syncBuiltinESMExports();
