import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

/** Validate an existing, explicitly selected directory without creating or falling back. */
export function validateStorageDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error('Storage path must be absolute');
  const normalized = resolve(path);
  if (path !== normalized) throw new Error('Storage path must be canonical; dot segments are not accepted');
  const actual = realpathSync(normalized);
  if (lstatSync(normalized).isSymbolicLink() || actual !== normalized)
    throw new Error('Storage path must be a physical directory without symlink components');
  if (!statSync(actual).isDirectory() || actual === parse(actual).root)
    throw new Error('Storage path must be a dedicated directory');
  // A missing external drive must not silently become a directory on the system disk.
  if (process.platform === 'darwin' && actual.startsWith('/Volumes/')) {
    const mount = actual.split(sep).slice(0, 3).join(sep);
    if (statSync(mount).dev === statSync(dirname(mount)).dev || statSync(actual).dev !== statSync(mount).dev)
      throw new Error('Selected external volume is not mounted');
  }
  accessSync(actual, constants.R_OK | constants.W_OK);
}
