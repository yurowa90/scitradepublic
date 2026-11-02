import { describe, expect, it, vi } from 'vitest';
import venues from '../../data/venues.json';
import { loadScenario } from '../content/scenario';
import { cultureBook } from '../engine/culture';
import { commitDay, createGame, openDay, planState } from '../engine/engine';
import { CULTURE_UNCHANGED_KO } from '../engine/previews-lazy';
import { culturePreview } from '../engine/previews-lazy';
import { runDays } from '../engine/testkit';
import type { Command, GameState, ScenarioConfig } from '../engine/types';
import { taskName } from './card';
import { cultureAnchorBlocks, culturePanel, cultureResults, cultureNotebook, cultureVenues, cultureTab, cultureToastText } from './culture';
import { esc } from './html';
import { initialUiState } from './session';

await (await import('./main-testkit')).screensReady();

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const start = (activityId='CA01', employeeId='EMP01', id=`${activityId}-${employeeId}`): Command =>
  ({ id, type:'START_CULTURE_ACTIVITY', activityId, employeeId });
const fresh = (cfg=config) => openDay(createGame(cfg), cfg).state;
const dayTwo = (cfg=config) => openDay(commitDay(fresh(cfg), cfg, []).state, cfg).state;
function panel(state=dayTwo(), cfg=config, pending:Command[]=[], employeeId='EMP01', activityId='CA01', bookOpen=false) {
  return culturePanel(state, planState(state,cfg,pending).state, pending, cfg,
    {...initialUiState(), cultureOpen:true, cultureActivityId:activityId, cultureEmployeeId:employeeId, cultureBookOpen:bookOpen});
}
const preview = (html:string) => html.split('<div id="culture-preview">')[1]!.split('<div id="culture-slot"')[0]!;
const done = (cfg=config) => openDay(commitDay(dayTwo(cfg),cfg,[start()]).state,cfg).state;
const visible = (html:string) => html.replace(/<[^>]*>/g,'');
function rejected(html:string, reason:string) {
  const p=preview(html);
  expect(p).toContain(`⚠ 시작할 수 없음: ${esc(reason)}`);
  expect(p).toContain('시작할 수 없으므로 새로 생기는 기록이 없습니다.');
  expect(p).toContain('<b>바뀌지 않는 것</b>');
  for(const text of ['새로 생길 기록','첫 완료 경험치','이 활동에 쓰는 것','다른 업무를 맡을 수 없습니다',
    '활동에 쓸 수 있는 원화','원화 급여 지급 가능일','→','캠페인 마지막 날']) expect(p).not.toContain(text);
  expect(html).toMatch(/data-action="culture-queue"[^>]* disabled/);
  expect(html).not.toContain('넣기만 해서는 시간이 흐르지 않습니다.');
}

