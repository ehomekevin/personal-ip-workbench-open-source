import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExternalVolume } from '../probes/runtime/mount-guard.ts';

const projectRoot = resolve(import.meta.dirname, '../..');
const assets = ['icon.svg', 'avatar.svg', 'platforms/xiaohongshu.svg', 'platforms/wechat.svg', 'platforms/x.svg', 'platforms/douyin.svg', 'platforms/bilibili.svg'];
const mime: Record<string, string> = { png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', woff2: 'font/woff2' };
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function dataAsset(name: string): string {
  const bytes = readFileSync(join(projectRoot, 'apps/web/public/workbench', name));
  return 'data:' + mime[name.split('.').at(-1)!] + ';base64,' + bytes.toString('base64');
}

// Shared UI assets, including the audio worklet, are self-contained in the host iframe.
export async function buildPluginRuntime(outputRoot = join(projectRoot, '.ci-artifacts/plugins/shared')) {
  if (process.platform === 'darwin') assertExternalVolume(projectRoot);
  const targetRoot = resolve(outputRoot), serverPath = join(targetRoot, 'server/server.mjs'), uiPath = join(targetRoot, 'ui/workbench.html');
  mkdirSync(dirname(serverPath), { recursive: true }); mkdirSync(dirname(uiPath), { recursive: true });
  const common = { absWorkingDir: projectRoot, bundle: true, sourcemap: false, logLevel: 'warning' as const };
  await build({ ...common, entryPoints: ['apps/mcp/src/main.ts'], outfile: serverPath, platform: 'node', format: 'esm', target: 'node24',
    banner: { js: "import { createRequire as workbenchCreateRequire } from 'node:module'; const require = workbenchCreateRequire(import.meta.url);" } });
  const compiled = await build({ ...common, entryPoints: ['plugins/shared/ui/main.tsx'], outfile: join(targetRoot, 'ui/compiled.js'), write: false,
    platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', splitting: false, minify: true, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'approved-brand-assets', setup(builder) {
      builder.onResolve({ filter: /^\/workbench\// }, args => ({ path: args.path.slice('/workbench/'.length), namespace: 'approved-brand' }));
      builder.onLoad({ filter: /.*/, namespace: 'approved-brand' }, args => {
        if (!assets.includes(args.path)) throw new Error('未登记的品牌资源');
        return { contents: readFileSync(join(projectRoot, 'apps/web/public/workbench', args.path)), loader: 'dataurl' };
      });
    } }] });
  let javascript = compiled.outputFiles?.find(file => file.path.endsWith('.js'))?.text;
  let css = compiled.outputFiles?.find(file => file.path.endsWith('.css'))?.text ?? '';
  if (!javascript) throw new Error('共享 UI 未产生脚本');
  for (const name of assets) { javascript = javascript.replaceAll('/workbench/' + name, dataAsset(name)); css = css.replaceAll('/workbench/' + name, dataAsset(name)); }
  const worklet = readFileSync(join(projectRoot, 'apps/web/public/speech-pcm-worklet.js'));
  javascript = javascript.replaceAll('/speech-pcm-worklet.js', 'data:text/javascript;base64,' + worklet.toString('base64'));
  const template = readFileSync(join(projectRoot, 'plugins/shared/ui/index.html'), 'utf8');
  const html = template.replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi, '')
    .replace(/<\/head>/i, () => '<style>' + css.replace(/<\/style/gi, '<\\/style') + '</style></head>')
    .replace(/<\/body>/i, () => '<script type="module">' + javascript.replace(/<\/script/gi, '<\\/script') + '</script></body>');
  if (!html.includes('id="root"') || /(?:src|href)=["']\/(?:workbench|assets)\//.test(html)) throw new Error('宿主资源仍依赖站点绝对资源路径');
  writeFileSync(uiPath, html);
  const sourcePaths = ['apps/web/public/speech-pcm-worklet.js', 'apps/web/src/styles/approved.css', 'apps/web/src/styles/today-continuation.css', 'plugins/shared/ui/main.tsx', 'plugins/shared/ui/index.html', ...assets.map(name => 'apps/web/public/workbench/' + name)];
  const manifest = { schema_version: 'workbench-plugin-build-v1', built_at: new Date().toISOString(), target: 'node24',
    external_service_started: false, database_included: false, csp_network_domains: [],
    files: [serverPath, uiPath].map(path => ({ path: path.slice(targetRoot.length + 1), bytes: readFileSync(path).length, sha256: digest(readFileSync(path)) })),
    source_inputs: sourcePaths.map(path => ({ path, sha256: digest(readFileSync(join(projectRoot, path))) })) };
  writeFileSync(join(targetRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { root: targetRoot, server: serverPath, ui: uiPath, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPluginRuntime();
  console.log('共享插件运行包：' + result.root);
}
