import { payrollRunwayDay } from '../engine/previews';
import { payrollRunwayKo } from './growth';
import { listSailings, routeBetween, unitKo } from '../engine/catalog';
import { workloadSummary } from '../engine/capacity';
import { isAvailableFromToday } from '../engine/employees';
import { formatMoney } from '../engine/money';
import { campaignSummary, companyReport, onTimeDeliveryRate, tradePairs, upcomingPayments } from '../engine/reports';
import { fundsPosition } from '../engine/reservations';
import type { Command, Contract, GameState } from '../engine/types';
import { attributeKo, roleKo, taskName } from './card';
import { crewEntries, crewFacetOptions } from './recruitment';
import { bottlenecks, cargoListKo, heldCargoByGood, rateKo, settlementRows, upcomingSummary, workloadLinesKo } from './reports';
import { contractProgress } from '../engine/progress';
import { afterEach, describe, expect, it, vi } from 'vitest';
import legacySave from '../engine/fixtures/save-v4-m2.json';
import { assumptionNotes, loadScenario } from '../content/scenario';
import { createGame, openDay, planState } from '../engine/engine';
import { serializeSave } from '../engine/save';
import { acceptAllFeasible, runToCampaignEnd, runDays, standardDayOneCommands } from '../engine/testkit';
import { esc } from './html';
import { startUi } from './main-testkit';

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const readySave = (cfg=config) => serializeSave(openDay(runDays(createGame(cfg),cfg,3,{
  1:[{id:'S',type:'SCOUT_SITE',venueId:'VEN_PORT',employeeId:'EMP02'}],
  2:[{id:'Q',type:'START_RECRUIT_QUEST',candidateId:'EMP04',employeeId:'EMP01'}],
}).state,cfg).state);
const selectOptions = (html:string,key:string) => html.split(`<select data-action="plan-emp" data-key="${key}">`)[1]!.split('</select>')[0]!;
const growthNotice = (html:string) => html.match(/<div class="growth-notices"([^>]*)>([\s\S]*?)<\/div>/);
const crewNote = (html:string) => html.match(/<p class="muted small">((?:레벨·능력은|처리량은 고정값)[\s\S]*?)<\/p>/)?.[1] ?? '';
const employeeSection = (html:string) => html.split('<section class="employee-detail"')[1]!.split('</section>')[0]!;

describe('TASK-0015 평택 본사 화면', () => {
  it('본사·문화 탭·영입 제목을 평택으로 표시한다', async () => {
    expect(config.homeCityId).toBe('PYEONGTAEK');
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    expect(ui.app.innerHTML).toContain('평택 현지');
    expect(ui.app.innerHTML).toContain('<h3 id="recruit-h">평택 동료 영입</h3>');
  });

  it('이전 판 저장의 거절 이유를 보이고 현재 게임을 보존한다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    ui.click({ action: 'accept-fwd', offer: 'OFFER_FWD_01' });
    let saved = '';
    vi.stubGlobal('localStorage', { setItem: (_key: string, value: string) => { saved = value; } });
    ui.click({ action: 'save' });
    const before = saved;
    await ui.importText(JSON.stringify(legacySave));
    expect(ui.app.innerHTML).toContain('이전 판(부산 본사)의 저장입니다. 이번 판에서는 열 수 없습니다.');
    ui.click({ action: 'save' });
    expect(saved).toBe(before);
    expect(ui.app.innerHTML).toContain('오늘 실행 예정');
  });
});

describe('TASK-0013 실제 화면 표시', () => {
  it('수금일 전날·당일과 도착 전후를 표시한다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    ui.click({ action: 'accept', buy: 'OFFER_BUY_02', sell: 'OFFER_SELL_02' });
    ui.click({ action: 'assign', emp: 'EMP01' });
    ui.click({ action: 'book', contract: 'CT001', sailing: 'ROUTE02-D002' });
    for (let day = 1; day < 6; day++) ui.click({ action: 'end-day' });
    expect(ui.app.innerHTML).toContain('<dt>운송</dt><dd>SH001 · 2일 출항 · 도착 6일 예정</dd>');
    ui.click({ action: 'end-day' });
    expect(ui.app.innerHTML).toContain('<dt>운송</dt><dd>SH001 · 2일 출항 · 도착 6일</dd>');
    for (let day = 7; day < 11; day++) ui.click({ action: 'end-day' });
    expect(ui.app.innerHTML).toContain('<b>11일</b>');
    expect(ui.app.innerHTML).toContain('12일 수금 대기');
    expect(ui.app.innerHTML).toContain('인도는 끝났고 12일에 2,500.00 USD를 받습니다. 그때까지 현금은 들어오지 않습니다.');
    ui.click({ action: 'end-day' });
    expect(ui.app.innerHTML).toContain('<b>12일</b>');
    expect(ui.app.innerHTML).toContain('오늘 수금 예정 — 하루 진행 때 받습니다');
    expect(ui.app.innerHTML).toContain('인도는 끝났고 오늘 하루 진행 때 2,500.00 USD를 받습니다.');
    expect(ui.app.innerHTML).not.toContain('12일 수금 대기');
    ui.click({ action: 'end-day' });
    expect(ui.app.innerHTML).toContain('CT001 대금 2,500.00 USD 수금. 계약 종결');
  });

  it('금액 기준 안내는 위쪽 막대에 한 번 나오고 오늘 대기 명령을 금액에 반영하지 않는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    const header = () => ui.app.innerHTML.match(/<header class="topbar">([\s\S]*?)<\/header>/)![1]!;
    const original = header();
    // 막대의 ‘오늘 할 일 N건’ 단추는 대기 명령 수를 센다. 금액 칸만 비교한다(TASK-0024).
    const stats = () => [...header().matchAll(/<div class="stat">[\s\S]*?<\/div>/g)].map((m) => m[0]).join('');
    const originalStats = stats();
    const queue = () => ui.app.innerHTML.split('<section class="panel queue"')[1]!.split('</section>')[0]!;
    const note = '위쪽 막대의 금액은 확정 기준입니다. 여기 넣은 일은 하루 진행 뒤에 반영됩니다.';
    expect(original).toContain('<small class="amount-basis">금액은 확정 기준</small>');
    expect(queue()).not.toContain(note);
    ui.click({ action: 'accept', buy: 'OFFER_BUY_02', sell: 'OFFER_SELL_02' });
    expect(stats()).toBe(originalStats);
    expect(queue()).toContain(note);
    expect(ui.app.innerHTML.match(/금액은 확정 기준/g)).toHaveLength(2);
    const resources = ui.app.innerHTML.split('<section class="panel resources"')[1]!.split('</section>')[0]!;
    expect(header()).toContain('<b>3,000.00 USD</b>');
    // 위쪽 막대(확정)와 이름으로도 구분한다.
    expect(resources).toContain('<th>현금 (오늘 할 일 실행 뒤)</th><td>1,000.00 USD</td>');
    expect(resources).toContain('<th>사용 가능 (오늘 할 일 실행 뒤)</th>');
    ui.click({ action: 'end-day' });
    expect(header()).toContain('<b>1,000.00 USD</b>');
    expect(header()).not.toContain('<b>3,000.00 USD</b>');
  });

  it('첫 편의 선복 부족은 계약 안내와 한 번에 확정 미리 보기에 나온다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    ui.click({ action: 'accept-fwd', offer: 'OFFER_FWD_01' });
    ui.click({ action: 'assign', emp: 'EMP01' });
    ui.click({ action: 'book', contract: 'CT001', sailing: 'ROUTE01-D002' });
    const preview = ui.app.innerHTML.match(/<p class="reason">(한 번에 확정할 수 없습니다 — 운송편 예약 불가:[\s\S]*?)<\/p>/)![1]!;
    expect(preview).toContain('견적도 수락하지 않습니다.');
    expect(preview).not.toContain('철회했습니다');
    expect(ui.rendered({ action: 'accept-plan', key: 'OFFER_FWD_02' }).disabled).toBe(true);
    ui.click({ action: 'accept-fwd', offer: 'OFFER_FWD_02' });
    expect(ui.app.innerHTML).toContain('운송편을 예약하지 않았습니다. 2일 편은 선복이 부족합니다. 실을 수 있는 첫 출항은 9일이고 예약 마감은 8일입니다.');
  });

  it('발견·의뢰 중 후보는 일급과 설정 일수의 계약금 금액을 보이고 면담에서도 같은 금액이다', async () => {
    const cfg = structuredClone(config); cfg.recruitment!.signingFeeWageDays = 7;
    const ui = await startUi(cfg); await (await import('./main-testkit')).screensReady();
    ui.change({ action: 'recruit-emp', key: 'VEN_PORT' }, 'EMP02');
    ui.click({ action: 'scout', venue: 'VEN_PORT', emp: 'EMP02' });
    ui.click({ action: 'end-day' });
    const candidateParts = () => [
      ui.app.innerHTML.match(/<article class="card [^"]*"[^>]*data-emp="EMP04"[\s\S]*?<\/article>/)![0]!,
      ui.app.innerHTML.match(/<article class="recruit-candidate"><h4 id="candidate-h-EMP04"[\s\S]*?<\/article>/)![0]!,
      ui.app.innerHTML.match(/<tr[^>]*data-emp="EMP04"[\s\S]*?<\/tr>/)![0]!,
    ];
    for (const stage of ['발견', '의뢰 진행 중']) {
      const parts = candidateParts();
      expect(parts[0]).toContain(stage);
      for (const part of parts) expect(part).toContain('110,000원');
      for (const card of parts.slice(0, 2)) {
        expect(card).toContain('고용하면 계약금 770,000원(일급 110,000원 × 7일)을 한 번 냅니다. 고용 여부는 면담 뒤에 정합니다.');
      }
      if (stage === '발견') ui.click({ action: 'recruit-quest', candidate: 'EMP04', emp: 'EMP01' });
    }
    ui.click({ action: 'end-day' }); ui.click({ action: 'end-day' });
    ui.click({ action: 'interview', candidate: 'EMP04' });
    const interview = candidateParts()[1]!;
    expect(interview).toContain('<dt>계약금 (일급×7)</dt><dd>770,000원</dd>');
    expect(interview).toContain('<dt>일급</dt><dd>110,000원</dd>');
    expect(interview).not.toContain('고용 여부는 면담 뒤에 정합니다.');
  });
});

describe('항만 대기 실제 화면 연결',()=>{
  const mapSummary=(html:string)=>html.match(/<h2 id="world-h">세계지도 <small>(.*?)<\/small>/)![1]!;
  const ship=(html:string)=>html.match(/<g class="ship [^"]*"[^>]*><title>(.*?)<\/title>/)![0]!;

  it('M2 6일 화면·지도 요약·선박은 하역 중단 대기를 표시하지 않는다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    ui.click({action:'accept',buy:'OFFER_BUY_02',sell:'OFFER_SELL_02'});
    ui.click({action:'assign',emp:'EMP01'});
    ui.click({action:'book',contract:'CT001',sailing:'ROUTE02-D002'});
    for(let day=1;day<6;day++)ui.click({action:'end-day'});
    const html=ui.app.innerHTML;
    expect(html).toContain('<b>6일</b>');
    expect(mapSummary(html)).toBe('운항 중 화물 1건');
    expect(mapSummary(html)).not.toContain('대기');
    expect(ship(html)).toContain('ROUTE02-D002: SH001');
    expect(ship(html)).not.toMatch(/waiting|하역 중단/);
    expect(html).not.toContain('하역 중단');
    expect(html).toContain('오늘 도착 예정 — 하루 진행 때 하역합니다');
  });

  it('M1 7·8일에는 화면·지도 요약·선박에 대기를 표시하고 9일에는 해제한다',async()=>{
    const cfg=loadScenario('SCENARIO_M1_DELAY_ACCEPTED');
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    await ui.importText(serializeSave(openDay(runDays(createGame(cfg),cfg,6,{1:standardDayOneCommands(cfg)}).state,cfg).state));
    for(const day of [7,8]) {
      const html=ui.app.innerHTML;
      expect(html).toContain('<b>'+day+'일</b>');
      expect(mapSummary(html)).toBe('운항 중 화물 1건 · 대기 1건 (하역 재개를 기다림)');
      expect(ship(html)).toContain('class="ship waiting"');
      expect(ship(html)).toContain('하역 중단으로 대기 중');
      expect(html).toContain(`바다에서 대기 중입니다 (${day-7}일째)`);
      ui.click({action:'end-day'});
    }
    expect(mapSummary(ui.app.innerHTML)).toBe('운항 중 화물 1건');
    expect(ship(ui.app.innerHTML)).not.toMatch(/waiting|하역 중단/);
    expect(ui.app.innerHTML).toContain('하역 재개 — 오늘 도착 예정 (대기 2일)');
    expect(ui.app.innerHTML).not.toContain('바다에서 대기 중입니다');
  });
});

describe('A 실제 화면 연결',()=>{
  it('빈 동료 목록 안내는 격자의 모든 열을 차지한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'crew-filter',filter:'busy'});
    expect(ui.app.innerHTML).toContain('<div class="crew-cards"><p class="muted small">이 조건의 동료가 없습니다.</p></div>');
    const { readFileSync }=await vi.importActual<{readFileSync:(path:URL,encoding:string)=>string}>('node:fs');
    const css=readFileSync(new URL('./style.css',import.meta.url),'utf8');
    expect(css).toMatch(/\.crew-cards > p\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*\}/);
  });
  it.each([['ROUTE01','OFFER_BUY_01','OFFER_SELL_01','150.00'],['ROUTE02','OFFER_BUY_02','OFFER_SELL_02','130.00']])('%s 예약 계약의 실제 취소 안내는 엔진 환급액이다',async(route,buy,sell,refund)=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    ui.click({action:'accept',buy,sell});ui.click({action:'assign',emp:'EMP01'});
    expect(ui.app.innerHTML).toContain('<dt>담당</dt><dd>귀솔</dd>');
    expect(ui.app.innerHTML).not.toContain('EMP01)');
    ui.click({action:'book',contract:'CT001',sailing:`${route}-D002`});
    const line=ui.app.innerHTML.match(/<p[^>]*>취소하면: ([\s\S]*?)<\/p>/)![1];
    expect(line).toContain(`운임 ${refund} USD 환급·취소비 50.00 USD`);
  });
  it('운영 장부의 여덟 행은 실제 화면에서 지정 순서로 나온다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    const table=ui.app.innerHTML.split('<caption>운영 장부 · KRW</caption>')[1]!.split('</table>')[0]!;
    expect([...table.matchAll(/<th>(.*?)<\/th>/g)].map((m)=>m[1])).toEqual(['시작 운영 자금','급여','영입 계약금','훈련비','현지 활동비','운영 손익','미지급 급여','현금']);
    expect(table).toContain('<td colspan="2" class="muted small">급여는 원화로 매일 지급하며 계약금·훈련비·현지 활동비는 한 번 내는 원화 비용입니다. USD 거래 장부와 합산하지 않습니다. 가상 환율 1,300원/달러는 보고에 쓰지 않습니다.</td>');
  });
  it.each(['restart','scenario'])('%s 뒤 지난 게임의 flash 알림을 비운다',async(mode)=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'scout',venue:'VEN_PORT'});
    expect(ui.app.innerHTML).toContain('<div class="flash-toast flash info">오늘 할 일에 넣었습니다.');
    expect(ui.announcements.at(-1)).toContain('오늘 할 일에 넣었습니다.');
    if(mode==='restart')ui.click({action:'restart'});
    else await ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');
    expect(ui.app.innerHTML).not.toContain('class="flash');
    expect(ui.app.innerHTML).not.toContain('오늘 할 일에 넣었습니다.');
  });
  it('조사·의뢰가 진행 중일 때 일정·계획·배정의 표시와 접근 이름에는 내부 ID가 없다',async()=>{
    const discovered=openDay(runDays(createGame(config),config,1,{1:[
      {id:'A',type:'ACCEPT_FORWARDING',offerId:'OFFER_FWD_01'},
      {id:'B',type:'ASSIGN_TASK',taskId:'TASK001',employeeId:'EMP01'},
      {id:'C',type:'BOOK_SAILING',contractId:'CT001',sailingId:'ROUTE01-D002'},
      {id:'D',type:'CANCEL_CONTRACT',contractId:'CT001'},
      {id:'S',type:'SCOUT_SITE',venueId:'VEN_PORT',employeeId:'EMP02'},
    ]}).state,config).state;
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await ui.importText(serializeSave(discovered));
    ui.click({action:'recruit-quest',candidate:'EMP04',emp:'EMP01'});
    ui.click({action:'scout',emp:'EMP02'});
    ui.click({action:'accept',buy:'OFFER_BUY_01',sell:'OFFER_SELL_01'});
    ui.click({action:'book',contract:'CT002',sailing:'ROUTE01-D009'});
    const html=ui.app.innerHTML;
    expect(html).toContain('영입 의뢰 중 — 현돌');expect(html).toContain('현장 조사 중');
    const parts=[html.match(/<ul class="crew-time">([\s\S]*?)<\/ul>/)![1]!,selectOptions(html,'OFFER_FWD_02'),
      ...[...html.matchAll(/<button[^>]*data-action="assign"[^>]*>[\s\S]*?<\/button>/g)].map((m)=>m[0])];
    expect(parts).toHaveLength(4);
    for(const part of parts) {
      const visible=part.replace(/<[^>]*>/g,'');
      expect(visible).not.toMatch(/EMP\d+|VEN_|RECRUIT-|SCOUT-/);
      for(const attribute of part.matchAll(/(?:aria-label|title)="([^"]*)"/g)) expect(attribute[1]).not.toMatch(/EMP\d+|VEN_|RECRUIT-|SCOUT-/);
    }
  });

  it.each(['load','import','restart','scenario'])('%s 성공은 대기·선택·필터·수동 계획을 초기화한다',async(mode)=>{
    const cfg=structuredClone(config);for(const offer of cfg.offers)offer.validUntilDay=90;
    const ready=()=>readySave(cfg);
    const ui=await startUi(cfg); await (await import('./main-testkit')).screensReady();await ui.importText(ready());
    ui.click({action:'culture-tab'});ui.click({action:'culture-book'});
    ui.click({action:'culture-act',activity:'CA01'});ui.click({action:'culture-emp',emp:'EMP02'});
    ui.click({action:'interview',candidate:'EMP04'});
    await ui.change({action:'recruit-emp',key:'VEN_PORT'},'EMP02');
    ui.click({action:'select-card',emp:'EMP02'});ui.click({action:'detail',emp:'EMP02'});
    expect(ui.app.innerHTML).toContain('aria-expanded="true" aria-controls="growth-EMP02"');
    expect(ui.app.innerHTML).toContain('aria-expanded="true" aria-controls="interview-EMP04"');
    ui.click({action:'accept-fwd',offer:'OFFER_FWD_01'});
    ui.click({action:'assign',emp:'EMP01'});
    ui.click({action:'book',contract:'CT001',sailing:'ROUTE01-D009'});
    ui.click({action:'cancel',contract:'CT001'});
    const key='OFFER_BUY_01+OFFER_SELL_01';
    await ui.change({action:'plan-emp',key},'EMP02');
    ui.click({action:'crew-filter',filter:'busy'});
    if(mode==='import') await ui.importText(ready());
    else if(mode==='scenario') await ui.change({action:'scenario'},config.id);
    else if(mode==='restart') ui.click({action:'restart'});
    else {vi.stubGlobal('localStorage',{getItem:ready});ui.click({action:'load'});}
    expect(ui.app.innerHTML).not.toContain('id="local"');
    expect(ui.app.innerHTML).not.toContain('id="culture-preview"');
    expect(ui.app.innerHTML).not.toContain('id="culture-book-body"');
    expect(ui.app.innerHTML).not.toContain('is-selected');
    expect(ui.app.innerHTML).toContain('data-filter="all" aria-pressed="true"');
    expect(ui.app.innerHTML).toContain('대기 중인 명령이 없습니다');
    expect(ui.app.innerHTML).not.toContain('aria-expanded="true" aria-controls="interview-EMP04"');
    expect(ui.app.innerHTML.split('<select data-action="recruit-emp" data-key="VEN_PORT"')[1]!.split('</select>')[0]).toContain('value="EMP01" selected');
    ui.click({action:'select-card',emp:'EMP02'});
    expect(ui.app.innerHTML).toContain('aria-expanded="false" aria-controls="growth-EMP02"');
    if(mode==='restart' || mode==='scenario') {
      ui.click({action:'scout',venue:'VEN_PORT'});ui.click({action:'end-day'});
      ui.click({action:'recruit-quest',candidate:'EMP04'});ui.click({action:'end-day'});ui.click({action:'end-day'});
    }
    expect(ui.app.innerHTML).not.toContain('aria-expanded="true" aria-controls="interview-EMP04"');
    expect(ui.app.innerHTML).toMatch(/id="interview-EMP04"[^>]* hidden/);
    // 기본값이 EMP01이 되는 상황을 다시 만들어 지난 EMP02 수동 선택이 남는지도 검증한다.
    ui.click({action:'accept-fwd',offer:'OFFER_FWD_01'});
    ui.click({action:'assign',emp:'EMP02'});
    ui.click({action:'book',contract:'CT001',sailing:'ROUTE01-D009'});
    expect(selectOptions(ui.app.innerHTML,key)).toContain('value="EMP01" selected');
  });
  it('불러오기 실패는 현재 게임·대기 명령·선택을 유지한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});
    ui.click({action:'accept',buy:'OFFER_BUY_02',sell:'OFFER_SELL_02'});
    ui.click({action:'end-day'});
    ui.click({action:'accept-fwd',offer:'OFFER_FWD_01'});
    const contract=ui.app.innerHTML.match(/<div class="contract [\s\S]*?<\/dl>/)![0];
    await ui.importText('{');
    expect(ui.app.innerHTML).toContain('<b>2일</b>');
    expect(ui.app.innerHTML).toContain(contract);
    expect(ui.app.innerHTML).toContain('is-selected'); expect(ui.app.innerHTML).toContain('오늘 실행 예정');
    expect(ui.app.innerHTML).toContain('JSON 형식 오류');
  });
  it('하루 진행 예외는 실제 화면에서 게임·대기 명령을 보존하고 한국어 알림을 보여 준다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    const engine=await import('../engine/engine');
    const spy=vi.spyOn(engine,'commitDay').mockImplementation(()=>{throw new Error('결산 검증 실패');});
    ui.click({action:'accept',buy:'OFFER_BUY_02',sell:'OFFER_SELL_02'});
    ui.click({action:'end-day'});
    expect(ui.app.innerHTML).toContain('하루 진행에 실패했습니다: 결산 검증 실패');
    expect(ui.app.innerHTML).toContain('<b>1일</b>');
    expect(ui.app.innerHTML).toContain('오늘 실행 예정');
    spy.mockRestore();ui.click({action:'end-day'});
    expect(ui.app.innerHTML).toContain('<b>2일</b>');
  });
  it.each([`공통<&"'문자>`, '<img src=x onerror=alert(1)>'])('저장 렌더링은 이름·계약 번호·공지 %s를 이스케이프한다',async(unsafe)=>{
    const cfg=structuredClone(config);
    for(const emp of cfg.employees) emp.nameKo=unsafe;
    for(const city of cfg.cities) city.nameKo=unsafe;
    for(const good of cfg.goods) good.nameKo=unsafe;
    const s=planState(openDay(createGame(cfg),cfg).state,cfg,standardDayOneCommands(cfg).slice(0,1)).state;
    const old=s.contracts[0]!.id; s.contracts[0]!.id=unsafe;
    for(const t of s.tasks) if(t.contractId===old)t.contractId=unsafe;
    for(const l of s.cargoLots)if(l.contractId===old)l.contractId=unsafe;
    for(const e of s.ledger.entries)if(e.contractId===old)e.contractId=unsafe;
    s.notices.push({id:'SAFE-NOTICE',day:1,titleKo:unsafe,bodyKo:unsafe,evidenceKo:unsafe,kind:'PORT_RESTRICTION',eventInstanceId:'TEST',affectedShipmentIds:[]});
    const ui=await startUi(cfg); await (await import('./main-testkit')).screensReady();
    ui.click({action:'accept-fwd',offer:'OFFER_FWD_01'});
    expect(ui.app.innerHTML).not.toContain(unsafe);expect(ui.app.innerHTML).toContain(`${esc(unsafe)}에게`);
    expect(ui.app.innerHTML).toContain('오늘 실행 예정');
    ui.click({action:'assign',emp:'EMP01'});
    expect(ui.app.innerHTML).not.toContain(unsafe);expect(ui.app.innerHTML).toContain(`<dd>${esc(unsafe)}</dd>`);
    ui.click({action:'book',contract:'CT001',sailing:'ROUTE01-D002'});
    expect(selectOptions(ui.app.innerHTML,'OFFER_BUY_01+OFFER_SELL_01')).toContain(esc(unsafe));
    expect(ui.app.innerHTML).not.toContain(unsafe);
    await ui.importText(serializeSave(s));
    expect(ui.app.innerHTML).toContain('상태를 불러왔습니다');
    expect(ui.app.innerHTML).not.toContain(unsafe);expect(ui.app.innerHTML).toContain(esc(unsafe));
    expect(ui.app.innerHTML).toContain(`<b>${esc(unsafe)}의 보고</b>`);
    expect(ui.app.innerHTML).toContain(`<h3>⚠ ${esc(unsafe)}`);
    expect(ui.app.innerHTML).toContain(`<p>${esc(unsafe)}</p>`);
    expect(ui.app.innerHTML).toContain(`data-contract="${esc(unsafe)}"`);
    const escaped = () => {
      expect(ui.app.innerHTML).not.toContain(unsafe);
      expect(ui.app.innerHTML).toContain(esc(unsafe));
    };
    ui.click({action:'select-card',emp:'EMP02'});escaped();
    ui.click({action:'detail',emp:'EMP02'});escaped();
    expect(ui.app.innerHTML).toContain(`aria-label="${esc(unsafe)} 일반 훈련"`);
    ui.click({action:'train',emp:'EMP02'});escaped();
    expect(ui.app.innerHTML).toContain(`${esc(unsafe)} 일반 훈련<button`);
    expect(ui.app.innerHTML).toContain(`${esc(unsafe)}에게`);
    ui.click({action:'assign',task:'TASK001',emp:'EMP01'});escaped();
    ui.click({action:'book',contract:unsafe,sailing:'ROUTE01-D002'});escaped();
    expect(selectOptions(ui.app.innerHTML,'OFFER_FWD_01')).toContain(esc(unsafe));
    ui.click({action:'cancel',contract:unsafe});escaped();
    ui.click({action:'end-day'});escaped();
    expect(ui.app.innerHTML).toContain(`<p>${esc(unsafe)} +60 경험치</p>`);
    const storage:Record<string,string>={};
    vi.stubGlobal('localStorage',{setItem:(key:string,value:string)=>{storage[key]=value;},getItem:(key:string)=>storage[key]});
    ui.click({action:'save'});ui.click({action:'load'});escaped();
    expect(ui.app.innerHTML).toContain('종결된 계약 1건');
  });
});

