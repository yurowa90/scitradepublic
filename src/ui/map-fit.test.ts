import { describe, expect, it } from 'vitest';
import { loadScenario, SCENARIO_IDS } from '../content/scenario';
import { loadMapCities, loadRouteWaypoints } from '../content/map';
import { createGame, openDay } from '../engine/engine';
import { acceptAllFeasible, runDays } from '../engine/testkit';
import type { ScenarioConfig } from '../engine/types';
import { mapAsset } from './assets';
import { project } from './projection';
import {
  BLANK_BAND_LIMIT_CSS, LABEL_FLOOR_PX, MapMeasurementMemory, labelCapCssWidth, mapLabelScale, mapRibbonScale,
  mapRedrawDecision, mapViewportKey, planMapViewport, renderWorldMap, worldMapViewport,
} from './map';

// 시험 전용: 계획 함수와 같은 규칙으로 항로 상자·필요 크기를 따로 계산한다.
function routeFit(config: ScenarioConfig) {
  const map = mapAsset('MAP_EAST_ASIA')!;
  const u = map.pixelGrid!.unitsPerPixel;
  const pts = config.routes.flatMap((r) => loadRouteWaypoints(r.id)).map((p) => project(p, map.bounds, map.width, map.height));
  const left = Math.floor(Math.min(...pts.map((p) => p.x)) / u), top = Math.floor(Math.min(...pts.map((p) => p.y)) / u);
  const right = Math.ceil(Math.max(...pts.map((p) => p.x)) / u), bottom = Math.ceil(Math.max(...pts.map((p) => p.y)) / u);
  const requiredW = right - left + 24, requiredH = bottom - top + 24;
  return { left, top, right, bottom, requiredW, requiredH, minimumL: Math.max(requiredW, Math.ceil((requiredH - 0.5) * 16 / 10)) };
}

const M2 = loadScenario('SCENARIO_M2_MULTI_TRADE');
const M1 = loadScenario('SCENARIO_M1_ONE_TRADE');
const SWEEP_DPR = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.333, 1.5, 1.75, 2, 2.25, 2.5, 2.625, 2.75, 3, 3.5, 4];

