import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ContractError } from '@workbench/contracts';
import type { ImageProviderOptions } from './types.ts';

const PARSE_NAMES = `import json,pathlib,sys,tomllib
p=pathlib.Path(sys.argv[1])
if p.exists() and p.stat().st_size > 2097152: raise ValueError('config too large')
c=tomllib.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
names=set()
def visit(value):
    if isinstance(value,list):
        for child in value: visit(child)
        return
    if not isinstance(value,dict): return
    for key,child in value.items():
        if key == 'mcp_servers':
            if not isinstance(child,dict): raise ValueError('mcp_servers must be a table')
            for name,server in child.items():
                if not isinstance(server,dict): raise ValueError('server must be a table')
                names.add(name)
        elif isinstance(child,(dict,list)): visit(child)
visit(c)
print(json.dumps(sorted(names)))
`;
export function imageMcpNames(options: ImageProviderOptions): readonly string[] {
  const config = options.mcp_config_path ?? join(options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
  const refused = (): ContractError => new ContractError('CAPABILITY_UNVERIFIED', '无法完整隔离 Codex 图像渠道的 MCP 配置', { pre_submit_failure: true, no_new_submit: true });
  try {
    // Only names leave the parser. Syntax errors can quote credential-bearing lines, so stderr is discarded.
    const parsed: unknown = JSON.parse(execFileSync('python3', ['-c', PARSE_NAMES, config], {
      env: options.env, encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    if (!Array.isArray(parsed) || parsed.some(name => typeof name !== 'string') ||
      (options.mcp_names !== undefined && !Array.isArray(options.mcp_names))) throw refused();
    const names = [...new Set([...parsed, ...(options.mcp_names ?? [])])];
    // CodexNative accepts safe bare names; unusual but legal TOML names fail closed before native spawn.
    if (names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name))) throw refused();
    return names;
  } catch { throw refused(); }
}
