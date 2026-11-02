"""Assemble an arm64 macOS app using the Windows CI artifact from this commit."""
import argparse
import hashlib
import json
import platform
import plistlib
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
NODE_VERSION = '26.9.0'
NODE_ARCHIVE_SHA = '6f3de7ed853ee283b4bf24b6e426618f1d357401ce5815db1866eb85eb4b05d9'
NODE_EXE_SHA = '8bebc3d846767864093af8619b1a6dc2ff01dea4f643b8bdb5e8cbd51bf6756d'
NODE_FOLDER = f'node-v{NODE_VERSION}-darwin-arm64'


def verify(path, expected):
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError(f'Incorrect SHA-256 for {path.name}')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def build(args):
    if (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
        raise ValueError('Build this package on Apple Silicon macOS')
    if git('status', '--porcelain'):
        raise ValueError('Use a clean source checkout and output outside it')
    package = json.loads((ROOT/'package.json').read_bytes())
    version = package['version']
    if package['engines']['node'] != NODE_VERSION:
        raise ValueError('Update the pinned Node runtime before building')
    verify(args.windows, args.windows_sha256)
    verify(args.node, NODE_ARCHIVE_SHA)
    commit, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
    args.out.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(dir=args.out) as stage:
        app = Path(stage)/'创作有数.app'
        contents = app/'Contents'
        resources = contents/'Resources'
        for folder in (resources/'runtime', contents/'Helpers', contents/'MacOS'):
            folder.mkdir(parents=True)
        with zipfile.ZipFile(args.windows) as win:
            metadata = json.loads(win.read('release.json'))
            baseline = (version, commit, tree, 'win32', 'x64', NODE_VERSION)
            if tuple(metadata[k] for k in ('version','commit','tree','platform','arch','nodeVersion')) != baseline:
                raise ValueError('Windows payload does not match this source revision')
            for member in win.infolist():
                name = member.filename
                if member.is_dir() or not name.startswith(('app/','web/','licenses/')) or name.startswith('licenses/node/'):
                    continue
                parts = name.split('/')
                if any(p in ('', '.', '..') for p in parts) or '\\' in name:
                    raise ValueError(f'Unexpected ZIP member: {name}')
                dest = resources/name
                dest.parent.mkdir(parents=True, exist_ok=True)
                with win.open(member) as source, dest.open('xb') as target:
                    shutil.copyfileobj(source, target)
        if json.loads((resources/'app/package.json').read_bytes())['version'] != version:
            raise ValueError('Incorrect bundled service version')
        if '<title>创作有数</title>' not in (resources/'web/index.html').read_text():
            raise ValueError('Incorrect web product name')
        node = contents/'Helpers/node'
        node_license = resources/'licenses/node/LICENSE'
        node_license.parent.mkdir()
        with tarfile.open(args.node, 'r:gz') as archive:
            for member, dest in [('bin/node', node), ('LICENSE', node_license)]:
                with archive.extractfile(f'{NODE_FOLDER}/{member}') as source, dest.open('xb') as target:
                    shutil.copyfileobj(source, target)
        verify(node, NODE_EXE_SHA)
        node.chmod(0o755)
        subprocess.run(['codesign','--verify','--strict',node],check=True)
        for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
            shutil.copyfile(ROOT/name, resources/name)
        shutil.copyfile(HERE/'launcher.mjs', resources/'runtime/launcher.mjs')
        info = plistlib.loads((HERE/'Info.plist').read_bytes())
        info.update(CFBundleShortVersionString=version, CFBundleVersion=version, LSMinimumSystemVersion='13.5')
        (contents/'Info.plist').write_bytes(plistlib.dumps(info))
        subprocess.run(['xcrun','clang','-arch','arm64','-mmacosx-version-min=13.5','-fobjc-arc','-framework','Cocoa',
                        '-o', contents/'MacOS/Workbench', HERE/'main.m'],check=True)
        provenance = dict(version=version,commit=commit,tree=tree,platform='darwin',arch='arm64',
                          windowsInputSha256=args.windows_sha256,nodeVersion=NODE_VERSION,
                          nodeUrl=f'https://nodejs.org/dist/v{NODE_VERSION}/{NODE_FOLDER}.tar.gz',
                          nodeArchiveSha256=NODE_ARCHIVE_SHA,upstreamNodeExeSha256=NODE_EXE_SHA,
                          thirdParty=metadata['thirdParty'])
        (resources/'release.json').write_text(json.dumps(provenance,indent=2)+'\n')
        app.rename(args.out/app.name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--windows', type=Path, required=True)
    parser.add_argument('--windows-sha256', required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    build(parser.parse_args())