describe('이번 항로 지도 폭 맞춤', () => {
  it('모든 시나리오의 항로 상자와 필요 크기', () => {
    expect(BLANK_BAND_LIMIT_CSS).toBe(16);
    for (const id of SCENARIO_IDS) {
      expect(routeFit(loadScenario(id))).toEqual({ left: 98, top: 79, right: 328, bottom: 300, requiredW: 254, requiredH: 245, minimumL: 392 });
    }
  });

  it.each([
    [582.7, 2, { vb: { x: 38, y: 134, w: 776, h: 490 }, n: 3, cssWidth: 582, cssHeight: 367.5 }],
    [346.06, 2, { vb: { x: 80, y: 134, w: 692, h: 490 }, n: 2, cssWidth: 346, cssHeight: 245 }],
    [314.22, 2, { vb: { x: 112, y: 134, w: 628, h: 490 }, n: 2, cssWidth: 314, cssHeight: 245 }],
    [315.51, 2, { vb: { x: 110, y: 134, w: 630, h: 490 }, n: 2, cssWidth: 315, cssHeight: 245 }],
    [374.97, 2, { vb: { x: 52, y: 134, w: 748, h: 490 }, n: 2, cssWidth: 374, cssHeight: 245 }],
    [595.78, 1.25, { vb: { x: 54, y: 134, w: 744, h: 490 }, n: 2, cssWidth: 595.2, cssHeight: 392 }],
    [456.16, 1.5, { vb: { x: 84, y: 134, w: 684, h: 490 }, n: 2, cssWidth: 456, cssHeight: 326.6666666666667 }],
  ])('빈 띠가 16 CSS px 이상인 폭 %s·dpr %s는 한 배율 위에서 세로를 항로 높이까지 늘린다', (width, dpr, plan) => {
    for (const config of [M2, M1]) expect(worldMapViewport(config, 'route', { availableWidth: width, dpr })).toEqual(plan);
  });

  it.each([
    [559.78, 2, { vb: { x: 0, y: 38, w: 1092, h: 682 }, n: 2, cssWidth: 546, cssHeight: 341 }],
    [875.06, 1.25, { vb: { x: 0, y: 38, w: 1092, h: 682 }, n: 2, cssWidth: 873.6, cssHeight: 545.6 }],
    [689.61, 0.8, { vb: { x: 0, y: 38, w: 1092, h: 682 }, n: 1, cssWidth: 682.5, cssHeight: 426.25 }],
    [503.06, 1, { vb: { x: 0, y: 64, w: 1006, h: 628 }, n: 1, cssWidth: 503, cssHeight: 314 }],
    [400.6, 2, { vb: { x: 26, y: 128, w: 800, h: 500 }, n: 2, cssWidth: 400, cssHeight: 250 }],
    [805.25, 1, { vb: { x: 24, y: 128, w: 804, h: 502 }, n: 2, cssWidth: 804, cssHeight: 502 }],
    [920.61, 2, { vb: { x: 0, y: 90, w: 920, h: 576 }, n: 4, cssWidth: 920, cssHeight: 576 }],
    [1400, 1.25, { vb: { x: 0, y: 38, w: 1092, h: 682 }, n: 3, cssWidth: 1310.4, cssHeight: 818.4 }],
  ])('빈 띠가 16 CSS px 미만이거나 상한 배율인 폭 %s·dpr %s는 16:10 계획 그대로다', (width, dpr, plan) => {
    for (const config of [M2, M1]) expect(worldMapViewport(config, 'route', { availableWidth: width, dpr })).toEqual(plan);
  });

  it('측정 전 기본값(620 CSS px·dpr 1)의 계획', () => {
    const memory = new MapMeasurementMemory();
    expect(memory.get('route')).toEqual({ availableWidth: 620, dpr: 1 });
    expect(worldMapViewport(M2, 'route', memory.get('route'))).toEqual({ vb: { x: 116, y: 134, w: 620, h: 490 }, n: 2, cssWidth: 620, cssHeight: 490 });
    expect(worldMapViewport(M2, 'world', memory.get('world'))).toEqual({ vb: { x: 0, y: 0, w: 3600, h: 1220 }, n: 1, cssWidth: 720, cssHeight: 244 });
  });

  it('전수 검사: 상한 아래 빈 띠 합은 16 CSS px 미만이고, 세로는 한 배율 올릴 때만 항로 높이까지 는다', () => {
    let tall = 0, total = 0;
    for (const config of [M2, M1]) {
      const fit = routeFit(config);
      for (const dpr of SWEEP_DPR) for (let w = 150; w <= 2000; w += 0.5) {
        total++;
        const plan = worldMapViewport(config, 'route', { availableWidth: w, dpr });
        const cap = Math.max(1, Math.floor(3 * dpr));
        const L = plan.vb.w / 2, H = plan.vb.h / 2;
        const n16 = Math.min(cap, Math.max(1, Math.floor(w * dpr / fit.minimumL)));
        const h16 = Math.min(615, Math.max(1, Math.round(L * 10 / 16)));
        expect(plan.n).toBeLessThanOrEqual(cap);
        expect(plan.cssWidth).toBeLessThanOrEqual(w);
        if (plan.n < cap) expect(w - plan.cssWidth).toBeLessThan(16);
        if (H === h16) expect(plan.n).toBe(n16);
        else {
          tall++;
          expect([H, plan.n, h16 < fit.requiredH, H <= L, w - n16 * 546 / dpr >= 16]).toEqual([fit.requiredH, n16 + 1, true, true, true]);
        }
      }
    }
    expect([total, tall]).toEqual([140638, 12756]);
  }, 60000);

  it('합성 항로: 다음 배율의 폭이 항로보다 좁거나 세로가 정사각형을 넘으면 띠가 남아도 그대로다', () => {
    const map = { w: 1092, h: 1230 };
    // 필요 폭 324: 다음 배율 폭 300에 들어가지 않는다.
    expect(planMapViewport(map, 2, { x: 300, y: 400, w: 600, h: 80 }, 600, 1, 'route'))
      .toEqual({ vb: { x: 0, y: 98, w: 1092, h: 682 }, n: 1, cssWidth: 546, cssHeight: 341 });
    // 필요 높이 324 > 다음 배율 폭 300(정사각형 초과).
    expect(planMapViewport(map, 2, { x: 300, y: 300, w: 50, h: 600 }, 600, 1, 'route'))
      .toEqual({ vb: { x: 0, y: 258, w: 1092, h: 682 }, n: 1, cssWidth: 546, cssHeight: 341 });
  });

  it('합성 항로: 빈 띠 16 CSS px에서 올리고 15.5 CSS px에서는 올리지 않는다', () => {
    const map = { w: 1092, h: 1230 }, route = { x: 300, y: 300, w: 200, h: 420 };
    expect(planMapViewport(map, 2, route, 562, 1, 'route'))
      .toEqual({ vb: { x: 118, y: 276, w: 562, h: 468 }, n: 2, cssWidth: 562, cssHeight: 468 });
    expect(planMapViewport(map, 2, route, 561.5, 1, 'route'))
      .toEqual({ vb: { x: 0, y: 168, w: 1092, h: 682 }, n: 1, cssWidth: 546, cssHeight: 341 });
  });
});

