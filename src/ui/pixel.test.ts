import { afterEach, describe, expect, it, vi } from 'vitest';
import { integerScale, fitPixelBox, applyPixelScale } from './pixel';
import { mapAsset } from './assets';
import { renderWorldMap, snapViewBox, planMapViewport, MapMeasurementMemory, worldMapViewport, mapViewportKey, mapLabelScale, labelCapCssWidth, LABEL_CAP_FRAME_WIDTH, mapPresentation, mapRedrawDecision, readMapScroll, mapScrollPosition } from './map';
import { loadScenario } from '../content/scenario';
import { createGame } from '../engine/engine';

const DPR = [1, 1.25, 1.5, 2, 3];

describe('기기 픽셀 정수 배율', () => {
  it.each(DPR)('dpr %s에서 들어갈 수 있는 가장 큰 정수 배율을 고른다', (dpr) => {
    const size = integerScale(900, 450, dpr);
    expect(size.n).toBe(Math.floor(2 * dpr));
    expect(size.cssPx).toBe(size.n * 450 / dpr);
    expect(size.cssPx).toBeLessThanOrEqual(900);
    expect((size.n + 1) * 450 / dpr).toBeGreaterThan(900);
  });
  it.each(DPR)('dpr %s에서 공간이 1배보다 좁으면 넘치는 1배를 유지한다', (dpr) => {
    const available = 32 / dpr - 1;
    expect(integerScale(available, 32, dpr)).toEqual({ n: 1, cssPx: 32 / dpr });
  });
  it.each(DPR)('dpr %s의 정확한 경계에서 배율이 하나 작아지지 않는다', (dpr) => {
    for (const n of [1, 2, 7]) {
      const available = n * 96 / dpr;
      expect(integerScale(available, 96, dpr)).toEqual({ n, cssPx: available });
    }
  });
  it('부동소수 곱셈 오차를 보정하고 경계 바로 아래는 올리지 않는다', () => {
    expect(integerScale(0.3, 0.1, 1).n).toBe(3);
    expect(integerScale(299.999, 100, 1).n).toBe(2);
    expect(integerScale(900, 450, 1.25)).toEqual({ n: 2, cssPx: 720 });
  });
  it('높이 제약이 더 좁으면 높이 배율을 쓴다', () => {
    expect(fitPixelBox({ w: 500, h: 150 }, { w: 96, h: 128 }, 2))
      .toEqual({ n: 2, cssWidth: 96, cssHeight: 128 });
    expect(fitPixelBox({ w: 500 }, { w: 96, h: 128 }, 2))
      .toEqual({ n: 10, cssWidth: 480, cssHeight: 640 });
    expect(fitPixelBox({ w: 30, h: 20 }, { w: 96, h: 128 }, 1.25).n).toBe(1);
  });
});

describe('픽셀 지도 격자', () => {
  it.each([2, 5])('%s 단위로 넓히며 원래 영역을 포함한다', (unit) => {
    const source = { x: 13.1, y: 27.6, w: 212.2, h: 174.3 };
    const vb = snapViewBox(source, unit, 3600, 1220);
    for (const value of Object.values(vb)) expect(value % unit).toBe(0);
    expect(vb.x).toBeLessThanOrEqual(source.x);
    expect(vb.y).toBeLessThanOrEqual(source.y);
    expect(vb.x + vb.w).toBeGreaterThanOrEqual(source.x + source.w);
    expect(vb.y + vb.h).toBeGreaterThanOrEqual(source.y + source.h);
  });
  it('지도 밖으로 넓힌 영역은 지도 경계에서 자른다', () => {
    expect(snapViewBox({ x: -2.1, y: -1.3, w: 112, h: 60 }, 5, 100, 50))
      .toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });
  it('두 지도 자산의 논리 격자와 좌표 크기가 일치한다', () => {
    for (const [id, w, h, units] of [['MAP_EAST_ASIA', 546, 615, 2], ['MAP_WORLD', 720, 244, 5]] as const) {
      const map = mapAsset(id)!;
      expect(map.pixelGrid).toEqual({ logicalWidth: w, logicalHeight: h, unitsPerPixel: units });
      expect(map.width).toBe(w * units);
      expect(map.height).toBe(h * units);
      expect(map.path).toMatch(/\.png$/);
    }
  });
  it.each(['route', 'world'] as const)('%s 보기의 논리 크기는 맞춘 viewBox ÷ 단위다', (mode) => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const html = renderWorldMap(createGame(config), config, mode);
    const vb = html.match(/viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/)!.slice(1).map(Number);
    const unit = mode === 'world' ? 5 : 2;
    expect(html).toContain('class="map-base pixel-art"');
    expect(html).toContain(`data-pixel-w="${vb[2]! / unit}"`);
    expect(html).toContain(`data-pixel-h="${vb[3]! / unit}"`);
    vb.forEach((value) => expect(value % unit).toBe(0));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="');
  });
});

