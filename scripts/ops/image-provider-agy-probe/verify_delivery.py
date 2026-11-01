#!/usr/bin/env python3
"""Verify saved probe payloads/images; default is read-only and provider-free.

r1 changed scripts are checked at their frozen snapshots. The nineteen r1
baseline checks are historical saved facts, not assertions about current
integration code. Optional public-baseline observations never read private
configuration/credentials and never reclassify legal integration as probe failure.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re



def write_new_output(target, value, frozen):
    target = Path(target).absolute()
    resolved = target.resolve()
    if any(resolved.is_relative_to(folder.resolve()) for folder in frozen):
        raise ValueError('Output is inside frozen r1 evidence; use a new output path')
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('x', encoding='utf-8') as output:
        output.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def verify(*, evidence_dir, snapshot_dir, root, expected_model, current_public_baseline=False):
    from PIL import Image
    ROOT = Path(root)
    out, snapshot = Path(evidence_dir), Path(snapshot_dir)
    results = []

    def check(name, condition, detail=None):
        results.append({'check': name, 'status': 'passed' if condition else 'failed', 'detail': detail})

    manifest = json.loads((out / 'manifest.json').read_text())
    canonical = json.dumps(sorted(manifest['output_files'], key=lambda item: item['path']),
                           ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    check('r1:canonical_candidate', 'sha256:' + hashlib.sha256(canonical).hexdigest() == manifest['candidate_id'])
    snapshot_map = json.loads((snapshot / 'snapshot-map.json').read_text())
    snapshots = {entry['original_path']: entry for entry in snapshot_map['snapshots']}
    check('r1:manifest_preserved', hashlib.sha256((out / 'manifest.json').read_bytes()).hexdigest() == snapshot_map['manifest_sha256'])
    for entry in manifest['output_files']:
        # Only the three revised scripts are remapped. Every other r1 payload
        # remains checked at its original frozen path, including README/JSON.
        use_snapshot = entry['path'] in snapshots and entry['path'].endswith('.py')
        file = ROOT / (snapshots[entry['path']]['snapshot_path'] if use_snapshot else entry['path'])
        actual = hashlib.sha256(file.read_bytes()).hexdigest()
        check('r1:payload:' + entry['path'], actual == entry['sha256'] and file.stat().st_size == entry['bytes'],
              {'sha256': actual, 'source': 'r1_script_snapshot' if use_snapshot else 'frozen_original'})

    for operation in ('generate', 'edit'):
        record = json.loads((out / f'agy-{operation}-invocation.json').read_text())
        source = record['image']
        file = ROOT / source['path']
        check(f'{operation}:image_hash', hashlib.sha256(file.read_bytes()).hexdigest() == source['sha256'])
        with Image.open(file) as image:
            image.verify()
        with Image.open(file) as image:
            image.load()
            check(f'{operation}:full_decode_dimensions', list(image.size) == [source['width'], source['height']])
        check(f'{operation}:exactly_one_saved_tool_call', record['observed_generate_image_tool_calls'] == 1)
        native = record['native_tool_request_evidence'][0]
        check(f'{operation}:saved_model_bound_to_output', native['output_binding_checked'] and
              native['model_name'] == expected_model and
              native['image_uri'] == 'file://' + source['original_provider_path'] and
              native['image_num_bytes'] == source['bytes'])
        check(f'{operation}:saved_terminal_success', record['terminal_status'] == 'SUCCESS' and record['exit_code'] == 0)
        if operation == 'edit':
            image_paths = json.loads(record['tool_calls'][0]['args']['ImagePaths'])
            check('edit:saved_reference_binding', image_paths == [str(out / 'agy-generated-v1.jpg')])

    codex = json.loads((out / 'codex-host-invocation.json').read_text())
    file = Path(codex['saved_path'])
    check('codex:saved_host_output_hash', hashlib.sha256(file.read_bytes()).hexdigest() == codex['output_sha256'])
    with Image.open(file) as image:
        image.verify()
    with Image.open(file) as image:
        image.load()
        check('codex:saved_host_full_decode_dimensions', list(image.size) == [codex['width'], codex['height']])
    capability = json.loads((out / 'codex-native-capabilities.json').read_text())
    check('codex:saved_readonly_capability', capability['capability_response']['imageGeneration'] is True and
          capability['model_turns_started'] == 0 and capability['image_submits'] == 0)

    baseline = json.loads((out / 'baseline.json').read_text())
    saved_verification = json.loads((out / 'verification.json').read_text())
    saved_checks = {entry['check']: entry for entry in saved_verification['checks']}
    observations = []
    for entry in baseline['baseline_files']:
        saved = saved_checks.get('baseline:' + entry['path'], {})
        detail = saved.get('detail') or {}
        check('r1:saved_baseline_fact:' + entry['path'], saved.get('status') == 'passed' and
              detail.get('baseline') == entry['sha256'] and detail.get('current') == entry['sha256'],
              {'r1_sha256': entry['sha256'], 'scope': 'saved_r1_fact_only; current_not_asserted'})
        if current_public_baseline:
            if Path(entry['path']).is_absolute():
                observations.append({'path': entry['path'], 'status': 'not_read_private_or_external',
                                     'scope': 'current_private_configuration_not_authorized'})
            else:
                file = ROOT / entry['path']
                actual = hashlib.sha256(file.read_bytes()).hexdigest() if file.is_file() else None
                observations.append({'path': entry['path'], 'r1_sha256': entry['sha256'], 'current_sha256': actual,
                                     'status': 'unchanged_since_r1' if actual == entry['sha256'] else 'changed_since_r1',
                                     'scope': 'informational_current_public_observation; integration_candidate_separate'})

    patterns = [r'Bearer\s+[A-Za-z0-9._~-]{12,}', r'(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{25,}',
                r'(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}',
                r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}']
    hits = []
    for file in out.rglob('*'):
        if file.is_file() and file.suffix not in ('.jpg', '.png'):
            if any(re.search(pattern, file.read_text()) for pattern in patterns):
                hits.append(str(file.relative_to(out)))
    check('r1:published_evidence:no_credential_patterns', not hits, {'files_with_hits': hits})
    failed = [entry for entry in results if entry['status'] == 'failed']
    return {'task': 'IMAGE-PROVIDER-AGY-PROBE', 'requirement_version': 'r2',
            'historical_candidate_id': manifest['candidate_id'],
            'provider_calls_in_this_verification': 0, 'checks': results,
            'passed': len(results) - len(failed), 'failed': len(failed),
            'current_public_baseline_observations': observations,
            'verification_changed': False,
            'evidence_grade': 'saved_evidence_consistency_and_full_image_decode; no private native payload redecoded',
            'not_run': ['new_provider_calls', 'private_database_or_credentials', 'current_integration_acceptance']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--snapshot-dir', type=Path, required=True)
    parser.add_argument('--check-current-public-baseline', action='store_true')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--expected-model', required=True)
    args = parser.parse_args()
    result = verify(evidence_dir=args.evidence_dir, snapshot_dir=args.snapshot_dir,
                    root=args.root, expected_model=args.expected_model, current_public_baseline=args.check_current_public_baseline)
    if args.output:
        write_new_output(args.output, result, [args.evidence_dir, args.snapshot_dir])
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(1 if result['failed'] else 0)


if __name__ == '__main__':
    main()
