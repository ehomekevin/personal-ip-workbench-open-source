#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2), mode = process.env.WP15_FAKE_CLAUDE_MODE ?? 'success';
if (args.includes('--version')) { process.stdout.write('2.1.283 (Claude Code)\n'); process.exit(0); }
if (args[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: mode !== 'auth', authMethod: mode === 'auth' ? 'none' : 'claude.ai', apiProvider: 'firstParty', subscriptionType: mode === 'auth' ? null : 'max' })+'\n'); process.exit(mode === 'auth' ? 1 : 0); }
const session = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : randomUUID(); const send = value => process.stdout.write(JSON.stringify(value)+'\n');
send({ type: 'system', subtype: 'init', session_id: session, tools: [], model: 'internal_rule' });
const message = { type: 'assistant', session_id: session, message: { id: randomUUID(), usage: { input_tokens: 11, output_tokens: 3 } } }; send(message); send(message);
setTimeout(() => { send({ type: 'result', subtype: mode === 'quota' ? 'error_during_execution' : 'success', is_error: mode === 'quota', errors: mode === 'quota' ? ['quota_exhausted internal_rule'] : [], uuid: randomUUID(), session_id: session, structured_output: mode === 'schema' ? { wrong: 1 } : { answer: '42' }, usage: { input_tokens: 11, output_tokens: 3 }, modelUsage: {}, total_cost_usd: 0.001 }); process.exit(0); }, mode === 'slow' ? 5000 : mode === 'idle' ? 1500 : mode === 'trickle' ? 1500 : 50);
if (mode === 'trickle') { const tick = setInterval(() => send({ type: 'assistant', session_id: session, message: { id: randomUUID(), usage: { input_tokens: 1, output_tokens: 1 } } }), 40); tick.unref(); }
