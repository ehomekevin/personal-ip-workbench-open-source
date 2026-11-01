import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';

test('可移植fixture拒绝数据库symlink，不改写其目标文件',()=>{
 const root=mkdtempSync(join(resolve('tests/helpers'),'.portable-db-'));
 try {
  const target=join(root,'target.sqlite'),link=join(root,'workbench.sqlite');writeFileSync(target,'untouched test sentinel');symlinkSync(target,link);
  assert.throws(()=>openWorkspaceStorage(link),{code:'STORAGE_UNAVAILABLE'});assert.equal(readFileSync(target,'utf8'),'untouched test sentinel');
  rmSync(target);assert.throws(()=>openWorkspaceStorage(link),{code:'STORAGE_UNAVAILABLE'});
 } finally {rmSync(root,{recursive:true,force:true});}
});
