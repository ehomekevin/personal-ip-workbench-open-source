const test = require('node:test'), assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { externalLink, isWorkbench, workspace } = require('./policy.cjs');
test('only the owned loopback page may navigate; external handoff is HTTPS only', () => {
  const origin = 'http://127.0.0.1:53001';
  assert(isWorkbench(origin + '/#topics', origin));
  for (const v of ['file:///C:/test','javascript:alert(1)','blob:'+origin+'/foo',origin+'/api/media','http://127.0.0.1:53002','https://127.0.0.1:53001','http://user@127.0.0.1:53001'])
    assert(!isWorkbench(v, origin), v);
  assert.equal(externalLink('https://example.org/post'), 'https://example.org/post');
  for (const v of ['file:///C:/test','ms-settings:test','https://name@example.org','javascript:alert(1)','relative']) assert.equal(externalLink(v), undefined);
});
test('business files stay in the legacy folder outside the installation', t => {
  const base = require('node:fs').realpathSync.native(mkdtempSync(join(require('node:os').tmpdir(),'desktop-policy-')));
  t.after(() => rmSync(base,{force:true,recursive:true}));
  const install = join(base,'Programs'); mkdirSync(install);
  assert.equal(workspace({LOCALAPPDATA:base},install), join(base,'PersonalIPWorkbench'));
  for (const bad of ['relative',install,join(install,'data')]) assert.throws(() => workspace({WORKBENCH_DATA_DIR:bad},install));
});
