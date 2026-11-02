import { afterEach, describe, expect, it, vi } from 'vitest';

const resize = vi.hoisted(() => ({ callback: undefined as ((frame: HTMLElement, width: number, dpr: number) => void) | undefined }));
vi.mock('./pixel', () => ({ applyPixelScale: (_root: HTMLElement, callback: typeof resize.callback) => { resize.callback = callback; } }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resize.callback = undefined; });

async function start(outsideRegion = false) {
  vi.resetModules();
  vi.stubGlobal('confirm',()=>true);
  vi.stubGlobal('ResizeObserver',class { observe() {} disconnect() {} });
  if (outsideRegion) {
    const content = await import('../content/map');
    vi.spyOn(content,'loadRouteWaypoints').mockReturnValue([{lon:0,lat:40}]);
  }
  const listeners: Record<string, (event: {target: unknown}) => void> = {};
  let html = '';
  let frame: { dataset: Record<string,string>; innerHTML: string; scrollLeft: number; scrollWidth: number; clientWidth: number; querySelector: () => unknown };
  const app = {
    get innerHTML() { return html; },
    set innerHTML(value: string) {
      html = value;
      frame = {dataset:{},innerHTML:value,scrollLeft:0,scrollWidth:2000,clientWidth:930,querySelector:()=>({dataset:{mapCenter:'.5'}})};
    },
    addEventListener: (name: string, callback: typeof listeners[string]) => { listeners[name] = callback; },
    querySelectorAll:()=>[],
    querySelector: (selector: string) => selector === '.statusbar' ? {getBoundingClientRect:()=>({height:80})} : selector === '[data-map-frame]' || (selector === '.map-frame.is-world' && html.includes('class="map-frame is-world"')) ? frame : null,
  };
  vi.stubGlobal('window', { innerHeight: 800, scrollX: 0, scrollY: 0, scrollBy: () => undefined, scrollTo: () => undefined, addEventListener: () => undefined, requestAnimationFrame: () => 0, matchMedia: () => ({ matches: false, addEventListener: () => undefined }) });
  vi.stubGlobal('document',{querySelector:()=>app,activeElement:null,addEventListener:()=>undefined,body:{insertAdjacentHTML:()=>undefined},getElementById:(id:string)=>id==='live-status' ? {textContent:''} : null,documentElement:{style:{setProperty:()=>undefined}}});
  await import('./main');
  const click = (dataset: Record<string,string>) => listeners.click!({target:{closest:()=>({dataset,closest:()=>null})}});
  return {app, frame:()=>frame!, click,
    importText: async (text: string) => {
      class Input { dataset = {action:'import'}; files = [{text:async()=>text}]; }
      vi.stubGlobal('HTMLInputElement', Input);
      await listeners.change!({target:new Input()});
    },
    changeScenario: () => listeners.change!({target:{dataset:{action:'scenario'},value:'SCENARIO_M2_MULTI_TRADE'}}),
    measure: (width: number, dpr: number) => resize.callback!(frame! as unknown as HTMLElement,width,dpr),
  };
}

