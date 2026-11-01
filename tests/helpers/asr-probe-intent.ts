import { existsSync, mkdirSync, openSync, constants, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export function claimAsrProbeIntent(fixedRoot:string,evidenceRoot:string,journal:Record<string,unknown>){
  const journalPath=join(fixedRoot,'attempt.json'),copyPath=join(evidenceRoot,'attempt.json');
  if(existsSync(journalPath)||existsSync(copyPath))throw new Error('此唯一测试已有 journal；只允许回读，不能再次外发');
  mkdirSync(fixedRoot,{recursive:true});mkdirSync(evidenceRoot,{recursive:true});
  const persist=(path:string,exclusive=false)=>{const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|(exclusive?constants.O_EXCL:constants.O_TRUNC),0o600);try{writeFileSync(fd,JSON.stringify(journal,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
  // Fixed intent fence is created and flushed before any provider connection; evidence is a copy.
  persist(journalPath,true);const directory=openSync(fixedRoot,constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}
  persist(copyPath,true);return()=>{persist(journalPath);persist(copyPath);};
}
