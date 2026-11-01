import { validateStorageDirectory } from '../../../packages/storage/src/connection/storage-root.ts';

// Kept as a compatibility name for existing local test/build entry points.
// The public distribution validates the selected directory, not a personal disk UUID.
export function assertExternalVolume(path: string): void {
  validateStorageDirectory(path);
}
