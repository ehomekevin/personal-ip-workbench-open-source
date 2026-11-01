import { assertExternalVolume } from './mount-guard.ts';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

assertExternalVolume(resolve(fileURLToPath(new URL('.', import.meta.url))));
process.stdout.write('storage-path guard: passed\n');