describe('B 실제 성장 화면 연결',()=>{
  it('쉬는 직원과 조사 중인 직원은 훈련 빼기·진행 안내를 표시하지 않는다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    const noTrainingNotice=()=>{
      const detail=employeeSection(ui.app.innerHTML);
      expect(detail).not.toContain('빼려면');
      expect(detail).not.toContain('일반 훈련 중');
    };
    noTrainingNotice();
    ui.click({action:'scout',venue:'VEN_PORT',emp:'EMP01'});
    noTrainingNotice();
    expect(employeeSection(ui.app.innerHTML)).toContain('class="reason"');
  });

  it('같은 성장 알림도 진행 전 날짜로 구분하고 대기 목록 뒤에 표시한다',async()=>{
    const cfg=structuredClone(config);cfg.employees[0]!.growth!.startXp=300;
    const ui=await startUi(cfg); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    ui.click({action:'train',emp:'EMP01'});ui.click({action:'end-day'});
    expect(growthNotice(ui.app.innerHTML)?.[2]).toBe('<h3 class="small">1일 하루 진행 — 경험치·레벨 변화</h3><p>귀솔 +60 경험치</p>');
    expect(ui.announcements.at(-1)).toContain(growthNotice(ui.app.innerHTML)![2]!.includes('2일 하루 진행') ? '2일 하루 진행 — 경험치·레벨 변화:' : '1일 하루 진행 — 경험치·레벨 변화:');
    expect(ui.announcements.at(-1)).toContain('+60 경험치');
    const queue=()=>ui.app.innerHTML.split('<section class="panel queue"')[1]!.split('</section>')[0]!;
    expect(queue().indexOf('대기 중인 명령이 없습니다.')).toBeLessThan(queue().indexOf('class="growth-notices"'));
    ui.click({action:'train',emp:'EMP01'});
    expect(queue()).toContain('<ol class="pending">');
    expect(queue().indexOf('</ol>')).toBeLessThan(queue().indexOf('1일 하루 진행 — 경험치·레벨 변화'));
    expect(queue().indexOf('</ol>')).toBeLessThan(queue().indexOf('class="growth-notices"'));
    expect(queue().indexOf('class="flash')).toBeLessThan(queue().indexOf('<ol class="pending">'));
    ui.click({action:'end-day'});
    expect(growthNotice(ui.app.innerHTML)?.[2]).toBe('<h3 class="small">2일 하루 진행 — 경험치·레벨 변화</h3><p>귀솔 +60 경험치</p>');
    expect(ui.announcements.at(-1)).toContain(growthNotice(ui.app.innerHTML)![2]!.includes('2일 하루 진행') ? '2일 하루 진행 — 경험치·레벨 변화:' : '1일 하루 진행 — 경험치·레벨 변화:');
    expect(ui.announcements.at(-1)).toContain('+60 경험치');
  });
  it('하루 진행 예외 뒤 이전 성장 알림은 날짜와 함께 남고 다시 읽지 않는다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    ui.click({action:'train',emp:'EMP01'});ui.click({action:'end-day'});
    const notice=growthNotice(ui.app.innerHTML)![2];
    expect(notice).toContain('1일 하루 진행 — 경험치·레벨 변화');expect(notice).toContain('귀솔 +60 경험치');
    expect(ui.announcements.at(-1)).toContain(growthNotice(ui.app.innerHTML)![2]!.includes('2일 하루 진행') ? '2일 하루 진행 — 경험치·레벨 변화:' : '1일 하루 진행 — 경험치·레벨 변화:');
    expect(ui.announcements.at(-1)).toContain('+60 경험치');
    const engine=await import('../engine/engine');
    vi.spyOn(engine,'commitDay').mockImplementation(()=>{throw new Error('결산 검증 실패');});
    const beforeFailure=ui.announcements.length;
    ui.click({action:'end-day'});
    expect(ui.announcements).toHaveLength(beforeFailure+1);
    expect(ui.app.innerHTML).toContain('하루 진행에 실패했습니다: 결산 검증 실패');
    expect(ui.app.innerHTML).toContain('<b>2일</b>');
    expect(growthNotice(ui.app.innerHTML)?.[2]).toBe(notice);
    expect(growthNotice(ui.app.innerHTML)![1]).not.toMatch(/role="status"|aria-live/);
    expect(ui.announcements.at(-1)).toBe('하루 진행에 실패했습니다: 결산 검증 실패');
    expect(ui.announcements.at(-1)).not.toContain('경험치');
  });
  it('경험치·레벨 변화 없는 다음 하루를 성공적으로 진행하면 이전 성장 알림을 비운다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    ui.click({action:'train',emp:'EMP01'});ui.click({action:'end-day'});
    expect(growthNotice(ui.app.innerHTML)?.[2]).toContain('귀솔 +60 경험치');
    ui.click({action:'end-day'});
    expect(ui.app.innerHTML).toContain('<b>3일</b>');
    expect(ui.app.innerHTML).toContain('경험치 60 / 100');
    expect(ui.app.innerHTML).not.toContain('하루 진행에 실패했습니다');
    expect(growthNotice(ui.app.innerHTML)).toBeNull();
    expect(ui.app.innerHTML).not.toContain('하루 진행 — 경험치·레벨 변화');
  });
  it('오늘 대기 훈련만 빼기를 안내하고 진행 중 3일 훈련의 진행 정도는 한 번만 표시한다',async()=>{
    const cfg=structuredClone(config);cfg.growth!.ordinaryTraining.durationDays=3;
    const ui=await startUi(cfg); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    ui.click({action:'train',emp:'EMP01'});
    for(const progress of [0,1]) {
      const detail=employeeSection(ui.app.innerHTML);
      expect(detail).toContain(`◆ 훈련 중 ${progress}/3일`);
      expect(detail.match(new RegExp(`${progress}/3일`, 'g'))).toHaveLength(1);
      expect(detail).not.toContain('class="reason"');
      if(progress===0) {
        expect(detail).toContain('<p>이미 일반 훈련을 넣었습니다. 빼려면 오늘 할 일에서 ‘빼기’를 누르세요.</p>');
        expect(ui.app.innerHTML).toContain('aria-label="귀솔 일반 훈련 빼기"');
      } else {
        expect(detail).not.toContain('<p>일반 훈련 중 1/3일</p>');
        expect(detail).not.toContain('빼려면');
        expect(ui.app.innerHTML).not.toContain('aria-label="귀솔 일반 훈련 빼기"');
      }
      expect(detail).toContain('<p>레벨·능력이 올라도 하루 처리량은 2pt 그대로입니다. 훈련하는 3일 동안 다른 업무를 맡을 수 없습니다.</p>');
      if(progress===0)ui.click({action:'end-day'});
    }
  });
  it('훈련 대기의 급여 날짜는 이미 반영한 훈련비를 두 번 빼지 않는다',async()=>{
    // 370,000원에서 훈련비를 한 번 빼면 이틀 급여 320,000원, 두 번 빼면 하루분만 남는다.
    const cfg=structuredClone(config);cfg.startingCash.KRW=370_000;
    const ui=await startUi(cfg); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    ui.click({action:'train',emp:'EMP01'});
    const detail=employeeSection(ui.app.innerHTML);
    expect(detail).toContain('훈련비 50,000원 반영됨');
    expect(detail).toContain('<p>원화 급여 지급 가능일: 지금 2일까지</p>');
    expect(detail).not.toContain('훈련하면');
  });
  it('1일과 3pt 동료 고용 후 5일의 상세·직원 각주는 실제 처리량을 표시한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    expect(employeeSection(ui.app.innerHTML)).toContain('<p>레벨·능력이 올라도 하루 처리량은 2pt 그대로입니다. 훈련하는 날은 다른 업무를 맡을 수 없습니다.</p>');
    expect(crewNote(ui.app.innerHTML)).toBe('레벨·능력은 성장 기록으로 보여 주며 아직 처리량(하루 2pt)에는 쓰지 않습니다. 레벨이 올라도 급여·직책은 바뀌지 않습니다. 일급 80,000원.');
    const day5=openDay(runDays(createGame(config),config,4,{
      1:[{id:'S',type:'SCOUT_SITE',venueId:'VEN_PORT',employeeId:'EMP02'}],
      2:[{id:'Q',type:'START_RECRUIT_QUEST',candidateId:'EMP04',employeeId:'EMP01'}],
      4:[{id:'H',type:'HIRE_CANDIDATE',candidateId:'EMP04'}],
    }).state,config).state;
    await ui.importText(serializeSave(day5));
    expect(ui.app.innerHTML).toContain('<b>5일</b>');
    ui.click({action:'select-card',emp:'EMP04'});ui.click({action:'detail',emp:'EMP04'});
    expect(employeeSection(ui.app.innerHTML)).toContain('<p>레벨·능력이 올라도 하루 처리량은 3pt 그대로입니다. 훈련하는 날은 다른 업무를 맡을 수 없습니다.</p>');
    expect(crewNote(ui.app.innerHTML)).toBe('레벨·능력은 성장 기록으로 보여 주며 아직 처리량(하루 2~3pt)에는 쓰지 않습니다. 레벨이 올라도 급여·직책은 바뀌지 않습니다. 일급 80,000원~110,000원.');
  });

  it('조사 중인 직원은 훈련 반영 상태 대신 가정 금액과 엔진 거절 이유를 표시한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'scout',venue:'VEN_PORT',emp:'EMP01'});
    ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    const detail=employeeSection(ui.app.innerHTML);
    expect(detail).not.toContain('반영됨');
    expect(detail).toContain('훈련에 쓸 수 있는 원화: 지금 10,000,000원 → 훈련 뒤 9,950,000원');
    expect(detail).toContain('지금 62일까지 → 훈련하면 62일까지');
    expect(detail).toContain('<p class="reason">귀솔은 다른 업무(항만 물류단지 현장 조사)를 진행 중입니다. 한 사람은 한 번에 업무 하나만 맡습니다.</p>');
    expect(detail.match(/<button[^>]*data-action="train"[^>]*>/)![0]).toContain('disabled');
  });

  it.each([false,true])('꺼진 훈련 버튼 클릭은 아무 일도 하지 않는다 (안쪽 자식: %s)',async(fromChild)=>{
    const cfg=structuredClone(config);cfg.growth!.ordinaryTraining.durationDays=3;
    const ui=await startUi(cfg); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    ui.click({action:'train',emp:'EMP01'},fromChild);ui.click({action:'end-day'});
    expect(ui.rendered({action:'train',emp:'EMP01'}).disabled).toBe(true);
    const before=ui.app.innerHTML;
    ui.click({action:'train',emp:'EMP01'},fromChild);
    expect(ui.app.innerHTML).toBe(before);
  });

  it.each(['load','import','restart','scenario'])('%s 성공은 이전 성장 알림을 비운다',async(mode)=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    ui.click({action:'train',emp:'EMP01'});ui.click({action:'end-day'});
    expect(growthNotice(ui.app.innerHTML)?.[2]).toContain('귀솔 +60 경험치');
    if(mode==='import')await ui.importText(readySave());
    else if(mode==='restart')ui.click({action:'restart'});
    else if(mode==='scenario')await ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');
    else {
      const storage:Record<string,string>={};
      vi.stubGlobal('localStorage',{setItem:(key:string,value:string)=>{storage[key]=value;},getItem:(key:string)=>storage[key]});
      ui.click({action:'save'});ui.click({action:'load'});
    }
    expect(growthNotice(ui.app.innerHTML)).toBeNull();
  });
  it('훈련 버튼 속성·상세 접근 참조는 허용 상태와 거절 상태 모두 유지된다',async()=>{
    const cfg=structuredClone(config);cfg.startingCash.KRW=500_000;
    const ui=await startUi(cfg); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    expect(ui.app.innerHTML).toContain('지금 3일까지 → 훈련하면 2일까지');
    expect(ui.app.innerHTML).toContain('성장 변화는 완료할 때 반영됩니다');
    for(const allowed of [true,false]) {
      const html=ui.app.innerHTML.match(/<div class="growth-detail">[\s\S]*?<\/section>\s*<\/div>/)![0];
      const button=html.match(/<button[^>]*data-action="train"[^>]*>/)?.[0];
      if (!allowed) {
        expect(button).toBeUndefined();
        expect(html).toContain('id="status-train-EMP01" tabindex="-1">일반 훈련 예정');
      } else {
      expect(button).toContain('data-action="train"');expect(button).toContain('data-emp="EMP01"');
      expect(button).toContain('aria-label="귀솔 일반 훈련"');expect(button!.includes('disabled')).toBe(false);
      }
      for(const b of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const visible=b[2]!.replace(/<[^>]*>/g,'').trim();const label=b[1]!.match(/aria-label="([^"]*)"/)?.[1];
        if(label)expect(label).toContain(visible);
      }
      const ids=new Set([...html.matchAll(/\bid="([^"]*)"/g)].map((m)=>m[1]));
      for(const ref of html.matchAll(/aria-(?:labelledby|controls)="([^"]*)"/g)) for(const id of ref[1]!.split(' '))expect(ids.has(id),id).toBe(true);
      if(allowed)ui.click({action:'train',emp:'EMP01'});
    }
    expect(employeeSection(ui.app.innerHTML)).toContain('<p>원화 급여 지급 가능일: 지금 2일까지</p>');
    expect(employeeSection(ui.app.innerHTML)).not.toContain('훈련하면');
  });
  it('영입 버튼의 초점 대안도 실제 선택자 결합과 대상 영역을 따른다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.doc.activeElement=ui.rendered({action:'scout',venue:'VEN_PORT'});
    ui.click({action:'scout',venue:'VEN_PORT'});
    expect(ui.focusIds).toEqual(['site-h-VEN_PORT']);
    expect(ui.closestSelectors).toContain('.employee-detail, .recruit-site, .recruit-candidate');
  });
  it('훈련 대기→완료→레벨 알림→저장 재개를 연결하고 버튼이 꺼지면 상세 제목으로 초점을 옮긴다',async()=>{
    const cfg=structuredClone(config);cfg.employees[0]!.growth!.startXp=90;
    const ui=await startUi(cfg); await (await import('./main-testkit')).screensReady();
    ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    expect(ui.app.innerHTML).toContain('aria-expanded="true" aria-controls="growth-EMP01"');
    ui.focus.mockClear();ui.focusIds.length=0;
    ui.focusTrain('EMP01');ui.click({action:'train',emp:'EMP01'});
    expect(ui.focus).toHaveBeenCalledOnce();expect(ui.focusIds).toEqual(['growth-h-EMP01']);
    expect(ui.app.innerHTML).toContain('◆ 훈련 중 0/1일');
    expect(ui.app.innerHTML).not.toContain('data-action="train"');
    expect(ui.app.innerHTML).toContain('id="status-train-EMP01" tabindex="-1">일반 훈련 예정');
    expect(ui.closestSelectors).toContain('.employee-detail, .recruit-site, .recruit-candidate');
    const detail=ui.app.innerHTML.split('<section class="employee-detail"')[1]!.split('</section>')[0]!;
    expect(detail).not.toContain('훈련 뒤');expect(detail).not.toContain('훈련하면');
    expect(detail).toContain('◆ 훈련 중 0/1일 — 훈련비 50,000원 반영됨. 완료하면 +60 경험치');
    ui.doc.activeElement=null;ui.click({action:'end-day'});
    const status=()=>growthNotice(ui.app.innerHTML)?.[2];
    expect(status()).toBe('<h3 class="small">1일 하루 진행 — 경험치·레벨 변화</h3><p>귀솔 +60 경험치</p><p>귀솔 레벨 2 달성 (교섭 +2, 협업 +1)</p>');
    expect(status()!.match(/\+60 경험치/g)).toHaveLength(1);
    expect(status()!.match(/레벨 2 달성/g)).toHaveLength(1);
    expect(ui.announcements.at(-1)).toContain('귀솔 +60 경험치, 귀솔 레벨 2 달성 (교섭 +2, 협업 +1)');
    const notice=growthNotice(ui.app.innerHTML)![2];
    const beforeSelect=ui.announcements.length;
    ui.click({action:'select-card',emp:'EMP02'});
    expect(ui.announcements).toHaveLength(beforeSelect);
    expect(growthNotice(ui.app.innerHTML)?.[2]).toBe(notice);
    expect(growthNotice(ui.app.innerHTML)![1]).not.toContain('role="status"');
    expect(growthNotice(ui.app.innerHTML)![1]).not.toContain('aria-live');
    const beforeDetail=ui.announcements.length;
    ui.click({action:'detail',emp:'EMP02'});
    expect(ui.announcements).toHaveLength(beforeDetail);
    expect(growthNotice(ui.app.innerHTML)?.[2]).toBe(notice);
    expect(growthNotice(ui.app.innerHTML)![1]).not.toContain('role="status"');
    expect(growthNotice(ui.app.innerHTML)![1]).not.toContain('aria-live');
    ui.click({action:'train',emp:'EMP02'});
    const beforeUnqueue=ui.announcements.length;
    ui.click({action:'unqueue',index:'0'});
    expect(ui.announcements).toHaveLength(beforeUnqueue);
    expect(growthNotice(ui.app.innerHTML)?.[2]).toBe(notice);
    expect(growthNotice(ui.app.innerHTML)![1]).not.toMatch(/role="status"|aria-live/);
    const beforeFilter=ui.announcements.length;
    ui.click({action:'crew-filter',filter:'busy'});
    expect(ui.announcements).toHaveLength(beforeFilter);
    expect(growthNotice(ui.app.innerHTML)?.[2]).toBe(notice);
    expect(growthNotice(ui.app.innerHTML)![1]).not.toMatch(/role="status"|aria-live/);
    ui.click({action:'train',emp:'EMP02'});ui.click({action:'end-day'});
    expect(growthNotice(ui.app.innerHTML)![2]).toBe('<h3 class="small">2일 하루 진행 — 경험치·레벨 변화</h3><p>물보리 +60 경험치</p>');
    expect(ui.announcements.at(-1)).toContain(growthNotice(ui.app.innerHTML)![2]!.includes('2일 하루 진행') ? '2일 하루 진행 — 경험치·레벨 변화:' : '1일 하루 진행 — 경험치·레벨 변화:');
    expect(ui.announcements.at(-1)).toContain('+60 경험치');
    const storage:Record<string,string>={};
    vi.stubGlobal('localStorage',{setItem:(key:string,value:string)=>{storage[key]=value;},getItem:(key:string)=>storage[key]});
    const beforeSave=ui.announcements.length;
    ui.click({action:'save'});expect(ui.announcements).toHaveLength(beforeSave+1);
    expect(ui.announcements.at(-1)).toContain('저장했습니다.');expect(ui.announcements.at(-1)).not.toContain('경험치');
    expect(growthNotice(ui.app.innerHTML)![2]).toBe('<h3 class="small">2일 하루 진행 — 경험치·레벨 변화</h3><p>물보리 +60 경험치</p>');
    const beforeLoad=ui.announcements.length;
    ui.click({action:'load'});expect(ui.announcements).toHaveLength(beforeLoad+1);
    expect(ui.announcements.at(-1)).toContain('불러왔습니다.');expect(ui.announcements.at(-1)).not.toContain('경험치');
    expect(growthNotice(ui.app.innerHTML)).toBeNull();
    expect(ui.app.innerHTML).not.toContain('aria-expanded="true" aria-controls="growth-EMP01"');
    ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    expect(ui.app.innerHTML).toContain('경험치 150 / 300');
    const beforeNextDay=ui.announcements.length;
    ui.click({action:'end-day'});expect(ui.announcements).toHaveLength(beforeNextDay);
    expect(growthNotice(ui.app.innerHTML)).toBeNull();
  });
  it('교육 상태는 자원·계약 배정·계획 선택에도 표시하고 제거하면 훈련 선택도 돌아온다',async()=>{
    const s=openDay(createGame(config),config).state;
    // 단계별 배정·예약 기록만 준비하고 해당 계약은 취소해 현재 직원 시간을 비운다.
    const p=planState(s,config,[{id:'A',type:'ACCEPT_FORWARDING',offerId:'OFFER_FWD_01'},{id:'ASSIGN',type:'ASSIGN_TASK',taskId:'TASK001',employeeId:'EMP02'},{id:'BOOK',type:'BOOK_SAILING',contractId:'CT001',sailingId:'ROUTE01-D002'},{id:'CANCEL',type:'CANCEL_CONTRACT',contractId:'CT001'}]).state;
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await ui.importText(serializeSave(p));
    ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});ui.click({action:'train',emp:'EMP01'});
    const html=ui.app.innerHTML;
    expect(html.match(/<ul class="crew-time">([\s\S]*?)<\/ul>/)![1]).toContain('◆ 훈련 중 0/1일');
    expect(selectOptions(html,'OFFER_BUY_02+OFFER_SELL_02')).toContain('◆ 훈련 중 0/1일');
    ui.click({action:'accept',buy:'OFFER_BUY_02',sell:'OFFER_SELL_02'});
    expect(ui.app.innerHTML.match(/<button[^>]*data-action="assign"[^>]*data-emp="EMP01"[\s\S]*?<\/button>/)![0]).toContain('◆ 훈련 중 0/1일');
    ui.click({action:'unqueue',index:'0'});
    expect(ui.app.innerHTML.match(/<button[^>]*data-action="train"[^>]*>/)![0]).not.toContain('disabled');
  });
  it('M1 전체 화면에는 훈련·경험치가 없다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');ui.click({action:'select-card',emp:'EMP01'});
    expect(ui.app.innerHTML).not.toContain('data-action="train"');expect(ui.app.innerHTML).not.toContain('경험치');
    expect(ui.app.innerHTML).toContain('레벨 1');
    expect(ui.app.innerHTML).toContain('aria-label="귀솔 직원 카드, 영업, 레벨 1, 대기 — 배정 가능"');
    expect(ui.app.innerHTML).not.toContain('주능력');
    expect(ui.app.innerHTML).toContain('업무·훈련 중');
    expect(crewNote(ui.app.innerHTML)).toBe('처리량은 고정값(하루 2pt)만 씁니다. 능력·속성·레벨·시너지는 이 시나리오에서 쓰지 않습니다. 일급 80,000원.');
    const table=ui.app.innerHTML.split('<caption>운영 장부 · KRW</caption>')[1]!.split('</table>')[0]!;
    expect([...table.matchAll(/<th>(.*?)<\/th>/g)].map((m)=>m[1])).toEqual(['시작 운영 자금','급여','운영 손익','미지급 급여','현금']);
    expect(table).not.toContain('계약금');expect(table).not.toContain('훈련비');
    expect(ui.app.innerHTML).not.toContain('class="employee-detail"');
    ui.click({action:'end-day'});
    const updated=ui.app.innerHTML.split('<caption>운영 장부 · KRW</caption>')[1]!.split('</table>')[0]!;
    expect([...updated.matchAll(/<td>(.*?)<\/td>/g)].map((m)=>m[1])).toEqual(['10,000,000원','−80,000원','−80,000원','0원','9,920,000원']);
  });
});

