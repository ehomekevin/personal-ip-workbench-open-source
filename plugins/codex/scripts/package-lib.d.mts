export interface BuildOptions { server: string; ui: string; skills: string; out: string; 'runtime-root'?: string }
export interface InventoryEntry { path: string; bytes: number; sha256: string }
export function parseBuildArgs(argv: string[]): BuildOptions;
export function filesBelow(root: string, relative?: string): Promise<string[]>;
export function stageRuntime(root: string, options: BuildOptions): Promise<void>;
export function copyTemplate(source: string, root: string): Promise<void>;
export function inspectPackage(root: string, form: 'codex' | 'claude' | 'mcpb'): Promise<InventoryEntry[]>;
export function archivePackage(root: string, file: string, form: 'codex' | 'claude' | 'mcpb'): Promise<{ file: string; bytes: number; sha256: string; inventory: InventoryEntry[] }>;