describe('픽셀 크기 감시 연결', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('node처럼 DOM 기능이 없는 환경에서는 아무것도 하지 않는다', () => {
    expect(() => applyPixelScale({} as HTMLElement)).not.toThrow();
  });
  it('크기 감시나 해상도 감시가 없으면 아무것도 하지 않는다', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('ResizeObserver', undefined);
    expect(() => applyPixelScale({} as HTMLElement)).not.toThrow();
    vi.stubGlobal('ResizeObserver', vi.fn());
    expect(() => applyPixelScale({} as HTMLElement)).not.toThrow();
    expect(ResizeObserver).not.toHaveBeenCalled();
  });
  it('재렌더 때 감시자를 재사용하고 dpr 변화 뒤 새 해상도를 감시한다', () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const callbacks: (() => void)[] = [];
    const construct = vi.fn();
    let computedWidth: string | undefined;
    class FakeObserver {
      observe = observe;
      disconnect = disconnect;
      constructor(callback: () => void) { construct(); callbacks.push(callback); }
    }
    const media: { query: string; change?: () => void; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }[] = [];
    const scheduled: (() => void)[] = [];
    const flush = () => { scheduled.splice(0).forEach((fn) => fn()); };
    const fakeWindow = {
      requestAnimationFrame: vi.fn((fn: () => void) => { scheduled.push(fn); return scheduled.length; }),
      devicePixelRatio: 1.25,
      getComputedStyle: () => ({ paddingLeft: '10px', paddingRight: '10px', borderLeftWidth: '3px', borderRightWidth: '3px',
        boxSizing: 'border-box', width: computedWidth }),
      matchMedia: (query: string) => {
        const item = { query, change: undefined as (() => void) | undefined,
          addEventListener: vi.fn((_name, listener) => { item.change = listener; }), removeEventListener: vi.fn() };
        media.push(item);
        return item;
      },
    };
    vi.stubGlobal('ResizeObserver', FakeObserver);
    vi.stubGlobal('window', fakeWindow);
    const parent = { clientWidth: 220 };
    const first = { dataset: { pixelW: '96', pixelH: '128' }, style: { width: '', height: '' }, parentElement: parent };
    const second = { ...first, style: { width: '', height: '' } };
    const root = (element: typeof first) => ({ querySelectorAll: (selector: string) => selector === '[data-map-frame]' ? [] : [element], style: { setProperty: vi.fn() } } as unknown as HTMLElement);
    const firstRoot = root(first);
    applyPixelScale(firstRoot);
    flush();
    expect(firstRoot.style.setProperty).toHaveBeenCalledWith('--pixel-dpr', '1.25');
    expect(observe).toHaveBeenCalledWith(parent);
    expect(first.style).toEqual({ width: '153.6px', height: '204.8px' });
    const secondRoot = root(second);
    applyPixelScale(secondRoot);
    flush();
    expect(construct).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(media[0]!.removeEventListener).toHaveBeenCalledTimes(1);
    fakeWindow.devicePixelRatio = 2;
    media[1]!.change!();
    flush();
    expect(second.style).toEqual({ width: '192px', height: '256px' });
    expect(secondRoot.style.setProperty).toHaveBeenLastCalledWith('--pixel-dpr', '2');
    expect(observe.mock.calls.map(([element]) => element)).toEqual([parent, parent]);
    expect(first.style.width).toBe('153.6px');
    expect(media[2]!.query).toBe('(resolution: 2dppx)');
    parent.clientWidth = 120;
    callbacks[0]!();
    callbacks[0]!();
    expect(scheduled).toHaveLength(1);
    flush();
    expect(second.style.width).toBe('96px');
    // 2배 경계 바로 아래의 소수 폭을 clientWidth 반올림으로 2배로 올리지 않는다.
    fakeWindow.devicePixelRatio = 1.25;
    computedWidth = '179.599px'; // 테두리와 여백 26px를 빼면 153.599px
    parent.clientWidth = 174;
    callbacks[0]!();
    callbacks[0]!();
    expect(scheduled).toHaveLength(1);
    flush();
    expect(second.style.width).toBe('76.8px');
  });
  it('지도 틀만 감시하고 대안 모드 안쪽 SVG를 다시 배율 계산하지 않는다', async () => {
    vi.resetModules();
    const { applyPixelScale: apply } = await import('./pixel');
    const observe = vi.fn(), disconnect = vi.fn(), scheduled: (() => void)[] = [];
    let resized: () => void = () => {};
    class Observer {
      observe = observe; disconnect = disconnect;
      constructor(callback: () => void) { resized = callback; }
    }
    vi.stubGlobal('ResizeObserver', Observer);
    vi.stubGlobal('window', {
      devicePixelRatio: 1.5,
      requestAnimationFrame: (fn: () => void) => { scheduled.push(fn); return 1; },
      getComputedStyle: () => ({width:'543px',boxSizing:'content-box'}),
      matchMedia: () => ({addEventListener:vi.fn(),removeEventListener:vi.fn()}),
    });
    const frame = {};
    const nestedSvg = {closest:()=>frame,style:{width:'100%',height:'100%'}};
    const root = {querySelectorAll:(selector:string)=>selector==='[data-map-frame]'?[frame]:[nestedSvg],style:{setProperty:vi.fn()}};
    const redraw = vi.fn();
    apply(root as unknown as HTMLElement,redraw);
    expect(observe.mock.calls.map(([element])=>element)).toEqual([frame]);
    expect(redraw).not.toHaveBeenCalled();
    scheduled.splice(0).forEach(fn=>fn());
    expect(redraw).toHaveBeenCalledWith(frame,543,1.5);
    expect(nestedSvg.style.width).toBe('100%');
    apply(root as unknown as HTMLElement,redraw);
    resized(); resized();
    expect(scheduled).toHaveLength(1);
    scheduled.splice(0).forEach(fn=>fn());
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

});


