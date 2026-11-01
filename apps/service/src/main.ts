import { loadConfiguration } from './bootstrap/config.ts';
import { startApplication } from './bootstrap/application.ts';
const application = await startApplication(loadConfiguration());
process.stdout.write(JSON.stringify({ event: 'application_ready', identity: application.identity, boot_id: application.boot_id, listen: application.address }) + '\n');
if (process.send) process.send({ identity: application.identity, boot_id: application.boot_id, listen: application.address });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; try { await application.close(); process.exitCode = 0; } catch { process.exitCode = 1; } }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
