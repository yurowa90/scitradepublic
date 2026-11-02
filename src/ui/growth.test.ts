import { describe, expect, it } from 'vitest';
import acceptance from '../../tests/character_acceptance_cases.json';
import { loadScenario } from '../content/scenario';
import { createGame, openDay, commitDay, planState } from '../engine/engine';
import { levelProgress, awardXp } from '../engine/growth';
import { trainingPreview } from '../engine/previews';
import { companyReport } from '../engine/reports';
import { runningTaskOf } from '../engine/reservations';
import { crewEntries, crewEntryCard, crewRow, recruitmentPanel } from './recruitment';
import { employeeDetail, growthMessages, growthStatus, trainingBlock, xpProgressKo } from './growth';
import { krwReportRows } from './reports';
import { crewNoteKo, crewStatusKo, taskSchedule } from './crew-status';
import { FOCUS_FALLBACK_SELECTORS, focusFallbackIds } from './focus';

const config=loadScenario('SCENARIO_M2_MULTI_TRADE');
const initial=()=>openDay(createGame(config),config).state;
const def=config.employees[0]!;
const train={id:'TRAIN',type:'START_TRAINING' as const,employeeId:def.id};
const button=(html:string)=>html.match(/<button[^>]*data-action="train"[^>]*>/)![0]!;

