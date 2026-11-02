#!/usr/bin/env python3
"""등록 전 PNG 크기·칸 격자·알파·공용 팔레트를 검사한다."""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

try:
    from .palette import ROOT, load_palette, palette_rgb
    from .pixelize import parse_size
    from .png_format import png_errors
except ImportError:
    from palette import ROOT, load_palette, palette_rgb
    from pixelize import parse_size
    from png_format import png_errors

SLOTS = {
    'background': ((640, 360), None, 32),  # 2026-11-01 DECISIONS 화면 미술 방향 7항
    'icon': ((16, 16), None, 15), 'map-icon': ((16, 16), None, 15),
    'ship': ((24, 16), None, 15), 'frame': ((24, 24), None, 32),
    'map-east-asia': ((546, 615), None, 20), 'map-world': ((720, 244), None, 20),
}


def slot_spec(slot):
    if slot in SLOTS:
        return SLOTS[slot]
    slots = json.loads((ROOT / 'src/assets/manifest.json').read_text(encoding='utf-8'))['character_slots']
    if slot not in ('card', 'portrait', 'work'):
        raise ValueError(f'알 수 없는 슬롯: {slot}')
    spec = slots[slot]
    frame = (spec['frame_width'], spec['frame_height']) if spec.get('sheet') else None
    return ((spec['logical_width'], spec['logical_height']), frame, spec.get('max_opaque_colors', 32))


def check_asset(path, size, frame=None, max_colors=32):
    errors = []
    try:
        errors.extend(png_errors(Path(path)))
        with Image.open(path) as image:
            if image.format != 'PNG':
                errors.append('형식: 무손실 PNG 파일이어야 합니다.')
            if image.size != size:
                errors.append(f'크기: {size[0]}×{size[1]} 필요, 실제 {image.width}×{image.height}.')
            if frame and (image.width % frame[0] or image.height % frame[1]):
                errors.append(f'칸 격자: 크기는 {frame[0]}×{frame[1]} 칸의 배수여야 합니다.')
            rgba = np.asarray(image.convert('RGBA'))
    except OSError as exc:
        return [f'파일: 그림을 읽을 수 없습니다 ({exc}).']
    alpha = rgba[..., 3]
    if np.any((alpha != 0) & (alpha != 255)):
        errors.append('알파: 0과 255만 허용합니다. 반투명 픽셀이 있습니다.')
    colors = np.unique(rgba[alpha == 255, :3], axis=0)
    allowed = {tuple(c) for c in palette_rgb(load_palette())}
    outside = sum(tuple(c) not in allowed for c in colors)
    if outside:
        errors.append(f'팔레트: 불투명 픽셀에 공용 팔레트 밖 {outside}색이 있습니다.')
    if len(colors) > max_colors:
        errors.append(f'색 수: 불투명 {len(colors)}색으로 상한 {max_colors}색을 넘었습니다.')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--slot')
    mode.add_argument('--size', type=parse_size)
    parser.add_argument('--frame', type=parse_size)
    parser.add_argument('--max-colors', type=int)
    args = parser.parse_args()
    try:
        if args.slot:
            if args.frame is not None or args.max_colors is not None:
                raise ValueError('슬롯 규격은 --frame·--max-colors로 덮어쓸 수 없습니다.')
            size, frame, limit = slot_spec(args.slot)
        else:
            size, frame, limit = args.size, args.frame, args.max_colors if args.max_colors is not None else 32
        if limit < 1:
            raise ValueError('색 수 상한은 양의 정수여야 합니다.')
        errors = check_asset(args.file, size, frame, limit)
    except (ValueError, OSError) as exc:
        parser.exit(1, f'{exc}\n')
    for error in errors:
        print(error)
    if not errors:
        print('통과: PNG·크기·칸 격자·알파·팔레트·색 수 검사.')
    raise SystemExit(bool(errors))


if __name__ == '__main__':
    main()
