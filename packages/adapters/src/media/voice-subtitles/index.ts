import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from '@workbench/contracts';
import { LOCAL_TOOLS, metadata, runTool, type ToolTrace } from '../render/tools.ts';

export interface VoiceShot { shot_key: string; duration_ms: number; narration: string; subtitle: string }
function timestamp(ms: number): string { const seconds = Math.floor(ms / 1000); return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; }
export function makeSrt(shots: VoiceShot[]): string { let cursor = 0; return shots.map((shot, index) => { const start = cursor; cursor += shot.duration_ms; return `${index + 1}\n${timestamp(start)} --> ${timestamp(cursor)}\n${shot.subtitle}\n`; }).join('\n'); }
export async function generateVoiceTimeline(shots: VoiceShot[], root: string, options: { signal?: AbortSignal; traces?: ToolTrace[] } = {}): Promise<{ audio: string; subtitles: string; provenance: { source_kind: 'system_tts'; owner_voice: false; voice: string }; segments: Array<{ shot_key: string; begin_ms: number; end_ms: number; speech_duration_ms: number }> }> {
  await mkdir(root, { recursive: true }); const files: string[] = [], segments: Array<{ shot_key: string; begin_ms: number; end_ms: number; speech_duration_ms: number }> = []; let cursor = 0;
  for (const [index, shot] of shots.entries()) {
    if (!Number.isSafeInteger(shot.duration_ms) || shot.duration_ms <= 0 || !shot.narration.trim() || !shot.subtitle.trim()) throw new ContractError('VALIDATION_ERROR', '旁白、字幕与镜头时长不完整');
    const text = join(root, `voice-${index}.txt`), aiff = join(root, `voice-${index}.aiff`), wav = join(root, `voice-${index}.wav`); await writeFile(text, shot.narration, { flag: 'wx' });
    await runTool(LOCAL_TOOLS.say, ['-v', 'Tingting (Chinese (China mainland))', '-r', '205', '-f', text, '-o', aiff], options);
    const info = await metadata(aiff, options); const speech = Number((info.format as Record<string, unknown>).duration) * 1000;
    if (!Number.isFinite(speech) || speech > shot.duration_ms) throw new ContractError('VALIDATION_ERROR', '系统旁白长于固定镜头，需补充计划', { shot_key: shot.shot_key, speech_duration_ms: speech });
    await runTool(LOCAL_TOOLS.ffmpeg, ['-hide_banner', '-v', 'error', '-n', '-i', aiff, '-af', 'apad', '-t', String(shot.duration_ms / 1000), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wav], options);
    files.push(wav); segments.push({ shot_key: shot.shot_key, begin_ms: cursor, end_ms: cursor + shot.duration_ms, speech_duration_ms: Math.round(speech) }); cursor += shot.duration_ms;
  }
  const concat = join(root, 'voice-concat.txt'); await writeFile(concat, files.map((_, index) => `file 'voice-${index}.wav'`).join('\n') + '\n', { flag: 'wx' });
  const audio = join(root, 'narration.wav'), subtitles = join(root, 'subtitles.srt');
  await runTool(LOCAL_TOOLS.ffmpeg, ['-hide_banner', '-v', 'error', '-n', '-f', 'concat', '-safe', '1', '-i', concat, '-c:a', 'pcm_s16le', audio], options);
  await writeFile(subtitles, makeSrt(shots), { flag: 'wx' });
  return { audio, subtitles, provenance: { source_kind: 'system_tts', owner_voice: false, voice: 'Tingting (Chinese (China mainland))' }, segments };
}