describe('틀을 채우는 지도 보기 영역', () => {
  const map = { w: 1092, h: 1230 };
  const route = { x: 300, y: 400, w: 200, h: 80 };
  it.each(DPR)('dpr %s에서 가로와 세로 여백이 들어가는 최대 정수 배율과 폭을 고른다', (dpr) => {
    for (const width of [278, 543, 1024, 1440]) {
      const plan = planMapViewport(map, 2, route, width, dpr, 'route');
      const L = Math.min(map.w / 2, Math.floor(width * dpr / plan.n));
      expect(plan.n).toBeGreaterThan(1);
      expect(plan.n).toBeLessThanOrEqual(Math.max(1, Math.floor(3 * dpr)));
      expect(plan.cssWidth).toBe(plan.n * L / dpr);
      expect(plan.vb.w).toBe(L * 2);
      expect(plan.vb.h).toBe(Math.round(L * 10 / 16) * 2);
      expect(width - plan.cssWidth).toBeGreaterThanOrEqual(0);
      if (L < map.w / 2) expect(width - plan.cssWidth).toBeLessThan(plan.n / dpr);
      expect(plan.vb.x).toBeLessThanOrEqual(route.x - 24);
      expect(plan.vb.y).toBeLessThanOrEqual(route.y - 24);
      expect(plan.vb.x + plan.vb.w).toBeGreaterThanOrEqual(route.x + route.w + 24);
      expect(plan.vb.y + plan.vb.h).toBeGreaterThanOrEqual(route.y + route.h + 24);
      const nextL = Math.floor(width * dpr / (plan.n + 1));
      expect(plan.n === Math.max(1, Math.floor(3 * dpr)) || nextL < route.w / 2 + 24 || Math.round(nextL * 10 / 16) < route.h / 2 + 24).toBe(true);
    }
  });
  it('항로 좌표가 소수여도 격자 정렬 뒤 네 방향 최소 여백을 유지한다', () => {
    const route = {x:300.1,y:400.9,w:200.6,h:80.6};
    const plan = planMapViewport(map,2,route,500,1,'route');
    expect(plan.vb.x).toBeLessThanOrEqual(route.x-24);
    expect(plan.vb.y).toBeLessThanOrEqual(route.y-24);
    expect(plan.vb.x+plan.vb.w).toBeGreaterThanOrEqual(route.x+route.w+24);
    expect(plan.vb.y+plan.vb.h).toBeGreaterThanOrEqual(route.y+route.h+24);
  });
  it('세로가 긴 항로와 지도 가장자리도 고려한다', () => {
    const plan = planMapViewport(map, 2, { x: 0, y: 0, w: 50, h: 300 }, 543, 1.5, 'route');
    expect(plan.n).toBe(2);
    expect(plan.vb.x).toBe(0); expect(plan.vb.y).toBe(0);
    expect(plan.cssHeight).toBe(plan.n * (plan.vb.h / 2) / 1.5);
  });
  it.each(DPR)('세계 dpr %s에서 최소 720 CSS px와 틀 폭을 유지한다', (dpr) => {
    for (const width of [278,390,543,1024,1440,4000]) {
      const plan = planMapViewport({ w: 3600, h: 1220 }, 5, route, width, dpr, 'world');
      expect(plan.n).toBe(Math.min(Math.max(1, Math.floor(3*dpr)), Math.max(Math.ceil(dpr), Math.ceil(width*dpr/720))));
      expect(plan.cssWidth).toBe(plan.n * 720 / dpr);
      expect(plan.vb).toEqual({x:0,y:0,w:3600,h:1220});
    }
  });
  it('SVG 밖 바탕은 바깥 상자 하나에만 배율 속성을 단다', () => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const html = renderWorldMap(createGame(config),config,'route',{availableWidth:543,dpr:1.25,baseOutsideSvg:true});
    expect(html.match(/data-pixel-w=/g)).toHaveLength(1);
    expect(html).toContain('<div class="map-layers" data-pixel-w=');
    expect(html.match(/<svg[^>]+>/)?.[0]).not.toContain('data-pixel-');
    expect(html).not.toContain('<image');
  });

});

