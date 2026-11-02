// 정거원통도법 지도 좌표 변환. 세계지도는 태평양 중심이라 경도 범위가 180°를 넘을 수 있다(−30°~330°).

export interface GeoBounds {
  lon_min: number;
  lon_max: number;
  lat_min: number;
  lat_max: number;
}

/** 경도를 지도 범위의 시작점 기준 한 바퀴(lon_min ≤ x < lon_min + 360) 안으로 옮긴다. */
export function wrapLon(lon: number, b: GeoBounds): number {
  let x = lon;
  while (x < b.lon_min) x += 360;
  while (x >= b.lon_min + 360) x -= 360;
  return x;
}

export function project(p: { lat: number; lon: number }, b: GeoBounds, width: number, height: number) {
  const lon = wrapLon(p.lon, b);
  return {
    x: ((lon - b.lon_min) / (b.lon_max - b.lon_min)) * width,
    y: ((b.lat_max - p.lat) / (b.lat_max - b.lat_min)) * height,
  };
}

export function inBounds(p: { lat: number; lon: number }, b: GeoBounds): boolean {
  const lon = wrapLon(p.lon, b);
  return lon <= b.lon_max && p.lat >= b.lat_min && p.lat <= b.lat_max;
}

/** 지도 가장자리(이음매)를 넘는 꺾은선을 나눈다. 이웃한 두 점이 지도 폭의 절반 넘게 떨어지면 끊는다. */
export function splitAtSeam<T extends { x: number }>(points: T[], width: number): T[][] {
  const parts: T[][] = [];
  let current: T[] = [];
  for (const pt of points) {
    const prev = current[current.length - 1];
    if (prev && Math.abs(pt.x - prev.x) > width / 2) {
      parts.push(current);
      current = [];
    }
    current.push(pt);
  }
  if (current.length) parts.push(current);
  return parts;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 이름표 자리 고르기: 후보 위치를 순서대로 시험해 이미 놓인 이름표·보기 영역과 겹치지 않는 첫 자리를 쓴다.
 * 자리가 없으면 null(이름표 없이 점과 툴팁만 남긴다).
 */
export function placeLabel(candidates: Box[], placed: Box[], view: Box): Box | null {
  for (const c of candidates) {
    const inside = c.x >= view.x && c.y >= view.y && c.x + c.w <= view.x + view.w && c.y + c.h <= view.y + view.h;
    if (inside && !placed.some((p) => overlaps(p, c))) return c;
  }
  return null;
}