describe('TASK-0014 휴대폰·태블릿 조작', () => {
  const cosmetics = { action:'accept', buy:'OFFER_BUY_02', sell:'OFFER_SELL_02' };
  const pendingCount = (html:string) => (html.match(/<ol class="pending">([\s\S]*?)<\/ol>/)?.[1]?.match(/<li\b/g) ?? []).length;
  it.each(['accept','accept-fwd','accept-plan'])('포인터 %s 뒤 새 계약 제목을 스크롤·초점 대상으로 쓴다', async(action) => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    if (action === 'accept-plan') {
      const initial = openDay(createGame(config),config).state;
      const unlocked = planState(initial,config,[
        {id:'A',type:'ACCEPT_FORWARDING',offerId:'OFFER_FWD_01'},
        {id:'S',type:'ASSIGN_TASK',taskId:'TASK001',employeeId:'EMP02'},
        {id:'B',type:'BOOK_SAILING',contractId:'CT001',sailingId:'ROUTE01-D002'},
        {id:'C',type:'CANCEL_CONTRACT',contractId:'CT001'},
      ]).state;
      await ui.importText(serializeSave(unlocked));
    }
    ui.focus.mockClear();ui.focusIds.length=0;ui.scroll.mockClear();
    ui.clickNow(action === 'accept' ? cosmetics : action === 'accept-fwd'
      ? {action,offer:'OFFER_FWD_01'} : {action,key:'OFFER_BUY_02+OFFER_SELL_02'},1);
    const id = action === 'accept-plan' ? 'contract-h-CT002' : 'contract-h-CT001';
    expect(ui.scrollIds).toEqual([id]);
    expect(ui.focusIds).toEqual([id]);
    expect(ui.focus).toHaveBeenCalledExactlyOnceWith({preventScroll:true});
    expect(ui.scroll).toHaveBeenCalledExactlyOnceWith({block:'start'});
    expect(ui.app.innerHTML).toContain(`id="${id}" tabindex="-1"`);
    expect(ui.app.innerHTML).toContain('<div class="flash-toast flash info">오늘 할 일에 넣었습니다. ‘하루 진행’을 누르면 실행됩니다. 그 전에는 시간이 흐르지 않습니다.</div>');
    expect(ui.announcements.at(-1)).toContain('오늘 할 일에 넣었습니다.');
    expect(ui.app.innerHTML).toContain('<p class="flash info">오늘 할 일에 넣었습니다.');
  });
  it('배정·예약은 스크롤을 요청하지 않고 같은 칸에 예정 표시와 키보드 초점을 남긴다', async() => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();ui.click(cosmetics);
    ui.scroll.mockClear();ui.focus.mockClear();ui.focusIds.length=0;
    ui.click({action:'assign',emp:'EMP01'});
    expect(ui.focusIds).toEqual(['status-assign-TASK001']);
    expect(ui.doc.activeElement.id).toBe('status-assign-TASK001');
    expect(ui.app.innerHTML).toContain('min-height:88px;width:260px;max-width:100%');
    ui.click({action:'book',contract:'CT001',sailing:'ROUTE02-D002'});
    expect(ui.focusIds.at(-1)).toBe('status-book-CT001');
    expect(ui.doc.activeElement.id).toBe('status-book-CT001');
    expect(ui.scroll).not.toHaveBeenCalled();
    for (const [options] of ui.focus.mock.calls) expect(options).toEqual({preventScroll:true});
    expect(ui.app.innerHTML).toContain('준비 업무 배정 예정');
    expect(ui.app.innerHTML).toContain('운송편 예약 예정');
  });
  it.each(['scout','recruit-quest','hire','train'])('%s 뒤에도 스크롤 없이 누른 칸에 예정 표시가 남는다', async(action) => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    if(action==='recruit-quest') {
      const discovered=openDay(runDays(createGame(config),config,1,{
        1:[{id:'S',type:'SCOUT_SITE',venueId:'VEN_PORT',employeeId:'EMP02'}],
      }).state,config).state;
      await ui.importText(serializeSave(discovered));
    } else if(action==='hire') {
      await ui.importText(readySave());ui.click({action:'interview',candidate:'EMP04'});
    } else if(action==='train') {
      ui.click({action:'select-card',emp:'EMP01'});ui.click({action:'detail',emp:'EMP01'});
    }
    ui.scroll.mockClear();
    ui.click(action==='scout' ? {action,venue:'VEN_PORT',emp:'EMP01'}
      : action==='train' ? {action,emp:'EMP01'} : {action,candidate:'EMP04'});
    expect(ui.scroll).not.toHaveBeenCalled();
    expect(ui.app.innerHTML).toContain({scout:'현장 조사 예정','recruit-quest':'영입 의뢰 예정',hire:'고용 예정',train:'일반 훈련 예정'}[action]!);
    expect(ui.doc.activeElement).not.toBeNull();
  });
  it('포인터로 사라지는 버튼을 눌러도 오늘 할 일 제목으로 대체하지 않는다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click(cosmetics);vi.advanceTimersByTime(500);
    ui.focus.mockClear();ui.focusIds.length=0;
    ui.clickNow({action:'unqueue',index:'0'},1);
    expect(ui.focusIds).not.toContain('queue-h');
    expect(ui.focus).not.toHaveBeenCalled();
  });
  it('키보드로 사라진 버튼을 누르면 body 대신 가까운 제목으로 초점을 옮긴다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click(cosmetics);
    ui.click({action:'unqueue',index:'0'});
    expect(ui.doc.activeElement.id).toBe('queue-h');
    expect(ui.focus).toHaveBeenLastCalledWith({preventScroll:true});
  });
  it('대안 제목 가운데가 고정 막대에 가려지면 보이는 하루 진행에 초점을 둔다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click(cosmetics);
    ui.bounds['status-assign-TASK001']={top:20,bottom:60,height:40};
    ui.click({action:'assign',emp:'EMP01'});
    expect(ui.doc.activeElement.dataset.action).toBe('end-day');
    expect(ui.scrollIds).toEqual(['contract-h-CT001']);
  });
  it('대안 제목 가운데가 아래쪽 알림에 가려져도 보이는 하루 진행에 초점을 둔다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click(cosmetics);ui.setToastTop(700);
    ui.bounds['status-assign-TASK001']={top:720,bottom:760,height:40};
    ui.click({action:'assign',emp:'EMP01'});
    expect(ui.doc.activeElement.dataset.action).toBe('end-day');
  });
  it('배정 뒤 위쪽 내용이 늘면 늘어난 만큼 스크롤해 예정 표시를 누른 높이에 둔다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click(cosmetics);ui.scrollBy.mockClear();
    ui.afterRender(()=>{ui.slotTops['assign-TASK001']=230;});
    ui.click({action:'assign',emp:'EMP01'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,50);
    // 버튼(위 200)이 칸(위 180)에서 20px 아래에 있었다.
    expect(ui.app.innerHTML).toContain('justify-content:flex-start;padding-top:20px"><span class="pill" id="status-assign-TASK001"');
  });
  it('배정 뒤 위쪽 내용이 줄면 스크롤하지 않는다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click(cosmetics);ui.scrollBy.mockClear();
    ui.afterRender(()=>{ui.slotTops['assign-TASK001']=150;});
    ui.click({action:'assign',emp:'EMP01'});
    expect(ui.scrollBy).not.toHaveBeenCalled();
    expect(ui.doc.activeElement.id).toBe('status-assign-TASK001');
  });
  it.each([[340,40],[275,-25]])('하루 진행 뒤 읽던 계약 제목이 %ipx로 가면 %ipx 스크롤해 같은 높이에 둔다', async(after,dy) => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click(cosmetics);ui.click({action:'end-day'});
    ui.bounds['contract-h-CT001']={top:300,bottom:330,height:30};ui.scrollBy.mockClear();
    ui.afterRender(()=>{ui.bounds['contract-h-CT001']={top:after,bottom:after+30,height:30};});
    ui.click({action:'end-day'});
    expect(ui.app.innerHTML).toContain('<b>3일</b>');
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,dy);
  });
  it('하루 진행 뒤 계약 제목이 그대로면 스크롤하지 않는다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click(cosmetics);ui.click({action:'end-day'});ui.scrollBy.mockClear();
    ui.click({action:'end-day'});
    expect(ui.scrollBy).not.toHaveBeenCalled();
  });
  it('알림이 있으면 가리는 높이를 --toast-h로 알리고 없어지면 0px로 되돌린다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();const set=vi.mocked(ui.doc.documentElement.style.setProperty);
    ui.setToastTop(690);ui.click(cosmetics);
    expect(set).toHaveBeenCalledWith('--toast-h','118px');
    set.mockClear();ui.click({action:'end-day'});
    expect(set).toHaveBeenCalledWith('--toast-h','0px');
    expect(set).not.toHaveBeenCalledWith('--toast-h','118px');
  });
  it('500ms 안의 다른 명령 클릭도 막고 500ms 뒤에는 받는다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.clickNow(cosmetics,1);
    ui.clickNow({action:'assign',emp:'EMP01'},1);
    expect(pendingCount(ui.app.innerHTML)).toBe(1);
    vi.advanceTimersByTime(499);ui.clickNow({action:'assign',emp:'EMP01'},1);
    expect(pendingCount(ui.app.innerHTML)).toBe(1);
    vi.advanceTimersByTime(1);ui.clickNow({action:'assign',emp:'EMP01'},1);
    expect(pendingCount(ui.app.innerHTML)).toBe(2);
  });
  it('하루 진행을 두 번 눌러도 하루만 진행하고 차단 시간 뒤에는 다음 날로 간다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.clickNow({action:'end-day'},1);ui.clickNow({action:'end-day'},1);
    expect(ui.app.innerHTML).toContain('<b>2일</b>');expect(ui.app.innerHTML).not.toContain('<b>3일</b>');
    vi.advanceTimersByTime(500);ui.clickNow({action:'end-day'},1);
    expect(ui.app.innerHTML).toContain('<b>3일</b>');
  });
  it.each(['restart','scenario','load','import'])('%s 확인을 거절하면 진행과 대기 명령이 유지된다', async(action) => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'end-day'});
    ui.click({action:'scout',venue:'VEN_PORT'});
    const before=ui.app.innerHTML;
    vi.mocked(confirm).mockReturnValue(false);
    vi.stubGlobal('localStorage',{getItem:()=>serializeSave(openDay(createGame(config),config).state)});
    if(action==='scenario')await ui.change({action},'SCENARIO_M1_ONE_TRADE');
    else if(action==='import')await ui.importText(serializeSave(openDay(createGame(config),config).state));
    else ui.click({action});
    expect(confirm).toHaveBeenCalled();
    expect(ui.app.innerHTML).toBe(before);expect(pendingCount(ui.app.innerHTML)).toBe(1);
    expect(ui.doc.title).toBe(`Scitrade — ${config.titleKo}`);
  });
  it('적용 가능한 배정·예약 버튼에는 title이 없고 거절 이유는 버튼 밖에도 있다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'accept-fwd',offer:'OFFER_FWD_01'});
    const buttons=ui.app.innerHTML.match(/<button[^>]*data-action="(?:assign|book)"[^>]*>/g)!;
    expect(buttons.length).toBeGreaterThan(0);
    for(const button of buttons)if(!button.includes('disabled'))expect(button).not.toContain('title=');
    ui.click({action:'book',contract:'CT001',sailing:'ROUTE01-D002'});
    ui.click({action:'accept-fwd',offer:'OFFER_FWD_02'});
    const blocked=ui.app.innerHTML.match(/<button[^>]*data-action="book"[^>]*data-sailing="ROUTE01-D002"[^>]*disabled[^>]*>([\s\S]*?)<\/button><p class="reason">([^<]+)<\/p>/);
    expect(blocked).not.toBeNull();
    expect(blocked![1]).toContain(blocked![2]!);
    expect(blocked![2]).toContain('이 출항편의 남은 화물 공간이 부족합니다');
  });
  it('카드를 두 번 눌러도 선택이 유지되고 성장 상세 버튼을 화면 안으로 가져온다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card',emp:'EMP01'});
    ui.click({action:'select-card',emp:'EMP01'});
    expect(ui.app.innerHTML).toMatch(/<article class="[^"]*is-selected"[^>]*data-action="select-card"[^>]*data-emp="EMP01"/);
    expect(ui.app.innerHTML).toContain('귀솔 성장·훈련 상세');
    expect(ui.scroll).toHaveBeenCalledTimes(2);
    expect(ui.doc.activeElement.dataset.action).toBe('detail');
  });
  it('문서 제목은 새 시나리오와 불러온 시나리오를 따른다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();expect(ui.doc.title).toBe(`Scitrade — ${config.titleKo}`);
    const m1=loadScenario('SCENARIO_M1_ONE_TRADE');
    await ui.change({action:'scenario'},m1.id);expect(ui.doc.title).toBe(`Scitrade — ${m1.titleKo}`);
    await ui.importText(serializeSave(openDay(createGame(config),config).state));
    expect(ui.doc.title).toBe(`Scitrade — ${config.titleKo}`);
  });
  it('M1도 견적 수락·배정·예약에서 수금·종결까지 진행한다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');
    ui.click({action:'accept',buy:'OFFER_BUY_01',sell:'OFFER_SELL_01'});
    ui.click({action:'assign',emp:'EMP01'});
    ui.click({action:'book',contract:'CT001',sailing:'ROUTE01-D002'});
    for(let day=1;day<=12;day++)ui.click({action:'end-day'});
    expect(ui.app.innerHTML).toContain('CT001 대금 1,400.00 USD 수금. 계약 종결');
    expect(ui.app.innerHTML).toContain('종결된 계약');
    expect(ui.app.innerHTML).not.toContain('data-action="train"');
    expect(ui.app.innerHTML).not.toContain('id="recruit-h"');
  });
  it('고정되는 상태 막대의 실제 높이를 ResizeObserver로 CSS에 갱신한다', async() => {
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    expect(ui.doc.documentElement.style.setProperty).toHaveBeenLastCalledWith('--topbar-h','100px');
    ui.resizeStatusbar(140);
    expect(ui.doc.documentElement.style.setProperty).toHaveBeenLastCalledWith('--topbar-h','140px');
  });
  it('가로 세 열(거래 먼저)·한 열 배치 순서·고정 막대 분리·터치 크기·글자 대비 규칙을 유지한다', async() => {
    const {readFileSync}=await vi.importActual<{readFileSync:(path:URL,encoding:string)=>string}>('node:fs');
    const css=readFileSync(new URL('./style.css',import.meta.url),'utf8');
    expect(css).toContain('grid-template-areas: "trade" "queue" "crew" "resources" "report" "world" "log";');
    // 1001px 이상 가로 기기는 모두 거래가 맨 위인 세 열 배치다.
    expect(css).toMatch(/\.layout \{[^}]*grid-template-areas:\s*"trade trade crew"\s*"trade trade resources"\s*"trade trade queue"\s*"world report log";/);
    expect(css).toContain('@media (max-width: 1000px) {\n  .layout, .layout.map-wide');
    expect(css).not.toContain('max-width: 1100px');
    expect(css).toMatch(/\.layout\.map-wide\s*\{[^}]*"trade trade crew"\s*"trade trade resources"\s*"trade trade queue"\s*"world world world"\s*"report report log";/);
    expect(css).toMatch(/@media \(any-pointer: coarse\)\s*\{\s*\.training > \.pill\s*\{\s*min-height:\s*44px/);
    expect(css).toMatch(/\.books\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*12rem\),\s*1fr\)\)/);
    expect(css).toMatch(/\.resources table\.money td\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).not.toMatch(/(^|\n)table\.money td\s*\{[^}]*nowrap/);
    expect(css).toMatch(/\.masthead\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.statusbar\s*\{[^}]*position:\s*sticky/);
    expect(css).toContain('scroll-padding-top: var(--topbar-h)');
    expect(css).toContain('overscroll-behavior-y: none');
    expect(css).toContain('color-scheme: only dark'); // TASK-0078 B안(먹 틀)에서 only light → only dark
    expect(css).toContain('touch-action: manipulation');
    expect(css).toMatch(/@media \(any-pointer: coarse\)\s*\{[^}]*min-height:\s*44px/);
    expect(css).not.toMatch(/@media \(pointer: coarse\)/);
    expect(css).toContain('select { font-size: 16px; }');
    expect(css.match(/button:disabled\s*\{([^}]+)\}/)![1]).not.toContain('opacity');
    const color=(name:string)=>css.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))![1]!;
    const luminance=(hex:string)=>[1,3,5].map((i)=>parseInt(hex.slice(i,i+2),16)/255)
      .map((v)=>v<=.04045 ? v/12.92 : ((v+.055)/1.055)**2.4)
      .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i]!,0);
    for(const background of ['paper','warn-bg']) {
      const [dark,light]=[luminance(color('warn')),luminance(color(background))].sort((a,b)=>a-b);
      expect((light!+.05)/(dark!+.05)).toBeGreaterThanOrEqual(4.5);
    }
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    const masthead=ui.app.innerHTML.split('<div class="masthead">')[1]!.split('<div class="statusbar"')[0]!;
    expect(masthead).toContain('data-action="restart"');expect(masthead).not.toContain('data-action="end-day"');
    const bar=ui.app.innerHTML.split('<div class="statusbar"')[1]!.split('</header>')[0]!;
    for(const label of ['거래 현금','사용 가능','운영 현금','다음 수금','금액은 확정 기준','하루 진행 ▶'])expect(bar).toContain(label);
  });
});

