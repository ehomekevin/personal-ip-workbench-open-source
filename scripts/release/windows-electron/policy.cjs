const { isAbsolute, join, parse, relative, resolve, sep } = require('node:path');
const { lstatSync, realpathSync } = require('node:fs');

function isWorkbench(url, origin) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.origin === origin &&
      !u.username && !u.password && u.pathname === '/';
  } catch { return false; }
}

function externalLink(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password) return u.href;
  } catch { /* Invalid or relative link. */ }
}

function workspace(env, install) {
  const target = env.WORKBENCH_DATA_DIR || (env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'PersonalIPWorkbench'));
  if (!target || !isAbsolute(target)) throw Error('Invalid workspace');
  const path = resolve(target), root = parse(path).root;
  if (path === root) throw Error('Invalid workspace');
  let ancestor = root;
  for (const part of relative(root, path).split(sep)) {
    const next = join(ancestor, part), entry = lstatSync(next, { throwIfNoEntry: false });
    if (!entry) break;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('Unexpected workspace link or file');
    ancestor = next;
  }
  const physical = resolve(realpathSync.native(ancestor), relative(ancestor, path));
  const rel = relative(realpathSync.native(install), physical);
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) throw Error('Workspace inside installation');
  return physical;
}
module.exports = { externalLink, isWorkbench, workspace };