// 렌더 HTML의 거점마다 상태·휘장 위치·리본 여부.
function portsOf(out: string) {
  return out.split('<g class="port ').slice(1).map((chunk) => {
    const [, x, y] = chunk.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
    return { status: chunk.slice(0, chunk.indexOf('"')), x: Number(x), y: Number(y), ribbon: chunk.includes('<g class="ribbon">') };
  });
}
const inBox = (p: { x: number; y: number }, vb: { x: number; y: number; w: number; h: number }) => p.x >= vb.x && p.x <= vb.x + vb.w && p.y >= vb.y && p.y <= vb.y + vb.h;

describe('경로 지도 이름표 하한', () => {
  const html = (config: ScenarioConfig, width: number, dpr: number, state = createGame(config)) => renderWorldMap(state, config, 'route', { availableWidth: width, dpr });
  const scales = (config: ScenarioConfig, width: number, dpr: number, world = false) => {
    const plan = worldMapViewport(config, world ? 'world' : 'route', { availableWidth: width, dpr });
    const cap = labelCapCssWidth(config, world ? 'world' : 'route', dpr);
    return { plan, k: mapLabelScale(plan, world, cap), kr: mapRibbonScale(plan, world, cap), css: plan.cssWidth / plan.vb.w };
  };

  it('이름표 글자와 리본 상자만 11 CSS px 하한을 쓰고 휘장·나침반·배·사건·선은 그대로다', () => {
    expect(LABEL_FLOOR_PX).toBe(11);
    const cfg = structuredClone(M2);
    cfg.portRestrictions = [{ eventInstanceId: 'SYNTH-WAIT', templateId: 'SYNTH', cityId: cfg.routes[0]!.toCityId, announceDay: 1, startDay: 1, endDay: 1, forecastKo: '시험용 가상 공지' }];
    const open = openDay(createGame(cfg), cfg).state;
    const sailing = runDays(open, cfg, 2, { 1: acceptAllFeasible(open, cfg) }).state;
    const state = { ...structuredClone(sailing), appliedEventIds: { ...sailing.appliedEventIds, 'SYNTH-WAIT': true as const } };
    const { plan, k, kr, css } = scales(cfg, 315.51, 2);
    const out = html(cfg, 315.51, 2, state);
    expect([15 * k * css, 15 * kr * css]).toEqual([15 * 315 / 620, 11]);
    for (const part of [`font-size="${15 * kr}"`, `font-size="${12.5 * kr}"`, `rx="${5 * kr}"`, `height="${24 * kr}"`,
      `scale(${k})"><circle r="10" class="port-badge"`, `scale(${k * 0.78})"><circle r="10" class="port-badge"`, `r="${15 * k}" class="port-glow"`,
      `<circle r="${34 * k}" class="compass-ring"/>`, `scale(${k * 0.9})"><title>`, `scale(${k * 0.8})">`,
      `stroke-width="${7 * k}"`, `stroke-width="${2.6 * k}"`, `<g class="graticule" stroke-width="${0.8 * k}">`, `font-size="${12 * k}"`]) expect(out).toContain(part);
    expect(out).not.toContain(`font-size="${15 * k}"`);
    expect(plan.n).toBe(2);
    // k를 그대로 쓰는 나머지 자리: 나침반 위치, 관문 표시, 항로 점선, 폭풍 위치, 경위도 글자 위치(Claude 검수).
    const map = mapAsset('MAP_EAST_ASIA')!;
    const storm = project(loadMapCities().find((c) => c.id === cfg.routes[0]!.toCityId)!, map.bounds, map.width, map.height);
    for (const part of [`translate(${(plan.vb.x + plan.vb.w - 52 * k).toFixed(1)} ${(plan.vb.y + plan.vb.h - 60 * k).toFixed(1)})" aria-hidden="true"`,
      `width="${10 * k}" height="${10 * k}" transform="rotate(45`, `stroke-dasharray="${10 * k} ${8 * k}"`,
      `translate(${(storm.x + 30 * k).toFixed(1)} ${(storm.y + 40 * k).toFixed(1)}) scale(${k * 0.8})`,
      `y="${plan.vb.y + 16 * k}" font-size="${12 * k}"`]) expect(out).toContain(part);
    // 리본 자리: 휘장에서 띄우는 간격 13과 위아래 4는 k를 쓴다(크기만 kr).
    const placed = out.split('<g class="port ').slice(1).filter((c) => c.includes('<g class="ribbon">')).map((chunk) => {
      const t = chunk.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
      const r = chunk.match(/<g class="ribbon"><rect x="([-\d.e]+)" y="([-\d.e]+)" width="([\d.e-]+)" height="([\d.e-]+)"/)!;
      const x = Number(t[1]), y = Number(t[2]), bx = Number(r[1]), by = Number(r[2]), bw = Number(r[3]), bh = Number(r[4]);
      const gap = 13 * k, d = 4 * k;
      const spots: [number, number][] = [[x + gap, y - bh - d], [x - gap - bw, y - bh - d], [x + gap, y + d], [x - gap - bw, y + d],
        [x - bw / 2, y - gap - bh], [x - bw / 2, y + gap], [x - bw / 2, y - gap - 2 * bh], [x - bw / 2, y + gap + bh]];
      return spots.some(([sx, sy]) => Math.abs(sx - bx) < 1e-6 && Math.abs(sy - by) < 1e-6);
    });
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.every(Boolean)).toBe(true);
  });

  it('하한보다 큰 이름표와 세계지도는 바꾸지 않는다', () => {
    const big = scales(M2, 920.61, 2);
    expect(big.kr).toBe(big.k);
    const world = scales(M2, 930, 1.5, true);
    expect(world.kr).toBe(world.k);
    expect(renderWorldMap(createGame(M2), M2, 'world', { availableWidth: 930, dpr: 1.5 })).toContain(`font-size="${15 * world.k}"`);
    // 946 상한 아래 넓은 틀: 그린 리본 글자와 휘장이 상한을 쓴 k를 쓴다(Claude 검수).
    for (const width of [1154.33, 1600]) {
      const s = scales(M2, width, 1), out = html(M2, width, 1);
      expect(out).toContain(`font-size="${15 * s.k}"`);
      expect(out).toContain(`scale(${s.k})"><circle r="10" class="port-badge"`);
    }
  });

  it('320 CSS px 휴대폰(폭 259.22·dpr 2)에서는 1장 예정 거점 이름표 하나가 빠지고 이번 시나리오 거점 이름표는 남는다', () => {
    const ribbonsInView = (config: ScenarioConfig) => {
      const plan = worldMapViewport(config, 'route', { availableWidth: 259.22, dpr: 2 });
      return portsOf(html(config, 259.22, 2)).filter((p) => inBox(p, plan.vb)).map((p) => `${p.status}:${p.ribbon ? '이름표' : '없음'}`);
    };
    expect(ribbonsInView(M2)).toEqual(['active:이름표', 'active:이름표', 'active:이름표', 'planned:이름표', 'planned:없음', 'preview:이름표']);
    expect(ribbonsInView(M1)).toEqual(['active:이름표', 'active:이름표', 'planned:이름표', 'planned:이름표', 'planned:없음', 'preview:이름표']);
  });

  it.each(['route', 'world'] as const)('%s에서 같은 다시 그리기 키는 같은 이름표 글자 크기를 뜻한다', (mode) => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const sizes = new Map<string, number>();
      for (let width = 240; width <= 1800; width += 7) {
        const plan = worldMapViewport(M2, mode, { availableWidth: width, dpr });
        const screen = mapRibbonScale(plan, mode === 'world', labelCapCssWidth(M2, mode, dpr)) * plan.cssWidth / plan.vb.w;
        const { key } = mapRedrawDecision(M2, mode, { availableWidth: width, dpr });
        expect(key).toBe(mapViewportKey(plan, dpr));
        if (sizes.has(key)) expect(screen).toBeCloseTo(sizes.get(key)!, 10);
        sizes.set(key, screen);
        if (mode === 'route') expect(15 * screen).toBeGreaterThanOrEqual(11 - 1e-9);
      }
    }
    if (mode === 'route') {
      // 같은 키의 두 폭을 실제로 그려, 렌더의 리본 크기가 키 밖의 틀 폭에 기대지 않는지 본다(Claude 검수).
      const ribbonSizes = (width: number) => [...html(M2, width, 2).matchAll(/<g class="ribbon"><rect [^>]*\/>\s*<text [^>]*font-size="([\d.e-]+)"/g)].map((m) => Number(m[1]));
      const a = worldMapViewport(M2, 'route', { availableWidth: 274, dpr: 2 }), b = worldMapViewport(M2, 'route', { availableWidth: 288.9, dpr: 2 });
      expect(mapViewportKey(a, 2)).toBe(mapViewportKey(b, 2));
      expect(ribbonSizes(274).length).toBeGreaterThan(0);
      expect(ribbonSizes(288.9)).toEqual(ribbonSizes(274));
      expect(Math.max(...ribbonSizes(274)) * a.cssWidth / a.vb.w).toBeGreaterThanOrEqual(11 - 1e-9);
    }
  });

  it('전수 검사: 이번 시나리오 거점 이름표는 빠지지 않고, 그린 항로선은 보기 영역 안쪽에 있다', () => {
    let keys = 0, minCtrl = Infinity, minAfterUnder = Infinity;
    for (const config of [M2, M1]) {
      const fit = routeFit(config), seen = new Set<string>(), state = createGame(config);
      for (const dpr of [1, 1.25, 1.5, 2, 2.5, 3]) for (let w = 240; w <= 1600; w += 2) {
        if (w * dpr < fit.minimumL) continue;
        const plan = worldMapViewport(config, 'route', { availableWidth: w, dpr });
        const key = mapViewportKey(plan, dpr);
        if (seen.has(key)) continue;
        seen.add(key); keys++;
        const out = html(config, w, dpr, state);
        for (const p of portsOf(out)) if (p.status === 'active' && inBox(p, plan.vb)) expect(p.ribbon).toBe(true);
        const under = Number(out.match(/class="route-under" d="[^"]+" stroke-width="([\d.e-]+)"/)![1]);
        for (const m of out.matchAll(/<path class="route-line" d="([^"]+)"/g)) {
          const nums = m[1]!.replace(/[MC]/g, ' ').trim().split(/\s+/).map(Number);
          const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
          const margin = Math.min(Math.min(...xs) - plan.vb.x, Math.min(...ys) - plan.vb.y, plan.vb.x + plan.vb.w - Math.max(...xs), plan.vb.y + plan.vb.h - Math.max(...ys)) / 2;
          minCtrl = Math.min(minCtrl, margin);
          minAfterUnder = Math.min(minAfterUnder, margin - under / 4);
        }
      }
    }
    // 논리 px: 조절점 상자(곡선을 포함)의 가장 좁은 여백, 거기서 밑선(route-under) 반폭을 뺀 값.
    expect([keys, Math.round(minCtrl * 100) / 100, Math.round(minAfterUnder * 100) / 100]).toEqual([6422, 9.05, 6.83]);
  }, 60000);
});