describe('TASK-0012 문화 패널의 엔진 읽기와 미리 보기',()=>{
  it('새 화면 초기값은 본 날·탭 위치·선택·펼침·결과 알림을 모두 비운다',()=>{
    expect(initialUiState()).toMatchObject({cultureOpen:false,cultureActivityId:null,cultureEmployeeId:null,cultureBookOpen:false,
      cultureSeenDay:null,cultureShowFromDay:null,cultureTabTop:null,cultureResultFresh:false,flash:null});
  });
  it('2일 기본 미리 보기의 기회비용·급여·새 기록·불변 값은 지정 순서다',()=>{
    const html=panel(), p=preview(html), v=visible(p);
    const lines=['미리 보기 — 귀솔 · 시장과 포장 요구 탐방',
      '이 활동에 쓰는 것: 직원 1명의 하루 업무 · 원화 20,000원',
      '귀솔: 오늘(2일) 하루 동안 다른 업무를 맡을 수 없습니다.',
      '활동에 쓸 수 있는 원화: 지금 9,840,000원 → 활동 뒤 9,820,000원',
      '원화 급여 지급 가능일: 지금 62일까지 → 활동하면 62일까지',
      '급여는 활동비와 별도로 평소대로 지급합니다.', '새로 생길 기록과 경험치',
      '회사 보고서(처음 생김) — 한 상인의 포장·보관 요구', '귀솔의 직접 경험 기록',
      '함께한 활동: 귀솔 — 시장 상인 윤서', '첫 완료 경험치 +10', '바뀌지 않는 것', CULTURE_UNCHANGED_KO];
    for(const line of lines)expect(v).toContain(line);
    for(let i=1;i<lines.length;i++)expect(v.indexOf(lines[i]!)).toBeGreaterThan(v.indexOf(lines[i-1]!));
    expect(p).toContain('<p class="culture-cost"><b>이 활동에 쓰는 것:</b> 직원 1명의 하루 업무');
    expect(p).not.toContain('끝나는 날');expect(p).not.toContain('role="status"');expect(p).not.toContain('<button');
    expect(html.indexOf('id="culture-emp-EMP01"')).toBeLessThan(html.indexOf('id="culture-preview"'));
    expect(html.indexOf('id="culture-preview"')).toBeLessThan(html.indexOf('id="culture-slot"'));
    expect(html).toContain('넣기만 해서는 시간이 흐르지 않습니다.');
  });
  it('RF-2 같은 직원 반복은 엔진 거절만 보이고 기록·비교·경험치는 없다',()=>{
    const s=done(), p=culturePreview(s,config,'CA01','EMP01');expect(p.allowed).toBe(false);
    rejected(panel(s),p.reasonKo!);
  });
  it('RF-2 같은 날 두 번째 직원은 대기 목록을 반영한 거절만 보인다',()=>{
    const s=dayTwo(), pending=[start()];const view=planState(s,config,pending).state;
    const p=culturePreview(view,config,'CA01','EMP02');expect(p.allowed).toBe(false);
    rejected(panel(s,config,pending,'EMP02'),p.reasonKo!);
  });
  it('RF-2 자금 부족은 엔진 거절만 보인다',()=>{
    const cfg=structuredClone(config);cfg.startingCash.KRW=19_999;
    const s=fresh(cfg),p=culturePreview(s,cfg,'CA01','EMP01');expect(p.allowed).toBe(false);
    rejected(panel(s,cfg),p.reasonKo!);
  });
  it('RF-1 허용된 활동이 캠페인을 넘으면 경고와 지출은 보이고 새 기록은 없다',()=>{
    // 오늘(2일)·시작일과 다른 캠페인 일수(3일)를 써서 어느 값을 읽는지 구분한다.
    const cfg=structuredClone(config);cfg.culture!.activities[0]!.durationDays=3;cfg.campaignDays=3;
    const s=dayTwo(cfg),p=culturePreview(s,cfg,'CA01','EMP01');
    expect(p.allowed).toBe(true);expect(p.busyUntilDay).toBe(4);
    const html=preview(panel(s,cfg));
    expect(html).toContain('⚠ 캠페인 마지막 날(3일)까지 끝나지 않습니다. 기록·경험치는 생기지 않고 활동비는 나갑니다.');
    expect(html).toContain('직원 1명의 3일 업무');expect(html).toContain('귀솔: 2~4일 동안');
    expect(html).not.toContain('끝나는 날');expect(html).not.toContain('새로 생길 기록');expect(html).not.toContain('첫 완료 경험치');
    expect(html).toContain('3일(캠페인 끝)까지');
    cfg.startingCash.KRW=179_999;
    const poor=dayTwo(cfg),deny=culturePreview(poor,cfg,'CA01','EMP01');expect(deny.allowed).toBe(false);
    rejected(panel(poor,cfg),deny.reasonKo!);
  });
  it('캠페인 안의 여러 날 활동은 완료일과 업무 공백을 보여 준다',()=>{
    const cfg=structuredClone(config);cfg.culture!.activities[0]!.durationDays=2;
    const p=preview(panel(dayTwo(cfg),cfg));
    expect(p).toContain('끝나는 날: 3일');expect(p).toContain('귀솔: 2~3일 동안 다른 업무를 맡을 수 없습니다.');
  });
  it.each([[179_999,1,'이 활동비를 내면'],[100_000,0,'지금도']] as const)('급여 %i원은 미지급 경고와 읽을 수 있는 날짜 표기다',(cash,before,word)=>{
    const cfg=structuredClone(config);cfg.startingCash.KRW=cash;const s=fresh(cfg);
    const p=culturePreview(s,cfg,'CA01','EMP01');expect(p.allowed).toBe(true);
    expect(p.payrollRunwayBefore).toBe(before);expect(p.payrollRunwayAfter).toBe(0);
    const html=preview(panel(s,cfg));
    expect(html).toContain(`⚠ ${word} 오늘(1일) 급여 일부가 미지급으로 남습니다.`);
    expect(html).toContain('→ 활동하면 없음');expect(html).not.toContain('0일까지');
    // 미지급 경고와 맞지 않는 ‘평소대로 지급’ 문장은 이때 뺀다.
    expect(html).not.toContain('급여는 활동비와 별도로 평소대로 지급합니다.');
  });
  it.each([false,true])('미배정 준비 업무 경고와 다른 쉬는 직원 안내 (다른 직원도 바쁨 %s)',(busy)=>{
    const commands:Command[]=[{id:'A',type:'ACCEPT_TRADE',buyOfferId:'OFFER_BUY_01',sellOfferId:'OFFER_SELL_01'},
      {id:'B',type:'BOOK_SAILING',contractId:'CT001',sailingId:'ROUTE01-D002'},
      ...(busy ? [{id:'T',type:'START_TRAINING',employeeId:'EMP02'} as Command] : [])];
    const s=fresh(), view=planState(s,config,commands).state;
    const p=culturePreview(view,config,'CA01','EMP01');expect(p.allowed).toBe(true);expect(p.waitingTasks).toHaveLength(1);
    const html=preview(panel(s,config,commands));
    expect(html).toContain(`⚠ 기다리는 업무: CT001 ${taskName(p.waitingTasks[0]!.task.kind)} 2pt (2일 출항편 예약됨) — 아직 아무에게도 배정하지 않았습니다.`);
    expect(html).toContain(busy ? '오늘 쉬는 다른 평택 직원: 없음. 이 활동을 하면 오늘 이 업무를 맡을 사람이 없습니다.' : '오늘 쉬는 다른 평택 직원: 물보리');
    expect(html).toContain('(오늘 할 일 반영)');
  });
  it('대기 중인 쌍 하나만 빼서 미리 보고 다른 대기 지출은 남긴다',()=>{
    const s=dayTwo(), pending=[start(),{id:'T',type:'START_TRAINING',employeeId:'EMP02'} as Command];
    const html=panel(s,config,pending),p=preview(html);
    expect(p).not.toContain('진행 중');expect(p).toContain('새로 생길 기록');
    expect(p).toContain('지금 9,790,000원 → 활동 뒤 9,770,000원 (오늘 할 일 반영)');
    expect(html).toContain('id="status-culture-CA01-EMP01"');expect(html).toContain('현지 활동 예정');
    expect(html).toContain('빼려면 ‘오늘 할 일’에서 ‘빼기’를 누르세요.');
    expect(html).not.toContain('data-action="culture-queue"');
  });
  it('대기 목록이 그 쌍뿐이면 ‘(오늘 할 일 반영)’을 붙이지 않는다',()=>{
    const p=preview(panel(dayTwo(),config,[start()]));
    expect(p).toContain('지금 9,840,000원 → 활동 뒤 9,820,000원');expect(p).not.toContain('(오늘 할 일 반영)');
  });
  it('계획 상태의 바쁜 직원·근무 전 직원만 꺼지고 쉬는 직원은 켜지며 후보는 없다',()=>{
    const s=fresh(), pending=[{id:'T',type:'START_TRAINING',employeeId:'EMP02'} as Command];
    const html=panel(s,config,pending);
    expect(html).toMatch(/id="culture-emp-EMP01"[^>]*aria-pressed="true">귀솔 · /);
    expect(html).not.toMatch(/id="culture-emp-EMP01"[^>]* disabled/);
    expect(html).toMatch(/id="culture-emp-EMP02"[^>]* disabled>물보리 · ◆ 교육 중 0\/1일 — 일반 훈련 중/);
    expect(html).not.toContain('id="culture-emp-EMP03"');
    const hired=runDays(createGame(config),config,4,{
      1:[{id:'S',type:'SCOUT_SITE',venueId:'VEN_PORT',employeeId:'EMP02'}],
      2:[{id:'Q',type:'START_RECRUIT_QUEST',candidateId:'EMP04',employeeId:'EMP01'}],
    }).state;
    const today=openDay(hired,config).state;
    const h=panel(today,config,[{id:'H',type:'HIRE_CANDIDATE',candidateId:'EMP04'}]);
    expect(h).toMatch(/id="culture-emp-EMP04"[^>]* disabled>현돌 · 6일부터 근무/);
  });
});

