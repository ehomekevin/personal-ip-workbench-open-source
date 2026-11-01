#!/usr/bin/env python3
"""Read-only app-server initialization and image capability query; no turn."""
import datetime
import json
from pathlib import Path
import queue
import subprocess
import threading

import argparse

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--query-native-host', action='store_true', required=True)
    args = parser.parse_args()
    if not args.executable.is_absolute() or not args.executable.is_file() or not args.workspace.is_dir() or args.output.exists() or not args.output.parent.is_dir():
        parser.error('Explicit existing executable/workspace and a new output in an existing directory are required')
    cmd = [str(args.executable), 'app-server', '--stdio',
           '-c', 'features.hooks=false', '-c', 'features.plugins=false',
           '-c', 'features.apps=false', '-c', 'features.memories=false']
    process = subprocess.Popen(cmd, cwd=args.workspace, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               text=True)
    responses = queue.Queue()
    def receive():
        for line in process.stdout:
            try:
                value = json.loads(line)
                if value.get('id') in (1, 2):
                    responses.put(value)
            except ValueError:
                pass
    threading.Thread(target=receive, daemon=True).start()
    def request(number, method, params):
        process.stdin.write(json.dumps({'id': number, 'method': method, 'params': params}) + '\n')
        process.stdin.flush()
        return responses.get(timeout=15)
    record = {'route': 'native Codex app-server stdio', 'model_turns_started': 0,
              'image_submits': 0,
              'recorded_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        initial = request(1, 'initialize', {'clientInfo': {'name': 'image_provider_probe_readonly', 'version': 'r1'},
                                          'capabilities': {'experimentalApi': True}})
        record['initialize_ok'] = 'result' in initial
        if 'error' in initial:
            record['initialize_error'] = initial['error']
        else:
            process.stdin.write(json.dumps({'method': 'initialized', 'params': {}}) + '\n')
            process.stdin.flush()
            reply = request(2, 'modelProvider/capabilities/read', {})
            record['capability_response'] = reply.get('result')
            record['capability_error'] = reply.get('error')
    except queue.Empty:
        record['readonly_error'] = 'Timed out. No turn was started and no image submitted.'
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        record['process_exit_code'] = process.returncode
        with args.output.open('x', encoding='utf-8') as output:
            output.write(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(record, ensure_ascii=False))

if __name__ == '__main__':
    main()