describe('3판 표시 수정 (Codex 사용성 점검 2026-10-07)', () => {
  it('견적의 대금일은 계약 조건으로 적고, 인도가 늦으면 실제로 받는 날을 따로 알린다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    // 1일 화장품: 계약상 대금일 12일이 인도보다 늦으므로 그대로 받는다.
    expect(ui.app.innerHTML).toContain('계약상 대금일은 12일입니다.');
    expect(ui.app.innerHTML).toContain('<li>대금은 12일에 받을 예정</li>');
    ui.click({ action: 'end-day' }); ui.click({ action: 'end-day' });
    expect(ui.app.innerHTML).toContain('<b>3일</b>');
    // 3일 가구 주선: 다음 편이 14일에 도착하므로 계약상 대금일 10일에는 받을 수 없다.
    const fwd = ui.app.innerHTML.split('가구 화주가')[1]!.split('</article>')[0]!;
    expect(fwd).toContain('계약상 대금일은 10일입니다.');
    expect(fwd).toContain('대금은 14일에 받을 예정 (인도가 계약상 대금일 10일보다 늦기 때문)');
    expect(ui.app.innerHTML).not.toContain('대금은 10일.');
  });
});

describe('TASK-0012 문화 활동 실제 화면 연결',()=>{
  const taskId='CULTURE-CA01-EMP01-D2';
  const pendingCount=(html:string)=>(html.match(/<ol class="pending">([\s\S]*?)<\/ol>/)?.[1]?.match(/<li\b/g) ?? []).length;
  const local=(html:string)=>html.split('<div id="local-body">')[1]!.split('</section>')[0]!;
  const tab=(html:string)=>html.match(/<button id="local-tab"[^>]*>([\s\S]*?)<\/button>/)![1]!;
  const toast=(html:string)=>html.match(/<div class="flash-toast[^>]*>([\s\S]*?)<\/div>/)?.[0] ?? '';
  const header=(html:string)=>html.match(/<header class="topbar">[\s\S]*?<\/header>/)![0];
  async function select(ui:Awaited<ReturnType<typeof startUi>>) {
    ui.click({action:'end-day'});ui.click({action:'culture-tab'});
    ui.click({action:'culture-act',activity:'CA01'});ui.click({action:'culture-emp',emp:'EMP01'});
  }
  async function exportReader(ui:Awaited<ReturnType<typeof startUi>>) {
    let blob:Blob|null=null;
    vi.spyOn(URL,'createObjectURL').mockImplementation((value)=>{blob=value as Blob;return 'blob:task0012';});
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>undefined);
    return async()=>{
      const calls=ui.doc.createElement.mock.calls.length;
      ui.click({action:'export'});
      expect(ui.doc.createElement).toHaveBeenCalledWith('a');expect(ui.doc.createElement.mock.calls.length).toBe(calls+1);
      expect(ui.doc.createElement.mock.results.at(-1)!.value.click).toHaveBeenCalledOnce();
      return blob!.text();
    };
  }
  it('한 바퀴(a): 연 채 진행·선택 500ms·F1 예정 초점·결과 단일 알림',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await select(ui);
    expect(ui.scrollIds).toContain('local-h');expect(ui.focusIds).toContain('local-h');
    expect(ui.doc.activeElement.id).toBe('culture-emp-EMP01');expect(ui.app.innerHTML).toContain('id="culture-preview"');
    vi.advanceTimersByTime(499);ui.clickNow({action:'culture-queue',activity:'CA01',emp:'EMP01'});
    expect(pendingCount(ui.app.innerHTML)).toBe(0);
    ui.scrollBy.mockClear();ui.afterRender(()=>{ui.slotTops['culture-CA01-EMP01']=230;});
    ui.click({action:'culture-queue',activity:'CA01',emp:'EMP01'});
    expect(pendingCount(ui.app.innerHTML)).toBe(1);
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,50);
    expect(ui.doc.activeElement.id).toBe('status-culture-CA01-EMP01');
    expect(ui.app.innerHTML).toContain('id="status-culture-CA01-EMP01"');
    ui.click({action:'culture-emp',emp:'EMP02'});
    expect(ui.app.innerHTML).toContain('같은 활동에 오늘 이미 귀솔이 갑니다.');
    expect(ui.rendered({action:'culture-queue'}).disabled).toBe(true);
    ui.click({action:'culture-emp',emp:'EMP01'});
    expect(local(ui.app.innerHTML)).not.toContain('를 진행 중입니다.');
    expect(ui.app.innerHTML).toContain('id="status-culture-CA01-EMP01"');
    ui.scrollIds.length=0;ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.doc.activeElement.dataset.action).toBe('end-day');expect(ui.scrollIds).toEqual([]);expect(ui.scrollBy).not.toHaveBeenCalled();
    expect(toast(ui.app.innerHTML)).toContain('data-action="culture-result"');expect(ui.announcements.at(-1)).toContain('2일 현지 활동 기록: 한 상인의 포장·보관 요구 — 귀솔');
    expect(ui.announcements.at(-1)).not.toContain('경험치');
    expect(growthNotice(ui.app.innerHTML)![1]).not.toContain('role');
    const copy=ui.app.innerHTML.split('<section class="panel queue"')[1]!.split('</section>')[0]!;
    expect(copy).toContain('<p class="flash info">2일 현지 활동 기록: 한 상인의 포장·보관 요구 — 귀솔</p>');
    expect(copy).not.toContain('data-action="culture-result"');expect(copy).not.toContain('role="status"');
    expect(tab(ui.app.innerHTML)).toContain('<small>닫기</small>');
    expect(ui.app.innerHTML).toMatch(/<div id="local-body">\s*<article class="cul-result"/);
    expect(ui.app.innerHTML).not.toContain('id="culture-preview"');
    const beforeBook=ui.announcements.length;
    ui.click({action:'culture-book'});
    expect(ui.announcements).toHaveLength(beforeBook);
    expect(toast(ui.app.innerHTML)).toContain('결과 보기');expect(toast(ui.app.innerHTML)).not.toContain('role="status"');
  });
  it('한 바퀴(b): 닫고 진행은 스크롤 없이 새 기록 표시, 결과 보기만 제목으로 이동한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await select(ui);ui.click({action:'culture-queue'});ui.click({action:'culture-tab'});
    ui.scrollBy.mockClear();ui.scrollIds.length=0;ui.click({action:'end-day'});
    expect(ui.scrollBy).not.toHaveBeenCalled();expect(ui.scrollIds).toEqual([]);expect(tab(ui.app.innerHTML)).toContain('새 기록 있음');
    expect(ui.doc.activeElement.dataset.action).toBe('end-day');
    ui.click({action:'culture-result'});
    expect(ui.app.innerHTML).toContain('id="local"');
    expect(ui.scrollIds).toEqual([`culture-result-h-${taskId}`]);expect(ui.focusIds.at(-1)).toBe(`culture-result-h-${taskId}`);
    expect(ui.scroll).toHaveBeenLastCalledWith({block:'start'});expect(ui.focus).toHaveBeenLastCalledWith({preventScroll:true});
    expect(toast(ui.app.innerHTML)).toBe('');
    ui.clickNow({action:'culture-close',where:'head'});expect(ui.app.innerHTML).toContain('id="local"');
    // 결과 보기로 본 결과는 본 것으로 남는다.
    ui.click({action:'culture-close',where:'head'});expect(tab(ui.app.innerHTML)).toContain('장소 5곳');
  });
  it('안 본 결과는 이틀 진행 뒤에도 남고 열어 본 다음 다시 열 때 사라진다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await select(ui);ui.click({action:'culture-queue'});ui.click({action:'culture-close',where:'head'});
    ui.click({action:'end-day'});ui.click({action:'end-day'});expect(ui.app.innerHTML).toContain('<b>4일</b>');
    expect(tab(ui.app.innerHTML)).toContain('새 기록 있음');expect(toast(ui.app.innerHTML)).toBe('');
    ui.click({action:'culture-tab'});
    expect(ui.app.innerHTML).toMatch(/<div id="local-body">\s*<article class="cul-result"/);
    expect(ui.app.innerHTML).toContain(`id="culture-result-h-${taskId}"`);
    ui.click({action:'culture-tab'});expect(tab(ui.app.innerHTML)).toContain('장소 5곳');
    ui.click({action:'culture-tab'});expect(ui.app.innerHTML).not.toContain('class="cul-result"');
  });
  it.each(['tab','head','end'])('닫기 %s는 열기 전 탭 위치로 한 번 복원하고 초점·500ms를 지킨다',async(where)=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.bounds['local-tab']={top:240,bottom:284,height:44};
    ui.click({action:'culture-tab'});expect(ui.doc.activeElement.id).toBe('local-h');
    ui.clickNow({action:'culture-tab'});expect(ui.app.innerHTML).toContain('id="local"');
    ui.scrollBy.mockClear();ui.afterRender(()=>{ui.bounds['local-tab']={top:310,bottom:354,height:44};});
    ui.click(where==='tab' ? {action:'culture-tab'} : {action:'culture-close',where});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,70);expect(ui.doc.activeElement.id).toBe('local-tab');
    expect(ui.app.innerHTML).not.toContain('id="local"');
    vi.advanceTimersByTime(499);ui.clickNow({action:'culture-tab'});expect(ui.app.innerHTML).not.toContain('id="local"');
    vi.advanceTimersByTime(1);ui.clickNow({action:'culture-tab'});expect(ui.app.innerHTML).toContain('id="local"');
  });
  it('결과 보기로 연 뒤 닫을 때는 탭을 막대 아래·알림 위로 최소 이동한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await select(ui);ui.click({action:'culture-queue'});ui.click({action:'culture-tab'});ui.click({action:'end-day'});ui.click({action:'culture-result'});
    ui.scrollBy.mockClear();ui.afterRender(()=>{ui.bounds['local-tab']={top:50,bottom:94,height:44};});
    ui.click({action:'culture-close',where:'end'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,-58);expect(ui.doc.activeElement.id).toBe('local-tab');
  });
  it('읽던 직원 제목은 결과 높이만큼 한 번 보정하고 사라지는 미리 보기는 기준이 아니다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await select(ui);ui.click({action:'culture-queue'});
    ui.bounds['culture-h']={top:50,bottom:80,height:30};
    ui.bounds['culture-emp-h']={top:180,bottom:210,height:30};
    ui.bounds['culture-pv-h']={top:280,bottom:310,height:30};
    ui.bounds['culture-book-h']={top:780,bottom:810,height:30};
    ui.afterRender(()=>{ui.bounds['culture-emp-h']={top:530,bottom:560,height:30};});
    ui.scrollBy.mockClear();ui.scrollIds.length=0;ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,350);expect(ui.scrollIds).toEqual([]);
    expect(ui.app.innerHTML).not.toContain('id="culture-pv-h"');expect(ui.doc.activeElement.dataset.action).toBe('end-day');
  });
  it('읽던 첫 결과가 남고 여러 후보 중 가장 위의 제목을 쓴다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await select(ui);ui.click({action:'culture-queue'});ui.click({action:'end-day'});
    const heading=`culture-result-h-${taskId}`;ui.bounds[heading]={top:170,bottom:200,height:30};
    ui.bounds['culture-h']={top:400,bottom:430,height:30};ui.bounds['culture-emp-h']={top:550,bottom:580,height:30};
    ui.afterRender(()=>{ui.bounds[heading]={top:150,bottom:180,height:30};});ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,-20);
  });
  it('직원 고르기는 한 번의 최소 스크롤 뒤 누른 직원에 초점을 둔다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'culture-tab'});ui.click({action:'culture-act',activity:'CA01'});
    ui.bounds['culture-emp-h']={top:600,bottom:630,height:30};ui.bounds['culture-slot']={top:960,bottom:1050,height:90};
    ui.bounds['culture-emp-EMP01']={top:700,bottom:744,height:44};
    ui.setToastTop(620);ui.click({action:'save'});ui.scrollBy.mockClear();
    ui.click({action:'culture-emp',emp:'EMP01'});
    // 띠 아래 끝은 알림 위 끝(620px)이다. CSS 변수와 무관하다.
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,430);expect(ui.doc.activeElement.id).toBe('culture-emp-EMP01');
    expect(ui.focus).toHaveBeenLastCalledWith({preventScroll:true});
  });
  it('미리 보기 넘침은 누른 직원의 막대 아래 8px 상한을 우선한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'culture-tab'});ui.click({action:'culture-act',activity:'CA01'});
    ui.bounds['culture-emp-h']={top:160,bottom:190,height:30};ui.bounds['culture-emp-EMP01']={top:180,bottom:224,height:44};
    ui.bounds['culture-slot']={top:910,bottom:1000,height:90};ui.scrollBy.mockClear();
    ui.click({action:'culture-emp',emp:'EMP01'});expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,72);
    expect(ui.doc.activeElement.id).toBe('culture-emp-EMP01');
  });
  it('활동·직원의 같은 선택은 유지하고 다른 활동을 고르면 직원·미리 보기만 지운다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await select(ui);ui.click({action:'culture-emp',emp:'EMP01'});ui.click({action:'culture-act',activity:'CA01'});
    expect(ui.app.innerHTML).toContain('id="culture-preview"');
    ui.click({action:'culture-act',activity:'CA02'});expect(ui.app.innerHTML).not.toContain('id="culture-preview"');
    ui.clickNow({action:'culture-emp',emp:'EMP01'});expect(ui.app.innerHTML).not.toContain('id="culture-preview"');
    vi.advanceTimersByTime(500);ui.clickNow({action:'culture-emp',emp:'EMP01'});expect(ui.app.innerHTML).toContain('id="culture-preview"');
  });
  it('P0-CITY-01 열람·선택·미리 보기·결과 보기 전후 저장 문자열과 위쪽 막대는 같다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();const read=await exportReader(ui);const saved=await read(),bar=header(ui.app.innerHTML);
    for(const action of [{action:'culture-tab'},{action:'culture-book'},{action:'culture-book'},
      {action:'culture-act',activity:'CA01'},{action:'culture-emp',emp:'EMP01'},
      {action:'culture-close',where:'head'},{action:'culture-tab'},{action:'culture-close',where:'end'}] as Record<string,string>[]) {
      ui.click(action);expect(await read()).toBe(saved);expect(header(ui.app.innerHTML)).toBe(bar);
    }
    expect(ui.focusIds).toContain('local-h');expect(ui.focusIds).toContain('culture-emp-EMP01');expect(ui.focusIds).toContain('local-tab');
    ui.click({action:'culture-tab'});ui.click({action:'culture-queue'});ui.click({action:'culture-tab'});ui.click({action:'end-day'});
    const before=await read(),beforeBar=header(ui.app.innerHTML);expect(toast(ui.app.innerHTML)).toContain('결과 보기');
    ui.click({action:'culture-result'});expect(await read()).toBe(before);expect(header(ui.app.innerHTML)).toBe(beforeBar);
    expect(ui.scrollIds.some((id)=>id.startsWith('culture-result-h-'))).toBe(true);expect(toast(ui.app.innerHTML)).toBe('');
    expect(ui.doc.createElement.mock.calls.length).toBe(11);
  });
  it('P0-CITY-01 금융센터는 미구현 표시가 있고 주식·상장 단추가 없다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'culture-tab'});
    expect(ui.app.innerHTML).toContain('금융센터</dt><dd>주식 거래와 상장(회사 주식을 시장에 내놓기)은 이번 판에 없습니다.');
    const list=ui.app.innerHTML.match(/<dl class="local-venues">([\s\S]*?)<\/dl>/)![1]!;
    expect([...list.matchAll(/<dt>/g)]).toHaveLength(5);expect(list).not.toContain('<button');
    for(const button of ui.app.innerHTML.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g))expect(button[1]).not.toMatch(/주식|상장|IPO/);
  });
  it.each(['restart','load','import','scenario'])('%s 뒤 펼침·기록장·활동·직원 선택은 초기화된다',async(mode)=>{
    const s=openDay(runDays(createGame(config),config,2,{2:[{id:'C',type:'START_CULTURE_ACTIVITY',activityId:'CA01',employeeId:'EMP01'}]}).state,config).state;
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await ui.importText(serializeSave(s));ui.click({action:'end-day'});ui.click({action:'culture-tab'});ui.click({action:'culture-book'});
    ui.click({action:'culture-act',activity:'CA02'});ui.click({action:'culture-emp',emp:'EMP01'});
    if(mode==='load'){vi.stubGlobal('localStorage',{getItem:()=>serializeSave(s)});ui.click({action:'load'});}
    else if(mode==='import')await ui.importText(serializeSave(s));
    else if(mode==='restart')ui.click({action:'restart'});
    else await ui.change({action:'scenario'},config.id);
    expect(ui.app.innerHTML).not.toContain('id="local"');expect(toast(ui.app.innerHTML)).not.toContain('culture-result');
    ui.click({action:'culture-tab'});expect(ui.app.innerHTML).not.toContain('id="culture-preview"');expect(ui.app.innerHTML).not.toContain('id="culture-book-body"');
    expect(local(ui.app.innerHTML)).not.toContain('aria-pressed="true"');expect(ui.app.innerHTML).not.toContain('id="culture-emp-h"');
    if(mode==='load'||mode==='import')expect(ui.app.innerHTML).toContain(`id="culture-result-h-${taskId}"`);
    // 닫기는 초기화 뒤 새로 연 순간의 탭 위치로 돌아간다. 초기화 전 값이 남는지는 이 하네스로 관찰할 수 없다(initialUiState 시험이 맡는다).
    ui.scrollBy.mockClear();ui.afterRender(()=>{ui.bounds['local-tab']={top:250,bottom:294,height:44};});ui.click({action:'culture-close',where:'end'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,50);
  });
  it('M1 전체 화면에는 문화 탭·패널·비용·감싸는 칸이 없다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');
    for(const text of ['id="local-tab"','현지 활동비','data-action="culture-','class="maincol"'])expect(ui.app.innerHTML).not.toContain(text);
    ui.click({action:'end-day'});for(const text of ['id="local-tab"','현지 활동비','data-action="culture-','class="maincol"'])expect(ui.app.innerHTML).not.toContain(text);
  });
  it('CA01 하루 뒤 원화 비용 행의 합과 운영 손익·현금식은 일치한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'culture-tab'});ui.click({action:'culture-act',activity:'CA01'});ui.click({action:'culture-emp',emp:'EMP01'});ui.click({action:'culture-queue'});ui.click({action:'end-day'});
    const table=ui.app.innerHTML.split('<caption>운영 장부 · KRW</caption>')[1]!.split('</table>')[0]!;
    expect([...table.matchAll(/<th>(.*?)<\/th>/g)].map((m)=>m[1])).toEqual(['시작 운영 자금','급여','영입 계약금','훈련비','현지 활동비','운영 손익','미지급 급여','현금']);
    expect([...table.matchAll(/<td>(.*?)<\/td>/g)].map((m)=>m[1])).toEqual(['10,000,000원','−160,000원','0원','0원','−20,000원','−180,000원','0원','9,820,000원']);
    const read=await exportReader(ui),save=JSON.parse(await read());
    const {companyReport}=await import('../engine/reports');const p=companyReport(save.state,config).payroll;
    expect(-p.wageExpense-p.recruitmentExpense-p.trainingExpense-p.cultureExpense).toBe(p.profit);
    expect(p.cash).toBe(p.openingEquity+p.profit+p.accountsPayable);
  });
  it('문화 CSS의 줄 높이·알림 단추·탭 위치는 고정한 규칙이다',async()=>{
    const {readFileSync}=await vi.importActual<{readFileSync:(path:URL,encoding:string)=>string}>('node:fs');
    const css=readFileSync(new URL('./style.css',import.meta.url),'utf8');
    expect(css).toMatch(/\.layout\s*\{[^}]*grid-template-rows:\s*auto auto 1fr/);
    expect(css).toMatch(/@media \(max-width: 1000px\)\s*\{\s*\.layout, \.layout\.map-wide\s*\{[^}]*grid-template-rows:\s*none/);
    expect(css).toMatch(/\.flash-toast button\s*\{[^}]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.flash-toast button\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.trade\s*\{[^}]*position:\s*relative/);expect(css).toMatch(/\.local-tab\s*\{[^}]*position:\s*absolute/);
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();expect(ui.app.innerHTML).toMatch(/<h2 id="trade-h"[^>]*>[\s\S]*?<\/h2>\s*<button id="local-tab"/);
    expect(ui.app.innerHTML).not.toMatch(/id="local-tab"[^>]*aria-controls/);
    ui.click({action:'culture-tab'});expect(ui.app.innerHTML).toMatch(/id="local-tab"[^>]*aria-controls="local-body"/);
  });
});