describe('TASK-0012 결과·기록장·장소·알림',()=>{
  it('결과의 네 칸은 같은 요소·클래스이고 자료 문장을 그대로 쓴다',()=>{
    const s=done(), html=cultureResults(s,config,2);
    const fields=[...html.matchAll(/<li class="rec-field"[^>]*>([\s\S]*?)<\/li>/g)];expect(fields).toHaveLength(4);
    const report=config.culture!.activities[0]!.reportKo!;
    for(const [i,field] of ['findingKo','scopeKo','notClaimedKo','openQuestionKo'].entries()) {
      const body=fields[i]![1]!.match(/<p>([\s\S]*?)<\/p>/)![1]!;
      expect(body).toBe(esc(field==='notClaimedKo' ? '평택의 다른 상인이나 손님도 작은 포장을 원한다는 뜻이 아닙니다.' : report[field as keyof typeof report]));
      expect(fields[i]![1]!.includes('넓혀 읽지 않기')).toBe(i===2);
    }
    expect(html).toContain('출처 1명: 시장 상인 윤서 · 다른 출처로 아직 확인하지 않은 기록');
    expect(visible(html)).toContain('쓴 것 귀솔의 하루 업무(2일) · 원화 20,000원');
    expect(visible(html)).toContain(`바뀌지 않은 것 ${CULTURE_UNCHANGED_KO}`);
    expect(html).not.toContain('<button');expect(html).not.toContain('role="status"');expect(html).not.toContain('경험치');
    const second=openDay(commitDay(s,config,[start('CA01','EMP02')]).state,config).state;
    expect(cultureResults(second,config,3)).toContain('회사 보고서는 2일에 이미 있습니다. 네 칸은 그대로입니다. · 이번 활동 직원 물보리');
    expect(cultureResults(second,config,3)).toContain('기록한 직원 귀솔');
  });
  it('여러 날 결과의 쓴 업무 날짜와 CA03의 두 명 출처를 보여 준다',()=>{
    const cfg=structuredClone(config);cfg.culture!.activities[0]!.durationDays=2;
    const s=runDays(dayTwo(cfg),cfg,3,{2:[start()]}).state;
    expect(visible(cultureResults(s,cfg,3))).toContain('쓴 것 귀솔의 2~3일 업무 · 원화 20,000원');
    const two=commitDay(dayTwo(),config,[start('CA03')]).state;
    expect(cultureResults(two,config,2)).toContain('출처 2명: 시장 상인 윤서, 지역 기록 안내자 하람 · 다른 출처로');
  });
  it('기록장은 최신·같은 날 역순 보고서와 사건마다 한 줄을 그린다',()=>{
    const s=runDays(createGame(config),config,3,{2:[start()],3:[start('CA03'),start('CA02','EMP02')]}).state;
    const html=cultureNotebook(s,config,true),book=cultureBook(s,config);
    // 기록장의 보고서 제목은 ‘회사 보고서’(h4) 아래 단계다.
    const titles=[...html.matchAll(/<article class="cul-report"[\s\S]*?<h5[^>]*>(.*?)<\/h5>/g)].map((m)=>m[1]);
    expect(html).not.toMatch(/<article class="cul-report"[^>]*><h3/);
    expect(titles).toEqual([config.culture!.activities[1]!.topic.titleKo,config.culture!.activities[2]!.topic.titleKo,config.culture!.activities[0]!.topic.titleKo]);
    expect(html).toContain('귀솔 — 시장 상인 윤서 · 시장과 포장 요구 탐방 (2일)');
    expect(html).toContain('귀솔 — 시장 상인 윤서 · 언어 교류와 주문 확인 (3일)');
    expect(html.indexOf('귀솔 — 시장 상인 윤서 · 언어')).toBeLessThan(html.indexOf('귀솔 — 시장 상인 윤서 · 시장'));
    expect(html.match(/<li>귀솔 — 시장 상인 윤서 ·/g)).toHaveLength(2);
    for(const contact of config.culture!.contacts)expect(html).toContain(esc(contact.informationScopeKo));
    for(const e of book.employees.flatMap((employee)=>employee.experiences))expect(html).toContain(`(${e.verifiedDay}일)`);
    const experiences=html.split('<h4>직원의 직접 경험 기록</h4>')[1]!.split('<h4>')[0]!;
    expect(experiences).toContain('<li>귀솔 — 시장과 포장 요구 탐방 (2일)</li>');expect(experiences).not.toContain('직접 경험 기록이 없습니다.');
    expect(html).toContain('거래 신뢰는 계약을 약속대로 지켰는지에서만 나옵니다. 현지 활동은 이것을 바꾸지 않습니다.');
    expect(html).not.toContain('쓴 것');expect(html).not.toContain('바뀌지 않은 것');
  });
  it('기록이 없으면 빈 쌍·경험 없는 직원을 나열하지 않는다',()=>{
    const html=cultureNotebook(fresh(),config,true);
    for(const text of ['회사 보고서가 없습니다.','직접 경험 기록이 없습니다.','함께한 활동이 없습니다.','만난 사람이 없습니다.'])expect(html).toContain(text);
    for(const name of ['귀솔','물보리','윤서','하람'])expect(html).not.toContain(name);
    expect(cultureNotebook(fresh(),config,false)).not.toContain('id="culture-book-body"');
  });
  it('만난 사람은 함께한 사건이 있는 인물만이다',()=>{
    const html=cultureNotebook(done(),config,true);
    const met=html.split('<h4>만난 사람</h4>')[1]!.split('<p class="book-trust">')[0]!;
    expect(met).toContain('시장 상인 윤서');expect(met).not.toContain('하람');expect(met).not.toContain('만난 사람이 없습니다.');
    const none=cultureNotebook(fresh(),config,true).split('<h4>만난 사람</h4>')[1]!;
    expect(none).toContain('<p>만난 사람이 없습니다.</p>');
  });
  it('장소는 자료 순서의 정적 목록이고 영입 여부에 맞는 안내다',()=>{
    const html=cultureVenues(config);
    expect([...html.matchAll(/<dt>(.*?)<\/dt>/g)].map((m)=>m[1])).toEqual(venues.items.map((v)=>v.title_ko));
    expect(html).toContain('주식 거래와 상장(회사 주식을 시장에 내놓기)은 이번 판에 없습니다.');
    expect(html).not.toContain('data-action');expect(html).not.toContain('revisit_reason');
    const cfg=structuredClone(config);cfg.recruitment=null;
    expect(cultureVenues(cfg)).toContain('비즈니스 라운지</dt><dd>이번 판에서는 여기서 할 일이 없습니다.');
  });
  it('알림 함수는 1건·2건·거절 동시 완료의 문장과 종류를 만든다',()=>{
    const s=done();expect(cultureToastText(s,config)).toEqual({kind:'info',action:'culture-result',text:'2일 현지 활동 기록: 한 상인의 포장·보관 요구 — 귀솔'});
    const multiple=commitDay(dayTwo(),config,[start(),start('CA02','EMP02')]).state;
    const [first,second]=[config.culture!.activities[1]!,config.culture!.activities[0]!].map((a)=>a.topic.titleKo);
    expect(cultureToastText(multiple,config)).toEqual({kind:'info',action:'culture-result',text:`2일 현지 활동 기록 2건: ‘${first}’, ‘${second}’`});
    const rejected=commitDay(dayTwo(),config,[start(),start('CA01','EMP02')]);
    expect(cultureToastText(rejected.state,config,rejected.results.filter((r)=>r.status==='REJECTED'))).toEqual({kind:'warn',action:'culture-result',text:`실행하지 못한 명령: ${rejected.results[1]!.reasonKo} · 2일 현지 활동 기록이 있습니다.`});
    expect(cultureToastText(fresh(),config)).toBeNull();
  });
  it('M1의 모든 문화 HTML은 빈 문자열이다',()=>{
    const cfg=loadScenario('SCENARIO_M1_ONE_TRADE'),s=fresh(cfg);
    expect(panel(s,cfg)).toBe('');expect(cultureResults(s,cfg,1)).toBe('');expect(cultureNotebook(s,cfg,true)).toBe('');
    expect(cultureVenues(cfg)).toBe('');expect(cultureTab(s,cfg,initialUiState())).toBe('');expect(cultureToastText(s,cfg)).toBeNull();
  });
  it('자료 이름은 이스케이프하고 보이는 글자·접근 이름에는 내부 ID가 없다',()=>{
    const cfg=structuredClone(config);cfg.employees[0]!.nameKo='<귀솔>';cfg.culture!.contacts[0]!.nameKo='<시장 상인 윤서>';
    cfg.culture!.activities[0]!.titleKo='<시장 탐방>';
    const s=dayTwo(cfg),p=panel(s,cfg);expect(p).toContain('&lt;귀솔&gt;');expect(p).toContain('&lt;시장 상인 윤서&gt;');expect(p).toContain('&lt;시장 탐방&gt;');
    for(const raw of ['<귀솔>','<시장 상인 윤서>','<시장 탐방>'])expect(p).not.toContain(raw);
    const completed=openDay(commitDay(s,cfg,[start()]).state,cfg).state;
    const html=panel(completed,cfg,[],'EMP02','CA01',true)+cultureTab(completed,cfg,initialUiState());
    expect(visible(html)).not.toMatch(/CA\d+|EMP\d+|VEN_|NPC_|CULTURE-|TASK\d+/);
    for(const match of html.matchAll(/aria-label="([^"]*)"/g))expect(match[1]).not.toMatch(/CA\d+|EMP\d+|VEN_|NPC_|CULTURE-|TASK\d+/);
  });
  it('수집 유도·움직임 문구와 변수 직후 조사를 쓰지 않는다',async()=>{
    const html=panel(done(),config,[],'EMP02','CA01',true);
    expect(html).not.toMatch(/빈 쪽|채우|쪽 남음|다녀온 직원|다녀옴|✓|✕|animation|transition/);
    const {readFileSync}=await vi.importActual<{readFileSync:(path:URL,encoding:string)=>string}>('node:fs');
    const source=readFileSync(new URL('./culture.ts',import.meta.url),'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'');
    expect(source).not.toMatch(/\}(은|는|이|가|을|를|와|과|으로|로)/);
  });
});