describe('main.ts 지도 연결', () => {
  it('첫 측정값으로 그리고 전체 다시 그리기에도 측정 폭과 dpr을 기억한다', async () => {
    const ui = await start();
    const map = await import('./map');
    const { loadScenario } = await import('../content/scenario');
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const measurement = {availableWidth:543,dpr:1.25};
    const plan = map.worldMapViewport(config,'route',measurement);
    ui.measure(543,1.25);
    const size = `width="${plan.cssWidth}" height="${plan.cssHeight}"`;
    expect(ui.frame().innerHTML).toContain(size);
    expect(ui.frame().dataset.measured).toBe('true');
    ui.click({action:'select-card',emp:'EMP01'});
    expect(ui.app.innerHTML).toContain(size);
    expect(ui.frame().dataset.measured).toBe('true');
    ui.changeScenario();
    const fallback = map.worldMapViewport(config,'route',{availableWidth:620,dpr:1});
    expect(ui.app.innerHTML).toContain(`width="${fallback.cssWidth}" height="${fallback.cssHeight}"`);
    expect(ui.frame().dataset.measured).toBeUndefined();
  });
  it('저장을 불러오면 측정값 기억을 지우고 기본 크기로 다시 잰다', async () => {
    const ui = await start();
    const map = await import('./map');
    const { loadScenario } = await import('../content/scenario');
    const { createGame, openDay } = await import('../engine/engine');
    const { serializeSave } = await import('../engine/save');
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const saved = serializeSave(openDay(createGame(config),config).state);
    vi.stubGlobal('localStorage',{getItem:() => saved,setItem:() => undefined});
    ui.measure(543,1.25);
    expect(ui.frame().dataset.measured).toBe('true');
    ui.click({action:'load'});
    expect(ui.app.innerHTML).toContain('상태를 불러왔습니다');
    const fallback = map.worldMapViewport(config,'route',{availableWidth:620,dpr:1});
    expect(ui.app.innerHTML).toContain(`width="${fallback.cssWidth}" height="${fallback.cssHeight}"`);
    expect(ui.frame().dataset.measured).toBeUndefined();
  });
  it('파일을 가져와도 측정 기억과 세계지도 스크롤을 초기화한다', async () => {
    const ui = await start();
    const map = await import('./map');
    const { loadScenario } = await import('../content/scenario');
    const { createGame, openDay } = await import('../engine/engine');
    const { serializeSave } = await import('../engine/save');
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    ui.click({action:'map-mode',mode:'world'});
    ui.measure(543,1.25); ui.frame().scrollLeft = 321;
    ui.click({action:'select-card',emp:'EMP01'});
    expect(ui.frame().scrollLeft).toBeCloseTo(321,10);
    await ui.importText(serializeSave(openDay(createGame(config),config).state));
    const fallback = map.worldMapViewport(config,'world',{availableWidth:620,dpr:1});
    expect(ui.app.innerHTML).toContain(`width="${fallback.cssWidth}" height="${fallback.cssHeight}"`);
    expect(ui.frame().dataset.measured).toBeUndefined();
    ui.measure(930,1);
    expect(ui.frame().scrollLeft).toBe(535);
  });
  it.each(['load','scenario'])('%s도 다시 그리기에 기억한 세계지도 비율을 초기화한다',async(mode)=>{
    const ui=await start();
    const {loadScenario}=await import('../content/scenario');
    const {createGame,openDay}=await import('../engine/engine');
    const {serializeSave}=await import('../engine/save');
    const config=loadScenario('SCENARIO_M2_MULTI_TRADE');
    vi.stubGlobal('localStorage',{getItem:()=>serializeSave(openDay(createGame(config),config).state)});
    ui.click({action:'map-mode',mode:'world'});ui.measure(930,1);
    ui.frame().scrollLeft=321;ui.click({action:'select-card',emp:'EMP01'});
    expect(ui.frame().scrollLeft).toBeCloseTo(321,10);
    if(mode==='load')ui.click({action:'load'});else ui.changeScenario();
    expect(ui.frame().dataset.measured).toBeUndefined();
    ui.measure(930,1);expect(ui.frame().scrollLeft).toBe(535);
  });
  it('측정 전 스크롤은 버리고 측정 후 비율은 다시 그리기에 복원한다', async () => {
    const ui = await start();
    ui.click({action:'map-mode',mode:'world'});
    ui.frame().scrollLeft = 17;
    ui.measure(930,1);
    expect(ui.frame().scrollLeft).toBe(535);
    ui.frame().scrollLeft = 321;
    ui.click({action:'select-card',emp:'EMP01'});
    expect(ui.frame().scrollLeft).toBeCloseTo(321,10);
  });
  it('경로 모드에서 세계 자산이 선택되면 세계지도 속성과 안내·스크롤을 쓴다', async () => {
    const ui = await start(true);
    expect(ui.app.innerHTML).toContain('data-map-frame tabindex="0" role="region"');
    expect(ui.app.innerHTML).toContain('class="map-frame is-world"');
    expect(ui.app.innerHTML).toContain('화살표 키를 눌러 보세요.');
    expect(ui.app.innerHTML).toContain('class="layout map-wide"');
    ui.measure(930,1);
    expect(ui.frame().scrollLeft).toBe(535);
  });
  it('빈 띠가 넓던 폭(315.51·dpr 2)을 재면 한 배율 위 계획으로 다시 그리고, 시나리오를 바꾸면 측정 전 기본 계획으로 돌아간다', async () => {
    const ui = await start();
    const before = ui.app.innerHTML;
    expect(before).toContain('width="620" height="490"');
    expect(before).toContain('data-map-viewport="2:620:490:116:134"');
    ui.measure(315.51, 2);
    expect(ui.frame().innerHTML).toContain('width="315" height="245"');
    expect(ui.frame().innerHTML).toContain('data-map-viewport="2:630:490:110:134"');
    expect(ui.frame().dataset.viewportKey).toBe('2:630:490:110:134:2');
    ui.click({action:'map-mode',mode:'route'});
    expect(ui.app.innerHTML).toContain('width="315" height="245"');
    expect(ui.frame().dataset.measured).toBe('true');
    ui.changeScenario();
    expect(ui.app.innerHTML).toContain('width="620" height="490"');
    expect(ui.frame().dataset.measured).toBeUndefined();
  });
  it('초점 그림자는 끄고 테두리와 가운데 여백 규칙을 유지한다', async () => {
    const { readFileSync } = await vi.importActual<{readFileSync: (path: URL, encoding: string) => string}>('node:fs');
    const css = readFileSync(new URL('./style.css',import.meta.url),'utf8');
    const focus = css.match(/\.map-frame:focus-visible\s*\{([^}]+)\}/)![1]!;
    expect(focus).toMatch(/box-shadow:\s*none\s*;/);
    expect(focus).toMatch(/outline:\s*3px solid/);
    expect(css).toMatch(/\.map-frame > \.sea-map[^}]+margin-inline:\s*auto/);
  });
});