describe('TASK-0012 Claude 검수 보강',()=>{
  const taskId='CULTURE-CA01-EMP01-D2';
  const tab=(html:string)=>html.match(/<button id="local-tab"[^>]*>([\s\S]*?)<\/button>/)![1]!;
  const toast=(html:string)=>html.match(/<div class="flash-toast[^>]*>([\s\S]*?)<\/div>/)?.[0] ?? '';
  async function queued(ui:Awaited<ReturnType<typeof startUi>>) {
    ui.click({action:'end-day'});ui.click({action:'culture-tab'});
    ui.click({action:'culture-act',activity:'CA01'});ui.click({action:'culture-emp',emp:'EMP01'});ui.click({action:'culture-queue'});
  }
  it.each([false,true])('M2에서도 제목이 막대 위인 읽던 계약 본문의 위치를 복원한다 (패널 열림 %s)',async(open)=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'accept',buy:'OFFER_BUY_02',sell:'OFFER_SELL_02'});ui.click({action:'end-day'});
    if(open){ui.click({action:'culture-tab'});
      // 계약 카드가 보이면 거래 칸 전체(견적판 기준)보다 계약 제목이 우선이다.
      ui.bounds.trade={top:-1000,bottom:900,height:1900};ui.bounds['trade-h']={top:-990,bottom:-960,height:30};}
    ui.bounds['contract-h-CT001']={top:20,bottom:50,height:30};
    ui.afterRender(()=>{ui.bounds['contract-h-CT001']={top:70,bottom:100,height:30};});
    ui.scrollBy.mockClear();ui.scrollIds.length=0;ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,50);expect(ui.scrollIds).toEqual([]);
    expect(ui.doc.activeElement.dataset.action).toBe('end-day');
  });
  it('결과 카드는 제목이 막대 위여도 블록이 보이면 읽던 자리 기준이다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await queued(ui);ui.click({action:'end-day'});
    ui.bounds[`culture-result-h-${taskId}`]={top:40,bottom:70,height:30};ui.bounds[`culture-result-${taskId}`]={top:30,bottom:520,height:490};
    ui.afterRender(()=>{ui.bounds[`culture-result-h-${taskId}`]={top:300,bottom:330,height:30};});
    ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,260);
  });
  it('읽던 자리 후보는 DOM 순서가 아니라 화면 위에서부터 고른다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'accept',buy:'OFFER_BUY_02',sell:'OFFER_SELL_02'});await queued(ui);
    ui.bounds['culture-h']={top:50,bottom:80,height:30};ui.bounds['culture-emp-h']={top:180,bottom:210,height:30};
    ui.bounds['culture-book-h']={top:780,bottom:810,height:30};ui.bounds['contract-h-CT001']={top:600,bottom:630,height:30};
    // 계약 후보는 먼저 모으지만 화면에서는 직원 제목이 위다. 두 후보의 이동량을 다르게 둔다.
    ui.afterRender(()=>{ui.bounds['culture-emp-h']={top:530,bottom:560,height:30};ui.bounds['contract-h-CT001']={top:900,bottom:930,height:30};});
    ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,350);
  });
  it('패널을 연 채 견적판을 읽으면 위 패널 높이가 바뀌어도 거래 칸을 제자리에 둔다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await queued(ui);
    for(const [id,top] of [['culture-h',-900],['culture-emp-h',-700],['culture-employees',-680],['culture-book-h',20],['trade-h',-40]] as const)ui.bounds[id]={top,bottom:top+30,height:30};
    ui.bounds.trade={top:-50,bottom:900,height:950};
    ui.afterRender(()=>{ui.bounds['trade-h']={top:390,bottom:420,height:30};});
    ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,430);expect(ui.doc.activeElement.dataset.action).toBe('end-day');
  });
  it('직원 줄이 보이면 그 제목이 막대 위여도 결과 높이만큼 보정한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await queued(ui);
    ui.bounds['culture-h']={top:-300,bottom:-270,height:30};ui.bounds['culture-emp-h']={top:70,bottom:91,height:21};
    ui.bounds['culture-employees']={top:120,bottom:164,height:44};ui.bounds['culture-book-h']={top:900,bottom:930,height:30};
    ui.afterRender(()=>{ui.bounds['culture-emp-h']={top:493,bottom:514,height:21};});
    ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,423);
  });
  it('기록장을 펼친 채 제목과 보고서가 함께 보여도 보고서 자리를 지킨다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await queued(ui);ui.click({action:'end-day'});ui.click({action:'culture-book'});
    for(const [id,top,bottom] of [[`culture-result-${taskId}`,-900,-500],[`culture-result-h-${taskId}`,-890,-860],['culture-h',-450,-420],
      ['culture-emp-h',-420,-400],['culture-employees',-400,-350],['culture-book-h',120,150],[`culture-report-${taskId}`,260,700],[`culture-report-h-${taskId}`,270,300]] as const)
      ui.bounds[id]={top,bottom,height:bottom-top};
    ui.afterRender(()=>{ui.bounds[`culture-report-h-${taskId}`]={top:620,bottom:650,height:30};});
    ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,350);
  });
  it('펼친 기록장에 띠에 걸친 보고서가 없으면 기록장 제목이 기준이다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await queued(ui);ui.click({action:'culture-book'});
    for(const [id,top,bottom] of [['culture-h',-450,-420],['culture-emp-h',-420,-400],['culture-employees',-400,-350],['culture-book-h',120,150],['trade-h',700,730]] as const)
      ui.bounds[id]={top,bottom,height:bottom-top};
    ui.bounds.trade={top:690,bottom:3000,height:2310};
    ui.afterRender(()=>{ui.bounds['culture-book-h']={top:500,bottom:530,height:30};});
    ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,380);
  });
  it('기록장 보고서를 읽는 중이면 그 보고서 자리를 지킨다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await queued(ui);ui.click({action:'end-day'});ui.click({action:'culture-book'});
    for(const [id,top,bottom] of [[`culture-result-${taskId}`,-900,-500],[`culture-result-h-${taskId}`,-890,-860],['culture-h',-450,-420],
      ['culture-emp-h',-420,-400],['culture-employees',-400,-350],['culture-book-h',20,50],[`culture-report-${taskId}`,30,500],[`culture-report-h-${taskId}`,40,70]] as const)
      ui.bounds[id]={top,bottom,height:bottom-top};
    ui.afterRender(()=>{ui.bounds[`culture-report-h-${taskId}`]={top:400,bottom:430,height:30};});
    ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,360);
  });
  it.each(['open','closed'])('탭으로 먼저 연 뒤(%s) 결과 보기를 눌러도 방금 마감한 날의 카드로 간다',async(after)=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await queued(ui);ui.click({action:'culture-close',where:'head'});ui.click({action:'end-day'});
    ui.click({action:'culture-tab'});expect(ui.app.innerHTML).toContain(`id="culture-result-h-${taskId}"`);
    if(after==='closed')ui.click({action:'culture-tab'});
    expect(toast(ui.app.innerHTML)).toContain('data-action="culture-result"');
    ui.focusIds.length=0;ui.scrollIds.length=0;ui.click({action:'culture-result'});
    expect(ui.app.innerHTML).toContain(`id="culture-result-h-${taskId}"`);
    expect(ui.scrollIds).toEqual([`culture-result-h-${taskId}`]);expect(ui.focusIds.at(-1)).toBe(`culture-result-h-${taskId}`);
    expect(toast(ui.app.innerHTML)).toBe('');
    ui.click({action:'culture-close',where:'head'});expect(tab(ui.app.innerHTML)).toContain('장소 5곳');
  });
  it('같은 날 결과가 두 건이면 결과 보기는 화면의 첫 결과 카드로 간다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await queued(ui);
    ui.click({action:'culture-act',activity:'CA02'});ui.click({action:'culture-emp',emp:'EMP02'});ui.click({action:'culture-queue'});
    ui.click({action:'end-day'});ui.scrollIds.length=0;ui.click({action:'culture-result'});
    const ids=[...ui.app.innerHTML.matchAll(/id="(culture-result-h-[^"]+)"/g)].map((m)=>m[1]);
    expect(ids).toHaveLength(2);expect(ui.scrollIds).toEqual([ids[0]]);expect(ui.focusIds.at(-1)).toBe(ids[0]);
  });
  it('탭·기록장·활동·직원의 상태 속성과 거래 위 패널 배치',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'end-day'});
    expect(ui.app.innerHTML).toMatch(/id="local-tab"[^>]*aria-expanded="false"/);
    ui.click({action:'culture-tab'});expect(ui.app.innerHTML).toMatch(/id="local-tab"[^>]*aria-expanded="true"/);
    expect(ui.app.innerHTML).toMatch(/<div class="maincol"><section class="panel local"[\s\S]*?<\/section>\s*<section class="panel trade"/);
    expect(ui.app.innerHTML).toMatch(/data-action="culture-book" aria-expanded="false"/);
    ui.click({action:'culture-book'});expect(ui.app.innerHTML).toMatch(/data-action="culture-book" aria-expanded="true"/);
    ui.click({action:'culture-act',activity:'CA02'});
    expect(ui.app.innerHTML).toMatch(/data-activity="CA02" aria-pressed="true"/);expect(ui.app.innerHTML).toMatch(/data-activity="CA01" aria-pressed="false"/);
    ui.click({action:'culture-emp',emp:'EMP01'});
    expect(ui.app.innerHTML).toMatch(/id="culture-emp-EMP01"[^>]*aria-pressed="true"/);expect(ui.app.innerHTML).toMatch(/id="culture-emp-EMP02"[^>]*aria-pressed="false"/);
  });
});

describe('TASK-0012 M1 동작 보존',()=>{
  it('M1에서는 제목이 막대 위라도 읽던 계약 본문의 위치를 복원한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');
    ui.click({action:'accept',buy:'OFFER_BUY_01',sell:'OFFER_SELL_01'});
    ui.bounds['contract-h-CT001']={top:20,bottom:50,height:30};
    ui.afterRender(()=>{ui.bounds['contract-h-CT001']={top:70,bottom:100,height:30};});
    ui.scrollBy.mockClear();ui.click({action:'end-day'});
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0,50);expect(ui.doc.activeElement.dataset.action).toBe('end-day');
  });
});

describe('TASK-0018 키보드·입력 안전·알림·문구',()=>{
  const pending=(html:string)=>[...html.matchAll(/data-action="unqueue"/g)].length;
  const culture=async(ui:Awaited<ReturnType<typeof startUi>>)=>{
    ui.click({action:'culture-tab'});ui.click({action:'culture-act'});ui.click({action:'culture-emp'});
  };
  it('빼기 두 번은 명령 하나만 빼고 500ms 뒤에는 다음 명령을 뺀다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'accept'});ui.click({action:'accept-fwd'});
    expect(pending(ui.app.innerHTML)).toBe(2);
    vi.advanceTimersByTime(501);
    ui.clickNow({action:'unqueue',index:'0'},1);ui.clickNow({action:'unqueue',index:'0'},1);
    expect(pending(ui.app.innerHTML)).toBe(1);
    vi.advanceTimersByTime(500);ui.clickNow({action:'unqueue',index:'0'},1);
    expect(pending(ui.app.innerHTML)).toBe(0);
  });
  it('빼기는 명령 ID로 찾고, 이미 빠진 명령의 단추는 아무것도 빼지 않는다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'accept'});ui.click({action:'accept-fwd'});
    const stale=ui.rendered({action:'unqueue',index:'0'});
    ui.click({action:'unqueue',index:'0'});expect(pending(ui.app.innerHTML)).toBe(1);
    vi.advanceTimersByTime(501);ui.clickTarget(stale,1);
    expect(pending(ui.app.innerHTML)).toBe(1);
  });
  it.each(['detail','interview','culture-book'])('열고 닫기 두 번(%s)',async(action)=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    if(action==='detail') ui.click({action:'select-card'});
    if(action==='interview') await ui.importText(readySave());
    if(action==='culture-book') ui.click({action:'culture-tab'});
    vi.advanceTimersByTime(501);ui.clickNow({action},1);ui.clickNow({action},1);
    expect(ui.app.innerHTML.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))![0]).toContain('aria-expanded="true"');
    vi.advanceTimersByTime(500);ui.clickNow({action},1);
    const button=ui.app.innerHTML.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))![0];
    expect(button).toContain('aria-expanded="false"');
  });
  it('떠나기 전 확인은 시작·대기·진행·저장 성공과 실패·불러오기·가져오기·처음부터·내보내기를 구분한다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    const leaving=(dirty:boolean)=>{
      const ev={preventDefault:vi.fn(),returnValue:'원래'};ui.fireWindow('beforeunload',ev);
      expect(ev.preventDefault.mock.calls.length).toBe(dirty ? 1 : 0);expect(ev.returnValue).toBe(dirty ? '' : '원래');
    };
    leaving(false);ui.click({action:'accept'});leaving(true);ui.click({action:'unqueue'});leaving(false);
    ui.click({action:'end-day'});leaving(true);
    let saved='';const setItem=vi.fn((_key:string,value:string)=>{saved=value;});
    vi.stubGlobal('localStorage',{setItem,getItem:()=>saved});
    ui.click({action:'save'});leaving(false);
    ui.click({action:'end-day'});setItem.mockImplementation(()=>{throw new Error('저장 실패');});
    ui.click({action:'save'});expect(ui.app.innerHTML).toContain('저장할 수 없습니다.');leaving(true);
    ui.click({action:'load'});leaving(false);
    ui.click({action:'end-day'});await ui.importText(saved);leaving(false);
    ui.click({action:'end-day'});ui.click({action:'restart'});leaving(false);
    ui.click({action:'end-day'});ui.click({action:'export'});leaving(false);
    ui.click({action:'accept'});ui.click({action:'export'});leaving(true);
    ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');leaving(false);
  });
  it('CSS는 가로 쓸기와 숨김 입력·건너뛰기 초점을 처리한다',async()=>{
    const {readFileSync}=await vi.importActual<{readFileSync:(path:URL,encoding:string)=>string}>('node:fs');
    const css=readFileSync(new URL('./style.css',import.meta.url),'utf8');
    expect(css).toContain('overscroll-behavior-x: none');
    const hidden=css.match(/\.visually-hidden[^}]+}/)![0];
    expect(hidden).toContain('clip-path: inset(50%)');expect(hidden).not.toContain('display: none');expect(hidden).not.toContain('visibility: hidden');
    expect(css).toContain('.file-btn:has(> input:focus-visible)');
    expect(css).toMatch(/\.skip-links:not\(:focus-within\)[^}]*min-height: 0/);
    expect(css).toMatch(/\.skip-links:focus-within\s*\{[^}]*position: fixed;[^}]*top: .5rem;[^}]*left: .5rem;[^}]*z-index: 30/);
  });
  it('화면 코드 순서는 세 열의 거래·동료·자원·오늘 할 일·지도·보고·기록이다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    const checkOrder=()=>{
      const html=ui.app.innerHTML;
      const trade=html.includes('<div class="maincol">') ? '<div class="maincol">' : '<section class="panel trade"';
      const markers=['class="skip-links"','<div class="masthead">','<div class="statusbar"','</header>','<main',trade,'<aside class="panel crew"','<section class="panel resources"','<section class="panel queue"','<section class="panel world"','<section class="panel report"','<section class="panel log"'];
      const positions=markers.map((m)=>html.indexOf(m));
      positions.forEach((position,index)=>{expect(position).toBeGreaterThanOrEqual(0);if(index)expect(position).toBeGreaterThan(positions[index-1]!);});
      if(html.includes('class="flash-toast')) {expect(html.indexOf('class="flash-toast')).toBeGreaterThan(html.indexOf('</header>'));expect(html.indexOf('class="flash-toast')).toBeLessThan(html.indexOf('<main'));}
    };
    checkOrder();ui.click({action:'map-mode',mode:'world'});checkOrder();
    ui.click({action:'accept'});checkOrder();
    ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');checkOrder();
  });
  it('건너뛰기 두 단추는 첫 정지점이며 제목으로 스크롤하고 초점을 옮긴다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    expect([...ui.app.innerHTML.matchAll(/data-action="([^"]+)"/g)].slice(0,2).map((m)=>m[1])).toEqual(['skip-to','skip-to']);
    for(const target of ['trade-h','queue-h']) {
      ui.scrollIds.length=0;ui.focusIds.length=0;ui.focus.mockClear();
      ui.click({action:'skip-to',target});expect(ui.scrollIds).toEqual([target]);expect(ui.focusIds).toEqual([target]);expect(ui.focus).toHaveBeenCalledExactlyOnceWith({preventScroll:true});
    }
  });
  it.each(['기본','튐 없음','Tab 없음','고정 영역 밖','200ms 뒤','결과 보기','Enter 뒤'])('Shift+Tab 튐 복원(%s)',async(kind)=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    if(kind==='결과 보기') {await culture(ui);ui.click({action:'culture-queue'});ui.click({action:'end-day'});}
    ui.win.scrollY=1200;
    if(kind!=='Tab 없음')ui.fireDoc('keydown',{key:'Tab',shiftKey:true});
    if(kind==='200ms 뒤')vi.advanceTimersByTime(200);
    if(kind==='Enter 뒤')ui.fireDoc('keydown',{key:'Enter'});
    const target=ui.rendered({action:kind==='결과 보기' ? 'culture-result' : kind==='고정 영역 밖' ? 'accept' : 'end-day'});
    // 실제 Chromium 순서: keydown → 화면 이동 → focusin(Claude 검수).
    if(kind!=='튐 없음') ui.win.scrollY=800;
    ui.fireDoc('focusin',{target});
    vi.advanceTimersByTime(16);
    if(kind==='기본'||kind==='결과 보기')expect(ui.win.scrollTo).toHaveBeenCalledExactlyOnceWith(0,1200);
    else expect(ui.win.scrollTo).not.toHaveBeenCalled();
  });
  it('가져오기 입력은 키보드 초점을 받고 같은 label에 이름이 있다',async()=>{
    const ui=await startUi(),label=ui.app.innerHTML.match(/<label class="file-btn">[^<]*<input[^>]+>[\s\S]*?<\/label>/)![0]; await (await import('./main-testkit')).screensReady();
    expect(label).toContain('가져오기');const input=label.match(/<input[^>]+>/)![0];
    expect(input).toContain('type="file"');expect(input).toContain('data-action="import"');expect(input).toContain('class="visually-hidden"');
    expect(input).not.toMatch(/\shidden\b/);expect(input).not.toContain('tabindex="-1"');
  });
  it('결과 보기 Tab 한 번: 하루 진행 다음 동작은 결과 보기다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();await culture(ui);ui.click({action:'culture-queue'});ui.click({action:'end-day'});
    expect(ui.doc.activeElement.dataset.action).toBe('end-day');
    expect(ui.app.innerHTML.split('data-action="end-day"')[1]!.match(/data-action="([^"]+)"/)![1]).toBe('culture-result');
  });
  it('알림 영역은 한 번 만들고 다시 그리기는 읽지 않으며 같은 새 알림은 공백을 바꾼다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    const noRole=()=>{expect(ui.app.innerHTML).not.toContain('role="status"');expect(ui.app.innerHTML).not.toContain('aria-live');};
    noRole();expect(ui.doc.body.insertAdjacentHTML).toHaveBeenCalledExactlyOnceWith('beforeend','<div id="live-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>');
    expect(ui.announcements).toHaveLength(0);ui.click({action:'accept'});noRole();expect(ui.announcements).toHaveLength(1);
    const first=ui.announcements[0]!;
    ui.click({action:'map-mode',mode:'world'});ui.click({action:'crew-filter',filter:'all'});ui.click({action:'select-card'});ui.click({action:'detail'});
    expect(ui.announcements).toHaveLength(1);
    ui.click({action:'accept-fwd'});expect(ui.announcements).toHaveLength(2);
    expect(ui.announcements[1]).not.toBe(first);expect(ui.announcements[1]!.trim()).toBe(first.trim());
    ui.click({action:'unqueue'});expect(ui.announcements).toHaveLength(2);
    ui.click({action:'unqueue'});expect(ui.announcements).toHaveLength(2);
    ui.click({action:'train'});const before=ui.announcements.length;ui.click({action:'end-day'});noRole();
    expect(ui.announcements).toHaveLength(before+1);expect(ui.announcements.at(-1)).toContain('+60 경험치');
    const after=ui.announcements.length;
    ui.click({action:'select-card'});ui.click({action:'detail'});ui.click({action:'crew-filter',filter:'all'});
    expect(ui.announcements).toHaveLength(after);
    const engine=await import('../engine/engine');const spy=vi.spyOn(engine,'commitDay').mockImplementation(()=>{throw new Error('결산 실패');});
    ui.click({action:'end-day'});expect(ui.announcements).toHaveLength(after+1);expect(ui.announcements.at(-1)).toBe('하루 진행에 실패했습니다: 결산 실패');spy.mockRestore();
    let saved='';vi.stubGlobal('localStorage',{setItem:(_k:string,v:string)=>{saved=v;},getItem:()=>saved});
    ui.click({action:'save'});expect(ui.announcements).toHaveLength(after+2);expect(ui.announcements.at(-1)).not.toContain('경험치');
    expect(growthNotice(ui.app.innerHTML)).not.toBeNull();ui.click({action:'load'});expect(ui.announcements).toHaveLength(after+3);expect(ui.announcements.at(-1)).not.toContain('경험치');
    await culture(ui);ui.click({action:'culture-queue'});ui.click({action:'end-day'});noRole();
    expect(ui.announcements.at(-1)).toContain('현지 활동 기록');expect(ui.announcements.at(-1)).not.toContain('경험치');
    const count=ui.announcements.length;ui.click({action:'culture-book'});expect(ui.announcements).toHaveLength(count);
    expect(ui.doc.body.insertAdjacentHTML).toHaveBeenCalledOnce();
  });
  it('카드·운영표는 선택 글자와 의미를 가지며 막대는 이름 있는 영역이다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();ui.click({action:'select-card'});
    const cards=[...ui.app.innerHTML.matchAll(/<article class="card [\s\S]*?<\/article>/g)].map((m)=>m[0]);
    expect(cards.filter((c)=>c.includes('aria-pressed="true"'))).toHaveLength(1);
    expect(cards[0]).toContain('✓ 선택됨');expect(cards[1]).toContain('aria-pressed="false"');expect(cards[1]).not.toContain('✓ 선택됨');
    const rows=[...ui.app.innerHTML.matchAll(/<tr[^>]*data-action="select-card"[\s\S]*?<\/tr>/g)].map((m)=>m[0]);
    rows.forEach((r,index)=>{const tag=r.match(/<tr[^>]*>/)![0];expect(tag).not.toMatch(/tabindex|aria-selected/);expect(r.match(/class="roster-pick"/g)).toHaveLength(1);expect(r).toContain(`aria-pressed="${index===0}"`);expect(r.includes('✓ 선택됨')).toBe(index===0);});
    expect(ui.app.innerHTML).toContain('<div class="statusbar" id="status-h" tabindex="-1" role="region" aria-label="오늘 상태">');
    const other=config.employees[1]!.id;
    ui.keydown(ui.rendered({action:'select-card',emp:other}),'Enter');
    expect(ui.app.innerHTML.match(new RegExp(`<article class="card [^>]*data-emp="${other}"[^>]*>`))![0]).toContain('aria-pressed="true"');
    const before=ui.app.innerHTML;
    const button=ui.app.querySelectorAll('[data-action]').find((e)=>'tagName' in e && e.tagName==='BUTTON'&&e.dataset.action==='select-card'&&e.dataset.emp!==other)!;
    ui.keydown(button,' ');expect(ui.app.innerHTML).toBe(before);
  });
  it('개발 단계 부호 0건은 성장·문화·M1·지연 대응 화면에 적용된다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();
    const clean=()=>expect(ui.app.innerHTML).not.toMatch(/M2a|M2b|LEGACY_FIXED|규칙 M1|규칙 M2|rules-1|M3 사건|DESIGN 가상값|개발용 가상값/);
    clean();expect(ui.app.innerHTML).toContain('가상값');
    ui.click({action:'culture-tab'});ui.click({action:'select-card'});ui.click({action:'detail'});clean();
    const items=(h:string)=>[...h.split('<summary>이 시제품이 가정한 값</summary><ul>')[1]!.split('</ul>')[0]!.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m)=>m[1]);
    const kept=(id:'SCENARIO_M2_MULTI_TRADE'|'SCENARIO_M1_ONE_TRADE')=>assumptionNotes(id).filter((n)=>!/^규칙 [^:]+: /.test(n)).map(esc);
    expect(items(ui.app.innerHTML)).toEqual(kept('SCENARIO_M2_MULTI_TRADE'));expect(kept('SCENARIO_M2_MULTI_TRADE').length).toBeGreaterThan(0);
    ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');clean();
    expect(items(ui.app.innerHTML)).toEqual(kept('SCENARIO_M1_ONE_TRADE'));
    ui.change({action:'scenario'},'SCENARIO_M1_DELAY_ACCEPTED');
    ui.click({action:'accept'});ui.click({action:'assign'});ui.click({action:'book'});
    for(let day=0;day<10&&!ui.app.innerHTML.includes('data-action="keep"');day++)ui.click({action:'end-day'});
    expect(ui.app.innerHTML).toContain('data-action="keep"');clean();
  });
  it('빌드 표시는 정보 접기 안에 있고 고정 막대에는 없다',async()=>{
    const ui=await startUi(); await (await import('./main-testkit')).screensReady();const header=/<details class="build-info"><summary>정보<\/summary><p>빌드 (dev|[0-9a-f]{7}(\+수정)?)<\/p><\/details>/;
    expect(ui.app.innerHTML).toMatch(header);
    ui.change({action:'scenario'},'SCENARIO_M1_ONE_TRADE');expect(ui.app.innerHTML).toMatch(header);
    expect(ui.app.innerHTML.split('<div class="statusbar"')[1]!.split('</header>')[0]).not.toContain('빌드');
  });
});

