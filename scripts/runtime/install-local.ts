import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertStorageRoot } from '../../packages/storage/src/connection/index.ts';
import { validateConfiguration } from '../../apps/service/src/bootstrap/config.ts';

const rootIndex = process.argv.indexOf('--root');
const root = process.argv[rootIndex + 1];
if (rootIndex < 0 || !root || !isAbsolute(root)) throw new Error('--root 必须指定日用工作区的绝对路径');
const projectRoot = resolve(import.meta.dirname, '../..');
let ancestor = root; while (!existsSync(ancestor)) ancestor = dirname(ancestor);
assertStorageRoot(ancestor); mkdirSync(root, { recursive: true }); assertStorageRoot(realpathSync(root));
const configPath = join(root, 'config.json'), webRoot = join(root, 'web'), logRoot = join(homedir(), 'Library/Logs/PersonalIPWorkbench');
if (!existsSync(join(webRoot, 'index.html'))) throw new Error('先将真实页面构建到工作区 web/ 目录，再安装入口');
const config = existsSync(configPath) ? validateConfiguration(JSON.parse(readFileSync(configPath, 'utf8'))) : validateConfiguration({
  workspace_id: randomUUID(), service_instance_id: randomUUID(), title: '个人工作台 · 日常工作区', mode: 'real', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  paths: { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') },
  listen: { host: '127.0.0.1', port: 4319 }, default_executor: 'codex', api_fallback_enabled: false,
});
if (config.mode !== 'real' || config.paths.state_root !== join(root, 'state')) throw new Error('已有配置不属于这个独立日用工作区');
if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
mkdirSync(logRoot, { recursive: true });
if (process.platform !== 'darwin' || !process.getuid) throw new Error('当前自动启动安装器只支持 macOS');
const label = 'design.flowo.personal-ip-workbench', domain = 'gui/' + process.getuid(), agents = join(homedir(), 'Library/LaunchAgents'), plistPath = join(agents, label + '.plist');
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const serverPath = join(projectRoot, 'scripts/runtime/local-server.ts');
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(serverPath)}</string></array>
<key>WorkingDirectory</key><string>${xml(homedir())}</string><key>EnvironmentVariables</key><dict>
<key>PATH</key><string>${xml(process.env.PATH ?? '/opt/homebrew/bin:/usr/bin:/bin')}</string>
<key>WORKBENCH_CONFIG_PATH</key><string>${xml(configPath)}</string><key>WORKBENCH_WEB_ROOT</key><string>${xml(webRoot)}</string><key>WORKBENCH_WEB_PORT</key><string>5180</string>
<key>WORKBENCH_COLLECTION_SETUP_ENABLED</key><string>1</string><key>WORKBENCH_TIKHUB_LOCAL_CREDENTIAL</key><string>1</string>
<key>WORKBENCH_PUBLISHERS_IMPORT_LEGACY</key><string>0</string><key>WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON</key><string>[]</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>180</integer>
<key>StandardOutPath</key><string>${xml(join(logRoot, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logRoot, 'service-error.log'))}</string></dict></plist>`;
mkdirSync(agents, { recursive: true });
if (existsSync(plistPath) && readFileSync(plistPath, 'utf8') !== plist) throw new Error('已有自动启动配置不同，保留原文件；需先核对当前服务再更新');
let installed = false;
try { execFileSync('/bin/launchctl', ['print', domain + '/' + label], { stdio: 'pipe' }); installed = true; } catch { /* 尚未安装。 */ }
if (!installed) { writeFileSync(plistPath, plist); execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' }); }
console.log(JSON.stringify({ url: 'http://127.0.0.1:5180', config_path: configPath, auto_start: { registered: true, newly_registered: !installed, startup_verification: 'not_checked' } }));
