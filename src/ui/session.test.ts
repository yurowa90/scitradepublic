import { describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../content/scenario';
import * as engine from '../engine/engine';
import { serializeSave } from '../engine/save';
import { advanceDay, initialUiState, loadSaveText } from './session';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const initial = () => engine.openDay(engine.createGame(config), config).state;

describe('화면 초기화와 저장 읽기', () => {
  it('계획·대기 명령·선택·열린 영역을 새 객체로 비운다', () => {
    const old = initialUiState();
    old.plans.x = { employeeId: 'EMP02' }; old.touchedPlans.add('x'); old.selectedCard = 'EMP02';
    old.recruitSelections.x = 'EMP01'; old.detailId = 'EMP01'; old.interviewId = 'EMP04';
    old.pending.push({ id: 'T', type: 'START_TRAINING', employeeId: 'EMP01' }); old.growthNotices.push('알림');
    const next = initialUiState();
    expect(next.plans).toEqual({}); expect(next.touchedPlans.size).toBe(0);
    expect(next.pending).toEqual([]); expect(next.recruitSelections).toEqual({});
    expect([next.selectedCard, next.detailId, next.interviewId, next.flash]).toEqual([null, null, null, null]);
    expect(next.crewFilter).toBe('all'); expect(next.growthNotices).toEqual([]);
    expect(next.plans).not.toBe(old.plans);
  });
  it('설정과 규칙을 확인하고 저장을 열며 손상을 한국어로 거절한다', () => {
    const state = initial();
    expect(loadSaveText(serializeSave(state))).toEqual({ config, state });
    for (const text of ['{', 'null', '{}', JSON.stringify({ scenarioId: 'UNKNOWN' })]) {
      const result = loadSaveText(text);
      expect(result).toHaveProperty('errorKo');
      expect('errorKo' in result && result.errorKo).toMatch(/[가-힣]/);
    }
    const file = JSON.parse(serializeSave(state)); file.state.employees[0].xp = -1;
    expect(loadSaveText(JSON.stringify(file))).toHaveProperty('errorKo');
    file.rulesVersion = 'wrong';
    expect(loadSaveText(JSON.stringify(file))).toHaveProperty('errorKo');
  });
  it('하루 확정 예외는 상태와 명령을 유지하며 알림으로 돌려준다', () => {
    const state = initial(), before = structuredClone(state);
    const commands = [{ id: 'T', type: 'START_TRAINING' as const, employeeId: 'EMP01' }];
    const spy = vi.spyOn(engine, 'commitDay').mockImplementation(() => { throw new Error('검증 실패'); });
    try { expect(advanceDay(state, config, commands)).toEqual({ errorKo: '하루 진행에 실패했습니다: 검증 실패' }); }
    finally { spy.mockRestore(); }
    expect(state).toEqual(before); expect(commands).toHaveLength(1);
  });
});

// 알림 객체와 엔진 상태의 동일성을 순수 함수로 확인한다.
describe('TASK-0018 알림과 저장 기준', () => {
  it.each(['새 알림','같은 객체','성장만','알림과 성장','문화 결과','성장 새로움 없음'])('nextAnnouncement %s', async (kind) => {
    const { nextAnnouncement } = await import('./session');
    const flash = {kind:'info' as const,text:'새 알림'};
    const input = {flash:null as ReturnType<typeof initialUiState>['flash'],announcedFlash:null as ReturnType<typeof initialUiState>['flash'],growthFresh:false,growthNotices:['동료 +60 경험치'],growthDay:3};
    const growth='3일 하루 진행 — 경험치·레벨 변화: 동료 +60 경험치';
    let expected:string|null=null;
    if(kind==='새 알림') {input.flash=flash;expected=flash.text;}
    if(kind==='같은 객체') {input.flash=flash;input.announcedFlash=flash;}
    if(kind==='성장만') {input.growthFresh=true;expected=growth;}
    if(kind==='알림과 성장') {input.flash=flash;input.growthFresh=true;expected=flash.text+' '+growth;}
    if(kind==='문화 결과') {input.flash={...flash,action:'culture-result'};input.growthFresh=true;expected=flash.text;}
    expect(nextAnnouncement(input)).toBe(expected);
    expect(nextAnnouncement({...input,flash:null,growthDay:null,growthFresh:true})).toBeNull();
    expect(nextAnnouncement({...input,flash:null,growthNotices:[],growthFresh:true})).toBeNull();
  });
  it('liveRegionText는 같은 글의 끝 공백을 붙였다 뗀다', async () => {
    const {liveRegionText}=await import('./session');
    expect(liveRegionText('앞','뒤')).toBe('뒤');
    expect(liveRegionText('같음','같음')).toBe('같음\u00a0');
    expect(liveRegionText('같음\u00a0','같음')).toBe('같음');
  });
  it('hasUnsavedWork는 대기 명령과 저장한 객체를 비교한다', async () => {
    const {hasUnsavedWork}=await import('./session');
    const state=initial();
    expect(hasUnsavedWork([{id:'대기',type:'START_TRAINING',employeeId:config.employees[0]!.id}],state,state)).toBe(true);
    expect(hasUnsavedWork([],state,state)).toBe(false);
    expect(hasUnsavedWork([],structuredClone(state),state)).toBe(true);
    expect(hasUnsavedWork([],state,null)).toBe(true);
  });
});