describe('지도 재그리기 계약', () => {
  const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
  it('측정 전만 기본값을 쓰고 보기별 마지막 폭·dpr을 재사용한다', () => {
    const memory = new MapMeasurementMemory();
    expect(memory.has('route')).toBe(false);
    expect(memory.get('route')).toEqual({ availableWidth: 620, dpr: 1 });
    memory.remember('world', 930, 1.5);
    memory.remember('route', 543, 1.25);
    expect(memory.has('world')).toBe(true);
    expect(memory.get('world')).toEqual({ availableWidth: 930, dpr: 1.5 });
    for (const mode of ['route', 'world'] as const) {
      const measured = mode === 'world' ? { availableWidth: 930, dpr: 1.5 } : { availableWidth: 543, dpr: 1.25 };
      const before = worldMapViewport(config, mode, measured);
      const redrawn = worldMapViewport(config, mode, memory.get(mode));
      expect(redrawn).toEqual(before);
      expect(renderWorldMap(createGame(config), config, mode, memory.get(mode)))
        .toBe(renderWorldMap(createGame(config), config, mode, measured));
    }
  });
  it('높이가 제한하는 경우의 최대 n은 전수 검색과 같다', () => {
    const box = { x: 500, y: 500, w: 10, h: 80 };
    // 필요 높이 64, 폭 102이면 round(102 × 10/16)=64라 3배가 가능하다.
    for (const width of [120, 121, 153, 180, 203, 204, 205, 255, 260, 306, 510, 714, 1000]) for (const dpr of DPR) {
      const cap = Math.max(1, Math.floor(3*dpr));
      let best = 1;
      for (let n = 1; n <= cap; n++) {
        const L = Math.floor(width*dpr/n);
        if (L >= 29 && Math.round(L*10/16) >= 64) best = n;
      }
      expect(planMapViewport({w:2000,h:2000},2,box,width,dpr,'route').n).toBe(best);
    }
  });
  it('가운데 맞춤은 격자 반올림 1픽셀 이내이고 상한에서는 보기 영역을 넓힌다', () => {
    const plan = planMapViewport({w:4000,h:4000},2,{x:1500,y:1500,w:200,h:80},930,1,'route');
    expect(plan.n).toBe(3);
    expect(plan.vb.w).toBe(620);
    expect(Math.abs(plan.vb.x+plan.vb.w/2-1600)).toBeLessThanOrEqual(1);
    expect(Math.abs(plan.vb.y+plan.vb.h/2-1540)).toBeLessThanOrEqual(1);
    expect(plan.cssWidth).toBe(plan.n*plan.vb.w/2);
  });
  it.each(['route','world'] as const)('%s 렌더는 전달한 폭·dpr과 SVG 크기·이름표 배율을 쓴다', (mode) => {
    const options = {availableWidth:930,dpr:1.5};
    const plan = worldMapViewport(config,mode,options);
    const html = renderWorldMap(createGame(config),config,mode,options);
    const svg = html.match(/<svg[^>]+>/)![0];
    expect(svg).toContain(`width="${plan.cssWidth}" height="${plan.cssHeight}"`);
    expect(svg).toContain(`style="width: ${plan.cssWidth}px; height: ${plan.cssHeight}px;"`);
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain(`viewBox="${plan.vb.x.toFixed(1)} ${plan.vb.y.toFixed(1)} ${plan.vb.w.toFixed(1)} ${plan.vb.h.toFixed(1)}"`);
    const cap = worldMapViewport(config,mode,{availableWidth:946,dpr:1.5}).cssWidth;
    const k = plan.vb.w/620*Math.min(plan.cssWidth,cap)/plan.cssWidth*(mode === 'world' ? .45 : 1);
    expect(html).toContain(`font-size="${15*k}"`);
    expect(html).toContain(`scale(${k})`);
  });
  it('대안 바탕은 SVG와 같은 위치·크기를 쓰며 바깥 키는 dpr도 구별한다', () => {
    const options = {availableWidth:543,dpr:1.25};
    const plan = worldMapViewport(config,'route',options);
    const {vb} = plan;
    const html = renderWorldMap(createGame(config),config,'route',{...options,baseOutsideSvg:true});
    expect(html).toContain(`data-map-viewport="${plan.n}:${vb.w}:${vb.h}:${vb.x}:${vb.y}"`);
    expect(html).toContain(`style="width: ${plan.cssWidth}px; height: ${plan.cssHeight}px;"`);
    expect(html).toContain(`left: ${-vb.x/vb.w*100}%; top: ${-vb.y/vb.h*100}%; width: ${1092/vb.w*100}%; height: ${1230/vb.h*100}%;`);
    expect(mapViewportKey(plan,1.25)).toBe(`${plan.n}:${vb.w}:${vb.h}:${vb.x}:${vb.y}:1.25`);
    expect(mapViewportKey(plan,1.5)).not.toBe(mapViewportKey(plan,1.25));
  });
});


