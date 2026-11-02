#!/usr/bin/env python3
"""공용 팔레트 검사, sRGB/D65 CIELAB 변환과 편집기용 내보내기."""
import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
PALETTE_PATH = ROOT / 'src/assets/palette.json'


def rgb_to_lab(rgb):
    """0~255 sRGB 배열을 D65 백색점의 L*, a*, b* 배열로 바꾼다."""
    c = np.asarray(rgb, dtype=np.float64) / 255
    linear = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = linear @ np.array([[0.4124564, 0.3575761, 0.1804375],
                             [0.2126729, 0.7151522, 0.0721750],
                             [0.0193339, 0.1191920, 0.9503041]]).T
    xyz /= np.array([0.95047, 1, 1.08883])
    delta = 6 / 29
    f = np.where(xyz > delta ** 3, np.cbrt(xyz), xyz / (3 * delta ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], axis=-1)


def all_colors(palette):
    """줄기 32색 뒤에 강조색(accents)을 붙인 목록. 동률이면 줄기 색이 먼저 뽑힌다."""
    return list(palette['colors']) + list(palette.get('accents', []))


def palette_rgb(palette):
    return np.array([tuple(bytes.fromhex(c['hex'][1:])) for c in all_colors(palette)], dtype=np.uint8)


def load_palette(path=PALETTE_PATH):
    palette = json.loads(Path(path).read_text(encoding='utf-8'))
    colors, ramps = palette['colors'], palette['ramps']
    if len(colors) != 32:
        raise ValueError('팔레트는 32색이어야 합니다.')
    if len({c['id'] for c in colors}) != 32:
        raise ValueError('팔레트 색 ID가 중복됩니다.')
    try:
        rgb = np.array([tuple(bytes.fromhex(c['hex'][1:])) for c in colors], dtype=np.uint8)
    except (ValueError, TypeError) as exc:
        raise ValueError('팔레트 hex는 #RRGGBB 형식이어야 합니다.') from exc
    if rgb.shape != (32, 3) or any(len(c['hex']) != 7 or not c['hex'].startswith('#') for c in colors):
        raise ValueError('팔레트 hex는 #RRGGBB 형식이어야 합니다.')
    if len({tuple(c) for c in rgb}) != 32:
        raise ValueError('팔레트 색 hex가 중복됩니다.')
    ramp_ids = {r['id'] for r in ramps}
    if len(ramps) != 8 or len(ramp_ids) != 8 or {c['ramp'] for c in colors} != ramp_ids:
        raise ValueError('팔레트는 서로 다른 8줄기여야 합니다.')
    lightness = rgb_to_lab(rgb)[:, 0]
    for ramp in ramps:
        indices = [i for i, c in enumerate(colors) if c['ramp'] == ramp['id']]
        if len(indices) != 4 or {colors[i]['step'] for i in indices} != {1, 2, 3, 4}:
            raise ValueError(f"{ramp['id']}: 줄기마다 1~4단계가 하나씩 있어야 합니다.")
        indices.sort(key=lambda i: colors[i]['step'])
        for left, right in zip(indices, indices[1:]):
            gap = lightness[right] - lightness[left]
            if gap < 7:
                raise ValueError(f"{ramp['id']}: 밝기 역전 또는 단계 간 L* 차이 부족 ({gap:.3f}, 최소 7).")
    accents = palette.get('accents', [])
    # 강조색은 줄기 밖의 낱색이다(2026-11-01 DECISIONS 화면 미술 방향 13항). 최대 4색, ID·hex는 줄기 색과 겹치지 않는다.
    if len(accents) > 4:
        raise ValueError('강조색은 최대 4색입니다.')
    ids = {c['id'] for c in colors} | set()
    seen = {tuple(c) for c in rgb}
    for accent in accents:
        hexv = accent.get('hex', '')
        if len(hexv) != 7 or not hexv.startswith('#'):
            raise ValueError('강조색 hex는 #RRGGBB 형식이어야 합니다.')
        value = tuple(bytes.fromhex(hexv[1:]))
        if accent.get('id') in ids or value in seen:
            raise ValueError('강조색 ID 또는 hex가 다른 색과 겹칩니다.')
        ids.add(accent['id']); seen.add(value)
    return palette


def nearest_indices(rgb, choices):
    """CIE76 최단 거리. 동률이면 choices의 앞 색을 택한다. 큰 입력은 나눠 처리한다."""
    shape = np.asarray(rgb).shape[:-1]
    pixels = np.asarray(rgb).reshape(-1, 3)
    labs = rgb_to_lab(choices)
    result = np.empty(len(pixels), dtype=np.int16)
    for start in range(0, len(pixels), 16384):
        sample = rgb_to_lab(pixels[start:start + 16384])
        distances = ((sample[:, None, :] - labs[None, :, :]) ** 2).sum(axis=2)
        result[start:start + len(sample)] = distances.argmin(axis=1)
    return result.reshape(shape)


def nearest_color(rgb, palette):
    colors = palette_rgb(palette)
    return all_colors(palette)[int(nearest_indices(rgb, colors))]


def export_palette(palette, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    lines = ['GIMP Palette', f"Name: {palette['id']}", 'Columns: 4', '#']
    for color, rgb in zip(all_colors(palette), palette_rgb(palette)):
        lines.append(f'{rgb[0]:3d} {rgb[1]:3d} {rgb[2]:3d}\t{color["id"]}')
    (directory / 'scitrade-32.gpl').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    (directory / 'scitrade-32.hex').write_text('\n'.join(c['hex'] for c in all_colors(palette)) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export', type=Path, required=True)
    args = parser.parse_args()
    export_palette(load_palette(), args.export)
