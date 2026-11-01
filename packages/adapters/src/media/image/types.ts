import type { JsonObject } from '@workbench/contracts';

export type ImageProviderId = 'agy' | 'codex';
export type ImageOperation = 'generate' | 'reference_edit';
export type ImageReferencePurpose = 'style' | 'identity' | 'content';
export interface ImageSizeRequest {
  mode: 'auto' | 'manual';
  width: number;
  height: number;
  aspect_ratio: string;
  policy: 'prompt_guided';
}
export interface ImageProviderInput {
  provider: ImageProviderId;
  operation: ImageOperation;
  prompt: string;
  references: Array<{ asset_id: string; file_path: string; sha256: string; purpose?: ImageReferencePurpose }>;
  size_request?: ImageSizeRequest;
  binding: { workspace_id: string; job_id: string; attempt_id: string; attempt_generation: number; input_hash: string };
  work_directory: string;
  output_directory: string;
}
export interface ImageProviderResult {
  file_path: string; mime: string; width: number; height: number; sha256: string;
  size_bytes: number; model: string | null; native: JsonObject; usage: JsonObject | null;
}
export interface ImageProviderPort {
  id: ImageProviderId;
  describe(): Promise<JsonObject>;
  execute(input: ImageProviderInput, options: { signal: AbortSignal; checkpoint: (value: JsonObject) => void; prior?: JsonObject }): Promise<ImageProviderResult>;
  query(input: ImageProviderInput, checkpoint: JsonObject, signal: AbortSignal): Promise<ImageProviderResult>;
}
export interface ImageProviderOptions {
  cwd?: string;
  executable?: string;
  state_root?: string;
  schema_directory?: string;
  mcp_config_path?: string;
  mcp_names?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
}
