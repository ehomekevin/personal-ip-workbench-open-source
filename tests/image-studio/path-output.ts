import {lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,dirname,relative,sep,join} from 'node:path';
// Establish every parent from the trusted project directory without following a symlink.
// The final leaf is created exactly once, before importing/starting the native port.
export function createStudioOutput(project:string,parent:string,out:string):string{
 const trusted=resolve(project),root=resolve(parent),leaf=resolve(out);
 if(realpathSync(trusted)!==trusted||!lstatSync(trusted).isDirectory()||lstatSync(trusted).isSymbolicLink())throw new Error('Project root must be a verified real directory');
 const inside=relative(trusted,root);
 if(!inside||inside==='..'||inside.startsWith('..'+sep)||resolve(trusted,inside)!==root||dirname(leaf)!==root)throw new Error('Real output must be one immediate new finite-run subdirectory');
 let current=trusted;
 for(const part of inside.split(sep)){
  current=join(current,part);
  try{const stat=lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Finite-run parent must be a real directory');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;mkdirSync(current,{mode:0o700});}
  if(realpathSync(current)!==current)throw new Error('Finite-run parent real path differs');
 }
 const parentStat=lstatSync(root);
 // mkdir is exclusive, including existing empty directories and dangling symlinks.
 mkdirSync(leaf,{mode:0o700});
 const actual=lstatSync(leaf),after=lstatSync(root);
 if(actual.isSymbolicLink()||!actual.isDirectory()||realpathSync(leaf)!==leaf||parentStat.dev!==after.dev||parentStat.ino!==after.ino)throw new Error('New finite-run output identity differs from its verified parent');
 return leaf;
}

export function verifyCreatedStudioOutput(parent:string,out:string){
 const root=resolve(parent),leaf=resolve(out);
 if(dirname(leaf)!==root)throw new Error('Finite-run output parent differs');
 for(const path of [root,leaf]){const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(path)!==path)throw new Error('Finite-run output is no longer a verified real directory');}
}