describe('성장 기록과 훈련',()=>{
  it('USD 일급 범위의 양 끝은 최소 단위를 통화 표시로 바꾼다',()=>{
    const cfg=structuredClone(config);cfg.payrollCurrency='USD';
    cfg.employees[0]!.salaryPerDayMinor=1234;cfg.employees[1]!.salaryPerDayMinor=5678;
    expect(crewNoteKo(cfg)).toContain('일급 12.34 USD~56.78 USD.');
  });
  it.each([[0,'경험치 0 / 100 · 다음 레벨까지 100'],[99,'경험치 99 / 100 · 다음 레벨까지 1'],[100,'경험치 100 / 300 · 다음 레벨까지 200'],[320,'경험치 320 / 600 · 다음 레벨까지 280'],[4499,'경험치 4499 / 4500 · 다음 레벨까지 1'],[4500,'경험치 4500 · 최대 레벨']] as const)('xp %i 문구', (xp,text)=>{
    const s=initial();s.employees[0]!.xp=xp;
    expect(xpProgressKo(levelProgress(s,config,def.id)!)).toBe(text);
  });
  it('상세 영역 이름·펼침·여섯 능력·주부능력과 카드·운영표를 연결한다',()=>{
    const s=initial(),html=employeeDetail(s,config,def,true);
    expect(html).toContain('aria-expanded="true" aria-controls="growth-EMP01"');
    expect(html).toContain('id="growth-EMP01" role="region" aria-labelledby="growth-h-EMP01"');
    expect(html).toContain('id="growth-h-EMP01" tabindex="-1"');
    const pairs=Object.fromEntries([...html.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map((m)=>[m[1],m[2]]));
    expect(pairs).toEqual({'교섭 (주능력)':'75','운영':'35','분석':'50','기술':'35','탐사':'40','협업 (부능력)':'65'});
    expect(employeeDetail(s,config,def,false)).toContain('hidden');
    const entry=crewEntries(s,config,'all')[0]!;
    expect(crewEntryCard(entry,s,config,false)).toContain('주능력 교섭 75 · 부능력 협업 65');
    expect(crewRow(def,s,config,false)).toContain('레벨 1');expect(crewRow(def,s,config,false)).toContain('2pt/일');
    expect(crewEntryCard(entry,s,config,false)).not.toContain('>EMP01<');
  });
  it('훈련 비용·기간·성장·사용액·급여 지급 가능일은 엔진 미리 보기를 쓴다',()=>{
    const s=initial();s.employees[0]!.xp=40;
    const html=trainingBlock(s,config,def),p=trainingPreview(s,config,def.id);
    expect(p.allowed).toBe(true);expect(button(html)).not.toContain('disabled');
    expect(html).toContain('훈련비 50,000원 · 기간 1일 · 완료 시 +60 경험치');
    expect(html).toContain('급여는 훈련비와 별도로');
    expect(html).toContain('훈련에 쓸 수 있는 원화: 지금 10,000,000원 → 훈련 뒤 9,950,000원');
    expect(html).toContain('완료하면 레벨 2 (교섭 +2, 협업 +1)');
    const cfg=structuredClone(config);cfg.startingCash.KRW=500_000;
    const low=openDay(createGame(cfg),cfg).state;
    expect(trainingBlock(low,cfg,cfg.employees[0]!)).toContain('지금 3일까지 → 훈련하면 2일까지');
    expect(html).toContain('성장 변화는 완료할 때 반영됩니다');
    s.employees[0]!.xp=0;expect(trainingBlock(s,config,def)).toContain('레벨 변화 없음 — 다음 레벨까지 40');
  });
  it('여러 날 훈련의 업무 공백 안내는 미리 보기의 기간을 쓴다',()=>{
    const cfg=structuredClone(config);cfg.growth!.ordinaryTraining.durationDays=3;
    const s=openDay(createGame(cfg),cfg).state;
    expect(trainingBlock(s,cfg,cfg.employees[0]!)).toContain('<p>레벨·능력이 올라도 하루 처리량은 2pt 그대로입니다. 훈련하는 3일 동안 다른 업무를 맡을 수 없습니다.</p>');
  });
  it.each(['busy','funds','unemployed'])('%s 거절 이유와 비활성 버튼은 엔진 판정과 같다',(kind)=>{
    let s=initial();let id=def.id;
    if(kind==='busy')s=planState(s,config,[{id:'SCOUT',type:'SCOUT_SITE',venueId:'VEN_PORT',employeeId:def.id}]).state;
    if(kind==='funds')s.ledger.entries.push({...s.ledger.entries[0]!,id:'DRAIN',currency:'KRW',lines:[{account:'CASH',amount:-10_000_000},{account:'WAGE_EXPENSE',amount:10_000_000}]});
    if(kind==='unemployed')id='EMP04';
    const e=config.employees.find((e)=>e.id===id)!,p=trainingPreview(s,config,id),html=trainingBlock(s,config,e);
    expect(p.allowed).toBe(false);expect(button(html)).toContain('disabled');expect(html).toContain(p.reasonKo!);
  });
  it('교육 상태 글자를 카드·운영표·담당 선택에서 같은 함수로 표시한다',()=>{
    const s=planState(initial(),config,[train]).state,t=runningTaskOf(s,def.id)!;
    const status='◆ 교육 중 0/1일';expect(crewStatusKo(t)).toBe(status);
    expect(taskSchedule(t,config)).toBe('일반 훈련 중 — 0/1일');
    expect(crewEntryCard(crewEntries(s,config,'busy')[0]!,s,config,false)).toContain(status);
    expect(crewRow(def,s,config,false,undefined,t)).toContain(status);
    expect(recruitmentPanel(s,config,{},null,(c)=>planState(s,config,[c]).results[0]!)).toContain(status);
  });
  it('CHAR-ACC-02 90→320은 레벨 3·능력 54/42와 두 문턱 알림을 만든다',()=>{
    const spec=acceptance.items.find((c)=>c.id==='CHAR-ACC-02')!;
    const cfg=structuredClone(config),d=cfg.employees[0]!;
    d.growth!.startXp=spec.setup.cumulative_xp!;
    d.growth!.baseStats.negotiation=spec.setup.primary_ability!;d.growth!.baseStats.coordination=spec.setup.secondary_ability!;
    const before=openDay(createGame(cfg),cfg).state,after=structuredClone(before);
    awardXp(after,cfg,d.id,'MULTI-LEVEL','TASK_COMPLETION_XP',spec.setup.award_xp!);
    const html=employeeDetail(after,cfg,d,true),messages=growthMessages(before,after,cfg);
    expect(html).toContain('레벨 3');expect(html).toContain('<dt>교섭 (주능력)</dt><dd>54</dd>');expect(html).toContain('<dt>협업 (부능력)</dt><dd>42</dd>');
    expect(messages).toEqual(['귀솔 +230 경험치','귀솔 레벨 2 달성 (교섭 +2, 협업 +1)','귀솔 레벨 3 달성 (교섭 +2, 협업 +1)']);
    const gains=messages.slice(1,3).map((m)=>m.match(/교섭 \+(\d+), 협업 \+(\d+)/)!);
    expect(gains.reduce((n,m)=>n+Number(m[1]),0)).toBe(54-50);
    expect(gains.reduce((n,m)=>n+Number(m[2]),0)).toBe(42-40);
    expect(growthMessages(after,after,cfg)).toEqual([]);
  });
  it('CHAR-ACC-08은 훈련비·급여 행을 분리하고 완료 +60을 한 번 알린다',()=>{
    const spec=acceptance.items.find((c)=>c.id==='CHAR-ACC-08')!.setup;
    const cfg=structuredClone(config);cfg.recruitment=null;cfg.employees=[cfg.employees[0]!];
    cfg.startingCash.KRW=spec.starting_cash_krw!;cfg.employees[0]!.salaryPerDayMinor=spec.regular_salary_due_krw!;
    cfg.growth!.ordinaryTraining={currency:'KRW',feeMinor:spec.general_training_fee_krw!,durationDays:spec.general_training_duration_days!,xpOnCompletion:spec.general_training_xp_on_completion!};
    const before=openDay(createGame(cfg),cfg).state,after=commitDay(before,cfg,[train]).state;
    const report=krwReportRows(companyReport(after,cfg),cfg);
    expect(report).toContain('<th>훈련비</th><td>−20,000원</td>');expect(report).toContain('<th>급여</th><td>−10,000원</td>');expect(report).toContain('<th>현금</th><td>470,000원</td>');
    const status=growthStatus(growthMessages(before,after,cfg),before.day);expect(status).not.toContain('role=');expect(status.match(/\+60 경험치/g)).toHaveLength(1);
    expect(growthMessages(after,after,cfg)).toEqual([]);
  });
  it('M1은 상세·훈련·경험치를 표시하지 않는다',()=>{
    const cfg=loadScenario('SCENARIO_M1_ONE_TRADE'),s=openDay(createGame(cfg),cfg).state;
    const html=employeeDetail(s,cfg,cfg.employees[0]!,true)+crewEntryCard(crewEntries(s,cfg,'all')[0]!,s,cfg,false);
    expect(html).not.toContain('data-action="train"');expect(html).not.toContain('경험치');
    expect(growthMessages(s,s,cfg)).toEqual([]);
  });
  it('훈련 초점 대안은 직원 상세 제목을 우선하고 연결용 선택자 목록을 고정한다',()=>{
    expect(FOCUS_FALLBACK_SELECTORS).toEqual(['.employee-detail','.recruit-site','.recruit-candidate']);
    expect(focusFallbackIds({action:'train',emp:'EMP01'})[0]).toBe('growth-h-EMP01');
    expect(focusFallbackIds({action:'scout'},'site-h-VEN_PORT')).toEqual(['site-h-VEN_PORT','queue-h']);
  });
});

describe('TASK-0018 훈련 지급 가능일',()=>{
  it('캠페인 끝·없음·날짜를 표시한다',async()=>{
    const {payrollRunwayKo}=await import('./growth');
    expect(payrollRunwayKo(null,1,config.campaignDays)).toBe(`${config.campaignDays}일(캠페인 끝)까지`);
    expect(payrollRunwayKo(0,1,config.campaignDays)).toBe('없음');
    expect(payrollRunwayKo(3,1,config.campaignDays)).toBe('3일까지');
  });
  it.each(['훈련 뒤에만 미지급','지금도 미지급','대기 훈련도 미지급'])('%s',(kind)=>{
    const cfg=structuredClone(config);
    const wage=cfg.employees.filter((e)=>!cfg.recruitment!.candidateEmployeeIds.includes(e.id)).reduce((sum,e)=>sum+e.salaryPerDayMinor,0);
    const fee=cfg.growth!.ordinaryTraining.feeMinor;
    cfg.startingCash.KRW=wage+(kind==='훈련 뒤에만 미지급' ? fee : 0)-1;
    let state=openDay(createGame(cfg),cfg).state;
    if(kind==='대기 훈련도 미지급') {
      cfg.startingCash.KRW=wage+fee-1;
      state=planState(openDay(createGame(cfg),cfg).state,cfg,[train]).state;
    }
    const html=trainingBlock(state,cfg,cfg.employees[0]!,kind==='대기 훈련도 미지급');
    expect(html).toContain(kind==='훈련 뒤에만 미지급' ? '→ 훈련하면 없음' : '지금 없음');
    expect(html).toContain(`⚠ ${kind==='훈련 뒤에만 미지급' ? '이 훈련비를 내면' : '지금도'} 오늘(1일) 급여 일부가 미지급으로 남습니다.`);
    expect(html).not.toContain('급여는 훈련비와 별도로 평소대로 지급합니다.');
    expect(html).not.toMatch(/(?<!\d)0일까지/);
    if(kind==='대기 훈련도 미지급') expect(html).not.toContain('훈련하면');
  });
});
