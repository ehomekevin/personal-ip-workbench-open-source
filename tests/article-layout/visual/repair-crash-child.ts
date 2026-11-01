/** This process contains only a fake protocol client and its own SQLite fixture. exit77 never stops a native/provider/service process. */
import { setup, identity, signal, QAOnlyNative } from './repair-fixture.ts';
import { CodexLayoutCheckAdapter } from '../../../packages/adapters/src/media/layout-check/check.ts';
import type { LayoutCheckJournal } from '../../../packages/adapters/src/media/layout-check/types.ts';
const f = setup(process.argv[2]), actual = f.journal();
const delayed = process.argv[3] === 'delayed-event';
const journal: LayoutCheckJournal = {
  reserve: e => actual.reserve(e), load: id => actual.load(id),
  async save(e) { if (delayed && e.attempt.state === 'running' && e.attempt.native.turn_id) await new Promise(done => setTimeout(done, 100)); await actual.save(e); },
};
await new CodexLayoutCheckAdapter({ workspace_id: 'qa-fixture-workspace', cwd: f.directory, lock_root: f.directory, schema_directory: f.directory, journal,
  fixture: true, native_factory: () => new QAOnlyNative('crash') }).execute(f.input, identity('crash'), signal());
throw new Error('repair fixture must exit77 before its fake reply');