describe('TASK-0023 경영 보고·일정·결산·필터', () => {
  const initial = (cfg = config) => openDay(createGame(cfg), cfg).state;
  const panel = (html: string, name: string) => html.split(`<section class="panel ${name}"`)[1]!.split('</section>')[0]!;
  const book = (html: string, caption: string) => html.split(`<caption>${caption}</caption>`)[1]!.split('</table>')[0]!;
  const linkHtml = (id: string) => `<button class="link" data-action="goto-contract" data-contract="${esc(id)}" aria-label="${esc(id)} 계약으로 가기">${esc(id)}</button>`;
  const late = (cfg = config) => {
    const accept: Command = { id: 'LATE', type: 'ACCEPT_TRADE', ...tradePairs(cfg)[0]! };
    const c = planState(initial(cfg), cfg, [accept]).state.contracts[0]!;
    const route = routeBetween(cfg, c.originCityId, c.destinationCityId)!;
    const sailing = listSailings(cfg, route.id, initial(cfg).day + 1).find((s) => s.scheduledArrivalDay + cfg.terms.customsDays > c.deliveryDeadlineDay)!;
    const commands: Command[] = [{ ...accept, plan: { employeeId: cfg.employees[0]!.id, sailingId: sailing.id } }];
    const end = runToCampaignEnd(initial(cfg), cfg, { 1: commands }).state;
    return { commands, c, end, receipt: end.contracts[0]!.completedDay! };
  };
  const savedAt = (day: number, commands: Command[], cfg = config) => openDay(runDays(initial(cfg), cfg, day - 1, { 1: commands }).state, cfg).state;
  const poor = () => {
    const cfg = structuredClone(config);
    cfg.startingCash[cfg.payrollCurrency] = cfg.employees.filter((e) => isAvailableFromToday(initial(cfg), e.id)).reduce((a, e) => a + e.salaryPerDayMinor, 0) - 1;
    return { cfg, s: savedAt(initial(cfg).day + 2, [], cfg) };
  };
  const restore = async (ui: Awaited<ReturnType<typeof startUi>>, how: string, s: GameState = initial()) => {
    if (how === 'import') await ui.importText(serializeSave(s));
    if (how === 'load') { vi.stubGlobal('localStorage', { getItem: () => serializeSave(s) }); ui.click({ action: 'load' }); }
    if (how === 'restart') ui.click({ action: 'restart' });
    if (how === 'scenario') ui.change({ action: 'scenario' }, config.id);
  };
  const assertDue = (html: string, s: GameState, cfg = config) => {
    const paymentRows = upcomingPayments(s, cfg);
    const summary = upcomingSummary(paymentRows, cfg);
    const table = html.match(/<table class="money due-table">[\s\S]*?<\/table>/)![0];
    // 통화를 섞은 합계 줄·칸은 속성이 붙어 있어도 줄·칸 수에서 드러난다.
    expect(table.match(/<tr[\s>]/g)).toHaveLength(1 + summary.lines.filter((l) => s.phase !== 'ENDED' || l.kind === 'OVERDUE').length);
    expect(table.match(/<td[\s>]/g)).toHaveLength((table.match(/<tr[\s>]/g)!.length - 1) * summary.currencies.length);
    expect(table.match(/<th[\s>]/g)).toHaveLength(1 + summary.currencies.length + table.match(/<tr[\s>]/g)!.length - 1);
    expect([...table.matchAll(/<th scope="col">(.*?)<\/th>/g)].map((m) => m[1])).toEqual(['항목', ...summary.currencies]);
    const values = [...table.matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(values).toEqual(summary.lines.flatMap((l) => summary.currencies.map((currency) => {
      const matching = paymentRows.filter((r) => r.day !== null && r.kind === l.kind && r.currency === currency);
      return matching.length ? esc(formatMoney(currency, matching.reduce((a, r) => a + r.amountMinor, 0))) : '—';
    })));
    values.forEach((value, i) => expect(value).toMatch(i % summary.currencies.length === 0 ? /^(?:—|.*USD)$/ : /^(?:—|.*원)$/));
  };
  it('보고 머리·미지급금과 확정 기준 문구 수를 유지한다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' });
    expect(panel(ui.app.innerHTML, 'report')).toContain('<h2 id="report-h">경영 보고 <small>하루 진행으로 확정된 상태 · 오늘 할 일은 하루 진행 뒤 반영</small></h2>');
    const rows = [...book(ui.app.innerHTML, '거래 장부 · USD').matchAll(/<tr[^>]*><th>(.*?)<\/th><td>(.*?)<\/td><\/tr>/g)];
    const index = rows.findIndex((r) => r[1] === '자산 합계');
    expect(rows[index + 1]!.slice(1, 3)).toEqual(['미지급금', formatMoney(config.tradeCurrency, companyReport(initial(), config).trade.accountsPayable)]);
    expect(ui.app.innerHTML.match(/금액은 확정 기준/g)).toHaveLength(2);
  });
  it('정시 인도율은 미인도와 늦은 종결 계약을 분리하고 종결 링크를 만들지 않는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    expect(panel(ui.app.innerHTML, 'report')).toContain('<p>정시 인도율: 아직 인도한 계약이 없습니다.</p>');
    const l = late(), past = savedAt(l.c.deliveryDeadlineDay + 1, l.commands);
    await ui.importText(serializeSave(past));
    expect(panel(ui.app.innerHTML, 'report')).toContain(`<p>납기가 지났는데 아직 인도하지 못한 계약: ${linkHtml(l.c.id)} (인도하면 정시 인도율에 들어갑니다)</p>`);
    const completed = savedAt(l.receipt + 1, l.commands); await ui.importText(serializeSave(completed));
    const rate = onTimeDeliveryRate(completed);
    expect(panel(ui.app.innerHTML, 'report')).toContain(`<p>정시 인도율 ${rateKo(rate.rateBasisPoints!)} — 인도 ${rate.delivered}건 중 납기 안 ${rate.onTime}건</p>`);
    expect(panel(ui.app.innerHTML, 'report')).toContain(`<p>납기를 넘겨 인도한 계약: ${esc(l.c.id)}</p>`);
    expect(ui.app.innerHTML).not.toContain(`data-contract="${l.c.id}"`);
  });
  it('앞으로 낼 돈은 통화별 표와 미지급 묶음 줄로 보인다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.click({ action: 'end-day' });
    const s = savedAt(initial().day + 1, [{ id: 'A', type: 'ACCEPT_TRADE', ...tradePairs(config)[0]! }]);
    assertDue(panel(ui.app.innerHTML, 'report'), s);
    const p = poor(); expect(p.s.obligations.length).toBeGreaterThanOrEqual(2);
    await ui.importText(serializeSave(p.s));
    const list = panel(ui.app.innerHTML, 'report').split('<ul class="due-list">')[1]!.split('</ul>')[0]!;
    expect(list.match(/<li>/g)).toHaveLength(1);
    const unpaid = p.s.obligations.filter((o) => o.paidDay === null), first = Math.min(...unpaid.map((o) => o.incurredDay));
    expect(list).toBe(`<li><span>${first}일부터</span>밀린 지급 ${unpaid.length}건 (현금이 들어오면 먼저 갚음) <b>${formatMoney(config.payrollCurrency, -fundsPosition(p.s, config, config.payrollCurrency).unpaidObligations)}</b></li>`);
  });
  it('업무 부하·막힌 곳의 원인 문장과 사람 외 막힘 건수를 보인다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.click({ action: 'end-day' });
    const s = savedAt(initial().day + 1, [{ id: 'A', type: 'ACCEPT_TRADE', ...tradePairs(config)[0]! }]);
    const html = panel(ui.app.innerHTML, 'report'), groups = bottlenecks(s, config);
    for (const line of workloadLinesKo(workloadSummary(s, config), config)) expect(html).toContain(`<li>${esc(line)}</li>`);
    for (const g of groups) for (const i of g.items) expect(html).toContain(`${i.contractId ? linkHtml(i.contractId) + ' ' : ''}${esc(i.textKo)}</li>`);
    const n = groups.filter((g) => g.kind !== '사람').reduce((a, g) => a + g.items.length, 0);
    expect(html).toContain(`<p class="muted small">사람을 더 뽑아도 돈·시간·선복 쪽 막힘 ${n}건은 풀리지 않습니다.</p>`);
  });
  it('계약 링크는 취소 대기 사본에서 사라지고 초점·500ms 막기를 지킨다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.click({ action: 'end-day' });
    const button = ui.rendered({ action: 'goto-contract' }), id = button.dataset.contract!;
    ui.scrollIds.length = 0; ui.focusIds.length = 0; ui.focus.mockClear();
    const count = ui.announcements.length;
    ui.fireDoc('keydown', { key: 'Tab' });
    ui.fireDoc('focusin', { target: button });
    ui.fireDoc('keydown', { key: 'Enter' });
    ui.click({ action: 'goto-contract', contract: id });
    expect(ui.scrollIds).toEqual([`contract-h-${id}`]); expect(ui.focusIds).toEqual([`contract-h-${id}`]);
    expect(ui.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(ui.announcements).toHaveLength(count); expect(ui.win.scrollTo).not.toHaveBeenCalled();
    ui.clickNow({ action: 'cancel', contract: id });
    expect(ui.app.innerHTML).toContain(`id="contract-h-${id}"`);
    ui.click({ action: 'cancel', contract: id });
    expect(ui.app.innerHTML).not.toContain(`id="contract-h-${id}"`);
    expect(panel(ui.app.innerHTML, 'report')).not.toContain(`data-contract="${id}"`);
    expect(panel(ui.app.innerHTML, 'report')).toContain(`${esc(id)} `);
    vi.advanceTimersByTime(501); ui.clickTarget(button);
    expect(ui.scrollIds).toEqual([`contract-h-${id}`]);
  });
  it('품목별 화물 화면은 개·상자를 합치지 않고 두 곳에 같은 목록을 쓴다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    const offers = config.offers.filter((o) => o.kind === 'forwarding');
    for (const o of offers) ui.click({ action: 'accept-fwd', offer: o.id });
    ui.click({ action: 'end-day' });
    const cmds: Command[] = offers.map((o, i) => ({ id: `FWD-${i}`, type: 'ACCEPT_FORWARDING', offerId: o.id }));
    const s = savedAt(initial().day + 1, cmds);
    const text = config.goods.flatMap((g) => {
      const quantity = s.cargoLots.filter((lot) => lot.owner === 'CUSTOMER' && lot.goodId === g.id
        && lot.status !== 'DELIVERED' && lot.status !== 'RETURNED_TO_OWNER').reduce((a, lot) => a + lot.quantity, 0);
      return quantity ? [`${g.nameKo} ${quantity.toLocaleString('ko-KR')}${unitKo(g)}`] : [];
    }).join(' · ');
    expect(cargoListKo(config, heldCargoByGood(s, config, 'CUSTOMER'))).toBe(text);
    const html = panel(ui.app.innerHTML, 'report');
    expect(html.split(`맡은 고객 화물 ${esc(text)}`).length - 1).toBe(2);
    expect(html).toContain(`<li>${esc(`맡은 고객 화물 ${text}는 고객 자산이라 위 표 어디에도 없습니다. 우리 몫은 서비스 대금뿐입니다.`)}</li>`);
    expect(html).not.toContain(`맡은 고객 화물 ${companyReport(s, config).customerCargoUnits}개`);
  });
  it('결산은 끝난 저장에서만 보이며 통화별 표·계약·미지급·종료 표시가 일치한다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); expect(ui.app.innerHTML).not.toContain('id="settlement-h"');
    const s = runToCampaignEnd(initial(), config, { 1: acceptAllFeasible(initial(), config) }).state;
    await ui.importText(serializeSave(s));
    const sum = campaignSummary(s, config), report = panel(ui.app.innerHTML, 'report');
    const settlement = report.split('<div class="settlement">')[1]!.split('\n    <div class="books">')[0]!;
    expect(settlement.match(/<table class="money">/g)).toHaveLength(sum.byCurrency.length);
    expect(settlement.match(/<caption>결산 · /g)).toHaveLength(sum.byCurrency.length);
    for (const st of sum.byCurrency) {
      const table = book(settlement, `결산 · ${st.currency}`), rows = settlementRows(st, config);
      expect(table.match(/<tr[\s>]/g)).toHaveLength(rows.length);
      expect(table.match(/<th[\s>]/g)).toHaveLength(rows.length); expect(table.match(/<td[\s>]/g)).toHaveLength(rows.length);
      expect([...table.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1])).toEqual(rows.map((r) => esc(r[0])));
      expect([...table.matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1])).toEqual(rows.map((r) => formatMoney(st.currency, r[1])));
      const unpaid = sum.unpaidObligations.filter((o) => o.currency === st.currency);
      if (unpaid.length) {
        const first = Math.min(...unpaid.map((o) => o.incurredDay)), last = Math.max(...unpaid.map((o) => o.incurredDay));
        expect(settlement).toContain(`<p>남은 미지급 ${st.currency}: ${formatMoney(st.currency, unpaid.reduce((a, o) => a + o.amountMinor, 0))} — ${unpaid.length}건, ${first === last ? first : `${first}~${last}`}일 발생</p>`);
      }
    }
    const c = sum.contracts;
    expect(settlement).toContain(`<p>계약 ${c.total}건 — 수금 완료 ${c.completed}건 · 인도 뒤 수금 대기 ${c.awaitingPayment}건 · 진행 중 ${c.inProgress}건 · 취소 ${c.cancelled}건</p>`);
    expect(settlement).toContain('<p>받지 못한 대금: 없음</p>');
    expect(settlement).toContain(`<details class="muted small"><summary>남은 미지급 목록 (${sum.unpaidObligations.length}건)</summary>`);
    expect(ui.app.innerHTML).not.toContain(`${config.campaignDays + 1}일`);
    expect(panel(ui.app.innerHTML, 'queue')).toContain(`<small>${config.campaignDays}일 · 캠페인 종료</small>`);
    expect(ui.app.innerHTML).not.toContain('id="schedule-toggle"');
    expect(ui.app.innerHTML).toContain('data-target="settlement-h">결산 보기</button>');
    expect(ui.app.innerHTML).toContain(`${config.titleKo} ${config.campaignDays}일 상태를 불러왔습니다. 이미 공개된 사건은 다시 적용하지 않습니다.`);
    for (const text of ['<h4>업무 부하</h4>', '<h4>막힌 곳</h4>', '지급 가능일']) expect(report).not.toContain(text);
    expect(report).toContain('<caption>남은 미지급 (캠페인 종료)</caption>');
    ui.scrollIds.length = 0; ui.focusIds.length = 0; ui.click({ action: 'skip-to', target: 'settlement-h' });
    expect(ui.scrollIds).toEqual(['settlement-h']); expect(ui.focusIds).toEqual(['settlement-h']);
    vi.stubGlobal('localStorage', { setItem: vi.fn() }); ui.click({ action: 'save' });
    expect(ui.app.innerHTML).toContain(`${config.campaignDays}일 상태를 이 브라우저에 저장했습니다. 대기 중인 명령은 저장하지 않습니다.`);
  });
  it('결산 하루 진행 종료는 읽던 자리 복원 없이 제목으로 이동하고 한 번 알린다', async () => {
    const ui = await startUi(), cmds: Command[] = [{ id: 'UNASSIGNED', type: 'ACCEPT_TRADE', ...tradePairs(config)[0]! }]; await (await import('./main-testkit')).screensReady();
    const s = savedAt(config.campaignDays, cmds); await ui.importText(serializeSave(s));
    const head = `contract-h-${s.contracts[0]!.id}`;
    ui.bounds[head] = { top: 180, bottom: 220, height: 40 };
    ui.afterRender(() => { ui.bounds[head] = { top: 380, bottom: 420, height: 40 }; });
    ui.scrollIds.length = 0; ui.focusIds.length = 0; ui.scrollBy.mockClear();
    const count = ui.announcements.length; ui.click({ action: 'end-day' });
    expect(ui.scrollIds).toEqual(['settlement-h']); expect(ui.doc.activeElement.id).toBe('settlement-h');
    expect(ui.scrollBy).not.toHaveBeenCalled();
    const text = `${config.campaignDays}일 캠페인이 끝났습니다. 경영 보고의 ${config.campaignDays}일 결산에서 통화별 결과를 확인하세요.`;
    expect(ui.app.innerHTML).toContain(`<div class="flash-toast flash info">${text}</div>`);
    expect(ui.announcements.slice(count)).toEqual([text]);
    expect(ui.app.innerHTML).not.toContain(`${config.campaignDays + 1}일`);
  });
  it('일정 화면은 접힘 기본값·500ms 막기·다시 그리기·알림을 지킨다', async () => {
    const ui = await startUi(), count = ui.announcements.length; await (await import('./main-testkit')).screensReady();
    expect(ui.app.innerHTML).toContain('aria-expanded="false" aria-controls="schedule-body"');
    expect(ui.app.innerHTML).not.toContain('id="schedule-body"');
    const header = ui.app.innerHTML.match(/<header class="topbar">[\s\S]*?<\/header>/)![0];
    ui.click({ action: 'schedule-toggle' }); ui.clickNow({ action: 'schedule-toggle' });
    expect(ui.app.innerHTML).toContain('id="schedule-body"');
    ui.click({ action: 'map-mode', mode: 'world' }); ui.click({ action: 'crew-filter', filter: 'all' });
    expect(ui.app.innerHTML).toContain('id="schedule-body"');
    expect(ui.announcements).toHaveLength(count);
    ui.click({ action: 'schedule-toggle' }); expect(ui.app.innerHTML).not.toContain('id="schedule-body"');
    expect(ui.app.innerHTML.match(/<header class="topbar">[\s\S]*?<\/header>/)![0]).toBe(header);
  });
  it.each(['load', 'import', 'restart', 'scenario'])('일정 화면 초기화 (%s)', async (how) => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'end-day' }); ui.click({ action: 'schedule-toggle' });
    expect(ui.app.innerHTML).toContain('id="schedule-body"');
    await restore(ui, how);
    expect(ui.app.innerHTML).toContain('aria-expanded="false" aria-controls="schedule-body"');
    ui.click({ action: 'schedule-toggle' });
    expect(panel(ui.app.innerHTML, 'queue')).not.toContain('>새 일정<');
    expect(panel(ui.app.innerHTML, 'queue')).not.toContain('날짜 바뀜');
    // 되돌린 뒤 대기 명령으로 새 줄을 만들어도 이전 판의 비교 기준이 남아 있지 않다.
    ui.click({ action: 'accept' });
    expect(panel(ui.app.innerHTML, 'queue')).toContain('data-action="goto-contract"');
    expect(panel(ui.app.innerHTML, 'queue')).not.toContain('>새 일정<');
    expect(panel(ui.app.innerHTML, 'queue')).not.toContain('날짜 바뀜');
  });
  it('일정 화면 수락·배정·예약 대기 계약도 링크와 담당 업무 완료 글을 보인다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' });
    const id = ui.rendered({ action: 'cancel' }).dataset.contract!;
    const assignment = ui.rendered({ action: 'assign' }).dataset;
    ui.click({ action: 'assign' }); ui.click({ action: 'book' }); ui.click({ action: 'schedule-toggle' });
    const html = panel(ui.app.innerHTML, 'queue');
    const name = config.employees.find((e) => e.id === assignment.emp)!.nameKo;
    expect(html).toContain(`${linkHtml(id)} ${taskName('EXPORT_PREP')} 완료 — ${esc(name)}`);
  });
  it('일정 화면 날짜 바뀜은 하루 진행 직전 사본과 비교한다', async () => {
    const cfg = structuredClone(config), start = initial(cfg), commands = acceptAllFeasible(start, cfg);
    const end = runToCampaignEnd(start, cfg, { 1: commands }).state;
    const sh = end.shipments[0]!, c = end.contracts.find((c) => c.id === sh.contractId)!, day = sh.arrivalDay!;
    cfg.portRestrictions = [{ eventInstanceId: 'SYNTH-WAIT', templateId: 'SYNTH', cityId: c.destinationCityId,
      announceDay: 1, startDay: day, endDay: day, forecastKo: '시험용 가상 공지' }];
    const ui = await startUi(cfg); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(savedAt(day, commands, cfg)));
    ui.click({ action: 'end-day' }); ui.click({ action: 'schedule-toggle' });
    expect(panel(ui.app.innerHTML, 'queue')).toContain(`<span class="tag">날짜 바뀜 (원래 ${day}일)</span>`);
  });
  it('일정 화면 칸 구조와 보고의 칸 구조는 안쪽 section을 만들지 않는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'schedule-toggle' });
    const queue = ui.app.innerHTML.split('<section class="panel queue"')[1]!.split('<section class="panel world"')[0]!;
    expect(queue.match(/<section/g) ?? []).toHaveLength(0); expect(queue.match(/<\/section>/g)).toHaveLength(1);
    const cut = panel(ui.app.innerHTML, 'queue'); expect(cut).toContain('id="schedule-toggle"');
    expect(cut).toContain('‘예상’은 지금 처리량과 운항표로 계산한 날입니다. 사건이 생기면 바뀔 수 있습니다.');
    for (const s of [savedAt(initial().day + 1, []), runToCampaignEnd(initial(), config).state]) {
      await ui.importText(serializeSave(s));
      const report = ui.app.innerHTML.split('<section class="panel report"')[1]!.split('<section class="panel log"')[0]!;
      expect(report.match(/<section/g) ?? []).toHaveLength(0); expect(report.match(/<\/section>/g)).toHaveLength(1);
    }
  });
  const crewIds = (html: string, tag: 'article' | 'tr') => [...html.matchAll(new RegExp(`<${tag}[^>]*data-action="select-card"[^>]*data-emp="([^"]+)"`, 'g'))].map((m) => m[1]!);
  it('동료 필터는 공개 선택지만 쓰고 카드·운영표를 함께 거르며 알림·막대를 유지한다', async () => {
    const ui = await startUi(), entries = crewEntries(initial(), config, 'all'); await (await import('./main-testkit')).screensReady();
    const options = { roles: [...new Set(entries.map(({ def }) => def.role))],
      attributes: [...new Set(entries.map(({ def }) => def.character.attribute ?? 'none'))] };
    expect(crewFacetOptions(initial(), config)).toEqual(options);
    const html = ui.app.innerHTML, facets = html.split('<div class="crew-facets"')[1]!.split('</div>')[0]!;
    expect(html.indexOf('class="crew-facets"')).toBeGreaterThan(html.indexOf('class="seg crew-filter"'));
    expect(html.indexOf('class="crew-facets"')).toBeLessThan(html.indexOf('class="crew-cards"'));
    for (const role of options.roles) expect(facets).toContain(`<option value="${role}" >${roleKo(role)}</option>`);
    for (const a of options.attributes) expect(facets).toContain(`<option value="${a}" >${attributeKo(a)}</option>`);
    for (const e of config.employees.filter((e) => !entries.some(({ def }) => def.id === e.id))) {
      const attr = e.character.attribute ?? 'none';
      if (!options.attributes.includes(attr)) expect(facets).not.toContain(`value="${attr}"`);
    }
    const count = ui.announcements.length, header = html.match(/<header class="topbar">[\s\S]*?<\/header>/)![0];
    const role = config.employees[0]!.role, attr = config.employees[0]!.character.attribute!;
    ui.doc.activeElement = ui.rendered({ action: 'crew-role' });
    ui.change({ action: 'crew-role' }, role); expect(ui.doc.activeElement.id).toBe('crew-role');
    expect(crewIds(ui.app.innerHTML, 'article')).toEqual(entries.filter(({ def }) => def.role === role).map(({ def }) => def.id));
    expect(crewIds(ui.app.innerHTML, 'tr')).toEqual(crewIds(ui.app.innerHTML, 'article'));
    ui.change({ action: 'crew-role' }, ''); ui.change({ action: 'crew-attr' }, attr);
    expect(crewIds(ui.app.innerHTML, 'article')).toEqual(entries.filter(({ def }) => def.character.attribute === attr).map(({ def }) => def.id));
    expect(crewIds(ui.app.innerHTML, 'tr')).toEqual(crewIds(ui.app.innerHTML, 'article'));
    const other = options.roles.find((r) => r !== role)!; ui.change({ action: 'crew-role' }, other);
    expect(ui.app.innerHTML).toContain('이 조건의 동료가 없습니다.');
    expect(ui.announcements).toHaveLength(count);
    expect(ui.app.innerHTML.match(/<header class="topbar">[\s\S]*?<\/header>/)![0]).toBe(header);
  });
  it.each(['load', 'import', 'restart', 'scenario'])('동료 필터 초기화 (%s)', async (how) => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.change({ action: 'crew-role' }, config.employees[0]!.role);
    ui.change({ action: 'crew-attr' }, config.employees[0]!.character.attribute!); await restore(ui, how);
    for (const action of ['crew-role', 'crew-attr']) expect(ui.app.innerHTML.split(`data-action="${action}"`)[1]!.split('</select>')[0]).toContain('<option value="" selected>전체</option>');
    expect(crewIds(ui.app.innerHTML, 'article')).toEqual(crewEntries(initial(), config, 'all').map(({ def }) => def.id));
    expect(crewIds(ui.app.innerHTML, 'tr')).toEqual(crewIds(ui.app.innerHTML, 'article'));
  });
  it('동료 필터 M1은 선택지가 하나라 필터를 그리지 않는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.change({ action: 'scenario' }, 'SCENARIO_M1_ONE_TRADE');
    expect(ui.app.innerHTML).not.toContain('class="crew-facets"');
  });
  it('구조·키보드 회귀는 새 조작을 기존 영역 안에 두고 양수 tabindex를 쓰지 않는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.click({ action: 'end-day' });
    const html = ui.app.innerHTML;
    for (const [marker, before, after] of [
      ['class="crew-facets"', '<aside class="panel crew"', '<section class="panel resources"'],
      ['id="schedule-toggle"', '<section class="panel queue"', '<section class="panel world"'],
      ['data-action="goto-contract"', '<section class="panel report"', '<section class="panel log"'],
    ]) {
      const from = html.indexOf(before!), to = html.indexOf(after!);
      expect(html.indexOf(marker!, from)).toBeGreaterThan(from); expect(html.indexOf(marker!, from)).toBeLessThan(to);
    }
    expect(html).not.toMatch(/tabindex="[1-9]/);
  });
  it('이스케이프는 일정·보고 계약 링크·필터 이름에 위험 글자를 남기지 않는다', async () => {
    const cfg = structuredClone(config), bad = '<img src=x onerror=alert(1)>';
    cfg.employees.forEach((e) => { e.nameKo = bad; e.role = bad + e.role; });
    cfg.cities.forEach((c) => { c.nameKo = bad; }); cfg.goods.forEach((g) => { g.nameKo = bad; });
    const s = planState(initial(cfg), cfg, [{ id: 'ESCAPE', type: 'ACCEPT_TRADE', ...tradePairs(cfg)[0]! }]).state;
    const c = s.contracts[0]!, old = c.id; c.id = bad;
    s.cargoLots.forEach((lot) => { if (lot.contractId === old) lot.contractId = c.id; });
    s.tasks.forEach((t) => { if (t.contractId === old) t.contractId = c.id; });
    const assigned = planState(s, cfg, [{ id: 'ASSIGN', type: 'ASSIGN_TASK', taskId: c.prepTaskId, employeeId: cfg.employees[0]!.id }]).state;
    const ui = await startUi(cfg); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(assigned)); ui.click({ action: 'schedule-toggle' });
    expect(ui.app.innerHTML).not.toContain(bad); expect(ui.app.innerHTML).toContain(esc(bad));
    expect(panel(ui.app.innerHTML, 'report')).toContain(linkHtml(assigned.contracts[0]!.id));
    expect(panel(ui.app.innerHTML, 'queue')).toContain(esc(bad));
    expect(ui.app.innerHTML.split('<div class="crew-facets"')[1]!.split('</div>')[0]).toContain(esc(bad));
  });
  // ── Claude 검수 수정 ──
  const firstTrade = (id = 'FIRST-TRADE'): Command => ({ id, type: 'ACCEPT_TRADE', ...tradePairs(config)[0]! });
  /** 관세를 즉시 현금으로만 내게 하고 세율을 높여 거래 통화 미지급을 만든다. */
  const dutyShort = () => {
    const cfg = structuredClone(config); cfg.rules.fundsCheck = 'IMMEDIATE_CASH'; cfg.terms.dutyRateBasisPoints = 20000;
    return cfg;
  };
  const moneyKo = (rows: { currency: string; amountMinor: number }[], cfg = config) => [...new Set([cfg.tradeCurrency, cfg.payrollCurrency])]
    .flatMap((currency) => { const m = rows.filter((r) => r.currency === currency); return m.length ? [formatMoney(currency, m.reduce((a, r) => a + r.amountMinor, 0))] : []; }).join(' · ');
  it('끝난 캠페인에서는 새 명령을 거절하고 숨은 대기 명령을 만들지 않는다', async () => {
    const end = runToCampaignEnd(initial(), config, { 1: [firstTrade()] }).state, id = end.contracts[0]!.id;
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(end));
    const notice = `${config.campaignDays}일 캠페인이 끝나 새 명령을 넣을 수 없습니다. 결산은 경영 보고에 있습니다.`;
    for (const dataset of [{ action: 'cancel', contract: id }, { action: 'assign' }] as Record<string, string>[]) {
      ui.click(dataset);
      expect(ui.app.innerHTML).toContain(`<div class="flash-toast flash warn">${notice}</div>`);
      expect(panel(ui.app.innerHTML, 'queue')).toContain(`<p class="flash warn">${notice}</p>`);
      expect(ui.app.innerHTML).not.toContain('오늘 할 일에 넣었습니다');
      expect(ui.app.innerHTML).toContain(`id="contract-h-${id}"`);
      expect(ui.app.innerHTML).not.toContain('data-action="unqueue"');
    }
    const ev = { preventDefault: vi.fn(), returnValue: '원래' }; ui.fireWindow('beforeunload', ev);
    expect(ev.preventDefault).not.toHaveBeenCalled(); expect(ev.returnValue).toBe('원래');
  });
  it('일정 표시·지급 표·결산 표 CSS는 표시 상자·순번 없음·통화 열 정렬·위 맞춤을 둔다', async () => {
    const {readFileSync}=await vi.importActual<{readFileSync:(path:URL,encoding:string)=>string}>('node:fs');
    const css=readFileSync(new URL('./style.css',import.meta.url),'utf8');
    expect(css).toMatch(/\.schedule-block \.tag\s*\{[^}]*display:\s*inline-block;[^}]*border:\s*1px solid var\(--line\);[^}]*font-size:\s*12px;/);
    expect(css).toMatch(/\.schedule-block \.tag:not\(\.tag-estimate\)\s*\{[^}]*border-color:\s*var\(--navy-soft\);[^}]*color:\s*var\(--navy-soft\);/);
    expect(css).toMatch(/\.schedule-days\s*\{\s*list-style:\s*none;\s*padding-left:\s*0;\s*\}/);
    expect(css).toMatch(/\.schedule-days > li \+ li\s*\{\s*margin-top:\s*10px;\s*\}/);
    expect(css).toMatch(/\.due-table thead th:not\(:first-child\)\s*\{\s*text-align:\s*right;\s*\}/);
    expect(css).toMatch(/\.settlement \.books\s*\{\s*align-items:\s*start;\s*\}/);
    // 터치 크기는 any-pointer로만 건다. 주 입력이 마우스인 터치 노트북에서도 44px가 되어야 한다.
    expect(css).not.toMatch(/\(\s*pointer\s*:\s*coarse\s*\)/);
    expect(css).toMatch(/@media \(any-pointer: coarse\)\s*\{[^}]*#schedule-toggle[^}]*min-height:\s*44px/);
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.click({ action: 'assign' }); ui.click({ action: 'book' }); ui.click({ action: 'schedule-toggle' });
    const q = panel(ui.app.innerHTML, 'queue');
    expect(q).toContain(' <span class="tag tag-estimate">예상</span>');
    expect(q).not.toContain('<span class="tag">예상</span>');
  });
  it('앞으로 낼 돈은 날짜 미정 지급을 원인별 문장으로 표 밖에 적는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    const c = planState(initial(), config, [firstTrade()]).state.contracts[0]!;
    const route = routeBetween(config, c.originCityId, c.destinationCityId)!;
    const lastDeparture = Math.max(...listSailings(config, route.id).map((sailing) => sailing.departureDay));
    const unbooked = '운송편을 아직 예약하지 않아 관세 낼 날을 정하지 못한 지급이';
    const noSailing = '캠페인 안에 실을 자리가 남은 출항편이 없어 날짜를 정하지 못한 지급이';
    // 예약 전 2일: 관세만 날짜가 없다.
    const day2 = savedAt(initial().day + 1, [firstTrade()]), nulls2 = upcomingPayments(day2, config).filter((r) => r.day === null);
    expect(nulls2.map((r) => r.kind)).toEqual(['DUTY']);
    await ui.importText(serializeSave(day2));
    let report = panel(ui.app.innerHTML, 'report');
    expect(report).toContain(`<p class="muted small">${unbooked} ${nulls2.length}건(${moneyKo(nulls2)}) 있습니다. 위 표에는 넣지 않았습니다.</p>`);
    expect(report).not.toContain(noSailing); expect(report).not.toContain('실을 편이 없어');
    assertDue(report, day2);
    // 그 노선의 마지막 출항일: 남은 출항편이 없어 운임·관세 모두 날짜가 없다.
    const ended = savedAt(lastDeparture, [firstTrade()]), nullsEnd = upcomingPayments(ended, config).filter((r) => r.day === null);
    expect(nullsEnd.map((r) => r.kind).sort()).toEqual(['DUTY', 'FREIGHT']);
    await ui.importText(serializeSave(ended));
    report = panel(ui.app.innerHTML, 'report');
    expect(report).toContain(`<p class="muted small">${noSailing} ${nullsEnd.length}건(${moneyKo(nullsEnd)}) 있습니다. 위 표에는 넣지 않았습니다.</p>`);
    expect(report).not.toContain(unbooked);
    assertDue(report, ended);
  });
  it('끝난 결산의 정시 인도율은 끝난 상태 문장으로 한 번만 보인다', async () => {
    const end = runToCampaignEnd(initial(), config, { 1: [firstTrade()] }).state, r = onTimeDeliveryRate(end);
    expect(r.delivered).toBe(0); expect(r.pastDeadlineUndelivered).toBeGreaterThan(0);
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(end));
    const report = panel(ui.app.innerHTML, 'report');
    const links = end.contracts.filter((c) => c.status !== 'CANCELLED' && c.deliveredDay === null && c.deliveryDeadlineDay < end.day).map((c) => linkHtml(c.id)).join(', ');
    const lines = `<p>정시 인도율: 인도한 계약이 없습니다.</p><p>납기 안에 인도하지 못하고 캠페인이 끝난 계약: ${links} (인도하지 않아 정시 인도율에 넣지 않았습니다)</p>`;
    expect(report.split(lines).length - 1).toBe(1);
    expect(report.split('<div class="settlement">')[1]!.split('\n    <div class="books">')[0]).toContain(lines);
    expect(report.split('<div class="report-ops">')[1]).not.toContain('정시 인도율');
    for (const old of ['아직 인도한 계약이 없습니다', '인도하면 정시 인도율에 들어갑니다', '납기가 지났는데']) expect(report).not.toContain(old);
  });
  it('결산의 남은 미지급 목록은 이유 글에 없는 발생일만 앞에 붙인다', async () => {
    const cfg = dutyShort(), end = runToCampaignEnd(initial(cfg), cfg, { 1: acceptAllFeasible(initial(cfg), cfg) }).state;
    const unpaid = campaignSummary(end, cfg).unpaidObligations;
    const duty = unpaid.filter((o) => o.currency === cfg.tradeCurrency), wages = unpaid.filter((o) => o.currency === cfg.payrollCurrency);
    expect(duty.length).toBeGreaterThan(0); expect(wages.length).toBeGreaterThan(0);
    for (const o of duty) expect(o.reasonKo).not.toMatch(/\d일/);
    for (const o of wages) expect(o.reasonKo).toContain(`${o.incurredDay}일`);
    const ui = await startUi(cfg); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(end));
    const list = panel(ui.app.innerHTML, 'report').split(`<summary>남은 미지급 목록 (${unpaid.length}건)</summary><ul>`)[1]!.split('</ul>')[0]!;
    expect(list).toBe(unpaid.map((o) => `<li>${o.currency === cfg.tradeCurrency ? `${o.incurredDay}일 ` : ''}${esc(o.reasonKo)} ${formatMoney(o.currency, o.amountMinor)}</li>`).join(''));
  });
  it('거래 통화 미지급은 USD 표·밀린 지급 줄·막힌 곳에 USD로만 보인다', async () => {
    const cfg = dutyShort(), cmds = acceptAllFeasible(initial(cfg), cfg);
    let s = initial(cfg);
    for (let day = s.day + 1; day <= cfg.campaignDays && !fundsPosition(s, cfg, cfg.tradeCurrency).unpaidObligations; day++) s = savedAt(day, cmds, cfg);
    const unpaid = fundsPosition(s, cfg, cfg.tradeCurrency).unpaidObligations, ap = companyReport(s, cfg).trade.accountsPayable;
    expect(unpaid).toBeGreaterThan(0); expect(ap).toBeGreaterThan(0);
    expect(fundsPosition(s, cfg, cfg.payrollCurrency).unpaidObligations).toBe(0);
    const ui = await startUi(cfg); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(s));
    const report = panel(ui.app.innerHTML, 'report');
    const rows = [...book(ui.app.innerHTML, '거래 장부 · USD').matchAll(/<tr[^>]*><th>(.*?)<\/th><td>(.*?)<\/td><\/tr>/g)];
    expect(rows[rows.findIndex((r) => r[1] === '자산 합계') + 1]!.slice(1, 3)).toEqual(['미지급금', formatMoney(cfg.tradeCurrency, ap)]);
    const usdRows = s.obligations.filter((o) => o.paidDay === null && o.currency === cfg.tradeCurrency), first = Math.min(...usdRows.map((o) => o.incurredDay));
    const list = report.split('<ul class="due-list">')[1]!.split('</ul>')[0]!;
    expect(list.startsWith(`<li><span>${first}일부터</span>밀린 지급 ${usdRows.length}건 (현금이 들어오면 먼저 갚음) <b>${formatMoney(cfg.tradeCurrency, -unpaid)}</b></li>`)).toBe(true);
    expect(list.match(/밀린 지급/g)).toHaveLength(1);
    expect(report).toContain(`<li><b>돈</b> `);
    expect(report).toContain(`<li>미지급금이 ${formatMoney(cfg.tradeCurrency, unpaid)} 있습니다. 현금이 들어오면 먼저 갚습니다.</li>`);
    assertDue(report, s, cfg);
  });
  it('거래 이익이 없고 원화 급여가 밀리면 이유 줄과 막힌 곳은 금액 뒤 조사 없이 쓴다', async () => {
    const p = poor(), r = companyReport(p.s, p.cfg);
    expect(r.trade.profit).toBeLessThanOrEqual(0); expect(r.payroll.accountsPayable).toBeGreaterThan(0);
    const ui = await startUi(p.cfg); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(p.s));
    const report = panel(ui.app.innerHTML, 'report');
    expect(report).toContain(`<li>${esc(`원화 미지급 급여가 ${formatMoney(p.cfg.payrollCurrency, r.payroll.accountsPayable)} 있습니다. 달러 현금 ${formatMoney(p.cfg.tradeCurrency, r.trade.cash)}로는 원화 급여를 낼 수 없습니다. 이번 판에는 달러를 원화로 바꾸는 기능이 없습니다.`)}</li>`);
    expect(report).toContain(`<li>미지급금이 ${formatMoney(p.cfg.payrollCurrency, fundsPosition(p.s, p.cfg, p.cfg.payrollCurrency).unpaidObligations)} 있습니다. 현금이 들어오면 먼저 갚습니다.</li>`);
    for (const wrong of ['원가 있습니다', '원이 있습니다', 'USD이 있습니다']) expect(report).not.toContain(wrong);
  });
  it('경영 보고는 대기 명령이 있어도 확정 상태만 읽는다', async () => {
    const ui = await startUi(), before = panel(ui.app.innerHTML, 'report'); await (await import('./main-testkit')).screensReady();
    expect(before).toContain(`<ul class="workload">${workloadLinesKo(workloadSummary(initial(), config), config).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`);
    expect(before).toContain('<ul class="bottleneck"><li><b>돈</b> 없음</li><li><b>시간</b> 없음</li><li><b>사람</b> 없음</li><li><b>선복</b> 없음</li></ul>');
    ui.click({ action: 'accept' });
    expect(ui.app.innerHTML).toContain('data-action="cancel"');
    expect(panel(ui.app.innerHTML, 'report')).toBe(before);
    // 2일: 확정된 계약에 배정·예약을 대기열에 넣어도 보고는 그대로다.
    ui.click({ action: 'end-day' });
    const day2 = panel(ui.app.innerHTML, 'report');
    ui.click({ action: 'assign' }); ui.click({ action: 'book' });
    expect(ui.app.innerHTML.match(/data-action="unqueue"/g)).toHaveLength(2);
    expect(panel(ui.app.innerHTML, 'report')).toBe(day2);
  });
  it('보고와 일정의 7일 창은 캠페인 마지막 날에서 자른다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    for (const day of [initial().day + 1, config.campaignDays - 5, config.campaignDays - 4, config.campaignDays]) {
      await ui.importText(serializeSave(savedAt(day, [])));
      const to = Math.min(config.campaignDays, day + 6);
      expect(panel(ui.app.innerHTML, 'report')).toContain(`<caption>앞으로 낼 돈 (${day === to ? day : `${day}~${to}`}일)</caption>`);
      expect(panel(ui.app.innerHTML, 'queue')).toContain(`aria-controls="schedule-body">앞으로 ${to - day + 1}일 일정 (`);
      expect(ui.app.innerHTML).not.toContain(`${config.campaignDays + 1}일`);
    }
  });
  it('결산 표의 행 이름·값·합계 줄과 결산 문장은 정한 순서와 같다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    for (const s of [runToCampaignEnd(initial(), config, { 1: acceptAllFeasible(initial(), config) }).state, runToCampaignEnd(initial(), config).state]) {
      await ui.importText(serializeSave(s));
      const sum = campaignSummary(s, config), report = panel(ui.app.innerHTML, 'report');
      const settlement = report.split('<div class="settlement">')[1]!.split('\n    <div class="books">')[0]!;
      expect(settlement.startsWith(`<h3 id="settlement-h" tabindex="-1">${config.campaignDays}일 결산</h3><p>통화마다 따로 결산합니다. USD와 KRW는 더하지 않습니다.</p><div class="books"><table class="money"><caption>결산 · `)).toBe(true);
      expect([...settlement.matchAll(/<caption>결산 · (.*?)<\/caption>/g)].map((m) => m[1])).toEqual([config.tradeCurrency, config.payrollCurrency]);
      for (const st of sum.byCurrency) {
        const trade = st.currency === config.tradeCurrency;
        if (!trade) expect([st.inventory, st.prepaidFreight, st.forwardingWip, st.accountsReceivable, st.contractContribution]).toEqual([0, 0, 0, 0, 0]);
        const expected: [string, number, boolean][] = [['현금', st.cash, false],
          ...(trade ? [['재고', st.inventory, false], ['선급운임', st.prepaidFreight, false], ['주선 진행원가', st.forwardingWip, false], ['매출채권', st.accountsReceivable, false]] as [string, number, boolean][] : []),
          ['자산 합계', st.totalAssets, true], ['미지급금', st.accountsPayable, false], ['순자산 (자산 − 미지급금)', st.netAssets, true],
          ['시작 자본', st.openingEquity, false], ['손익', st.profit, false],
          ...(trade ? [['계약 기여이익 합계', st.contractContribution, false]] as [string, number, boolean][] : [])];
        const table = book(settlement, `결산 · ${st.currency}`);
        expect([...table.matchAll(/<tr( class="total")?><th>(.*?)<\/th><td>(.*?)<\/td><\/tr>/g)].map((m) => [m[2], m[3], Boolean(m[1])]))
          .toEqual(expected.map(([label, value, total]) => [label, formatMoney(st.currency, value), total]));
      }
      const r = onTimeDeliveryRate(s);
      const rate = r.delivered ? `<p>정시 인도율 ${rateKo(r.rateBasisPoints!)} — 인도 ${r.delivered}건 중 납기 안 ${r.onTime}건</p>` : '<p>정시 인도율: 인도한 계약이 없습니다.</p>';
      expect(settlement).toContain(rate); expect(report.split(rate).length - 1).toBe(1);
    }
  });
  it('동료 필터에서 고른 값은 다시 그린 뒤에도 선택된 채 남는다', async () => {
    const ui = await startUi(), role = config.employees[0]!.role, attr = config.employees[0]!.character.attribute!; await (await import('./main-testkit')).screensReady();
    const select = (action: string) => ui.app.innerHTML.split(`data-action="${action}"`)[1]!.split('</select>')[0]!;
    ui.change({ action: 'crew-role' }, role);
    expect(select('crew-role')).toContain(`<option value="${role}" selected>`); expect(select('crew-role')).not.toContain('<option value="" selected>');
    ui.click({ action: 'map-mode', mode: 'world' });
    expect(select('crew-role')).toContain(`<option value="${role}" selected>`);
    ui.change({ action: 'crew-role' }, ''); ui.change({ action: 'crew-attr' }, attr);
    expect(select('crew-attr')).toContain(`<option value="${attr}" selected>`); expect(select('crew-attr')).not.toContain('<option value="" selected>');
    expect(select('crew-role')).toContain('<option value="" selected>전체</option>');
  });
  it('인도를 마친 다음 날 보고의 재고와 맡은 화물은 없음이다', async () => {
    const commands = acceptAllFeasible(initial(), config), end = runToCampaignEnd(initial(), config, { 1: commands }).state;
    const s = savedAt(Math.max(...end.contracts.map((c) => c.deliveredDay!)) + 1, commands);
    for (const owner of ['COMPANY', 'CUSTOMER']) expect(s.cargoLots.some((l) => l.owner === owner && l.status === 'DELIVERED')).toBe(true);
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(s));
    const report = panel(ui.app.innerHTML, 'report');
    expect(report).toContain('<th>재고 (없음)</th>');
    expect(report).toContain('맡은 고객 화물 없음 — 회사 자산이 아니라 표에 넣지 않습니다.');
  });
  it('끝나는 하루 진행 직후 500ms 안의 누름은 무시하고 그 뒤에는 받는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(savedAt(config.campaignDays, [firstTrade()])));
    ui.click({ action: 'end-day' });
    ui.scrollIds.length = 0; ui.clickNow({ action: 'skip-to', target: 'settlement-h' });
    expect(ui.scrollIds).toEqual([]);
    vi.advanceTimersByTime(501); ui.clickNow({ action: 'skip-to', target: 'settlement-h' });
    expect(ui.scrollIds).toEqual(['settlement-h']);
  });
  it('마지막 날 거절된 명령이 있으면 종료 알림은 경고로 거절 이유를 앞에 둔다', async () => {
    const cfg = structuredClone(config); cfg.campaignDays = initial().day;
    const ui = await startUi(cfg); await (await import('./main-testkit')).screensReady();
    ui.click({ action: 'accept' });
    const assign = ui.rendered({ action: 'assign' }).dataset;
    ui.click({ action: 'assign', task: assign.task!, emp: assign.emp! });
    ui.click({ action: 'unqueue', command: ui.rendered({ action: 'unqueue' }).dataset.command! });
    const reason = panel(ui.app.innerHTML, 'queue').match(/<li class="bad">.*? — (.*?)<button/)![1]!;
    ui.scrollIds.length = 0; const count = ui.announcements.length;
    ui.click({ action: 'end-day' });
    const text = `실행하지 못한 명령: ${reason} ${cfg.campaignDays}일 캠페인이 끝났습니다. 경영 보고의 ${cfg.campaignDays}일 결산에서 통화별 결과를 확인하세요.`;
    expect(ui.app.innerHTML).toContain(`<div class="flash-toast flash warn">${text}</div>`);
    expect(ui.scrollIds).toEqual(['settlement-h']);
    expect(ui.announcements.slice(count)).toEqual([text]);
  });
  it('막힌 곳 목록은 묶음마다 건수와 계약 막힘 문장을 정한 순서로 보인다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.click({ action: 'end-day' });
    const s = savedAt(initial().day + 1, [firstTrade()]), c = s.contracts[0]!, blockers = contractProgress(s, config, c).blockers;
    expect(blockers.map((b) => b.code)).toEqual(['TASK_UNASSIGNED', 'NO_BOOKING', 'NEXT_SAILING_LATE']);
    const one = (code: string) => `1건<ul><li>${linkHtml(c.id)} ${esc(blockers.find((b) => b.code === code)!.messageKo)}</li></ul>`;
    const notPeople = blockers.filter((b) => ['NO_BOOKING', 'NEXT_SAILING_LATE'].includes(b.code)).length;
    expect(panel(ui.app.innerHTML, 'report')).toContain(`<ul class="bottleneck"><li><b>돈</b> 없음</li><li><b>시간</b> ${one('NEXT_SAILING_LATE')}</li><li><b>사람</b> ${one('TASK_UNASSIGNED')}</li><li><b>선복</b> ${one('NO_BOOKING')}</li></ul><p class="muted small">사람을 더 뽑아도 돈·시간·선복 쪽 막힘 ${notPeople}건은 풀리지 않습니다.</p>`);
  });
  it('운임·관세 목록 줄·매출채권 이유 줄·끝난 표와 종료 안내는 전체 문장으로 보인다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.click({ action: 'end-day' });
    const s = savedAt(initial().day + 1, [firstTrade()]);
    const [freight, duty] = upcomingPayments(s, config).filter((r) => r.kind === 'FREIGHT' || r.kind === 'DUTY');
    expect([freight!.kind, freight!.day !== null, duty!.kind, duty!.day]).toEqual(['FREIGHT', true, 'DUTY', null]);
    let report = panel(ui.app.innerHTML, 'report');
    expect(report.split('<ul class="due-list">')[1]!.split('</ul>')[0]).toBe(
      `<li><span>${freight!.day}일까지</span>${linkHtml(freight!.contractId!)} 운송편 예약 때 운임 선지급 <b>${formatMoney(freight!.currency, -freight!.amountMinor)}</b></li>`
      + `<li><span>날짜 미정</span>${linkHtml(duty!.contractId!)} 도착 때 수입 관세 (회사 부담 · DDP 유사 단순화) <b>${formatMoney(duty!.currency, -duty!.amountMinor)}</b></li>`);
    expect(report).toContain('</table><p class="muted small">통화가 달라 USD와 KRW를 더하지 않습니다.</p>');
    // 끝난 표는 밀린 지급 한 줄이고 오늘 할 일은 종료 안내를 쓴다.
    await ui.importText(serializeSave(runToCampaignEnd(initial(), config, { 1: acceptAllFeasible(initial(), config) }).state));
    report = panel(ui.app.innerHTML, 'report');
    const table = report.match(/<table class="money due-table">[\s\S]*?<\/table>/)![0];
    expect(table.match(/<tr[\s>]/g)).toHaveLength(2);
    expect([...table.matchAll(/<th scope="row">(.*?)<\/th>/g)].map((m) => m[1])).toEqual(['밀린 지급 (현금이 들어오면 먼저 갚음)']);
    expect(panel(ui.app.innerHTML, 'queue')).toContain('<p class="muted">캠페인이 끝났습니다. 결산은 경영 보고에 있습니다.</p><button class="link" data-action="skip-to" data-target="settlement-h">결산 보기</button>');
    // 인도했지만 수금 전: 매출채권 이유 줄의 계약 ID는 링크다.
    const cfg = structuredClone(config); cfg.terms.paymentDueDay = cfg.campaignDays;
    const commands = acceptAllFeasible(initial(cfg), cfg), end = runToCampaignEnd(initial(cfg), cfg, { 1: commands }).state;
    const waiting = savedAt(end.contracts[0]!.deliveredDay! + 1, commands, cfg);
    const open = waiting.invoices.filter((i) => i.status !== 'PAID').sort((a, b) => a.dueDay - b.dueDay);
    expect(open.length).toBeGreaterThan(0);
    for (const i of open) expect(['ACTIVE', 'IN_PROGRESS']).toContain(waiting.contracts.find((c) => c.id === i.contractId)!.status);
    const ui2 = await startUi(cfg); await (await import('./main-testkit')).screensReady(); await ui2.importText(serializeSave(waiting));
    expect(panel(ui2.app.innerHTML, 'report')).toContain(`<li>매출 ${formatMoney(cfg.tradeCurrency, companyReport(waiting, cfg).trade.accountsReceivable)}는 이미 이익에 들어갔지만 현금은 나중에 들어옵니다 (매출채권: ${open.map((i) => `${linkHtml(i.contractId)} ${i.dueDay}일 ${formatMoney(i.currency, i.amountMinor)}`).join(', ')}).</li>`);
  });
  it('동료 필터 선택지 글은 직무·속성의 한국어 이름이다', async () => {
    const roles: Record<string, string> = { sales: '영업', operations: '운영' };
    const attributes: Record<string, string> = { water: '물', fire: '불', wind: '바람', earth: '대지', light: '빛', shadow: '그림자', none: '속성 미정' };
    const ui = await startUi(), options = crewFacetOptions(initial(), config); await (await import('./main-testkit')).screensReady();
    const facets = ui.app.innerHTML.split('<div class="crew-facets"')[1]!.split('</div>')[0]!;
    expect(options.roles.length).toBeGreaterThan(1); expect(options.attributes.length).toBeGreaterThan(1);
    for (const role of options.roles) expect(facets).toContain(`<option value="${role}" >${roles[role]}</option>`);
    for (const a of options.attributes) expect(facets).toContain(`<option value="${a}" >${attributes[a]}</option>`);
  });
  it('정시 인도율 목록은 마감일 인도를 정시로 보고 오늘 납기·취소 계약을 넣지 않는다', async () => {
    const l = late(), s = structuredClone(savedAt(l.receipt + 1, l.commands)), base = s.contracts.find((c) => c.id === l.c.id)!;
    expect(base.deliveredDay! > base.deliveryDeadlineDay).toBe(true);
    const add = (suffix: string, patch: Partial<Contract>) => { const c = { ...structuredClone(base), ...patch, id: `${base.id}-${suffix}` }; s.contracts.push(c); return c; };
    add('ONTIME', { deliveredDay: base.deliveryDeadlineDay });
    const past = add('PAST', { status: 'ACTIVE', deliveredDay: null, completedDay: null, deliveryDeadlineDay: s.day - 1 });
    add('TODAY', { status: 'ACTIVE', deliveredDay: null, completedDay: null, deliveryDeadlineDay: s.day });
    add('CANCEL', { status: 'CANCELLED', cancelledDay: s.day - 3, deliveredDay: null, completedDay: null, deliveryDeadlineDay: s.day - 2 });
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(s));
    const r = onTimeDeliveryRate(s);
    expect(panel(ui.app.innerHTML, 'report')).toContain(`<p>정시 인도율 ${rateKo(r.rateBasisPoints!)} — 인도 ${r.delivered}건 중 납기 안 ${r.onTime}건</p><p>납기를 넘겨 인도한 계약: ${esc(l.c.id)}</p><p>납기가 지났는데 아직 인도하지 못한 계약: ${linkHtml(past.id)} (인도하면 정시 인도율에 들어갑니다)</p>`);
  });
  it('정시 인도율의 납기 지난 목록은 실제로 취소한 계약을 넣지 않는다', async () => {
    const forwarding: Command = { id: 'KEEP-FWD', type: 'ACCEPT_FORWARDING', offerId: config.offers.filter((o) => o.kind === 'forwarding')[0]!.id };
    const planned = planState(initial(), config, [firstTrade(), forwarding]).state;
    const cancelled = planned.contracts.find((c) => c.kind === 'DIRECT_TRADE')!, kept = planned.contracts.find((c) => c.id !== cancelled.id)!;
    const deadline = Math.max(...planned.contracts.map((c) => c.deliveryDeadlineDay));
    const s = openDay(runDays(initial(), config, deadline + 1, { 1: [firstTrade(), forwarding],
      2: [{ id: 'CANCEL', type: 'CANCEL_CONTRACT', contractId: cancelled.id }] }).state, config).state;
    expect(s.contracts.find((c) => c.id === cancelled.id)!.status).toBe('CANCELLED');
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(s));
    expect(panel(ui.app.innerHTML, 'report')).toContain(`<p>납기가 지났는데 아직 인도하지 못한 계약: ${linkHtml(kept.id)} (인도하면 정시 인도율에 들어갑니다)</p>`);
  });
  it('하루 진행 전에 대기 명령으로 보던 일정은 다음 날 새 일정이 아니다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.click({ action: 'assign' }); ui.click({ action: 'book' });
    ui.click({ action: 'schedule-toggle' });
    expect(panel(ui.app.innerHTML, 'queue')).toContain('data-action="goto-contract"');
    ui.click({ action: 'end-day' });
    const q = panel(ui.app.innerHTML, 'queue');
    expect(q).toContain('id="schedule-body"'); expect(q).toContain('data-action="goto-contract"');
    expect(q).not.toContain('>새 일정<');
  });
});

