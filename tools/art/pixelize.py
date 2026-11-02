#!/usr/bin/env python3
"""AI 초안을 영역 최빈색으로 논리 격자·공용 팔레트에 맞춘다. 사람 보정 전 단계다."""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

try:
    from .palette import load_palette, nearest_indices, palette_rgb
except ImportError:
    from palette import load_palette, nearest_indices, palette_rgb


def parse_size(value):
    try:
        w, h = map(int, value.lower().split('x'))
        if w < 1 or h < 1:
            raise ValueError
        return w, h
    except ValueError as exc:
        raise argparse.ArgumentTypeError('크기는 양의 정수 WxH여야 합니다.') from exc


def despeckle_pixels(grid):
    """원본 격자를 보고 동시에 한 번만 정리한다. -1은 투명이다."""
    out = grid.copy()
    h, w = grid.shape
    for y in range(h):
        for x in range(w):
            current = grid[y, x]
            if current < 0:
                continue
            neighbors = [grid[ny, nx] for ny in range(max(0, y - 1), min(h, y + 2))
                         for nx in range(max(0, x - 1), min(w, x + 2))
                         if (ny, nx) != (y, x) and grid[ny, nx] >= 0]
            if current in neighbors:
                continue
            if neighbors:
                counts = np.bincount(neighbors)
                majority = counts.argmax()
                if counts[majority] >= 5:
                    out[y, x] = majority
    return out


def pixelize(image, size, palette, max_colors=None, despeckle=False, alpha_threshold=128):
    if not 0 <= alpha_threshold <= 255:
        raise ValueError('알파 기준은 0~255여야 합니다.')
    if max_colors is not None and not 1 <= max_colors <= 32:
        raise ValueError('색 수 상한은 1~32여야 합니다.')
    if image.mode.startswith('I;16') or image.mode in ('I', 'F'):
        raise ValueError('비트 깊이: 16비트 및 고정밀 입력은 8비트로 변환한 뒤 사용해 주세요.')
    # 열린 PNG의 디코더 정보는 BytesIO와 바뀐 파일 경로에서도 원본 깊이를 보존한다.
    for tile in getattr(image, 'tile', ()):
        args = tile[3]
        raw_mode = args[0] if isinstance(args, tuple) else args
        if isinstance(raw_mode, str) and ('16' in raw_mode or '32' in raw_mode):
            raise ValueError('비트 깊이: 16비트 입력은 8비트로 변환한 뒤 사용해 주세요.')
    # 이미 load()한 RGB는 원본 깊이를 복구할 수 없다. 경로 입력은 main에서 청크를 검사한다.
    source = np.asarray(image.convert('RGBA'))
    colors = palette_rgb(palette)
    opaque = source[..., 3] >= alpha_threshold
    mapped = np.full(opaque.shape, -1, dtype=np.int16)
    mapped[opaque] = nearest_indices(source[..., :3][opaque], colors)
    w, h = size
    sh, sw = mapped.shape
    grid = np.full((h, w), -1, dtype=np.int16)
    for y in range(h):
        y0, y1 = y * sh // h, max(y * sh // h + 1, (y + 1) * sh // h)
        for x in range(w):
            x0, x1 = x * sw // w, max(x * sw // w + 1, (x + 1) * sw // w)
            cell = mapped[y0:y1, x0:x1]
            visible = cell[cell >= 0]
            if len(visible) * 2 >= cell.size:
                grid[y, x] = np.bincount(visible, minlength=32).argmax()
    visible = grid[grid >= 0]
    if max_colors is not None and len(visible):
        counts = np.bincount(visible, minlength=32)
        # 사용 빈도 동률은 팔레트 등록 순서로 고정한다.
        keep = np.array(sorted(np.flatnonzero(counts), key=lambda i: (-counts[i], i))[:max_colors])
        remap = keep[nearest_indices(colors, colors[keep])]
        grid[grid >= 0] = remap[grid[grid >= 0]]
    if despeckle:
        grid = despeckle_pixels(grid)
    result = np.zeros((h, w, 4), dtype=np.uint8)
    opaque = grid >= 0
    result[opaque, :3] = colors[grid[opaque]]
    result[opaque, 3] = 255
    return Image.fromarray(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--size', type=parse_size, required=True)
    parser.add_argument('--max-colors', type=int)
    parser.add_argument('--despeckle', action='store_true')
    parser.add_argument('--alpha-threshold', type=int, default=128)
    args = parser.parse_args()
    try:
        try:
            from .png_format import png_errors
        except ImportError:
            from png_format import png_errors
        errors = png_errors(args.input)
        if errors:
            raise ValueError('\n'.join(errors))
        with Image.open(args.input) as source:
            result = pixelize(source, args.size, load_palette(), args.max_colors, args.despeckle, args.alpha_threshold)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        result.save(args.output, 'PNG', optimize=False, compress_level=9)
    except (ValueError, OSError) as exc:
        parser.exit(1, f'{exc}\n')
    rgba = np.asarray(result)
    used = np.unique(rgba[rgba[..., 3] == 255, :3], axis=0)
    print(json.dumps({'path': str(args.output), 'width': result.width, 'height': result.height,
                      'colors_used': len(used)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
