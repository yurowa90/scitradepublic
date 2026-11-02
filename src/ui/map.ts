// 세계지도(UI_WORLD): 픽셀 지도 위에 거점 휘장·이름 리본·항로·선박·해협·항만 사건·나침반을 겹친다.
// ‘이번 항로’는 1장 동아시아 확대 지도, ‘전 세계’는 태평양 중심 세계지도를 쓴다.
// 지도 위치는 표시용이며 운송시간·거리 계산에 쓰지 않는다.

import { HUB_ROLE_KO, loadMapCities, loadRouteScheduleCheck, loadRouteWaypoints, loadSeaGates, type MapCity } from '../content/map';
import { routeOf } from '../engine/catalog';
import { portWaitStatus } from '../engine/progress';
import type { GameState, ScenarioConfig } from '../engine/types';
import { mapAsset, type MapAsset } from './assets';
import { inBounds, placeLabel, project, splitAtSeam, type Box } from './projection';

export type MapMode = 'route' | 'world';

const REGION_MAP = mapAsset('MAP_EAST_ASIA');
const WORLD_MAP = mapAsset('MAP_WORLD');

export interface MapViewport { vb: Box; n: number; cssWidth: number; cssHeight: number }

/** 경로 지도에서 받아들이는 양옆 빈 띠 합의 상한(CSS px). 이 이상이면 한 배율 위를 시험한다. */
export const BLANK_BAND_LIMIT_CSS = 16;

/** 틀을 채우되 바탕의 논리 픽셀은 정수 개의 기기 픽셀로 표시한다. */
export function planMapViewport(map: { w: number; h: number }, unitsPerPixel: number,
  routeBox: Box, availableWidth: number, dpr: number, mode: MapMode): MapViewport {
  if (![map.w, map.h, unitsPerPixel, availableWidth, dpr].every((v) => Number.isFinite(v) && v > 0))
    throw new RangeError('지도 크기와 기기 배율을 확인해 주세요.');
  const cap = Math.max(1, Math.floor(3 * dpr));
  if (mode === 'world') {
    const n = Math.min(cap, Math.max(Math.ceil(dpr), Math.ceil(availableWidth * dpr / 720)));
    return { vb: { x: 0, y: 0, w: map.w, h: map.h }, n,
      cssWidth: n * map.w / unitsPerPixel / dpr, cssHeight: n * map.h / unitsPerPixel / dpr };
  }
  const left = Math.floor(routeBox.x / unitsPerPixel), top = Math.floor(routeBox.y / unitsPerPixel);
  const right = Math.ceil((routeBox.x + routeBox.w) / unitsPerPixel);
  const bottom = Math.ceil((routeBox.y + routeBox.h) / unitsPerPixel);
  const requiredW = right - left + 24;
  const requiredH = bottom - top + 24;
  // round(L × 10 / 16) ≥ requiredH를 만족하는 최소 정수 L.
  const minimumL = Math.max(requiredW, Math.ceil((requiredH - 0.5) * 16 / 10));
  const mapLW = Math.floor(map.w / unitsPerPixel), mapLH = Math.floor(map.h / unitsPerPixel);
  let n = Math.min(cap, Math.max(1, Math.floor(availableWidth * dpr / minimumL)));
  // 16:10 배율 n에서 양옆 빈 띠 합이 16 CSS px 이상이면 한 배율 위를 시험한다.
  // 그 배율에서 폭은 들어가고 세로만 모자라면 세로를 항로에 필요한 만큼만 늘린다(정사각형까지).
  let tallH = 0;
  if (n < cap && availableWidth - n * mapLW / dpr >= BLANK_BAND_LIMIT_CSS) {
    const nextW = Math.floor(availableWidth * dpr / (n + 1));
    if (nextW >= requiredW && requiredH <= Math.min(mapLH, nextW)) { n += 1; tallH = requiredH; }
  }
  const logicalW = Math.min(mapLW, Math.max(1, Math.floor(availableWidth * dpr / n)));
  const logicalH = Math.min(mapLH, Math.max(1, Math.round(logicalW * 10 / 16), tallH));
  const w = logicalW * unitsPerPixel, h = logicalH * unitsPerPixel;
  const x = Math.max(0, Math.min(Math.floor((left + right - logicalW) / 2) * unitsPerPixel, Math.max(0, map.w - w)));
  const y = Math.max(0, Math.min(Math.floor((top + bottom - logicalH) / 2) * unitsPerPixel, Math.max(0, map.h - h)));
  return { vb: { x, y, w, h }, n, cssWidth: n * logicalW / dpr, cssHeight: n * logicalH / dpr };
}

