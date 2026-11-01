import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
// 构建时为带哈希的 js/css 等产出 .br/.gz，日用入口（scripts/runtime/static-assets.ts）按 Accept-Encoding 直接返回，不在请求时压缩。
// index.html 在日用入口里会注入运行模式，内容与构建产物不同，不预压缩。
function precompress(): Plugin {
  let outDir = 'dist';
  return { name: 'workbench-precompress', apply: 'build', configResolved(config) { outDir = config.build.outDir; },
    writeBundle(options, bundle) { const root = options.dir ?? outDir;
      for (const [file, item] of Object.entries(bundle)) {
        if (!/\.(?:js|css|svg|json)$/.test(file)) continue; const source = Buffer.from(item.type === 'chunk' ? item.code : item.source); if (source.length < 1024) continue;
        writeFileSync(join(root, file + '.br'), brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: source.length } }));
        writeFileSync(join(root, file + '.gz'), gzipSync(source, { level: 9 }));
      } } };
}
// three 只被按需加载的生图加载器（img-fx）引用：单独成块，便于缓存，也不混进主包。
export default defineConfig({ plugins: [react(), precompress()], build: { rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'three', test: /[\\/]node_modules[\\/](?:\.pnpm[\\/])?three[@\\/]/ }] } } } }, server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4318', '/health': 'http://127.0.0.1:4318' } }, preview: { host: '127.0.0.1', port: 5173, strictPort: true } });
