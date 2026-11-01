import { ContractError, type JsonObject } from '@workbench/contracts';
import type { ImageProviderId, ImageProviderInput, ImageSizeRequest } from './types.ts';

// These are composition targets in the workbench. They are not native API sizes.
export const IMAGE_COMPOSITION_TARGETS = [
  { aspect_ratio: '16:9', width: 1600, height: 900 },
  { aspect_ratio: '4:3', width: 1600, height: 1200 },
  { aspect_ratio: '1:1', width: 1600, height: 1600 },
  { aspect_ratio: '3:4', width: 1200, height: 1600 },
  { aspect_ratio: '9:16', width: 1080, height: 1920 },
  { aspect_ratio: '2:5', width: 1200, height: 3000 },
] as const;

export function imageCapabilities(provider: ImageProviderId): JsonObject {
  const agy = provider === 'agy';
  return {
    schema_version: 'image-studio-capabilities.v1', provider,
    control: 'prompt_guided', exact_pixels: 'unsupported', aspect_output: 'unverified',
    accepted_size_parameter: null,
    // 可选的生图模型：两个适配器都只有一个固定模型（AGY 原生图像工具、Codex 内置生图），界面只显示不可改。
    models: agy ? [{ id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image（Nano Banana）' }] : [{ id: 'codex-builtin-image', label: 'Codex 内置生图' }], model_choice: 'fixed',
    composition_targets: IMAGE_COMPOSITION_TARGETS.map(value => ({ ...value, verified_native_size: false })),
    manual_range: { min_edge: 320, max_edge: 4096, min_ratio: 0.2, max_ratio: 5,
      constraint_source: 'workbench_request_validation', native_parameter_range: null },
    observed_formats: agy ? ['image/jpeg'] : ['image/png'],
    format_evidence_scope: agy ? 'saved_native_agy_results' : 'saved_host_image_not_native_workbench',
    supported_result_formats: ['image/png', 'image/jpeg', 'image/webp'],
    observed_dimensions: agy ? [{ width: 1024, height: 1024, scope: 'saved_agy_probe_and_integration' }] : [],
    references: { max_images: 1, purposes: ['style', 'identity', 'content'],
      reference_edit: agy ? 'saved_single_reference_verified' : 'unverified_native_route',
      multi_reference: 'unverified', mask: 'unverified', exact_text_edit: 'unverified' },
    limitations: ['画幅与像素作为图像说明发送，像素值不保证；以完整解码后的实际尺寸为准。',
      '未公开已验证的原生尺寸参数；不会拉伸、裁切或自动重发修正。',
      '参考用途用于说明，人物身份与品牌是否保持仍需本人核对。'],
    evidence: agy ? ['agy-1.3.3-local-help', 'probe-r1-native-GenerateImage', 'probe-r1-single-reference-edit'] :
      ['codex-cli-0.161.0-fixed-TurnStartParams', 'fixed-imageGeneration-item', 'host-PNG-does-not-prove-native-workbench-route'],
  };
}

export function validateSizeRequest(value: unknown): asserts value is ImageSizeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSize();
  const size = value as Record<string, unknown>, keys = Object.keys(size);
  if (keys.some(key => !['mode', 'width', 'height', 'aspect_ratio', 'policy'].includes(key)) ||
    !['auto', 'manual'].includes(String(size.mode)) || size.policy !== 'prompt_guided')
    throw new ContractError('CAPABILITY_UNSUPPORTED', '当前渠道仅支持画幅提示，不能保证任意像素尺寸', { pre_submit_failure: true });
  const w = size.width, h = size.height;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isSafeInteger(w) || !Number.isSafeInteger(h) ||
    w < 320 || h < 320 || w > 4096 || h > 4096 || w / h < 0.2 || w / h > 5 ||
    typeof size.aspect_ratio !== 'string' || size.aspect_ratio.length > 32) throw invalidSize();
  const ratio = aspectValue(size.aspect_ratio);
  if (ratio === null || Math.abs(ratio - w / h) / ratio > 0.005) throw invalidSize();
}
function invalidSize(): ContractError {
  return new ContractError('VALIDATION_ERROR', '拟生成尺寸需为320–4096整数像素、比例1:5–5:1且与宽高一致', { pre_submit_failure: true });
}
function aspectValue(value: string): number | null {
  const parts = value.split(':');
  if (parts.length !== 2 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  const [w, h] = parts.map(Number);
  return w && h && Number.isFinite(w / h) ? w / h : null;
}
export function imageCompositionPrompt(input: ImageProviderInput): string {
  const lines: string[] = [];
  if (input.size_request) {
    validateSizeRequest(input.size_request);
    lines.push(`Requested composition: ${input.size_request.aspect_ratio}; target ${input.size_request.width} x ${input.size_request.height} pixels. ` +
      'Use this aspect ratio and leave room for all described content. These are prompt-guided targets, not an unsupported native size parameter. ' +
      'Do not crop, stretch, pad, resize, retry or make a second image to force these dimensions. Keep the first native result.');
  }
  for (const [index, ref] of input.references.entries()) if (ref.purpose)
    lines.push(`Reference ${index + 1} (${ref.asset_id}, sha256=${ref.sha256}) purpose: ${ref.purpose}. ` +
      (ref.purpose === 'identity' ? 'Preserve the depicted person identity.' : ref.purpose === 'style' ? 'Use its visual style and brand identity.' : 'Preserve the referenced content.'));
  return lines.length ? '\n' + lines.join('\n') + '\n' : '';
}
export function decodedSizeVerification(input: ImageProviderInput, width: number, height: number): JsonObject | null {
  const requested = input.size_request;
  if (!requested) return null;
  const relativeError = Math.abs(width / height - requested.width / requested.height) / (requested.width / requested.height);
  const exact = width === requested.width && height === requested.height;
  return { requested: { ...requested }, accepted_size_parameter: null, decoded: { width, height },
    status: exact ? 'exact' : relativeError <= 0.02 ? 'aspect_match_pixels_differ' : 'mismatch',
    requested_pixels_matched: exact, requested_aspect_matched: relativeError <= 0.02,
    transformed: false, automatic_correction_submits: 0 };
}
