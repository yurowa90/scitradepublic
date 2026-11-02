#!/usr/bin/env python3
"""게임 지도 배경을 만든다: 동아시아 해역(1장 확대 지도)과 태평양 중심 세계지도.

입력 (공공 도메인 위성 합성 영상과 지형 높이 지도, 정거원통도법 4096×2048 / 2048×1024):
  bluemarble.jpg  NASA Blue Marble 합성 영상 — GitHub vasturiano/three-globe 예제 사본에서 받음
  ne/ne_{10m,50m}_{land,lakes}.geojson  Natural Earth 공공 도메인 육지·호수 벡터
  topology.png    지형 높이 회색조 지도(바다 0) — 같은 저장소 예제 사본
출력: 기본 pixel은 public/assets/maps/의 논리 해상도 PNG. satellite은 옛 WebP 지도를 참고용으로 재현해
  <입력 폴더>/satellite-reference/에 쓴다(배포 폴더 public/에는 쓰지 않는다).

픽셀 처리: 벡터 육지·호수 7×7 면적 판정 → 관문 4-연결 통로 → 위성 색 지형 분류
→ 해상도 보정 언덕 음영·분류 안 최빈값 → 팔레트·해안선 → 무손실 PNG.
위성 처리: 지역 자르기 → 2배 확대 → 산맥 음영(북서쪽 광원) → 수심 느낌의 바다 그라데이션
→ 모래색 해안선 → 가장자리 어둡게. 지형 색은 원본 위성 영상에서 가져오고 새로 칠하지 않는다.
필요 패키지: Pillow, numpy (게임 실행에는 필요 없음).

  python3 scripts/build_map.py --source-dir <입력 폴더> [--region east-asia|world] [--style pixel|satellite]

세계지도는 한국에서 익숙한 태평양 중심 배치다. 경도 −30°(대서양 한가운데)에서 잘라 330°까지 한 바퀴를 펼친다.
"""
from pathlib import Path
import argparse
import hashlib
import json

import numpy as np
from PIL import Image, ImageFilter, __version__ as PILLOW_VERSION

ROOT = Path(__file__).resolve().parents[1]
REGIONS = {
    # 1장 6개 거점(자카르타 −6.1° ~ 부산 35.1°, 싱가포르 103.8° ~ 요코하마 139.6°)을 모두 포함. 원본의 2배 확대.
    'east-asia': {'bounds': {'lon_min': 98.0, 'lon_max': 146.0, 'lat_min': -10.0, 'lat_max': 44.0},
                  'px_per_deg': 4096 / 360 * 2, 'scale': 2, 'file': 'east-asia.webp'},
    # 세계 거점 20곳(멜버른 −37.8° ~ 로테르담 51.9°)과 희망봉을 포함. 경도는 −30°~330°로 한 바퀴.
    'world': {'bounds': {'lon_min': -30.0, 'lon_max': 330.0, 'lat_min': -50.0, 'lat_max': 72.0},
              'px_per_deg': 10.0, 'file': 'world.webp'},
}
# 동아시아 지도에서 정한 필터 반경(픽셀)의 기준 해상도. 다른 해상도에서는 같은 지리적 크기가 되도록 비례 조정한다.
REFERENCE_PX_PER_DEG = 4096 / 360 * 2


def crop_equirect(img, b):
    """정거원통도법 영상을 경위도 범위로 자른다. 경도가 180°를 넘으면 영상을 옆으로 이어 붙여 감싼다."""
    w, h = img.size
    if b['lon_max'] > 180:
        wide = Image.new(img.mode, (w * 2, h))
        wide.paste(img, (0, 0))
        wide.paste(img, (w, 0))
        img = wide
    x0 = (b['lon_min'] + 180) / 360 * w
    x1 = (b['lon_max'] + 180) / 360 * w
    y0 = (90 - b['lat_max']) / 180 * h
    y1 = (90 - b['lat_min']) / 180 * h
    return img.crop((round(x0), round(y0), round(x1), round(y1)))


def odd(n):
    n = max(3, round(n))
    return n if n % 2 else n + 1


