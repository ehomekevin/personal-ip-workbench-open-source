import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prepareCodexSchemas } from '../../packages/adapters/src/agent/codex/native.ts';
import { CODEX_SCHEMA_HASHES } from '../../packages/adapters/src/agent/codex/schema-hashes.ts';
import { hash } from '../../packages/adapters/src/agent/codex/primitives.ts';
import { projectRoot } from './harness.ts';

test('全新工作区按固定协议准备文件，重启复用；损坏文件拒绝覆盖', () => {
 const root=mkdtempSync(join(projectRoot,'tests/service-agent/.wp15-schema-')),directory=join(root,'schemas'),trace=join(root,'trace');
 const binary=join(projectRoot,'tests/service-agent/fake-codex.mjs'),env={...process.env,WP15_SCHEMA_TRACE:trace};
 try {
  prepareCodexSchemas(binary,directory,env);
  for(const [name,expected] of Object.entries(CODEX_SCHEMA_HASHES))assert.equal(hash(readFileSync(join(directory,'v2',name+'.json'))),expected);
  prepareCodexSchemas(binary,directory,env);assert.equal(readFileSync(trace,'utf8'),'generate\n');
  writeFileSync(join(directory,'v2','ThreadStartParams.json'),'{}');
  assert.throws(()=>prepareCodexSchemas(binary,directory,env),{code:'INPUT_STALE'});
  assert.equal(readFileSync(join(directory,'v2','ThreadStartParams.json'),'utf8'),'{}');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('生成协议不匹配时不安装候选文件，并回收本次临时文件',()=>{
 const root=mkdtempSync(join(projectRoot,'tests/service-agent/.wp15-schema-')),directory=join(root,'schemas');
 try{assert.throws(()=>prepareCodexSchemas(join(projectRoot,'tests/service-agent/fake-codex.mjs'),directory,{...process.env,WP15_SCHEMA_BAD:'1'}),{code:'INPUT_STALE'});assert.deepEqual(readdirSync(root),[]);}
 finally{rmSync(root,{recursive:true,force:true});}
});
