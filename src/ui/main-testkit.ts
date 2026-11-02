// 실제 main 모듈의 연결을 시험하는 최소 DOM. 버튼 속성과 초점 선택자를 렌더 결과에서 읽는다.
import { vi } from 'vitest';
import type { ScenarioConfig } from '../engine/types';

export const SITUATION_BUTTON = '\n      <button data-action="situation" aria-haspopup="dialog">상황실</button>';

const unescape = (text: string) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export async function startUi(config?: ScenarioConfig) {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('confirm', vi.fn(() => true));
  const scrollBy = vi.fn();
  const windowListeners: Record<string, (ev: any) => unknown> = {};
  const documentListeners: Record<string, (ev: any) => unknown> = {};
  // 한 열 여부(style.css의 max-width: 1000px). 시작은 세 열. setOneColumn이 change 사건을 보낸다.
  let oneColumn = false; const mediaListeners: ((ev: any) => void)[] = []; const mediaQueries: string[] = [];
  const win = { innerHeight: 800, scrollBy, scrollX: 0, scrollY: 0,
    scrollTo: vi.fn((x:number,y:number)=>{win.scrollX=x;win.scrollY=y;}),
    addEventListener:(name:string,callback:(ev:any)=>unknown)=>{windowListeners[name]=callback;},
    requestAnimationFrame:(cb:FrameRequestCallback)=>setTimeout(()=>cb(0),16),
    matchMedia:(query:string)=>{mediaQueries.push(query);return {media:query,get matches(){return oneColumn;},
      addEventListener:(name:string,callback:(ev:any)=>void)=>{if(name==='change')mediaListeners.push(callback);},removeEventListener:()=>undefined};},
  };
  vi.stubGlobal('window', win);
  const announcements: string[] = [];
  const liveStatus = { get textContent() { return announcements.at(-1) ?? ''; },
    set textContent(value:string) { announcements.push(value); } };
  let statusbarHeight = 100;
  let resizeStatus: (() => void) | undefined;
  const bounds: Record<string,{top:number;bottom:number;height:number;left?:number;right?:number;width?:number}> = {};
  // 배정·예약 칸의 화면 위치. 다시 그린 뒤 위치는 afterRender에서 바꾼다.
  const slotTops: Record<string,number> = {};
  const slotRect = (slot:string) => { const top=slotTops[slot] ?? 180; return {top,bottom:top+88,height:88,width:260}; };
  let toastTop = 700;
  let afterRender: (() => void) | undefined;
  vi.stubGlobal('ResizeObserver', class { constructor(callback:()=>void) { resizeStatus=callback; } observe() {} disconnect() {} });
  const content = await import('../content/scenario');
  if (config) {
    const original = content.loadScenario;
    vi.spyOn(content, 'loadScenario').mockImplementation((id) => id === config.id ? config : original(id));
  }
  let measureCallback: ((frame: HTMLElement, width: number, dpr: number) => void) | undefined;
  const pixel = await import('./pixel');
  vi.spyOn(pixel, 'applyPixelScale').mockImplementation((_root, callback) => { measureCallback = callback; return () => undefined; });
  class Button { disabled = false; }
  class Input { dataset = { action:'import' }; files: {text:()=>Promise<string>}[] = []; }
  vi.stubGlobal('HTMLButtonElement', Button); vi.stubGlobal('HTMLInputElement', Input);
  const listeners: Record<string, (ev: any) => unknown> = {};
  let html = '';
  const focus = vi.fn();
  const scroll = vi.fn();
  const scrollIds: string[] = [];
  const rect = () => ({top:200,bottom:240,height:40});
  const focusIds: string[] = [];
  const closestSelectors: string[] = [];
  const doc = { title:'', documentElement:{style:{setProperty:vi.fn()}}, activeElement:null as any, querySelector:()=>app,
    addEventListener:(name:string,callback:(ev:any)=>unknown)=>{documentListeners[name]=callback;},
    body:{insertAdjacentHTML:vi.fn()},
    createElement:vi.fn(() => ({ href:'', download:'', click:vi.fn() })),
    getElementById:(id:string)=> id==='live-status' ? liveStatus : html.includes(`id="${id}"`) ? {
      id, dataset:{}, getBoundingClientRect:()=>bounds[id] ?? rect(), closest:(selector:string)=>idClosest(id,selector),
      parentElement:id.startsWith('status-') ? {getBoundingClientRect:()=>slotRect(id.slice(7))} : null,
      querySelector:()=>null,
      focus:(options?:FocusOptions)=>{focusIds.push(id);focus(options);doc.activeElement={id,dataset:{},closest:(selector:string)=>idClosest(id,selector)};},
      scrollIntoView:(options?:ScrollIntoViewOptions)=>{scrollIds.push(id);scroll(options);},
    } : null };
  // 제목 id가 든 칸. 현지 패널 안 제목, 오른쪽 칸 제목만 흉내 낸다.
  const ID_PANEL: Record<string,string> = { 'crew-h':'crew', 'res-h':'resources', 'queue-h':'queue' };
  const idClosest = (id:string, selector:string) => {
    const selectors=selector.split(',').map((s)=>s.trim());
    if (selectors.includes('#local') && /^(local-h|culture-)/.test(id)) return {};
    const panel = ID_PANEL[id] ?? (/^(growth-h-|candidate-h-|site-h-|interview-h-)/.test(id) ? 'crew' : undefined);
    if (panel && selectors.includes(`.${panel}`)) return {classList:['panel',panel]};
    if (selectors.includes('.layout') && id!=='status-h') return {};
    return null;
  };
  // 오른쪽 칸 요소의 칸 이름. 자원 예약 칸에는 data-action 요소가 없다.
  const PANEL_OF: Record<string,string> = { 'select-card':'crew','crew-filter':'crew','crew-role':'crew','crew-attr':'crew','detail':'crew','train':'crew',
    'scout':'crew','recruit-emp':'crew','recruit-quest':'crew','interview':'crew','hire':'crew','unqueue':'queue','schedule-toggle':'queue' };
  const OUTSIDE_LAYOUT = ['scenario','save','load','export','restart','end-day','queue-jump','skip-to','culture-result'];
  const newFrame = () => ({ dataset:{} as Record<string,string>,innerHTML:'',scrollLeft:0,scrollWidth:2000,clientWidth:930,querySelector:()=>null,
    // 고른 표시를 틀 안으로 옮길 때 틀의 위치를 읽는다.
    getBoundingClientRect:()=>({left:0,right:930,top:0,bottom:600,width:930,height:600}) });
  let frame = newFrame();
  const elements = () => [...html.matchAll(/<(button|article|tr|select|input)\b([^>]*\bdata-action="[^"]*"[^>]*)>/g)].map((match) => {
    const attrs = Object.fromEntries([...match[2]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, unescape(m[2]!)]));
    const dataset = Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_m,c:string)=>c.toUpperCase()),value]));
    const element = Object.assign(match[1] === 'button' ? new Button() : {}, {
      id:attrs.id ?? '', dataset, tagName:match[1]!.toUpperCase(), disabled:/\sdisabled(?:\s|$)/.test(match[2]!), getBoundingClientRect:()=>bounds[attrs.id!] ?? bounds[dataKey(dataset)] ?? rect(),
      focus:(options?:FocusOptions)=>{if(attrs.id)focusIds.push(attrs.id);focus(options);doc.activeElement=element;},
      closest:(selector:string)=>{
        closestSelectors.push(selector);
        const selectors=selector.split(',').map((s)=>s.trim());
        if ((selectors.includes('.statusbar') && dataset.action==='end-day')
          || (selectors.includes('.flash-toast') && dataset.action==='culture-result')
          || (selectors.includes('.skip-links') && dataset.action==='skip-to')
          || (selectors.includes('.statusbar') && dataset.action==='queue-jump')) return element;
        const panel=PANEL_OF[dataset.action!];
        if (panel && selectors.includes(`.${panel}`)) return {classList:['panel',panel]};
        if (selectors.includes('.layout')) return OUTSIDE_LAYOUT.includes(dataset.action!) ? null : {};
        // Esc 칸: 현지 패널 안 단추, 연 단추, 상세·면담 안 실행 단추.
        if (selectors.includes('#local') && dataset.action!.startsWith('culture-') && !['culture-tab','culture-result'].includes(dataset.action!)) return {};
        if (selectors.includes('#local-tab') && dataset.action==='culture-tab') return element;
        if (selectors.includes('[data-action="culture-book"]') && dataset.action==='culture-book') return element;
        if (dataset.action==='train' && selectors.includes(`#growth-${dataset.emp}`)) return {};
        if (dataset.action==='detail' && selectors.includes(`[data-action="detail"][data-emp="${dataset.emp}"]`)) return element;
        if (dataset.action==='hire' && selectors.includes(`#interview-${dataset.candidate}`)) return {};
        if (dataset.action==='interview' && selectors.includes(`[data-action="interview"][data-candidate="${dataset.candidate}"]`)) return element;
        if(selectors.includes('[data-action]')) return element;
        if(selectors.includes('[data-action-slot]')) {
          const slot=dataset.action==='assign' ? `assign-${dataset.task}` : dataset.action==='book' ? `book-${dataset.contract}`
            : dataset.action==='culture-queue' ? `culture-${dataset.activity}-${dataset.emp}` : dataset.action==='train' ? `train-${dataset.emp}` : '';
          return slot && html.includes(`data-action-slot="${slot}"`) ? {dataset:{actionSlot:slot},getBoundingClientRect:()=>slotRect(slot)} : null;
        }
        if (selectors.includes('.contract') && ['assign','book','cancel'].includes(dataset.action!)) return {querySelector:()=>({id:`contract-h-${dataset.contract ?? 'CT001'}`})};
        const section=dataset.action === 'train' || dataset.action === 'detail' ? '.employee-detail'
          : dataset.action === 'scout' ? '.recruit-site' : '.recruit-candidate';
        const id=section === '.employee-detail' ? `growth-h-${dataset.emp}` : section === '.recruit-site' ? `site-h-${dataset.venue}` : `candidate-h-${dataset.candidate}`;
        return selectors.includes(section) && html.includes(`id="${id}"`) ? {querySelector:()=>({id})} : null;
      },
    });
    return element;
  });
  // id가 없는 요소의 위치 열쇠: '동작:첫째 값', 예 'train:<직원 ID>'.
  const dataKey = (dataset:Record<string,string>) => `${dataset.action}:${Object.entries(dataset).filter(([k])=>k!=='action')[0]?.[1] ?? ''}`;
  // 오른쪽 칸 읽던 자리 후보 흉내: bounds에 위치를 준 후보만 화면 안이고, 나머지는 막대 위(위 −100)에 있다.
  const sideAnchors = () => [
    ...Object.entries(ID_PANEL).filter(([id])=>html.includes(`id="${id}"`)).map(([id,panel])=>({ id, tagName:'H2', dataset:{} as Record<string,string>, textContent:'', key:id, panel })),
    ...elements().filter((e)=>e.tagName==='ARTICLE' || e.tagName==='TR').map((e)=>({ id:'', tagName:e.tagName, dataset:e.dataset, textContent:'', key:`${e.tagName}:${e.dataset.emp}`, panel:'crew' })),
  ].map((a)=>({ ...a, getBoundingClientRect:()=>bounds[a.key] ?? {top:-100,bottom:-60,height:40}, closest:(selector:string)=>selector.split(',').map((s)=>s.trim()).includes(`.${a.panel}`) ? {classList:['panel',a.panel]} : null }));
  const rendered = (dataset:Record<string,string>) => {
    const element=elements().find((e)=>Object.entries(dataset).every(([key,value])=>e.dataset[key]===value));
    if(!element) throw new Error(`렌더된 요소 없음: ${JSON.stringify(dataset)}`);
    return element;
  };
  const app = {
    get innerHTML() { return html; }, set innerHTML(value:string) { html=value; frame=newFrame(); const after=afterRender; afterRender=undefined; after?.(); },
    addEventListener:(name:string,callback:typeof listeners[string])=>{listeners[name]=callback;},
    querySelector:(selector:string)=>/^(\[data-action="[^"]+"\])(\[data-[a-z-]+="[^"]*"\])*$/.test(selector) && selector!=='[data-action="detail"]' && selector!=='[data-action="end-day"]' && selector!=='[data-action="culture-result"]' ? (()=>{const d=Object.fromEntries([...selector.matchAll(/\[data-([a-z-]+)="([^"]*)"\]/g)].map((m)=>[m[1]!.replace(/-([a-z])/g,(_x,c:string)=>c.toUpperCase()),m[2]!]));return elements().find((e)=>Object.entries(d).every(([k,v])=>e.dataset[k]===v)) ?? null;})()
      : /^#growth-[^ ]+ \.training h4$/.test(selector) ? (html.includes(`id="${selector.slice(1).split(' ')[0]}"`) ? {getBoundingClientRect:()=>bounds[`training-h-${selector.slice(8).split(' ')[0]}`] ?? rect()} : null)
      : selector==='.trade' ? (bounds.trade ? {getBoundingClientRect:()=>bounds.trade} : null) : selector==='.flash-toast' ? (html.includes('class="flash-toast') ? {getBoundingClientRect:()=>({top:toastTop,bottom:792,height:792-toastTop})} : null) : selector==='.statusbar' ? {getBoundingClientRect:()=>({top:0,bottom:statusbarHeight,height:statusbarHeight})} : selector === '[data-action="detail"]' && html.includes('data-action="detail"') ? Object.assign(rendered({action:'detail'}),{scrollIntoView:scroll}) : selector === '[data-action="end-day"]' ? rendered({action:'end-day'}) : selector==='[data-map-frame]' || (selector === '.map-frame.is-world' && html.includes('class="map-frame is-world"')) ? frame : null,
    querySelectorAll:(selector:string)=>selector==='[data-map-frame] [data-mark-dot]' ? [...html.matchAll(/data-mark="([^"]+)"/g)].map((m)=>({getBoundingClientRect:()=>bounds[`mark:${m[1]}`] ?? {left:-1000,right:-990,top:-1000,bottom:-990,width:10,height:10},closest:()=>({dataset:{mark:m[1]}})}))
      : selector.startsWith('.crew h2,') ? sideAnchors() : selector==='[data-action-slot]' ? [...html.matchAll(/data-action-slot="([^"]+)"/g)].map((m)=>({dataset:{actionSlot:m[1]},getBoundingClientRect:()=>slotRect(m[1]!)}))
      // 계약 카드 위치는 제목 위치를 따른다.
      : selector==='.contract' ? [...html.matchAll(/id="(contract-h-[^"]+)"/g)].map((m)=>({getBoundingClientRect:()=>{const h=bounds[m[1]!] ?? rect();return {top:h.top-10,bottom:h.top+290,height:300};},querySelector:(q:string)=>q==='h3[id]' ? doc.getElementById(m[1]!) : null}))
      : elements(),
  };
  vi.stubGlobal('document',doc);
  await import('./main');
  const clickNow = (dataset:Record<string,string>,detail=0,fromChild=false) => {
    const element=rendered(dataset);
    return listeners.click!({detail,target:fromChild ? {closest:(selector:string)=>element.closest(selector)} : element});
  };
  return { app, doc, win, announcements,
    fireDoc:(name:string,ev:any)=>documentListeners[name]!(ev),
    fireWindow:(name:string,ev:any)=>windowListeners[name]!(ev),
    keydown:(target:unknown,key:string)=>listeners.keydown!({key,target,preventDefault:vi.fn()}),
    focus, focusIds, scroll, scrollIds, closestSelectors, rendered, frame:()=>frame, scrollBy, slotTops,
    setToastTop:(top:number)=>{toastTop=top;},
    // 다음 한 번의 다시 그리기 직후에 실행한다. 내용이 늘거나 준 상황을 흉내 낸다.
    afterRender:(callback:()=>void)=>{afterRender=callback;},
    // 기존 흐름 시험은 사람이 화면을 읽고 다음 버튼을 누르는 간격을 둔다.
    // 두 번 누름 시험은 clickNow와 가짜 타이머를 직접 쓴다.
    click:(dataset:Record<string,string>,fromChild=false)=>{vi.advanceTimersByTime(501);return clickNow(dataset,0,fromChild);},
    clickNow, bounds,
    // 이미 다시 그려져 사라진 단추를 누르는 경우를 흉내 낸다(Claude 검수).
    clickTarget:(target:unknown,detail=0)=>listeners.click!({detail,target}),
    // 지도 틀 안의 점을 누른다. label이 있으면 그 표시의 이름표를 누른다.
    tapMap:(x:number,y:number,label?:string)=>{vi.advanceTimersByTime(501);return listeners.click!({detail:1,clientX:x,clientY:y,target:{closest:(selector:string)=>selector==='[data-action]' ? null : selector==='[data-map-frame]' ? {} : selector==='.ribbon, .gate-label' && label ? {closest:()=>({dataset:{mark:label}})} : null}});},
    resizeStatusbar:(height:number)=>{statusbarHeight=height;resizeStatus!();},
    changeTarget:(target:unknown)=>listeners.change!({target}),
    change:(dataset:Record<string,string>,value:string)=>listeners.change!({target:{...rendered(dataset),value}}),
    importText:async(text:string)=>{const input=new Input(); input.files=[{text:async()=>text}]; await listeners.change!({target:input});},
    focusTrain:(emp:string)=>{ doc.activeElement=rendered({action:'train',emp}); },
    measure:(width:number,dpr:number)=>measureCallback!(frame as unknown as HTMLElement,width,dpr),
    // app에 단 수신기(pointerdown·wheel·touchstart·focusin)를 부른다.
    fireApp:(name:string,ev:any)=>listeners[name]!(ev),
    mediaQueries,
    setOneColumn:(on:boolean)=>{oneColumn=on;mediaListeners.forEach((callback)=>callback({matches:on}));},
  };
}

/** 기존 화면 시험은 지연 화면을 미리 받은 상태에서 동기 조작을 검증한다. */
export async function screensReady() {
  const culture = await import('./culture');
  await culture.culturePanelScreen.ensure();
  if (typeof document === 'undefined') { await import('./ops-screens'); return; }
  const main = await import('./main');
  await Promise.all([main.ensureOpsScreens(), main.ensureCulturePanel()]);
}