describe('넓은 틀과 지도 연결 판단', () => {
  const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
  it.each(DPR)('dpr %s의 넓은 경로 틀은 지도 안에서 자른다', (dpr) => {
    for (const width of [1600,2200,4000]) {
      const plan = worldMapViewport(config,'route',{availableWidth:width,dpr});
      expect(plan.vb.x).toBeGreaterThanOrEqual(0);
      expect(plan.vb.y).toBeGreaterThanOrEqual(0);
      expect(plan.vb.x+plan.vb.w).toBeLessThanOrEqual(1092);
      expect(plan.vb.y+plan.vb.h).toBeLessThanOrEqual(1230);
      expect(plan.cssWidth).toBeLessThanOrEqual(width);
    }
  });
  it.each(['route','world'] as const)('%s의 이름표·휘장은 946px보다 커지지 않는다', (mode) => {
    for (const dpr of DPR) {
      const small = worldMapViewport(config,mode,{availableWidth:946,dpr});
      const large = worldMapViewport(config,mode,{availableWidth:1600,dpr});
      const cap = labelCapCssWidth(config,mode,dpr);
      const screenSize = (plan: typeof small) => mapLabelScale(plan,mode === 'world',cap)*plan.cssWidth/plan.vb.w;
      expect(LABEL_CAP_FRAME_WIDTH).toBe(946);
      expect(screenSize(large)).toBeCloseTo(screenSize(small),10);
    }
  });
  it('946px보다 좁은 틀의 세계지도 이름표는 지도 표시 폭에 비례한다(줄이지 않는다)', () => {
    // 세계지도는 틀보다 넓게 그려 스크롤한다. 이름표는 틀 폭이 아니라 지도 표시 폭을 따른다.
    for (const dpr of DPR) for (const width of [330,390,550,720,930]) {
      const plan = worldMapViewport(config,'world',{availableWidth:width,dpr});
      const screen = 15*mapLabelScale(plan,true,labelCapCssWidth(config,'world',dpr))*plan.cssWidth/plan.vb.w;
      expect(plan.cssWidth).toBeGreaterThanOrEqual(720);
      expect(screen).toBeCloseTo(15*plan.cssWidth/620*.45,10);
      expect(screen).toBeGreaterThanOrEqual(15*720/620*.45-1e-9);
    }
  });
  it.each(['route','world'] as const)('%s에서 같은 다시 그리기 키는 같은 이름표 크기를 뜻한다', (mode) => {
    for (const dpr of DPR) {
      const sizes = new Map<string, number>();
      for (let width = 300; width <= 1800; width += 7) {
        const plan = worldMapViewport(config,mode,{availableWidth:width,dpr});
        const screen = mapLabelScale(plan,mode === 'world',labelCapCssWidth(config,mode,dpr))*plan.cssWidth/plan.vb.w;
        const {key} = mapRedrawDecision(config,mode,{availableWidth:width,dpr});
        if (sizes.has(key)) expect(screen).toBeCloseTo(sizes.get(key)!,10);
        sizes.set(key,screen);
      }
    }
  });
  it('처음 측정된 크기를 계획에 쓰고 같은 키이면 다시 그리지 않는다', () => {
    const measurement = {availableWidth:543,dpr:1.25};
    const first = mapRedrawDecision(config,'route',measurement);
    expect(first).toEqual({key:mapViewportKey(worldMapViewport(config,'route',measurement),1.25),redraw:true});
    expect(mapRedrawDecision(config,'route',measurement,first.key).redraw).toBe(false);
    // 세계지도는 배율 n이 같으면 틀 폭이 바뀌어도 그림·이름표가 같으므로 다시 그리지 않는다.
    const world = mapRedrawDecision(config,'world',{availableWidth:930,dpr:1});
    expect(mapRedrawDecision(config,'world',{availableWidth:940,dpr:1},world.key).redraw).toBe(false);
    expect(mapRedrawDecision(config,'world',{availableWidth:1500,dpr:1},world.key).redraw).toBe(true);
  });
  it('측정한 세계지도에서만 비율을 읽고 시나리오 초기화 동안 읽지 않는다', () => {
    expect(readMapScroll(true,true,false,300,1000,400)).toBe(.5);
    for (const [world,measured,reset] of [[false,true,false],[true,false,false],[true,true,true]]) {
      expect(readMapScroll(world!,measured!,reset!,300,1000,400,.2)).toBe(.2);
    }
    expect(mapScrollPosition(true,.5,.3,1000,400)).toBe(300);
    expect(mapScrollPosition(true,undefined,.3,1000,400)).toBe(100);
    expect(mapScrollPosition(false,.5,.3,1000,400)).toBeUndefined();
    const memory = new MapMeasurementMemory();
    memory.remember('route',543,1.25);memory.remember('world',930,3);memory.clear();
    expect(memory.has('route')).toBe(false);expect(memory.has('world')).toBe(false);
  });
  it('경로 보기에서 세계 자산이 선택되어도 접근성·안내·스크롤을 제공한다', async () => {
    const content = await import('../content/map');
    const spy = vi.spyOn(content,'loadRouteWaypoints').mockReturnValue([{lon:0,lat:40}]);
    const currentMap = await import('./map');
    const presentation = currentMap.mapPresentation(config,'route');
    expect(presentation.world).toBe(true);
    expect(presentation.attributes).toContain('tabindex="0" role="region"');
    expect(presentation.attributes).toContain('aria-label="세계지도');
    expect(presentation.hint).toContain('화살표 키');
    expect(currentMap.worldMapViewport(config,'route',{availableWidth:930,dpr:1}).vb.w).toBe(3600);
    spy.mockRestore();
  });
});