def build_satellite(args):
    region = REGIONS[args.region]
    BOUNDS = region['bounds']
    f = region['px_per_deg'] / REFERENCE_PX_PER_DEG  # 동아시아 지도 = 1
    color_src = args.source_dir / 'bluemarble.jpg'
    topo_src = args.source_dir / 'topology.png'

    color = crop_equirect(Image.open(color_src).convert('RGB'), BOUNDS)
    if 'scale' in region:  # 잘라낸 원본 픽셀을 정수배로 확대 (동아시아 지도의 원래 방식)
        size = (color.width * region['scale'], color.height * region['scale'])
    else:
        size = (round((BOUNDS['lon_max'] - BOUNDS['lon_min']) * region['px_per_deg']),
                round((BOUNDS['lat_max'] - BOUNDS['lat_min']) * region['px_per_deg']))
    color = color.resize(size, Image.LANCZOS)
    topo = crop_equirect(Image.open(topo_src).convert('L'), BOUNDS).resize(size, Image.BICUBIC)

    rgb = np.asarray(color).astype(np.float32) / 255
    height = np.asarray(topo).astype(np.float32) / 255

    # 육지: 높이 > 0. 색(파란빛이 우세하지 않음)은 높이로 확인된 육지 근처의 해안 저지대 보완에만 쓴다.
    # 색만으로 판정하면 얕은 바다·산호초가 가짜 섬으로 잡힌다.
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    height_land = height > 0.004
    near_height_land = np.asarray(
        Image.fromarray((height_land * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9 if f == 1 else odd(9 * f)))) > 127
    land = height_land | ((b < np.maximum(r, g) + 0.04) & near_height_land)
    land_img = Image.fromarray((land * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(5 if f == 1 else odd(5 * f)))
    land = np.asarray(land_img) > 127

    # 산맥 음영 (Horn 방식 근사, 광원 방위 315°·고도 40°).
    z = np.asarray(topo.filter(ImageFilter.GaussianBlur(1.2 * f))).astype(np.float32) / 255 * 60 * f
    dy, dx = np.gradient(z)
    slope = np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(dy, -dx)
    az, alt = np.radians(315), np.radians(40)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    shade = np.clip(shade, 0, 1)

    # 육지: 채도·온기를 조금 올리고 음영을 곱한다.
    lum = rgb.mean(axis=2, keepdims=True)
    land_rgb = lum + (rgb - lum) * 1.25
    land_rgb = land_rgb * np.array([1.06, 1.02, 0.92]) * 1.18
    land_rgb = land_rgb * (0.55 + 0.75 * shade[..., None])

    # 바다: 해안에서 멀어질수록 깊은 남색. 원본 바다 질감을 30% 남긴다.
    near = np.asarray(Image.fromarray((land * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(22 * f))).astype(np.float32) / 255
    near = np.clip(near * 2.2, 0, 1)[..., None] ** 0.8
    deep = np.array([0.05, 0.16, 0.33])
    shallow = np.array([0.16, 0.47, 0.56])
    sea_rgb = deep * (1 - near) + shallow * near
    sea_rgb = sea_rgb * 0.7 + rgb * 0.3 * 1.4

    out = np.where(land[..., None], land_rgb, sea_rgb)

    # 모래색 해안선.
    eroded = np.asarray(Image.fromarray((land * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))) > 127
    coast = land & ~eroded
    coast_soft = np.asarray(Image.fromarray((coast * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.1 * max(f, 0.6)))).astype(np.float32) / 255
    sand = np.array([0.93, 0.86, 0.66])
    out = out * (1 - 0.55 * coast_soft[..., None]) + sand * 0.55 * coast_soft[..., None]

    # 가장자리 어둡게.
    yy, xx = np.mgrid[0:size[1], 0:size[0]]
    d = np.hypot((xx - size[0] / 2) / (size[0] / 2), (yy - size[1] / 2) / (size[1] / 2))
    out = out * (1 - 0.28 * np.clip(d - 0.55, 0, 1)[..., None] / 0.85)

    img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))
    img = img.filter(ImageFilter.UnsharpMask(radius=1.6, percent=60, threshold=2))

    # 옛 위성 지도는 참고용 재현이다. public/에 쓰면 배포 빌드에 다시 들어가므로 원본 폴더 아래에 쓴다.
    dest = args.source_dir / 'satellite-reference' / region['file']
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, 'WEBP', quality=82, method=6)
    meta = {
        'path': str(dest),
        'width': size[0],
        'height': size[1],
        'bounds': BOUNDS,
        'projection': 'equirectangular',
        'inputs_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (color_src, topo_src)},
        'output_sha256': hashlib.sha256(dest.read_bytes()).hexdigest(),
    }
    print(json.dumps(meta, ensure_ascii=False, indent=2))


# 픽셀 분류 경계값. 높이는 원본 회색조의 0~1 값이며 실제 미터가 아니다.
MOUNTAIN_HEIGHT = 0.38  # 눈·얼음을 제외한 높은 곳을 산지로 분류
SNOW_BRIGHTNESS = 0.72  # 밝고 무채색에 가까운 눈·얼음
SNOW_SATURATION = 0.16
DRY_RED_GREEN = 1.12  # 붉은빛이 초록보다 강한 흙·건조지
DRY_BRIGHTNESS = 0.32
FOREST_GREEN_MARGIN = 0.025  # 초록이 붉은빛보다 우세한 곳
FOREST_MAX_BRIGHTNESS = 0.42
SHADE_LOW = 0.45  # 북서쪽 언덕 음영을 어두움·중간·밝음으로 나누는 경계
SHADE_HIGH = 0.75
PIXEL_SIZES = {'east-asia': (546, 615), 'world': (720, 244)}
LOWLAND, FOREST, DRY, MOUNTAIN, SNOW = range(5)
TERRAIN_RAMPS = {
    LOWLAND: ('green-2', 'green-3', 'green-4'),
    FOREST: ('green-1', 'green-2', 'green-3'),
    DRY: ('earth-2', 'earth-3', 'earth-4'),
    MOUNTAIN: ('ink-4', 'light-1', 'light-2'),
    SNOW: ('light-3', 'light-4', 'light-4'),
}


