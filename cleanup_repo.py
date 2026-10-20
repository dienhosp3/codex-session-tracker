"""Preview generated repository files; pass --delete to remove them yourself."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


ROOT = Path(__file__).resolve().parent
GENERATED_DIRECTORIES = (
    '.runtime-build',
    '.hook-venv',
    'runtime/bin',
    '.vscode-test',
    'node_modules',
    'artifacts/diagnostics',
)


def checked(path):
    path = Path(os.path.abspath(path))
    if path == ROOT or not path.is_relative_to(ROOT):
        raise ValueError(f'Refusing a path outside the repository: {path}')
    if not path.parent.resolve().is_relative_to(ROOT):
        raise ValueError(f'Refusing a linked parent outside the repository: {path}')
    if path.relative_to(ROOT).parts[0].lower() == '.git':
        raise ValueError('The Git database is protected.')
    return path


def linked(path):
    attributes = path.lstat()
    return path.is_symlink() or bool(getattr(attributes, 'st_file_attributes', 0) & 0x400)


def generated_paths():
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8-sig'))
    if package.get('name') != 'codex-session-tracker' or not (ROOT / 'extension.js').is_file():
        raise ValueError('This script must remain in the Codex Session Tracker repository.')
    paths = [ROOT / name for name in GENERATED_DIRECTORIES]
    paths.extend((ROOT / 'artifacts').glob('.ui-edge-profile-*'))
    paths.extend(ROOT.glob('codex-session-tracker-*.vsix'))
    paths.extend((ROOT / 'artifacts').rglob('*.vsix'))
    paths.extend((ROOT / 'artifacts').glob('*-tests.log'))
    paths.extend((ROOT / 'artifacts' / 'verification').rglob('*.png'))
    for folder, directories, _ in os.walk(ROOT, followlinks=False):
        parent = Path(folder)
        directories[:] = [name for name in directories if name != '.git' and not linked(parent / name)]
        for name in list(directories):
            candidate = parent / name
            if name == '__pycache__':
                paths.append(candidate)
                directories.remove(name)
            elif any(candidate == target for target in paths):
                directories.remove(name)
    selected = []
    for path in sorted(set(paths), key=lambda item: (len(item.parts), str(item).lower())):
        if not path.exists():
            continue
        checked(path)
        if linked(path):
            raise ValueError(f'Refusing a linked cleanup target: {path.relative_to(ROOT)}')
        if not any(path.is_relative_to(parent) for parent in selected):
            selected.append(path)
    return selected


def total_bytes(path):
    checked(path)
    if linked(path):
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for folder, directories, names in os.walk(path, followlinks=False):
        for name in list(directories):
            child = Path(folder) / name
            checked(child)
            if linked(child):
                directories.remove(name)
        for name in names:
            child = Path(folder) / name
            checked(child)
            if not linked(child):
                total += child.stat().st_size
    return total


def sha256(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def verify_installed_runtime():
    local = ROOT / 'runtime' / 'bin' / 'windows-x86_64' / 'codex.exe'
    if not local.exists():
        return
    manifest = json.loads((ROOT / 'runtime' / 'manifest.json').read_text(encoding='utf-8-sig'))
    expected = manifest['sha256']
    if sha256(local) != expected:
        raise ValueError('Local runtime differs from its manifest; keep runtime/bin and review it manually.')
    extensions = Path.home() / '.vscode' / 'extensions'
    for extension in sorted(extensions.glob('local.codex-session-tracker-*'), reverse=True):
        installed = extension / 'runtime' / 'bin' / 'windows-x86_64' / 'codex.exe'
        if installed.is_file() and installed.stat().st_size == local.stat().st_size and sha256(installed) == expected:
            return
    raise ValueError('No identical installed Tracker runtime found. Use --keep-runtime to preserve runtime/bin.')


def remove_generated(path):
    checked(path)
    if linked(path):
        attributes = getattr(path.lstat(), 'st_file_attributes', 0)
        if os.name == 'nt' and attributes & 0x10:
            os.rmdir(path)
        else:
            path.unlink()
        return
    if path.is_dir():
        with os.scandir(path) as entries:
            children = [Path(entry.path) for entry in entries]
        for child in children:
            remove_generated(child)
        try:
            path.rmdir()
        except PermissionError:
            path.chmod(stat.S_IWRITE | stat.S_IREAD)
            path.rmdir()
    else:
        try:
            path.unlink()
        except PermissionError:
            path.chmod(stat.S_IWRITE | stat.S_IREAD)
            path.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--delete', action='store_true', help='Delete the generated files listed in the preview.')
    parser.add_argument('--keep-runtime', action='store_true', help='Keep runtime/bin for packaging without rebuilding.')
    arguments = parser.parse_args(argv)
    paths = generated_paths()
    if arguments.keep_runtime:
        paths = [path for path in paths if path != ROOT / 'runtime' / 'bin']
    planned = [(path, total_bytes(path)) for path in paths]
    print(f'Repository: {ROOT}')
    for path, size in planned:
        print(f'{size / 1024 / 1024:9.2f} MiB  {path.relative_to(ROOT)}')
    print(f'Total: {sum(size for _, size in planned) / 1024 / 1024:.2f} MiB in {len(planned)} targets')
    print('Preserved: source, tests, .git, runtime source/manifest/licenses and JSON/Markdown verification records.')
    print('Installed VS Code extensions and Codex accounts are outside the deletion scope.')
    if not arguments.delete:
        print('\nPreview only. To delete: python cleanup_repo.py --delete')
        print('To retain the packaging binary: python cleanup_repo.py --delete --keep-runtime')
        return 0
    if not arguments.keep_runtime:
        verify_installed_runtime()
    failures = []
    removed = 0
    for path, _ in planned:
        try:
            checked(path)
            total_bytes(path)
            remove_generated(path)
            print(f'DELETED {path.relative_to(ROOT)}')
            removed += 1
        except (OSError, ValueError) as error:
            failures.append(str(path.relative_to(ROOT)))
            print(f'FAILED {path.relative_to(ROOT)}: {error}', file=sys.stderr)
    print(f'Deleted {removed} targets; failed {len(failures)}.')
    if not arguments.keep_runtime:
        print('runtime/bin was generated. Rebuild with scripts/build-runtime.ps1 before packaging again.')
    return 1 if failures else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f'STOPPED: {error}', file=sys.stderr)
        raise SystemExit(1)