/** 원래 영역을 포함하도록 격자 경계를 바깥으로 맞춘 뒤 지도 범위에서 자른다. */
export function snapViewBox(vb: Box, unitsPerPixel: number, mapW: number, mapH: number): Box {
  if (!(unitsPerPixel > 0) || !Number.isFinite(unitsPerPixel)) throw new RangeError('지도 픽셀 단위를 확인해 주세요.');
  const x = Math.max(0, Math.floor(vb.x / unitsPerPixel) * unitsPerPixel);
  const y = Math.max(0, Math.floor(vb.y / unitsPerPixel) * unitsPerPixel);
  const right = Math.min(mapW, Math.ceil((vb.x + vb.w) / unitsPerPixel) * unitsPerPixel);
  const bottom = Math.min(mapH, Math.ceil((vb.y + vb.h) / unitsPerPixel) * unitsPerPixel);
  return { x: Math.min(x, mapW), y: Math.min(y, mapH), w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/** Catmull-Rom 스플라인을 3차 베지어로 바꿔 부드러운 항로선을 만든다. */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  let d = `M${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/** 꺾은선 위 비율 t(0~1) 지점과 진행 방향(도). */
function pointAlong(points: { x: number; y: number }[], t: number) {
  const segs = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  const total = segs.reduce((a, b) => a + b, 0);
  let remain = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < segs.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (remain <= segs[i]! || i === segs.length - 1) {
      const f = segs[i]! === 0 ? 0 : Math.min(1, remain / segs[i]!);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
    }
    remain -= segs[i]!;
  }
  const last = points[points.length - 1]!;
  return { x: last.x, y: last.y, angle: 0 };
}

const SHIP = `
  <g class="ship-wake"><path d="M-30 -5 Q-48 0 -30 5" /><path d="M-40 -8 Q-62 0 -40 8" /></g>
  <path class="ship-hull" d="M-22 -7 H14 Q24 -7 28 0 Q24 7 14 7 H-22 Q-25 0 -22 -7 Z" />
  <rect class="ct ct-a" x="-17" y="-5" width="7" height="4.5" rx=".6" /><rect class="ct ct-b" x="-17" y=".5" width="7" height="4.5" rx=".6" />
  <rect class="ct ct-c" x="-9" y="-5" width="7" height="4.5" rx=".6" /><rect class="ct ct-a" x="-9" y=".5" width="7" height="4.5" rx=".6" />
  <rect class="ct ct-b" x="-1" y="-5" width="7" height="4.5" rx=".6" /><rect class="ct ct-c" x="-1" y=".5" width="7" height="4.5" rx=".6" />
  <rect class="ship-bridge" x="8" y="-4" width="5" height="8" rx="1" />`;

const ANCHOR = '<path d="M0 -6 V5 M-4 -3 H4 M-6 1 Q-5 6 0 6 Q5 6 6 1" fill="none" stroke-width="1.6" stroke-linecap="round"/><circle cx="0" cy="-7" r="1.6" fill="none" stroke-width="1.3"/>';

function compass(x: number, y: number, r: number): string {
  return `
  <g class="compass" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" aria-hidden="true">
    <circle r="${r}" class="compass-ring"/><circle r="${r * 0.78}" class="compass-ring inner"/>
    <path class="compass-ns" d="M0 ${-r * 0.95} L${r * 0.16} 0 L0 ${r * 0.95} L${-r * 0.16} 0 Z"/>
    <path class="compass-ew" d="M${-r * 0.7} 0 L0 ${r * 0.12} L${r * 0.7} 0 L0 ${-r * 0.12} Z"/>
    <path class="compass-north" d="M0 ${-r * 0.95} L${r * 0.16} 0 L${-r * 0.16} 0 Z"/>
    <text y="${-r * 1.12}" text-anchor="middle">N</text>
  </g>`;
}

const BANK = '<path d="M-6 -2 L0 -6.5 L6 -2 Z M-5 -1 V4 M-1.7 -1 V4 M1.7 -1 V4 M5 -1 V4 M-6.5 5 H6.5" fill="none" stroke-width="1.5" stroke-linejoin="round"/>';

type HubStatus = 'active' | 'planned' | 'preview';

function hubStatus(c: MapCity, routeCities: Set<string>): HubStatus {
  if (routeCities.has(c.id)) return 'active';
  return c.availability.status === 'MAP_PREVIEW' ? 'preview' : 'planned';
}

type Voyage = { routeId: string; shipmentIds: string[]; departureDay: number; waiting: boolean; arrived: boolean };

/** 선박: 출항 후 인도 전까지 항로 위에 표시. 같은 출항편에 실린 화물은 배 한 척으로 그린다. */
function voyagesOf(state: GameState, config: ScenarioConfig): Map<string, Voyage> {
  const voyages = new Map<string, Voyage>();
  for (const sh of state.shipments) {
    if (!(sh.arrivalDay === null || (sh.releaseDay !== null && state.day <= sh.releaseDay))) continue;
    const booking = state.bookings.find((x) => x.id === sh.bookingId);
    if (!booking) continue;
    const v = voyages.get(booking.sailingId) ?? { routeId: booking.routeId, shipmentIds: [], departureDay: sh.departureDay, waiting: false, arrived: true };
    v.shipmentIds.push(sh.id);
    v.waiting ||= portWaitStatus(state, config, sh) === 'WAITING_RESTRICTION';
    v.arrived &&= sh.arrivalDay !== null;
    voyages.set(booking.sailingId, v);
  }
  return voyages;
}

function hubWhen(status: HubStatus, c: MapCity): string {
  return status === 'active'
    ? '이번 시나리오 거점'
    : status === 'planned'
      ? `1장 ${c.availability.stage} 단계에서 열림`
      : '세계 확장(2장)에서 열림 — 지금은 지도 미리 보기';
}

function hubTitle(c: MapCity, status: HubStatus): string {
  const when = hubWhen(status, c);
  const roles = c.roles.map((r) => HUB_ROLE_KO[r]).join('·');
  return [`${c.nameKo} — ${roles}`, ...c.basisKo, c.noteKo, when].filter(Boolean).join('\n');
}

const fmtLon = (lon: number) => {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return l === 0 || l === -180 ? `${Math.abs(l)}°` : `${Math.abs(l)}°${l > 0 ? 'E' : 'W'}`;
};

/** 시나리오 항로가 모두 들어가면 동아시아 확대 지도, 아니면 세계지도. */
export function chooseMap(config: ScenarioConfig, mode: MapMode): MapAsset | null {
  if (mode === 'world' || !REGION_MAP) return WORLD_MAP ?? REGION_MAP;
  const pts = config.routes.flatMap((r) => loadRouteWaypoints(r.id));
  return pts.every((p) => inBounds(p, REGION_MAP.bounds)) ? REGION_MAP : (WORLD_MAP ?? REGION_MAP);
}

export interface MapMeasurement { availableWidth: number; dpr: number }

/** 전체 다시 그리기도 마지막 측정 크기로 시작해 지도 높이가 잠시 바뀌지 않는다. */
export class MapMeasurementMemory {
  private values: Partial<Record<MapMode, MapMeasurement>> = {};
  get(mode: MapMode): MapMeasurement { return this.values[mode] ?? { availableWidth: 620, dpr: 1 }; }
  has(mode: MapMode): boolean { return this.values[mode] !== undefined; }
  clear(): void { this.values = {}; }
  remember(mode: MapMode, availableWidth: number, dpr: number): void { this.values[mode] = { availableWidth, dpr }; }
}

/** 실제 선택된 지도에 맞춰 접근성·안내·스크롤을 함께 결정한다. */
export function mapPresentation(config: ScenarioConfig, mode: MapMode) {
  const world = chooseMap(config, mode) === WORLD_MAP;
  return { world, attributes: world ? 'tabindex="0" role="region" aria-label="세계지도 — 좌우로 움직여 볼 수 있음"' : '',
    hint: world ? '<p class="muted small">세계지도는 좌우로 움직여 볼 수 있습니다. 지도를 선택하고 화살표 키를 눌러 보세요.</p>' : '' };
}

/** 이름표·휘장이 더 커지지 않는 기준 틀 폭(CSS px). */
export const LABEL_CAP_FRAME_WIDTH = 946;

/**
 * 화면상 이름표·휘장 크기는 지도 표시 폭에 비례한다(기준 620 CSS px에서 1배, 세계지도는 0.45배).
 * 표시 폭이 틀 폭 946일 때의 표시 폭(capCssWidth)을 넘으면 그 크기에서 멈춘다.
 * 세계지도는 틀보다 넓게 그려 스크롤하므로 틀 폭이 아니라 지도 표시 폭을 기준으로 한다.
 */
export function mapLabelScale(plan: MapViewport, world: boolean, capCssWidth = plan.cssWidth): number {
  return plan.vb.w / 620 * Math.min(plan.cssWidth, capCssWidth) / plan.cssWidth * (world ? 0.45 : 1);
}

/** 경로 지도 거점 이름표(글자 15)의 최소 화면 크기(CSS px). */
export const LABEL_FLOOR_PX = 11;

/** 거점 이름표 글자와 리본 상자의 배율. 경로 지도에서만 LABEL_FLOOR_PX 아래로 줄이지 않는다. 그 밖의 표시는 mapLabelScale을 쓴다. */
export function mapRibbonScale(plan: MapViewport, world: boolean, capCssWidth = plan.cssWidth): number {
  const k = mapLabelScale(plan, world, capCssWidth);
  return world ? k : Math.max(k, LABEL_FLOOR_PX / 15 * plan.vb.w / plan.cssWidth);
}

/** 같은 지도·기기 배율에서 틀 폭 946일 때의 지도 표시 폭. */
export function labelCapCssWidth(config: ScenarioConfig, mode: MapMode, dpr: number): number {
  return worldMapViewport(config, mode, { availableWidth: LABEL_CAP_FRAME_WIDTH, dpr }).cssWidth;
}

/** 측정한 세계지도에서만 스크롤 비율을 읽는다. */
export function readMapScroll(world: boolean, measured: boolean, reset: boolean,
  scrollLeft: number, scrollWidth: number, clientWidth: number, remembered?: number): number | undefined {
  const range = scrollWidth - clientWidth;
  return world && measured && !reset && range > 0 ? scrollLeft / range : remembered;
}

export function mapScrollPosition(world: boolean, ratio: number | undefined, center: number,
  scrollWidth: number, clientWidth: number): number | undefined {
  return world ? ratio === undefined ? center * scrollWidth - clientWidth / 2
    : ratio * Math.max(0, scrollWidth - clientWidth) : undefined;
}

/** 첫 그리기도 전달된 측정값으로 계획하며 같은 보기 영역이면 DOM을 재생성하지 않는다. */
export function mapRedrawDecision(config: ScenarioConfig, mode: MapMode, measurement: MapMeasurement, previousKey?: string) {
  // 이름표 크기는 보기 영역·배율·dpr로만 정해지므로 키에 틀 폭을 따로 넣지 않는다.
  const key = mapViewportKey(worldMapViewport(config, mode, measurement), measurement.dpr);
  return { key, redraw: key !== previousKey };
}

export function mapViewportKey(plan: MapViewport, dpr: number): string {
  const { vb } = plan;
  return `${plan.n}:${vb.w}:${vb.h}:${vb.x}:${vb.y}:${dpr}`;
}

/** 크기 감시에서는 HTML을 만들기 전에 이 계획만 비교한다. */
export function worldMapViewport(config: ScenarioConfig, mode: MapMode, options: MapMeasurement): MapViewport {
  const map = chooseMap(config, mode)!;
  const world = map === WORLD_MAP;
  const allPts = config.routes.flatMap((r) => loadRouteWaypoints(r.id))
    .map((p) => project(p, map.bounds, map.width, map.height));
  const xs = allPts.map((p) => p.x), ys = allPts.map((p) => p.y);
  const routeBox = allPts.length ? { x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    : { x: map.width / 2, y: map.height / 2, w: 0, h: 0 };
  return planMapViewport({ w: map.width, h: map.height }, map.pixelGrid?.unitsPerPixel ?? 1,
    routeBox, options.availableWidth, options.dpr, world ? 'world' : 'route');
}

export function renderWorldMap(state: GameState, config: ScenarioConfig, mode: MapMode, options: { availableWidth?: number; dpr?: number; baseOutsideSvg?: boolean; picked?: string | null } = {}): string {
  const map = chooseMap(config, mode);
  if (!map) return '<p class="muted">지도 자산이 없습니다.</p>';
  const world = map === WORLD_MAP;
  const proj = (p: { lat: number; lon: number }) => project(p, map.bounds, map.width, map.height);
  const cities = loadMapCities().filter((c) => inBounds(c, map.bounds));
  const gates = loadSeaGates().filter((g) => inBounds(g, map.bounds));
  const routeCities = new Set(config.routes.flatMap((r) => [r.fromCityId, r.toCityId]));
  const routeLines = config.routes.map((r) => ({ route: r, pts: loadRouteWaypoints(r.id).map(proj) }));

  const plan = worldMapViewport(config, mode, { availableWidth: options.availableWidth ?? 620, dpr: options.dpr ?? 1 });
  const vb = plan.vb;
  // 보기 영역이 넓어져도 화면상 글자·휘장 크기가 비슷하게 유지되도록 맞춘다. 세계지도는 거점이 많아 조금 작게.
  const cap = labelCapCssWidth(config, mode, options.dpr ?? 1);
  const k = mapLabelScale(plan, world, cap);
  const kr = mapRibbonScale(plan, world, cap);

  // 경위선: 확대 지도 5°, 세계지도 30° 간격.
  const b = map.bounds;
  const step = world ? 30 : 5;
  const grid: string[] = [];
  for (let lon = Math.ceil(b.lon_min / step) * step; lon <= b.lon_max; lon += step) {
    const x = ((lon - b.lon_min) / (b.lon_max - b.lon_min)) * map.width;
    if (x < vb.x || x > vb.x + vb.w) continue;
    grid.push(`<line x1="${x}" y1="${vb.y}" x2="${x}" y2="${vb.y + vb.h}"/><text class="grid-label" x="${x + 4 * k}" y="${vb.y + 16 * k}" font-size="${12 * k}">${fmtLon(lon)}</text>`);
  }
  for (let lat = Math.ceil(b.lat_min / step) * step; lat <= b.lat_max; lat += step) {
    const y = ((b.lat_max - lat) / (b.lat_max - b.lat_min)) * map.height;
    if (y < vb.y || y > vb.y + vb.h) continue;
    grid.push(`<line x1="${vb.x}" y1="${y}" x2="${vb.x + vb.w}" y2="${y}"/><text class="grid-label" x="${vb.x + 6 * k}" y="${y - 4 * k}" font-size="${12 * k}">${Math.abs(lat)}°${lat > 0 ? 'N' : lat < 0 ? 'S' : ''}</text>`);
  }

  // 거점 휘장. 이름표는 우선순위(이번 시나리오 → 1장 예정 → 세계 미리 보기 → 해협) 순서로 겹치지 않게 놓는다.
  const order: Record<HubStatus, number> = { active: 0, planned: 1, preview: 2 };
  const hubs = cities
    .map((c) => ({ c, p: proj(c), status: hubStatus(c, routeCities) }))
    .sort((a, b) => order[a.status] - order[b.status]);
  const placed: Box[] = hubs.map(({ p }) => ({ x: p.x - 11 * k, y: p.y - 11 * k, w: 22 * k, h: 22 * k }));
  for (const g of gates) {
    const p = proj(g);
    placed.push({ x: p.x - 7 * k, y: p.y - 7 * k, w: 14 * k, h: 14 * k });
  }
  const view: Box = { x: vb.x + 4 * k, y: vb.y + 4 * k, w: vb.w - 8 * k, h: vb.h - 8 * k };
  const labelFor = (text: string, x: number, y: number, size: number, preferLeft: boolean) => {
    const w = (text.length * size + 22 * (size / 15)) * kr;
    const h = (size + 9) * kr;
    const gap = 13 * k;
    const right = { x: x + gap, y: y - h - 4 * k, w, h };
    const left = { x: x - gap - w, y: y - h - 4 * k, w, h };
    const below = { x: x - w / 2, y: y + gap, w, h };
    const above = { x: x - w / 2, y: y - gap - h, w, h };
    const rightLow = { x: x + gap, y: y + 4 * k, w, h };
    const leftLow = { x: x - gap - w, y: y + 4 * k, w, h };
    const farBelow = { x: x - w / 2, y: y + gap + h, w, h };
    const farAbove = { x: x - w / 2, y: y - gap - 2 * h, w, h };
    const base = preferLeft ? [left, right, leftLow, rightLow] : [right, left, rightLow, leftLow];
    const box = placeLabel([...base, above, below, farAbove, farBelow], placed, view);
    if (box) placed.push(box);
    return box;
  };

  const ports = hubs.map(({ c, p, status }) => {
    const size = status === 'preview' ? 12.5 : 15;
    const preferLeft = ['PYEONGTAEK', 'BUSAN', 'HONG_KONG'].includes(c.id) || c.id === 'SHANGHAI' || c.id === 'HAIPHONG';
    const box = labelFor(c.nameKo, p.x, p.y, size, preferLeft);
    const finance = c.roles.includes('FINANCE_CENTER');
    const badgeScale = status === 'preview' ? 0.78 : 1;
    return `
    <g class="port ${status}${options.picked === `hub:${c.id}` ? ' picked' : ''}" data-mark="hub:${c.id}">
      <title>${hubTitle(c, status)}</title>
      ${options.picked === `hub:${c.id}` ? `<circle cx="${p.x}" cy="${p.y}" r="${16 * k * badgeScale}" class="pick-ring" stroke-width="${3 * k}"/>` : ''}
      ${status === 'preview' ? '' : `<circle cx="${p.x}" cy="${p.y}" r="${15 * k}" class="port-glow"/>`}
      <g transform="translate(${p.x} ${p.y}) scale(${k * badgeScale})"><circle r="10" class="port-badge" data-mark-dot/><g class="port-anchor">${c.cargoPort ? ANCHOR : BANK}</g>${finance ? '<circle cx="8" cy="-8" r="4" class="finance-coin"/>' : ''}</g>
      ${box ? `<g class="ribbon"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${5 * kr}"/>
      <text x="${box.x + box.w / 2}" y="${box.y + box.h * 0.7}" text-anchor="middle" font-size="${size * kr}">${c.nameKo}</text></g>` : ''}
    </g>`;
  });

  const gateMarks = gates.map((g) => {
    const p = proj(g);
    const box = world ? labelFor(g.nameKo, p.x, p.y, 11, false) : null;
    return `
    <g class="gate gate-${g.gateType}${options.picked === `gate:${g.id}` ? ' picked' : ''}" data-mark="gate:${g.id}">
      ${options.picked === `gate:${g.id}` ? `<circle cx="${p.x}" cy="${p.y}" r="${11 * k}" class="pick-ring" stroke-width="${3 * k}"/>` : ''}
      <title>${g.nameKo} (${g.connectsKo})\n${g.eventHookKo}\n세계 확장(2장)에서 항로 선택·사건과 연결 예정</title>
      <rect x="${p.x - 5 * k}" y="${p.y - 5 * k}" width="${10 * k}" height="${10 * k}" transform="rotate(45 ${p.x} ${p.y})" class="gate-mark" data-mark-dot/>
      ${box ? `<text class="gate-label" x="${box.x + box.w / 2}" y="${box.y + box.h * 0.72}" text-anchor="middle" font-size="${11 * k}">${g.nameKo}</text>` : ''}
    </g>`;
  });

  const voyages = voyagesOf(state, config);
  const ships = [...voyages.entries()].map(([sailingId, v]) => {
    const pts = routeLines.find((l) => l.route.id === v.routeId)?.pts ?? [];
    if (pts.length < 2) return '';
    const t = v.arrived ? 1 : v.waiting ? 0.93 : (state.day - v.departureDay) / routeOf(config, v.routeId).transitDays;
    const pos = pointAlong(pts, t);
    const picked = options.picked === `ship:${sailingId}`;
    return `${picked ? `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${18 * k}" class="pick-ring" stroke-width="${3 * k}"/>` : ''}<g class="ship ${v.waiting ? 'waiting' : ''}${picked ? ' picked' : ''}" data-mark="ship:${sailingId}" data-mark-dot transform="translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)}) rotate(${pos.angle.toFixed(1)}) scale(${k * 0.9})"><title>${sailingId}: ${v.shipmentIds.join(', ')}${v.waiting ? ' — 하역 중단으로 대기 중' : ''}</title>${SHIP}</g>`;
  });

  // 항만 사건: 공지된 하역 중단.
  const storms = config.portRestrictions
    .filter((r) => state.appliedEventIds[r.eventInstanceId])
    .map((r) => {
      const c = cities.find((x) => x.id === r.cityId);
      if (!c) return '';
      const p = proj(c);
      const active = r.startDay <= state.day && state.day <= r.endDay;
      const done = state.day > r.endDay;
      return `
      <g class="storm ${active ? 'active' : done ? 'done' : 'upcoming'}" transform="translate(${(p.x + 30 * k).toFixed(1)} ${(p.y + 40 * k).toFixed(1)}) scale(${k * 0.8})">
        <circle r="34" class="storm-zone"/>
        <path class="storm-cloud" d="M-16 4 Q-22 4 -22 -2 Q-22 -9 -14 -9 Q-12 -17 -3 -17 Q6 -17 8 -9 Q17 -10 18 -2 Q18 4 12 4 Z"/>
        <path class="storm-bolt" d="M-1 4 L-6 14 L0 13 L-3 22 L7 9 L1 10 L4 4 Z"/>
        <title>${r.forecastKo}${done ? ' (종료)' : ''}</title>
      </g>`;
    })
    .join('');

  const routePaths = routeLines
    .flatMap((l) => splitAtSeam(l.pts, map.width))
    .map((pts) => smoothPath(pts))
    .filter(Boolean)
    .map((d) => `<path class="route-under" d="${d}" stroke-width="${7 * k}"/><path class="route-line" d="${d}" stroke-width="${2.6 * k}" stroke-dasharray="${10 * k} ${8 * k}"/>`)
    .join('');
  const allCities = loadMapCities();
  const routeNames = config.routes.map((r) => `${allCities.find((c) => c.id === r.fromCityId)?.nameKo}–${allCities.find((c) => c.id === r.toCityId)?.nameKo}`);
  const counts = { active: hubs.filter((h) => h.status === 'active').length, preview: hubs.filter((h) => h.status === 'preview').length };
  const cx = vb.x + vb.w - 52 * k;
  const cy = vb.y + vb.h - 60 * k;
  const pixelData = map.pixelGrid ? `data-pixel-w="${vb.w / map.pixelGrid.unitsPerPixel}" data-pixel-h="${vb.h / map.pixelGrid.unitsPerPixel}"` : '';
  const externalBase = options.baseOutsideSvg === true && !!map.pixelGrid;
  const sizeStyle = `width: ${plan.cssWidth}px; height: ${plan.cssHeight}px;`;
  const hubXs = cities.filter((c) => routeCities.has(c.id)).map((c) => proj(c).x);
  const scenarioCenter = hubXs.length ? (Math.min(...hubXs) + Math.max(...hubXs)) / 2 / map.width : 0.5;
  const viewportData = `data-map-viewport="${plan.n}:${vb.w}:${vb.h}:${vb.x}:${vb.y}" data-map-center="${scenarioCenter}"`;
  const svg = `
  <svg ${externalBase ? '' : `${pixelData} ${viewportData} style="${sizeStyle}"`} preserveAspectRatio="none" width="${plan.cssWidth}" height="${plan.cssHeight}" class="sea-map ${world ? 'is-world' : ''}" viewBox="${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}" role="img"
    aria-label="${world ? '태평양 중심 세계지도' : '동아시아 해역 지도'}. 항로 ${routeNames.join(', ')}. 이번 시나리오 거점 ${counts.active}곳, 세계 확장 미리 보기 거점 ${counts.preview}곳, 해협·운하 ${gates.length}곳${voyages.size ? `, 화물선 ${voyages.size}척 운항 중` : ''}">
    <defs>
      <radialGradient id="port-glow" r="0.5"><stop offset="0" stop-color="#ffe9a8" stop-opacity=".85"/><stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/></radialGradient>
    </defs>
    ${externalBase ? '' : `<image class="map-base ${map.pixelGrid ? 'pixel-art' : ''}" href="${map.path}" x="0" y="0" width="${map.width}" height="${map.height}" preserveAspectRatio="none"/>`}
    <g class="graticule" stroke-width="${0.8 * k}">${grid.join('')}</g>
    ${routePaths}
    ${gateMarks.join('')}
    ${ports.join('')}
    ${storms}
    ${ships.join('')}
    ${compass(cx, cy, 34 * k)}
  </svg>`;
  if (!externalBase) return svg;
  // 같은 보기 영역의 비율로 원본 그림을 잘라, 정수 배율 SVG 표시와 겹친다.
  return `<div class="map-layers" ${pixelData} ${viewportData} style="${sizeStyle}">
    <img class="map-base pixel-art" src="${map.path}" alt="" aria-hidden="true" style="left: ${-vb.x / vb.w * 100}%; top: ${-vb.y / vb.h * 100}%; width: ${map.width / vb.w * 100}%; height: ${map.height / vb.h * 100}%;" />
    ${svg}
  </div>`;
}

/** 지도 표시 하나. 목록·지도 누르기·상세 칸이 같은 열쇠를 쓴다. */
export interface MapMark { key: string; group: string; nameKo: string; lines: string[] }

const MARK_GROUP: Record<HubStatus | 'gate' | 'ship', string> = {
  active: '이번 시나리오 거점', planned: '1장에서 열릴 거점', preview: '세계 확장(2장) 미리 보기', gate: '해협·운하', ship: '운항 중인 배',
};

/** 그린 지도와 같은 표시를 돌려준다. 상세 글은 SVG 제목과 같은 자료로 만든다. */
export function mapMarks(state: GameState, config: ScenarioConfig, mode: MapMode): MapMark[] {
  const map = chooseMap(config, mode);
  if (!map) return [];
  const routeCities = new Set(config.routes.flatMap((r) => [r.fromCityId, r.toCityId]));
  const all = loadMapCities();
  const nameOf = (id: string) => all.find((c) => c.id === id)?.nameKo ?? id;
  const voyages = voyagesOf(state, config);
  const order: Record<HubStatus, number> = { active: 0, planned: 1, preview: 2 };
  const hubs = all.filter((c) => inBounds(c, map.bounds)).map((c) => ({ c, status: hubStatus(c, routeCities) }))
    .sort((a, b) => order[a.status] - order[b.status]);
  const marks: MapMark[] = hubs.map(({ c, status }) => ({
    key: `hub:${c.id}`, group: MARK_GROUP[status], nameKo: c.nameKo,
    lines: [
      c.roles.map((r) => HUB_ROLE_KO[r]).join('·'), ...c.basisKo, c.noteKo, hubWhen(status, c),
      ...config.routes.filter((r) => r.fromCityId === c.id || r.toCityId === c.id).map((r) => {
        const check = loadRouteScheduleCheck(r.id);
        return `${r.id} ${nameOf(r.fromCityId)}→${nameOf(r.toCityId)} ${r.transitDays}일·${r.departureIntervalDays}일마다`
          + (check ? ` (선사 요일표로 확인 ${check.checkedOn}, 오차 ±${check.toleranceDays}일. 게임은 요일 없이 단순화)` : '');
      }),
      ...(() => { const n = [...voyages.values()].filter((v) => { const r = routeOf(config, v.routeId); return !v.arrived && (r.fromCityId === c.id || r.toCityId === c.id); }).length;
        return n ? [`이 거점을 오가는 운항 중인 배 ${n}척`] : []; })(),
    ].filter(Boolean),
  }));
  for (const g of loadSeaGates().filter((x) => inBounds(x, map.bounds))) {
    marks.push({ key: `gate:${g.id}`, group: MARK_GROUP.gate, nameKo: g.nameKo, lines: [g.connectsKo, g.eventHookKo, '세계 확장(2장)에서 항로 선택·사건과 연결 예정'] });
  }
  for (const [sailingId, v] of voyages) {
    if ((loadRouteWaypoints(v.routeId)).length < 2) continue;
    const r = routeOf(config, v.routeId);
    marks.push({ key: `ship:${sailingId}`, group: MARK_GROUP.ship, nameKo: `${nameOf(r.fromCityId)}→${nameOf(r.toCityId)} 배`,
      lines: [`출항편 ${sailingId}`, `실은 화물 ${v.shipmentIds.join(', ')}`, ...(v.waiting ? ['하역 중단으로 대기 중'] : [])] });
  }
  return marks;
}

/** 반지름 22 CSS px 안의 표시를 가까운 순서로 돌려준다. */
export function nearestMarks(points: { key: string; x: number; y: number }[], x: number, y: number, radius = 22): string[] {
  return points.map((p) => ({ key: p.key, d: Math.hypot(p.x - x, p.y - y) }))
    .filter((p) => p.d <= radius).sort((a, b) => a.d - b.d).map((p) => p.key);
}

/** 지도 아래 범례. 색·모양만으로 뜻을 전하지 않도록 글자로도 적는다. */
export function mapLegend(): string {
  return `
  <ul class="map-legend" aria-label="지도 범례">
    <li><span class="lg lg-active"></span>이번 시나리오 거점</li>
    <li><span class="lg lg-planned"></span>1장에서 열릴 거점</li>
    <li><span class="lg lg-preview"></span>세계 확장(2장) 미리 보기</li>
    <li><span class="lg lg-coin"></span>국제 금융 중심</li>
    <li><span class="lg lg-gate"></span>해협·운하</li>
  </ul>`;
}

export const MAP_ATTRIBUTION = (WORLD_MAP ?? REGION_MAP)?.attribution ?? '';