describe('경영 보고 문장과 결산 잔여 항목', () => {
  it('흑자 거래의 달러 이익과 원화 급여 자금을 전체 문장으로 구분한다', async () => {
    const start = openDay(createGame(config), config).state, commands = acceptAllFeasible(start, config);
    const end = runToCampaignEnd(start, config, { [start.day]: commands }).state;
    const day = Math.max(...end.contracts.map((c) => c.completedDay!)) + 1;
    const s = openDay(runDays(start, config, day - 1, { [start.day]: commands }).state, config).state;
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(s));
    const r = companyReport(s, config), runway = payrollRunwayKo(payrollRunwayDay(s, config), s.day, config.campaignDays);
    expect(r.trade.profit).toBeGreaterThan(0);
    expect(ui.app.innerHTML).toContain(`<li>거래 손익 ${formatMoney(config.tradeCurrency, r.trade.profit)}는 달러 장부의 이익입니다. 급여 같은 원화 비용은 원화 현금 ${formatMoney(config.payrollCurrency, r.payroll.cash)}에서만 나갑니다(원화 급여 지급 가능일: ${runway}). 이번 판에는 달러를 원화로 바꾸는 기능이 없습니다.</li>`);
  });
  it('끝난 결산의 미수 대금과 없는 미지급은 전체 문장으로 보인다', async () => {
    const cfg = structuredClone(config);
    cfg.terms.paymentDueDay = cfg.campaignDays + 1;
    cfg.startingCash[cfg.payrollCurrency] = cfg.employees.reduce((a, e) => a + e.salaryPerDayMinor, 0) * cfg.campaignDays;
    const start = openDay(createGame(cfg), cfg).state;
    const s = runToCampaignEnd(start, cfg, { [start.day]: acceptAllFeasible(start, cfg) }).state;
    const ui = await startUi(cfg); await (await import('./main-testkit')).screensReady(); await ui.importText(serializeSave(s));
    const sum = campaignSummary(s, cfg); expect(sum.openInvoices.length).toBeGreaterThan(0);
    const expected = sum.openInvoices.map((i) => `<button class="link" data-action="goto-contract" data-contract="${i.contractId}" aria-label="${i.contractId} 계약으로 가기">${i.contractId}</button> ${i.dueDay}일 ${formatMoney(i.currency, i.amountMinor)}`).join(', ');
    expect(ui.app.innerHTML).toContain(`<p>받지 못한 대금: ${expected}</p>`);
    expect(ui.app.innerHTML).toContain('<p>남은 미지급: 없음</p>');
    expect(ui.app.innerHTML).toContain('<p>캠페인이 끝나 앞으로 낼 돈은 없습니다.</p>');
    // 청구서의 계약상 날짜는 캠페인 밖이어도 장부 그대로 보인다.
  });
});
