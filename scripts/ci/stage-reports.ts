import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '../..');
const allowedStatuses = new Set(['passed', 'failed', 'skipped', 'blocked', 'not_run', 'timedOut', 'interrupted', 'flaky']);
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}; }
function status(value: unknown): string { return typeof value === 'string' && allowedStatuses.has(value) ? value : 'unclassified'; }
function count(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid CI report JSON'); }
}

/** Only fixed-key states and numeric counts leave the local test-report directory. */
export function projectReport(input: unknown, digest: string) {
  const source = record(input), stats = record(source.stats);
  const counts: Record<string, number> = {};
  for (const key of ['expected', 'unexpected', 'flaky', 'skipped']) {
    const value = count(stats[key]); if (value !== undefined) counts[key] = value;
  }
  for (const key of ['tests', 'passed', 'failed', 'skipped']) {
    const value = count(source[key]); if (value !== undefined) counts[key] = value;
  }
  if (Array.isArray(source.steps)) {
    counts.steps = source.steps.length;
    counts.steps_passed = source.steps.filter(step => record(step).exit_code === 0).length;
    counts.steps_failed = source.steps.filter(step => typeof record(step).exit_code === 'number' && record(step).exit_code !== 0).length;
  }
  let result = status(source.result ?? source.status);
  if (result === 'unclassified' && typeof counts.unexpected === 'number')
    result = counts.unexpected > 0 || (Array.isArray(source.errors) && source.errors.length > 0) ? 'failed' : 'passed';
  return { schema: 'workbench-safe-ci-report/1', result, counts, source_sha256: digest };
}

export function stageReports(inputRoot = join(projectRoot, '.ci-artifacts'), outputRoot = join(projectRoot, 'ci-reports')) {
  const input = resolve(inputRoot), output = resolve(outputRoot), files: string[] = [];
  if (output === input || output.startsWith(input + '/') || input.startsWith(output + '/')) throw new Error('Report input and output must be separate');
  function walk(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error('Report symlinks are not accepted');
      if (info.isDirectory()) walk(file);
      else if (info.isFile() && (name === 'summary.json' || name === 'results.json')) files.push(file);
    }
  }
  if (!existsSync(input)) throw new Error('No CI report directory was produced');
  walk(input);
  if (!files.length) throw new Error('No summary/results reports were produced');
  // Parse everything before replacing this script's previous safe projection.
  const reports = files.map(file => {
    const bytes = readFileSync(file);
    return projectReport(parseJson(bytes.toString('utf8')), createHash('sha256').update(bytes).digest('hex'));
  });
  if (existsSync(output)) {
    if (lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory()) throw new Error('Unsafe report output');
    const previous = join(output, 'index.json');
    if (!existsSync(previous) || record(parseJson(readFileSync(previous, 'utf8'))).schema !== 'workbench-safe-ci-index/1')
      throw new Error('Refusing to replace an unowned report directory');
    rmSync(output, { recursive: true });
  }
  mkdirSync(output, { recursive: true });
  reports.forEach((report, index) => writeFileSync(join(output, `report-${String(index + 1).padStart(4, '0')}.json`), JSON.stringify(report, null, 2) + '\n'));
  const index = { schema: 'workbench-safe-ci-index/1', reports: reports.length,
    failed: reports.filter(report => report.result === 'failed').length,
    unclassified: reports.filter(report => report.result === 'unclassified').length };
  writeFileSync(join(output, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  return index;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('stage-reports accepts no command-line arguments');
  console.log(JSON.stringify(stageReports()));
}
