import { freezeVoiceProfile, ComfyVoice } from './voice.ts';
import { ContractError } from '@workbench/contracts';

// File reads can block on an unavailable NAS. This process is disposable and
// never submits a generation or exposes the full frozen profile to the UI.
try {
  const profile = freezeVoiceProfile(process.argv[2]);
  const view = { id: profile.id, skill_name: profile.skill_name, skill_sha256: profile.skill_sha256, reference_sha256: profile.reference_sha256, template_sha256: profile.template_sha256 };
  try {
    const queue = await new ComfyVoice(profile.endpoint).readiness(profile);
    process.stdout.write(JSON.stringify({ status: 'ready', message: '本人参考和制作节点可用；先生成一段试听', profile: view, ...queue }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: error instanceof ContractError && error.code === 'INPUT_STALE' ? 'input_changed' : 'offline', message: error instanceof ContractError ? error.message : '声音服务未连接，现有稿件与音频保留', profile: view, running: null, pending: null }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ status: error instanceof ContractError && error.code === 'INPUT_STALE' ? 'input_changed' : 'unconfigured', message: error instanceof ContractError ? error.message : '声音输入无法读取，请检查本机路径与文件', profile: null, running: null, pending: null }));
}