def shifted(array, dy, dx, fill=None):
    """이웃 배열을 만든다. 기본 가장자리는 복제하고, fill이 있으면 바깥을 그 값으로 둔다."""
    pad = max(abs(dy), abs(dx))
    if not pad:
        return array.copy()
    padding = [(pad, pad), (pad, pad)] + [(0, 0)] * (array.ndim - 2)
    padded = np.pad(array, padding, mode='edge') if fill is None else np.pad(array, padding, constant_values=fill)
    h, w = array.shape[:2]
    return padded[pad + dy:pad + dy + h, pad + dx:pad + dx + w]


def classify_terrain(rgb, height, land):
    r, g, b = np.moveaxis(rgb, -1, 0)
    brightness = rgb.mean(axis=2)
    saturation = rgb.max(axis=2) - rgb.min(axis=2)
    classes = np.full(land.shape, LOWLAND, dtype=np.int16)
    classes[(g > r + FOREST_GREEN_MARGIN) & (g > b) & (brightness < FOREST_MAX_BRIGHTNESS)] = FOREST
    classes[(r > g * DRY_RED_GREEN) & (brightness > DRY_BRIGHTNESS)] = DRY
    classes[height > MOUNTAIN_HEIGHT] = MOUNTAIN
    classes[(brightness > SNOW_BRIGHTNESS) & (saturation < SNOW_SATURATION)] = SNOW
    return np.where(land, classes, -1)


def smooth_classes(classes, land):
    """육지 분류의 3×3 최빈값. 바다는 투표에서 빼고 동률은 원래 분류를 유지한다."""
    votes = np.stack([sum((shifted(classes, dy, dx, -1) == category).astype(np.int16)
                         for dy in (-1, 0, 1) for dx in (-1, 0, 1)) for category in range(5)])
    winner = votes.argmax(axis=0).astype(np.int16)
    best = votes.max(axis=0)
    own = np.take_along_axis(votes, np.maximum(classes, 0)[None, ...], axis=0)[0]
    winner[own == best] = classes[own == best]
    return np.where(land, winner, -1)


