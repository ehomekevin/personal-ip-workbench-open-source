import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,realpathSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createStudioOutput} from './path-output.ts';
import {claimStudioRunAdmission} from './bounded-runner.ts';
function fixture(){const root=mkdtempSync(join(import.meta.dirname,'.studio-path-'));return{root,parent:join(root,'development/r2/finite-run'),close:()=>rmSync(root,{recursive:true,force:true})};}
test('real output claims one new owned leaf and rejects an existing directory or file',()=>{
 const f=fixture();try{const out=join(f.parent,'owned-run');assert.equal(createStudioOutput(f.root,f.parent,out),realpathSync(out));assert.deepEqual(readdirSync(out),[]);assert.throws(()=>createStudioOutput(f.root,f.parent,out),/EEXIST/);
  const file=join(f.parent,'owned-file');writeFileSync(file,'original');assert.throws(()=>createStudioOutput(f.root,f.parent,file),/EEXIST/);assert.equal(readFileSync(file,'utf8'),'original');assert.throws(()=>createStudioOutput(f.root,f.parent,join(f.root,'outside-leaf')),/immediate/);
 }finally{f.close();}
});
test('real output rejects existing and dangling symlink leaves within the owned fixture',()=>{
 const f=fixture();try{mkdirSync(f.parent,{recursive:true});const target=join(f.root,'owned-target');mkdirSync(target);symlinkSync(target,join(f.parent,'linked'));symlinkSync(join(f.root,'owned-missing'),join(f.parent,'dangling'));
  assert.throws(()=>createStudioOutput(f.root,f.parent,join(f.parent,'linked')),/EEXIST/);assert.throws(()=>createStudioOutput(f.root,f.parent,join(f.parent,'dangling')),/EEXIST/);assert.deepEqual(readdirSync(target),[]);assert.equal(existsSync(join(f.root,'owned-missing')),false);
 }finally{f.close();}
});
test('real output refuses a symlink parent before creating resources at its target',()=>{
 const f=fixture();try{mkdirSync(join(f.root,'development'));const target=join(f.root,'owned-target');mkdirSync(target);symlinkSync(target,join(f.root,'development/r2'));
  assert.throws(()=>createStudioOutput(f.root,f.parent,join(f.parent,'new-run')),/real directory/);assert.deepEqual(readdirSync(target),[]);
 }finally{f.close();}
});
test('a prior r1 admission prevents resetting the cumulative budget with a new r2 root',()=>{
 const f=fixture();try{const old=join(f.root,'development/r1/finite-run');mkdirSync(old,{recursive:true});const marker=join(old,'r1-admission.json');writeFileSync(marker,'old owned fixture intent');
  assert.throws(()=>claimStudioRunAdmission(f.parent,{mode:'fixture'},[old]),/cannot reset/);assert.equal(existsSync(f.parent),false);assert.equal(readFileSync(marker,'utf8'),'old owned fixture intent');
 }finally{f.close();}
});
