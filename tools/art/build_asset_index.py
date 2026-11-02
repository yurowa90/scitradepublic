#!/usr/bin/env python3
"""출처 원장에서 승인 자산의 화면용 목록을 만든다."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSET_FIELDS = ('id', 'kind', 'path', 'status', 'width', 'height', 'employee_id',
                'slot', 'bounds', 'pixel_grid')
SLOT_FIELDS = ('logical_width', 'logical_height', 'aspect', 'sheet', 'frame_width',
               'frame_height', 'rows', 'frames_per_row', 'frame_ms', 'reduced_motion')


def build_index(manifest):
    return {
        'pixel_art': {'rendering': manifest['pixel_art']['rendering']},
        'character_slots': {
            name: {key: value for key, value in spec.items() if key in SLOT_FIELDS}
            for name, spec in manifest['character_slots'].items() if name != 'reference'
        },
        'assets': [dict({key: asset[key] for key in ASSET_FIELDS if key in asset},
                        attribution=asset.get('provenance', {}).get('attribution', ''))
                   for asset in manifest['assets'] if asset['status'] == 'approved'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'src/assets/manifest.json').read_text(encoding='utf-8'))
    target = ROOT / 'src/assets/asset-index.json'
    content = json.dumps(build_index(manifest), ensure_ascii=False, indent=2) + '\n'
    if args.check:
        if not target.exists() or target.read_text(encoding='utf-8') != content:
            parser.exit(1, '실패: 화면용 자산 목록을 다시 만들어 주세요.\n')
        print('통과: 화면용 자산 목록이 출처 원장과 일치합니다.')
    else:
        target.write_text(content, encoding='utf-8')
        print('생성: src/assets/asset-index.json')


if __name__ == '__main__':
    main()