describe('TASK-0012 Claude 검수 2차: 반복 활동 문구·읽던 자리 블록',()=>{
  const repeatDay=()=>openDay(commitDay(done(),config,[start('CA01','EMP02')]).state,config).state;
  it('같은 활동을 다른 직원이 다시 하면 알림·카드가 새 보고서가 아님을 밝힌다',()=>{
    const s=repeatDay(),topic=config.culture!.activities[0]!.topic.titleKo;
    expect(cultureToastText(s,config)).toEqual({kind:'info',action:'culture-result',text:`3일 현지 활동: ${topic} — 물보리 (회사 보고서는 2일에 이미 있음)`});
    const html=cultureResults(s,config,3);
    expect(html).toContain('<small>3일 활동 · 시장과 포장 요구 탐방</small>');expect(html).not.toContain('3일 기록');
    expect(cultureResults(done(),config,2)).toContain('<small>2일 기록 · 시장과 포장 요구 탐방</small>');
  });
  it('여러 건 가운데 반복이 있으면 새 회사 보고서 수를 따로 적는다',()=>{
    const s=openDay(commitDay(done(),config,[start('CA01','EMP02'),start('CA02','EMP01')]).state,config).state;
    const text=cultureToastText(s,config)!.text;
    expect(text).toMatch(/^3일 현지 활동 2건\(새 회사 보고서 1건\): ‘[^’]+’, ‘[^’]+’$/);expect(text).not.toContain('기록 2건');
    const both=openDay(commitDay(openDay(commitDay(dayTwo(),config,[start(),start('CA02','EMP02')]).state,config).state,config,[start('CA01','EMP02'),start('CA02','EMP01')]).state,config).state;
    expect(cultureToastText(both,config)!.text).toMatch(/^3일 현지 활동 2건\(회사 보고서는 모두 이미 있음\): ‘[^’]+’, ‘[^’]+’$/);
  });
  it('읽던 자리 블록 후보는 열린 패널의 결과·직원 줄·펼친 기록장 보고서다',()=>{
    const s=repeatDay(),ui=(o:object)=>({...initialUiState(),cultureOpen:true,cultureShowFromDay:2,...o});
    expect(cultureAnchorBlocks(s,config,ui({}))).toEqual([['culture-result-CULTURE-CA01-EMP02-D3','culture-result-h-CULTURE-CA01-EMP02-D3'],['culture-result-CULTURE-CA01-EMP01-D2','culture-result-h-CULTURE-CA01-EMP01-D2']]);
    expect(cultureAnchorBlocks(s,config,ui({cultureShowFromDay:4,cultureActivityId:'CA01',cultureBookOpen:true}))).toEqual([['culture-employees','culture-emp-h'],['culture-report-CULTURE-CA01-EMP01-D2','culture-report-h-CULTURE-CA01-EMP01-D2']]);
    expect(cultureAnchorBlocks(s,config,ui({cultureOpen:false}))).toEqual([]);
    expect(cultureAnchorBlocks(fresh(loadScenario('SCENARIO_M1_ONE_TRADE')),loadScenario('SCENARIO_M1_ONE_TRADE'),ui({}))).toEqual([]);
    const book=cultureNotebook(s,config,true);
    expect(book).toContain('<article class="cul-report" id="culture-report-CULTURE-CA01-EMP01-D2"');expect(book).toContain('<p class="book-trust">');
    expect(panel(s,config,[],'EMP01','CA01')).toContain('<div class="culture-employees" id="culture-employees">');
  });
});

