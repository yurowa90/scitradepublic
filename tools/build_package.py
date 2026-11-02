#!/usr/bin/env python3
"""Refresh the development-data manifest and optionally build a portable ZIP."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = ['README.md', 'LICENSE', 'PACKAGE_STATUS.json', '.gitignore']
PACKAGE_DIR = ROOT / 'dist-package'
SOURCE_DIRS = ['docs', 'data', 'schemas', 'references', 'tests', 'tools']


def source_files():
    files = [ROOT / name for name in ROOT_FILES if (ROOT / name).is_file()]
    for dirname in SOURCE_DIRS:
        files.extend(path for path in (ROOT / dirname).rglob('*')
                     if path.is_file() and '__pycache__' not in path.parts
                     and path.suffix not in {'.pyc', '.pyo'})
    return sorted(files, key=lambda path: path.relative_to(ROOT).as_posix())


def build_manifest(status: dict, files: list[Path]) -> dict:
    return {
        'package_version': status['package_version'],
        'created_on': status['rebuilt_on'],
        'game_implemented': status['game_implemented'],
        'external_assets_bundled': False,
        'external_statistics_sample_bundled': 'ECB 10-day FX sample with attribution',
        'files': [{'path': path.relative_to(ROOT).as_posix(),
                   'size_bytes': path.stat().st_size,
                   'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                  for path in files],
    }


def manifest_text(manifest: dict) -> str:
    return json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'


def manifest_differences(current: dict, expected: dict) -> list[str]:
    differences = []
    for key in sorted((current.keys() | expected.keys()) - {'files'}):
        if key not in current or key not in expected or current[key] != expected[key]:
            differences.append(f'머리 값 다름: {key} {current.get(key)} → {expected.get(key)}')
    old = {item['path']: item for item in current.get('files', [])}
    new = {item['path']: item for item in expected['files']}
    for path in sorted(old.keys() | new.keys()):
        if path not in old:
            differences.append(f'목록에 없음(추가 필요): {path}')
        elif path not in new:
            differences.append(f'디스크에 없음(빼야 함): {path}')
        elif old[path] != new[path]:
            differences.append(f'해시·크기 다름: {path}')
    return differences


def check_manifest() -> int:
    path = ROOT / 'MANIFEST.json'
    try:
        raw = path.read_bytes()
        current = json.loads(raw)
    except FileNotFoundError:
        print('MANIFEST.json이 없습니다')
        return 1
    except (ValueError, UnicodeError):
        print('MANIFEST.json의 JSON이 깨졌습니다')
        return 1
    status = json.loads((ROOT / 'PACKAGE_STATUS.json').read_text(encoding='utf-8'))
    expected = build_manifest(status, source_files())
    if raw == manifest_text(expected).encode('utf-8'):
        print(f"MANIFEST 일치: {len(expected['files'])}개 파일")
        return 0
    try:
        differences = manifest_differences(current, expected)
    except (TypeError, KeyError, AttributeError):
        differences = ['MANIFEST.json의 구조가 올바르지 않습니다']
    print('\n'.join(differences or ['형식만 다름']))
    print('MANIFEST 불일치 — python3 tools/build_package.py --manifest-only로 다시 만든다')
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--manifest-only', action='store_true')
    modes.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.check:
        return check_manifest()
    status = json.loads((ROOT / 'PACKAGE_STATUS.json').read_text(encoding='utf-8'))
    files = source_files()
    manifest = build_manifest(status, files)
    manifest_path = ROOT / 'MANIFEST.json'
    manifest_path.write_text(manifest_text(manifest),
                             encoding='utf-8')
    if args.manifest_only:
        print(f'Manifest refreshed: {len(files)} source files')
        return 0
    subprocess.run([sys.executable, str(ROOT/'tools'/'validate_data.py')], check=True)
    output_dir = PACKAGE_DIR
    output_dir.mkdir(exist_ok=True)
    name = 'Scitrade_development_v' + status['package_version']
    output = output_dir / (name + '.zip')
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in files + [manifest_path]:
            archive.write(path, name + '/' + path.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('ZIP integrity check failed')
    print(f'Created {output.name}: {len(files)+1} files; ZIP integrity PASS')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