def isolated_ratio(classes, land):
    same = np.zeros(land.shape, dtype=bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy or dx:
                same |= shifted(classes, dy, dx, -2) == classes
    return float(np.count_nonzero(land & ~same) / max(1, np.count_nonzero(land)))


def geo_pixel(position, bounds, size):
    """UI의 wrapLon·project와 같은 경도 감싸기. 좌표를 포함하는 논리 칸을 택한다."""
    lon = (position['lon'] - bounds['lon_min']) % 360 + bounds['lon_min']
    lat = position['lat']
    if lon > bounds['lon_max'] or not bounds['lat_min'] <= lat <= bounds['lat_max']:
        return None
    w, h = size
    return (min(w - 1, int((lon - bounds['lon_min']) / (bounds['lon_max'] - bounds['lon_min']) * w)),
            min(h - 1, int((bounds['lat_max'] - lat) / (bounds['lat_max'] - bounds['lat_min']) * h)))


# 좁은 해협·운하를 가로지르는 양쪽 물의 기준점. 지도 표시만 바꾸며 운송 데이터는 그대로다.
PASSAGES = {
    'MALACCA_STRAIT': ((98.0, 7.0), (103.9, 1.15)),
    'HORMUZ_STRAIT': ((54.0, 26.0), (59.0, 24.0)),
    'BAB_EL_MANDEB': ((42.0, 15.0), (45.0, 12.0)),
    'SUEZ_CANAL': ((32.0, 32.0), (34.0, 27.0)),
    'PANAMA_CANAL': ((-80.0, 7.0), (-79.0, 10.0)),
    'CAPE_OF_GOOD_HOPE': ((17.5, -35.0), (20.0, -35.0)),
    'GIBRALTAR': ((-7.0, 36.0), (-4.0, 36.0)),
    'BOSPORUS': ((28.0, 40.8), (30.0, 42.0)),
    'DARDANELLES': ((25.0, 39.0), (28.0, 40.8)),
    'KOREA_STRAIT': ((129.0, 32.0), (130.5, 36.0)),
}
SEA_PAIRS = {
    '지중해–대서양': ((15, 35), (-15, 36)),
    '지중해–홍해': ((28, 34), (38, 20)),
    '홍해–아덴만': ((38, 20), (48, 12)),
    '페르시아만–아라비아해': ((51, 27), (64, 20)),
    '태평양–카리브해': ((-82, 5), (-77, 13)),
    '안다만해–남중국해': ((98, 8), (110, 10)),
    '동해–동중국해': ((133, 39), (125, 29)),
}
CHECK_POINTS = {
    '상하이 시가지': (121.5, 31.2, True),
    '상하이 동쪽 바다': (123.5, 31.0, False),
    '슈피리어호': (-87.5, 47.5, False),
    '카스피해': (51.0, 42.0, False),
    '베이징': (116.4, 39.9, True),
    '오키나와 본섬': (127.8, 26.4, True),
}


def component_labels(land):
    """지도 전체 물의 4-연결 성분을 구한다. 지도 가장자리끼리는 연결하지 않는다."""
    from collections import deque
    labels = np.full(land.shape, -1, dtype=np.int32)
    h, w = land.shape
    count = 0
    for y, x in zip(*np.nonzero(~land)):
        if labels[y, x] >= 0:
            continue
        labels[y, x] = count
        pending = deque([(y, x)])
        while pending:
            cy, cx = pending.popleft()
            for ny, nx in ((cy-1, cx), (cy+1, cx), (cy, cx-1), (cy, cx+1)):
                if 0 <= ny < h and 0 <= nx < w and not land[ny, nx] and labels[ny, nx] < 0:
                    labels[ny, nx] = count
                    pending.append((ny, nx))
        count += 1
    return labels


def sea_connections(land, bounds):
    labels = component_labels(land)
    checks = []
    for name, pair in SEA_PAIRS.items():
        points = [geo_pixel({'lon': lon, 'lat': lat}, bounds, (land.shape[1], land.shape[0])) for lon, lat in pair]
        if None in points:
            continue
        components = [int(labels[y, x]) for x, y in points]
        checks.append({'name': name, 'pixels': points, 'components': components,
                       'connected': components[0] >= 0 and components[0] == components[1]})
    return checks


# 창 밖을 막고 검사하여 희망봉 우회가 운하 검사를 대신하지 못하게 한다.
PASSAGE_WINDOWS = {
    'MALACCA_STRAIT': (97, 106, -1, 8), 'HORMUZ_STRAIT': (50, 61, 22, 29),
    'BAB_EL_MANDEB': (39, 48, 10, 17), 'SUEZ_CANAL': (30, 36, 26, 34),
    'PANAMA_CANAL': (-83, -76, 5, 12), 'CAPE_OF_GOOD_HOPE': (15, 23, -38, -32),
    'GIBRALTAR': (-8, -3, 34, 38), 'BOSPORUS': (27, 32, 39, 43),
    'DARDANELLES': (24, 30, 37, 42), 'KOREA_STRAIT': (125, 134, 30, 38),
}
MAX_PASSAGE_LAND_CELLS = 6
# 자료에 없는 보조 해협도 실제 관문 좌표로 검사한다.
PASSAGE_MARKERS = {
    'GIBRALTAR': {'lon': -5.6, 'lat': 35.95},
    'BOSPORUS': {'lon': 29.0, 'lat': 41.1},
    'DARDANELLES': {'lon': 26.4, 'lat': 40.2},
}


def pixel_distances(pixels, position, bounds, size):
    """실제 표시 좌표에서 논리 칸의 닫힌 정사각형까지의 거리."""
    lon = (position['lon'] - bounds['lon_min']) % 360 + bounds['lon_min']
    gx = (lon - bounds['lon_min']) / (bounds['lon_max'] - bounds['lon_min']) * size[0]
    gy = (bounds['lat_max'] - position['lat']) / (bounds['lat_max'] - bounds['lat_min']) * size[1]
    return [float(np.hypot(max(x-gx, gx-x-1, 0), max(y-gy, gy-y-1, 0))) for x,y in pixels]



def passage_window(name, bounds, size):
    lon0, lon1, lat0, lat1 = PASSAGE_WINDOWS[name]
    center = (bounds['lon_min'] + bounds['lon_max']) / 2
    lon0 = (lon0 - center + 180) % 360 - 180 + center
    lon1 = lon0 + PASSAGE_WINDOWS[name][1] - PASSAGE_WINDOWS[name][0]
    w, h = size
    x0 = max(0, int(np.floor((lon0-bounds['lon_min'])/(bounds['lon_max']-bounds['lon_min'])*w)))
    x1 = min(w, int(np.ceil((lon1-bounds['lon_min'])/(bounds['lon_max']-bounds['lon_min'])*w)))
    y0 = max(0, int(np.floor((bounds['lat_max']-lat1)/(bounds['lat_max']-bounds['lat_min'])*h)))
    y1 = min(h, int(np.ceil((bounds['lat_max']-lat0)/(bounds['lat_max']-bounds['lat_min'])*h)))
    return x0, y0, x1, y1


def passage_points(pair, bounds, size):
    points = [geo_pixel({'lon': lon, 'lat': lat}, bounds, size) for lon, lat in pair]
    if all(p is None for p in points):
        return None
    if None in points:
        points = [geo_pixel({'lon': max(bounds['lon_min'], min(bounds['lon_max']-1e-8, lon)),
                             'lat': max(bounds['lat_min'], min(bounds['lat_max'], lat))}, bounds, size)
                  for lon, lat in pair]
    return points


def passage_connections(land, bounds):
    checks = []
    size = land.shape[1], land.shape[0]
    for name, pair in PASSAGES.items():
        points = passage_points(pair, bounds, size)
        if points is None:
            continue
        x0, y0, x1, y1 = passage_window(name, bounds, size)
        labels = component_labels(land[y0:y1, x0:x1])
        components = [int(labels[y-y0, x-x0]) for x, y in points]
        checks.append({'id': name, 'pixels': points, 'window_pixels': [x0,y0,x1,y1],
                       'connected': components[0] >= 0 and components[0] == components[1]})
    return checks


def minimum_land_path(land, start, end, fractions=None):
    """육지 칸 수, 원본 육지 비율 합, 길이 순으로 최소인 4-연결 경로. 동률 순서도 고정한다."""
    import heapq
    h, w = land.shape
    fractions = land.astype(float) if fractions is None else fractions
    costs = {start: (0, 0, 0)}
    previous = {}
    pending = [(0, 0, 0, start)]
    while pending:
        cells, area, steps, point = heapq.heappop(pending)
        if costs[point] != (cells, area, steps):
            continue
        if point == end:
            path = [point]
            while point != start:
                point = previous[point]
                path.append(point)
            return path
        x, y = point
        for nx, ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
            if not (0 <= nx < w and 0 <= ny < h):
                continue
            cost = cells + int(land[ny,nx]), area + int(round(fractions[ny,nx] * 49)), steps + 1
            neighbor = nx, ny
            if cost < costs.get(neighbor, (w*h+1,49*w*h+1,w*h+1)):
                costs[neighbor] = cost
                previous[neighbor] = point
                heapq.heappush(pending, (*cost, neighbor))
    raise ValueError('통로 경로를 찾지 못했습니다.')


def carve_gate_passages(land, gates, bounds, fractions=None):
    """지역 안에서 이미 이어진 바다는 보존하고, 끊긴 곳만 최소 육지 경로를 연다."""
    result = land.copy()
    opened = []
    size = land.shape[1], land.shape[0]
    fractions = land.astype(float) if fractions is None else fractions
    markers = {**PASSAGE_MARKERS, **{g['id']: g['geo_position'] for g in gates}}
    for name, pair in PASSAGES.items():
        points = passage_points(pair, bounds, size)
        if points is None:
            continue
        if any(result[y,x] for x,y in points):
            raise ValueError(f'{name}: 통로 기준점은 물 위에 있어야 합니다: {points}')
        x0,y0,x1,y1 = passage_window(name, bounds, size)
        local = result[y0:y1,x0:x1]
        start, end = [(x-x0,y-y0) for x,y in points]
        labels = component_labels(local)
        changed = []
        already = labels[start[1],start[0]] == labels[end[1],end[0]]
        if not already:
            path = minimum_land_path(local, start, end, fractions[y0:y1,x0:x1])
            changed = [(x+x0,y+y0) for x,y in path if local[y,x]]
            if len(changed) > MAX_PASSAGE_LAND_CELLS:
                raise ValueError(f'{name}: 통로 육지 변경 {len(changed)}칸이 상한 {MAX_PASSAGE_LAND_CELLS}칸을 넘습니다.')
            for x,y in changed:
                result[y,x] = False
        distance = None
        if changed:
            if name not in markers:
                raise ValueError(f'{name}: 관문 표시 좌표가 없습니다.')
            distance = min(pixel_distances(changed, markers[name], bounds, size))
            if distance > 1:
                raise ValueError(f'{name}: 새 바다 칸의 관문 거리 {distance:.3f}픽셀이 1픽셀을 넘습니다.')
        opened.append({'gate_distance_px': distance, 'id': name, 'endpoints': pair, 'pixels': points, 'already_connected': bool(already),
                       'changed_cells': len(changed), 'source_land_cells': sum(int(fractions[y,x] >= .5) for x,y in changed),
                       'changed_pixels': changed})
    warnings = [c for c in sea_connections(result, bounds) + passage_connections(result, bounds) if not c['connected']]
    return result, opened, warnings


def remove_small_inland_water(land, lakes, minimum_area=1.5):
    """호수 원본의 표본 면적만으로 정리하며 바다와 이어진 칸은 보존한다."""
    labels = component_labels(land)
    sea_labels = set(np.concatenate((labels[0], labels[-1], labels[:,0], labels[:,-1]))) - {-1}
    ocean = np.isin(labels, list(sea_labels))
    candidates = np.zeros(land.shape, dtype=bool)
    retained = np.zeros_like(candidates)
    for lake in lakes:
        # 세계 타이호는 0.878칸이지만 지시서의 보존 목록을 우선한다.
        target = candidates if lake['area_cells'] < minimum_area and lake['name'] != 'Tai Hu' else retained
        target.flat[lake['indices']] = True
    return land | (candidates & ~retained & ~ocean)


def resize_equirect(image, bounds, size, resample):
    """실수 상자 하나로 자르고 크기를 맞춰 두 원본의 지리 좌표를 정렬한다."""
    w, h = image.size
    if bounds['lon_max'] > 180:
        wide = Image.new(image.mode, (w*2, h))
        wide.paste(image, (0, 0))
        wide.paste(image, (w, 0))
        image = wide
    box = ((bounds['lon_min']+180)/360*w, (90-bounds['lat_max'])/180*h,
           (bounds['lon_max']+180)/360*w, (90-bounds['lat_min'])/180*h)
    return image.resize(size, resample=resample, box=box)


def rasterize_land(land_path, lakes_path, bounds, size, subdivisions=7, return_fraction=False, return_lakes=False):
    """부분 칸 중심을 짝-홀 규칙으로 표본화한다. 구멍은 해당 다각형에만 적용한다."""
    if subdivisions < 1 or subdivisions % 2 == 0:
        raise ValueError('다각형 표본 수는 양의 홀수여야 합니다.')
    w, h = size
    sw, sh = w*subdivisions, h*subdivisions
    mask = np.zeros((sh,sw), dtype=bool)
    lakes = []
    def ring_mask(ring, offset, x0,y0,x1,y1):
        points = np.asarray(ring, dtype=float)[:,:2]
        px = (points[:,0]+offset-bounds['lon_min'])/(bounds['lon_max']-bounds['lon_min'])*sw
        py = (bounds['lat_max']-points[:,1])/(bounds['lat_max']-bounds['lat_min'])*sh
        ax, ay = px, py
        bx, by = np.roll(px, -1), np.roll(py, -1)
        xs = np.arange(x0,x1)+.5
        inside = np.zeros((y1-y0,x1-x0), dtype=bool)
        for row, y in enumerate(np.arange(y0,y1)+.5):
            crossing = (ay > y) != (by > y)
            intersections = ax[crossing] + (y-ay[crossing])*(bx[crossing]-ax[crossing])/(by[crossing]-ay[crossing])
            inside[row] = np.searchsorted(np.sort(intersections),xs,side='right') % 2 == 1
        return inside
    for path, is_land in ((land_path, True), (lakes_path, False)):
        geo = json.loads(Path(path).read_text(encoding='utf-8'))
        layer = np.zeros_like(mask)
        for feature in geo['features']:
            lake_samples = []
            geometry = feature['geometry']
            polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
            for polygon in polygons:
                outer = np.asarray(polygon[0])
                for offset in (-360,0,360):
                    x0 = max(0, int(np.floor((outer[:,0].min()+offset-bounds['lon_min'])/(bounds['lon_max']-bounds['lon_min'])*sw)))
                    x1 = min(sw, int(np.ceil((outer[:,0].max()+offset-bounds['lon_min'])/(bounds['lon_max']-bounds['lon_min'])*sw)))
                    y0 = max(0, int(np.floor((bounds['lat_max']-outer[:,1].max())/(bounds['lat_max']-bounds['lat_min'])*sh)))
                    y1 = min(sh, int(np.ceil((bounds['lat_max']-outer[:,1].min())/(bounds['lat_max']-bounds['lat_min'])*sh)))
                    if x1 <= x0 or y1 <= y0:
                        continue
                    filled = ring_mask(polygon[0], offset, x0,y0,x1,y1)
                    for hole in polygon[1:]:
                        filled &= ~ring_mask(hole, offset, x0,y0,x1,y1)
                    layer[y0:y1,x0:x1] |= filled
                    if not is_land:
                        yy, xx = np.nonzero(filled)
                        lake_samples.append((yy+y0)*sw + xx+x0)
            if not is_land and lake_samples:
                samples = np.unique(np.concatenate(lake_samples))
                indices = np.unique((samples // sw // subdivisions)*w + samples % sw // subdivisions)
                lakes.append({'name': feature.get('properties', {}).get('name'),
                              'area_cells': len(samples) / subdivisions**2, 'indices': indices})
        if is_land:
            mask |= layer
        else:
            mask &= ~layer
    fractions = mask.reshape(h,subdivisions,w,subdivisions).mean(axis=(1,3))
    result = fractions if return_fraction else fractions >= .5
    return (result, lakes) if return_lakes else result


def smooth_shades(shade, classes, land):
    votes = np.stack([sum(((shifted(shade, dy, dx, -1) == level) &
                           (shifted(classes, dy, dx, -1) == classes)).astype(np.int16)
                         for dy in (-1, 0, 1) for dx in (-1, 0, 1)) for level in range(3)])
    winner = votes.argmax(axis=0)
    own = np.take_along_axis(votes, shade[None, ...], axis=0)[0]
    winner[own == votes.max(axis=0)] = shade[own == votes.max(axis=0)]
    return np.where(land, winner, shade)


def color_isolated_ratio(out, neighbors):
    same = np.zeros(out.shape[:2], dtype=bool)
    for dy, dx in neighbors:
        same |= np.all(shifted(out.astype(np.int16), dy, dx, -1) == out, axis=2)
    return float(np.count_nonzero(~same) / same.size)


def coastline(land):
    """4-이웃 바다에 닿은 육지 쪽 한 줄. 지도 바깥은 바다로 간주하지 않는다."""
    touches_sea = np.zeros(land.shape, dtype=bool)
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        touches_sea |= ~shifted(land, dy, dx, True)
    return land & touches_sea


def sea_distance(land, max_distance):
    """유클리드 논리 픽셀 거리. 깊은 바다는 max_distance+1에서 잘라 계산량을 줄인다."""
    squared = np.full(land.shape, (max_distance + 1) ** 2, dtype=np.int16)
    for dy in range(-max_distance, max_distance + 1):
        for dx in range(-max_distance, max_distance + 1):
            distance = dx * dx + dy * dy
            if distance <= max_distance ** 2:
                squared = np.where(shifted(land, dy, dx, False), np.minimum(squared, distance), squared)
    return np.sqrt(squared)


def hillshade(height, px_per_deg):
    # 기존 처리와 같은 방위 315°·고도 40°. 논리 격자에서만 기울기를 구한다.
    dy, dx = np.gradient(height * 60 * (px_per_deg / REFERENCE_PX_PER_DEG))
    slope = np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(dy, -dx)
    az, alt = np.radians(315), np.radians(40)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.digitize(np.clip(shade, 0, 1), [SHADE_LOW, SHADE_HIGH])


def paint_palette(classes, land, shade, distance, sea_limits, palette):
    lookup = {c['id']: tuple(bytes.fromhex(c['hex'][1:])) for c in palette['colors']}
    out = np.empty((*land.shape, 3), dtype=np.uint8)
    out[:] = lookup['sea-1']
    out[(~land) & (distance <= sea_limits[1])] = lookup['sea-2']
    out[(~land) & (distance <= sea_limits[0])] = lookup['sea-3']
    for category, ramp in TERRAIN_RAMPS.items():
        for level, color_id in enumerate(ramp):
            out[land & (classes == category) & (shade == level)] = lookup[color_id]
    out[coastline(land)] = lookup['teal-4']
    return out


def source_hashes(args):
    names = ['bluemarble.jpg', 'topology.png']
    if args.style == 'pixel':
        names += [f'ne/ne_{"10m" if args.region == "east-asia" else "50m"}_{kind}.geojson' for kind in ('land', 'lakes')]
    manifest = json.loads((ROOT / 'src/assets/manifest.json').read_text(encoding='utf-8'))
    map_id = 'MAP_EAST_ASIA' if args.region == 'east-asia' else 'MAP_WORLD'
    sources = next(a for a in manifest['assets'] if a['id'] == map_id)['provenance']['sources']
    hashes = {}
    if len(sources) < len(names):
        raise ValueError('지도 매니페스트에 원본 출처가 빠졌습니다.')
    for name, source in zip(names, sources):
        path = args.source_dir / name
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != source['sha256']:
            raise ValueError(f'원본 SHA-256이 매니페스트 sources와 다릅니다: {name}')
        hashes[path.name] = digest
    return hashes


def build_pixel(args, inputs, output_dir=None):
    # 저장소 안 도구를 직접 실행할 때도 추가 패키지 설치 없이 가져온다.
    import sys
    sys.path.insert(0, str(ROOT))
    from tools.art.palette import load_palette

    bounds = REGIONS[args.region]['bounds']
    size = PIXEL_SIZES[args.region]
    with Image.open(args.source_dir / 'bluemarble.jpg') as source:
        color = resize_equirect(source.convert('RGB'), bounds, size, Image.Resampling.BOX)
    with Image.open(args.source_dir / 'topology.png') as source:
        topo = resize_equirect(source.convert('L'), bounds, size, Image.Resampling.BILINEAR)
    rgb = np.asarray(color).astype(np.float64) / 255
    height = np.asarray(topo).astype(np.float64) / 255
    resolution = '10m' if args.region == 'east-asia' else '50m'
    fractions, lakes = rasterize_land(args.source_dir / f'ne/ne_{resolution}_land.geojson',
                          args.source_dir / f'ne/ne_{resolution}_lakes.geojson', bounds, size, return_fraction=True, return_lakes=True)
    land = fractions >= 0.5
    world = json.loads((ROOT / 'data/world.json').read_text(encoding='utf-8'))
    regional = args.region == 'east-asia'
    land, opened, gate_warnings = carve_gate_passages(land, world.get('sea_gates', []), bounds, fractions)
    before_cleanup = land.copy()
    land = remove_small_inland_water(land, lakes)
    labels = component_labels(before_cleanup)
    sea_labels = set(np.concatenate((labels[0],labels[-1],labels[:,0],labels[:,-1]))) - {-1}
    ocean = np.isin(labels, list(sea_labels))
    lake_checks = []
    for lake in lakes:
        before = int(np.count_nonzero(~before_cleanup.flat[lake['indices']]))
        after = int(np.count_nonzero(~land.flat[lake['indices']]))
        if before:
            lake_checks.append({'name': lake['name'], 'area_cells': lake['area_cells'],
                                'before_cells': before, 'after_cells': after})
    final_labels = component_labels(land)
    sizes = np.bincount(final_labels[final_labels >= 0])
    final_sea_labels = set(np.concatenate((final_labels[0],final_labels[-1],final_labels[:,0],final_labels[:,-1]))) - {-1}
    lake_labels = set()
    for lake in lakes:
        lake_labels.update(final_labels.flat[lake['indices']])
    one_cell_lakes = sum(n == 1 and i not in final_sea_labels and i in lake_labels for i,n in enumerate(sizes))
    classes = smooth_classes(classify_terrain(rgb, height, land), land)
    ratio = isolated_ratio(classes, land)
    limits = (2, 6) if regional else (1.5, 3)
    shade = smooth_shades(hillshade(height, size[0] / (bounds['lon_max'] - bounds['lon_min'])), classes, land)
    out = paint_palette(classes, land, shade, sea_distance(land, limits[1]), limits, load_palette())
    point_checks = []
    for name, (lon, lat, expected) in CHECK_POINTS.items():
        # 오키나와 본섬은 세계 0.5° 칸의 절반 미만이므로 세계 기준점에서 제외한다.
        if name == '오키나와 본섬' and not regional:
            continue
        # 121.5°E는 세계 격자 경계이고 동쪽 칸은 육지 36.7%다. 같은 시가지 서쪽 칸을 검사한다.
        if name == '상하이 시가지' and not regional:
            lon = 121.4
        point = geo_pixel({'lon': lon, 'lat': lat}, bounds, size)
        if point is not None:
            x, y = point
            point_checks.append({'name': name, 'lon': lon, 'lat': lat, 'pixel': point,
                                 'expected_land': expected, 'actual_land': bool(land[y, x]),
                                 'source_land_fraction': float(fractions[y,x]),
                                 'passed': bool(land[y, x]) == expected})
    connections = sea_connections(land, bounds)
    if gate_warnings:
        raise ValueError(f'바다 연결 실패: {gate_warnings}')
    coastal_y, coastal_x = np.nonzero(coastline(land))
    city_warnings, city_checks = [], []
    for city in world['items']:
        if not city.get('geo_position'):
            continue
        point = geo_pixel(city['geo_position'], bounds, size)
        if point is None:
            continue
        x, y = point
        # 도시의 실제 투영 위치에서 해안 칸의 닫힌 정사각형까지 잰다.
        # 칸 중심끼리 재면 대각선으로 닿은 해안도 sqrt(2)로 과대평가한다.
        lon = (city['geo_position']['lon'] - bounds['lon_min']) % 360 + bounds['lon_min']
        cx = (lon - bounds['lon_min']) / (bounds['lon_max'] - bounds['lon_min']) * size[0]
        cy = (bounds['lat_max'] - city['geo_position']['lat']) / (bounds['lat_max'] - bounds['lat_min']) * size[1]
        dx = np.maximum(np.maximum(coastal_x - cx, cx - coastal_x - 1), 0)
        dy = np.maximum(np.maximum(coastal_y - cy, cy - coastal_y - 1), 0)
        distance = float(np.sqrt(np.min(dx**2 + dy**2))) if len(coastal_x) else None
        city_checks.append({'id': city['id'], 'pixel': [x,y], 'coast_distance_px': distance,
                            'passed': distance is not None and distance <= 1})
        if distance is None or distance > 1:
            city_warnings.append({'id': city['id'], 'pixel': [x, y], 'coast_distance_px': distance,
                                  'warning_ko': '도시 좌표가 육지 쪽 해안선에서 1논리 픽셀보다 멉니다.'})
    sea_y, sea_x = np.nonzero(~land)
    gate_water_checks = []
    for gate in world.get('sea_gates', []):
        position = gate['geo_position']
        if geo_pixel(position, bounds, size) is None:
            continue
        lon = (position['lon'] - bounds['lon_min']) % 360 + bounds['lon_min']
        gx = (lon - bounds['lon_min']) / (bounds['lon_max'] - bounds['lon_min']) * size[0]
        gy = (bounds['lat_max'] - position['lat']) / (bounds['lat_max'] - bounds['lat_min']) * size[1]
        distances = np.hypot(np.maximum(np.maximum(sea_x-gx,gx-sea_x-1),0),
                             np.maximum(np.maximum(sea_y-gy,gy-sea_y-1),0))
        nearest = int(distances.argmin())
        distance = float(distances[nearest])
        gate_water_checks.append({'id': gate['id'], 'nearest_water_pixel': [int(sea_x[nearest]),int(sea_y[nearest])],
                                  'water_distance_px': distance, 'passed': distance <= 1})
    dest = (output_dir or ROOT / 'public/assets/maps') / f'{args.region}.png'
    dest.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out).save(dest, 'PNG', optimize=False, compress_level=9)
    meta = {'path': str(dest.relative_to(ROOT)) if dest.is_relative_to(ROOT) else str(dest), 'width': size[0], 'height': size[1],
            'bounds': bounds, 'projection': 'equirectangular', 'inputs_sha256': inputs,
            'output_sha256': hashlib.sha256(dest.read_bytes()).hexdigest(),
            'colors_used': len(np.unique(out.reshape(-1, 3), axis=0)), 'isolated_ratio': ratio,
            'land_source_resolution': resolution, 'raster_subdivisions': 7,
            'versions': {'Pillow': PILLOW_VERSION, 'numpy': np.__version__},
            'lake_minimum_area_cells': 1.5, 'lake_cleanup_exceptions': ['Tai Hu'], 'sea_limits': limits,
            'lake_checks': lake_checks, 'one_cell_lakes': int(one_cell_lakes),
            'ocean_cells_before_cleanup': int(np.count_nonzero(ocean)),
            'ocean_cells_after_cleanup': int(np.count_nonzero(ocean & ~land)),
            'terrain_colors': {name: list(dict.fromkeys(TERRAIN_RAMPS[k])) for k,name in enumerate(('lowland','forest','dry','mountain','snow'))},
            'sea_colors': ['sea-1','sea-2','sea-3'], 'coast_colors': ['teal-4'],
            'passage_connections': passage_connections(land, bounds),
            'color_isolated_ratio_4': color_isolated_ratio(out, ((-1,0),(1,0),(0,-1),(0,1))),
            'color_isolated_ratio_8': color_isolated_ratio(out, [(dy,dx) for dy in (-1,0,1) for dx in (-1,0,1) if dy or dx]),
            'point_checks': point_checks, 'gate_water_checks': gate_water_checks, 'sea_connections': connections, 'city_coast_checks': city_checks,
            'gates_opened': opened, 'gate_warnings': gate_warnings, 'city_coast_warnings': city_warnings}
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return meta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--region', choices=sorted(REGIONS), default='east-asia')
    parser.add_argument('--style', choices=['satellite', 'pixel'], default='pixel')
    args = parser.parse_args()
    try:
        inputs = source_hashes(args)
        if args.style == 'pixel':
            build_pixel(args, inputs)
        else:
            build_satellite(args)
    except (ValueError, OSError) as exc:
        parser.exit(1, f'{exc}\n')


if __name__ == '__main__':
    main()
