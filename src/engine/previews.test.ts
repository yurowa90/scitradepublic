import { describe, expect, it } from 'vitest';
import venues from '../../data/venues.json';
import { loadScenario } from '../content/scenario';
import { commitDay, createGame, openDay, planState } from './engine';
import { levelProgress, statsFor } from './growth';
import { post } from './ledger';
import { payrollRunwayDay, trainingPreview } from './previews';
import { fundsPosition } from './reservations';
import { taskSubjectKo } from './tasks';
import type { Command, GameState, ScenarioConfig, Task } from './types';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const training: Command = { id: 'TRAIN', type: 'START_TRAINING', employeeId: 'EMP01' };
const scout: Command = { id: 'SCOUT', type: 'SCOUT_SITE', employeeId: 'EMP01', venueId: 'VEN_PORT' };
const open = (cfg = config) => openDay(createGame(cfg), cfg).state;
const emp = (s: GameState) => s.employees.find((e) => e.id === 'EMP01')!;
function debt(s: GameState, minor: number) {
  post(s.ledger, { id: 'DEBT', day: s.day, currency: 'KRW', reason: '미지급 의무 검증',
    lines: [{ account: 'CANCELLATION_EXPENSE', amount: minor }, { account: 'ACCOUNTS_PAYABLE', amount: -minor }] });
  s.obligations.push({ id: 'DEBT', currency: 'KRW', amountMinor: minor, reasonKo: '미지급 의무', incurredDay: s.day, paidDay: null });
}
function pure<T>(s: GameState, cfg: ScenarioConfig, read: () => T): T {
  const before = structuredClone(s), beforeConfig = structuredClone(cfg);
  const result = read();
  expect(s).toEqual(before);
  expect(cfg).toEqual(beforeConfig);
  return result;
}

describe('화면용 성장·업무 읽기 함수', () => {
  it('taskSubjectKo는 장소 제목·후보 이름·계약 번호·훈련 null을 반환하며 입력을 보존한다', () => {
    const s = planState(open(), config, [scout]).state;
    const task = s.tasks[0]!;
    const title = venues.items.find((v) => v.id === 'VEN_PORT')!.title_ko;
    expect(config.recruitment!.scoutSites.find((site) => site.venueId === 'VEN_PORT')!.titleKo).toBe(title);
    const cases: [Task['kind'], string | null, string | null, string | null][] = [
      ['SCOUT', 'VEN_PORT', null, title],
      ['RECRUIT_QUEST', 'EMP04', null, config.employees.find((e) => e.id === 'EMP04')!.nameKo],
      ['TRAINING', 'EMP01', null, null],
      ['EXPORT_PREP', null, 'CT001', 'CT001'], ['FORWARDING_PREP', null, 'CT002', 'CT002'],
    ];
    for (const [kind, subjectId, contractId, expected] of cases) {
      const input = { ...task, kind, subjectId, contractId };
      const before = structuredClone(input);
      expect(pure(s, config, () => taskSubjectKo(config, input))).toBe(expected);
      expect(input).toEqual(before);
    }
  });

  it('배정·바쁨·조사 완료 로그에 읽을 수 있는 대상을 사용한다', () => {
    const s = planState(open(), config, [scout]).state;
    expect(s.log.at(-1)!.textKo).toBe('귀솔에게 항만 물류단지 현장 조사 업무 배정 (1 업무 포인트)');
    expect(trainingPreview(s, config, 'EMP01').reasonKo).toContain('항만 물류단지 현장 조사');
    const done = commitDay(s, config, []).state;
    expect(done.log.some((l) => l.textKo === '귀솔: 항만 물류단지 현장 조사 완료')).toBe(true);
    const candidate = done.recruitment.candidates.find((c) => c.employeeId === 'EMP04')!;
    expect(candidate.stage).toBe('DISCOVERED');
    const quest = planState(openDay(done, config).state, config, [
      { id: 'QUEST', type: 'START_RECRUIT_QUEST', employeeId: 'EMP01', candidateId: 'EMP04' },
    ]).state;
    const name = config.employees.find((e) => e.id === 'EMP04')!.nameKo;
    expect(quest.log.at(-1)!.textKo).toContain(`${name} 영입 의뢰 업무 배정`);
    expect(trainingPreview(quest, config, 'EMP01').reasonKo).toContain(`${name} 영입 의뢰`);
  });

  it('훈련 시작에는 비용·일수를 쓰고 바쁨 문구에는 직원 ID를 넣지 않는다', () => {
    const s = planState(open(), config, [training]).state;
    expect(s.log.at(-1)!.textKo).toBe('귀솔 일반 훈련 시작 (1일, 훈련비 50,000원)');
    const reason = trainingPreview(s, config, 'EMP01').reasonKo!;
    expect(reason).toContain('다른 업무(일반 훈련)');
    expect(reason).not.toContain('EMP01');
  });

  it.each([0, 90, 99, 100, 299, 320, 4499, 4500, 5000])('levelProgress(%i)는 문턱·남은 경험치·능력을 읽고 상태를 보존한다', (xp) => {
    const s = open();
    emp(s).xp = xp;
    const p = pure(s, config, () => levelProgress(s, config, 'EMP01'))!;
    expect(p.xp).toBe(xp);
    expect(p.stats).toEqual(statsFor(config.employees[0]!, xp));
    if (xp >= 4500) expect(p).toMatchObject({ level: 10, levelFloorXp: 4500, nextLevelXp: null, xpToNext: null });
    else if (xp === 4499) expect(p).toMatchObject({ level: 9, levelFloorXp: 3600, nextLevelXp: 4500, xpToNext: 1 });
    else if (xp >= 300) expect(p).toMatchObject({ level: 3, levelFloorXp: 300, nextLevelXp: 600, xpToNext: 600 - xp });
    else if (xp >= 100) expect(p).toMatchObject({ level: 2, levelFloorXp: 100, nextLevelXp: 300, xpToNext: 300 - xp });
    else expect(p).toMatchObject({ level: 1, levelFloorXp: 0, nextLevelXp: 100, xpToNext: 100 - xp });
  });

  it('배열 첫 직원과 다른 경험치를 가진 직원을 ID로 찾고 없는 ID는 null이다', () => {
    const s = open();
    emp(s).xp = 320;
    s.employees.find((e) => e.id === 'EMP02')!.xp = 99;
    expect(pure(s, config, () => levelProgress(s, config, 'EMP02'))).toEqual({
      xp: 99, level: 1, levelFloorXp: 0, nextLevelXp: 100, xpToNext: 1,
      stats: statsFor(config.employees.find((e) => e.id === 'EMP02')!, 99),
    });
    expect(pure(s, config, () => levelProgress(s, config, 'MISSING'))).toBeNull();
    s.employees = s.employees.filter((e) => e.id !== 'EMP02');
    expect(pure(s, config, () => levelProgress(s, config, 'EMP02'))).toBeNull();
  });

  it('성장 없는 직원의 stats는 null이다', () => {
    const cfg = loadScenario('SCENARIO_M1_ONE_TRADE');
    const s = open(cfg);
    expect(pure(s, cfg, () => levelProgress(s, cfg, 'EMP01'))!.stats).toBeNull();
  });

  it('훈련 미리보기는 실제 완료 비용·성장과 같고 명령 ID 충돌에도 입력을 보존한다', () => {
    const cfg = structuredClone(config);
    cfg.employees[0]!.growth!.startXp = 90;
    const s = open(cfg);
    s.processedCommands['TRAINING-PREVIEW'] = { day: 1, type: 'START_TRAINING', status: 'REJECTED', reasonKo: '검증' };
    const p = pure(s, cfg, () => trainingPreview(s, cfg, 'EMP01'));
    expect(p).toMatchObject({ allowed: true, reasonKo: null, fee: { currency: 'KRW', minor: 50_000 },
      durationDays: 1, xpGain: 60, levelAfter: 2, availableBeforeMinor: 10_000_000, availableAfterMinor: 9_950_000 });
    const done = commitDay(s, cfg, [training]).state;
    expect(p.levelAfter).toBe(levelProgress(done, cfg, 'EMP01')!.level);
    expect(p.statsAfter).toEqual(statsFor(cfg.employees[0]!, emp(done).xp));
  });

  it.each(['현금 부족', '미지급 의무', '업무 중', '근무 시작 전', '다른 도시', '후보', '없는 직원', '성장 꺼짐', '성장 정의 없음'])
  ('훈련 미리보기의 %s 판정·이유는 실제 명령과 같고 상태를 보존한다', (reason) => {
    const cfg = reason === '성장 꺼짐' ? loadScenario('SCENARIO_M1_ONE_TRADE') : structuredClone(config);
    if (reason === '현금 부족') cfg.startingCash.KRW = 49_999;
    if (reason === '성장 정의 없음') cfg.employees[0]!.growth = null;
    let s = open(cfg);
    if (reason === '미지급 의무') debt(s, 9_950_001);
    if (reason === '업무 중') s = planState(s, cfg, [scout]).state;
    if (reason === '근무 시작 전') emp(s).availableFromDay = 2;
    if (reason === '다른 도시') emp(s).locationCityId = 'HAIPHONG';
    const id = reason === '후보' ? 'EMP04' : reason === '없는 직원' ? 'MISSING' : 'EMP01';
    const p = pure(s, cfg, () => trainingPreview(s, cfg, id));
    const actual = planState(s, cfg, [{ ...training, employeeId: id }]).results[0]!;
    expect(actual.status).toBe('REJECTED');
    expect(p.allowed).toBe(false);
    expect(p.reasonKo).toBe(actual.reasonKo);
    if (reason === '성장 꺼짐') expect(p.reasonKo).toBe('이 시나리오에서는 일반 훈련을 할 수 없습니다.');
  });

  it.each([
    ['PENDING_OPEN', '하루를 연 뒤에 훈련을 시작할 수 있습니다.'],
    ['ENDED', '캠페인이 끝났습니다.'],
  ] as const)('%s 단계에서는 훈련 미리보기를 거절한다', (phase, reasonKo) => {
    const s = createGame(config);
    s.phase = phase;
    if (phase === 'ENDED') s.day = config.campaignDays + 1;
    expect(pure(s, config, () => trainingPreview(s, config, 'EMP01'))).toMatchObject({ allowed: false, reasonKo });
    expect(() => commitDay(s, config, [training])).toThrow();
  });

  it('미지급 의무가 있으면 훈련 사용 가능액 49,999와 훈련 후 −1을 표시한다', () => {
    const s = open();
    debt(s, 9_950_001);
    const p = pure(s, config, () => trainingPreview(s, config, 'EMP01'));
    expect(p).toMatchObject({ allowed: false, availableBeforeMinor: 49_999, availableAfterMinor: -1 });
    expect(p.reasonKo).toContain('사용 가능 49,999원');
    expect(planState(s, config, [training]).results[0]).toMatchObject({ status: 'REJECTED', reasonKo: p.reasonKo });
  });

  it('계약 자금 예약이 있어도 기존 훈련 규칙의 사용 가능액과 판정을 유지한다', () => {
    const cfg = structuredClone(config);
    cfg.routes.forEach((r) => { r.currency = 'KRW'; r.bookingFeeMinor = 100_000; });
    cfg.offers.find((o) => o.id === 'OFFER_FWD_01')!.currency = 'KRW';
    cfg.startingCash.KRW = 100_000;
    const planned = planState(open(cfg), cfg, [{ id: 'FWD', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01' }]);
    expect(planned.results[0]!.status).toBe('APPLIED');
    const s = planned.state;
    expect(fundsPosition(s, cfg, 'KRW')).toMatchObject({ cash: 100_000, reserved: 100_000, available: 0 });
    expect(pure(s, cfg, () => trainingPreview(s, cfg, 'EMP01'))).toMatchObject({
      allowed: true, availableBeforeMinor: 100_000, availableAfterMinor: 50_000,
    });
    expect(planState(s, cfg, [training]).results[0]!.status).toBe('APPLIED');
    debt(s, 50_001);
    const p = pure(s, cfg, () => trainingPreview(s, cfg, 'EMP01'));
    expect(p).toMatchObject({ allowed: false, availableBeforeMinor: 49_999, availableAfterMinor: -1 });
    expect(planState(s, cfg, [training]).results[0]).toMatchObject({ status: 'REJECTED', reasonKo: p.reasonKo });
  });

  it('성장 비활성 훈련의 비용·기간·경험치는 0이고 능력은 null이다', () => {
    const cfg = loadScenario('SCENARIO_M1_ONE_TRADE');
    const s = open(cfg);
    expect(pure(s, cfg, () => trainingPreview(s, cfg, 'EMP01'))).toMatchObject({
      allowed: false, reasonKo: '이 시나리오에서는 일반 훈련을 할 수 없습니다.',
      fee: { currency: cfg.payrollCurrency, minor: 0 }, durationDays: 0, xpGain: 0,
      levelAfter: 1, statsAfter: null, availableBeforeMinor: cfg.startingCash.KRW,
      availableAfterMinor: cfg.startingCash.KRW,
    });
  });

  it.each(['EXPORT_PREP', 'FORWARDING_PREP'] as const)('%s 배정 로그·바쁨 문구에 계약 번호를 쓴다', (kind) => {
    const cmd: Command = kind === 'EXPORT_PREP'
      ? { id: 'TRADE', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_01', sellOfferId: 'OFFER_SELL_01', plan: { employeeId: 'EMP01' } }
      : { id: 'FWD', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01', plan: { employeeId: 'EMP01' } };
    const p = planState(open(), config, [cmd]);
    expect(p.results[0]!.status).toBe('APPLIED');
    const contractId = p.state.contracts[0]!.id;
    expect(p.state.log.filter((l) => l.textKo.includes('업무 배정')).map((l) => l.textKo).join()).toContain(contractId);
    expect(trainingPreview(p.state, config, 'EMP01').reasonKo).toContain(contractId);
  });

  it('모든 조사 장소 제목을 자료에서 읽어 업무 대상에 표시한다', () => {
    const s = planState(open(), config, [scout]).state;
    for (const site of config.recruitment!.scoutSites) {
      const venue = venues.items.find((v) => v.id === site.venueId)!;
      expect(site.titleKo).toBe(venue.title_ko);
      expect(pure(s, config, () => taskSubjectKo(config, { ...s.tasks[0]!, subjectId: venue.id }))).toBe(venue.title_ko);
    }
  });

  it('훈련 위치 거절은 설정의 본거지 이름을 사용한다', () => {
    const cfg = { ...config, homeCityId: 'HAIPHONG' };
    expect(trainingPreview(open(cfg), cfg, 'EMP01').reasonKo).toBe('일반 훈련은 하이퐁에서만 할 수 있습니다.');
  });
});

describe('급여 지급 가능일 표시', () => {
  it('M2 시작 원화 10,000,000 / 일급 80,000 + 80,000은 오늘 포함 62일까지다', () => {
    const s = open();
    expect(config.startingCash.KRW).toBe(10_000_000);
    expect(config.employees.filter((d) => s.employees.some((e) => e.id === d.id && e.employmentStatus === 'employed'))
      .reduce((sum, d) => sum + d.salaryPerDayMinor, 0)).toBe(160_000);
    expect(pure(s, config, () => payrollRunwayDay(s, config))).toBe(62);
    expect(pure(s, config, () => payrollRunwayDay(s, config, 100_000))).toBe(61);
    const tomorrow = commitDay(s, config, []).state;
    expect(payrollRunwayDay(tomorrow, config)).toBe(62);
    expect(payrollRunwayDay(openDay(tomorrow, config).state, config)).toBe(62);
  });

  it('오늘분에 1원 부족하면 어제, 정확하면 오늘까지다', () => {
    for (const cash of [159_999, 160_000]) {
      const cfg = { ...config, startingCash: { KRW: cash } };
      const s = open(cfg);
      expect(pure(s, cfg, () => payrollRunwayDay(s, cfg))).toBe(cash === 160_000 ? 1 : 0);
    }
  });

  it('미지급 의무와 추가 지출을 빼고 향후 근무 시작 직원의 급여를 합산한다', () => {
    const cfg = { ...config, startingCash: { KRW: 800_000 } };
    const s = open(cfg);
    const future = s.employees.find((e) => e.id === 'EMP04')!;
    future.employmentStatus = 'employed';
    future.availableFromDay = 3;
    debt(s, 100_000);
    // 800,000 - 100,000 - 10,000 - 160,000*2 - 270,000 = 100,000: 3일까지.
    expect(pure(s, cfg, () => payrollRunwayDay(s, cfg, 10_000))).toBe(3);
  });

  it('시작 원화 10,000,000에서 미지급 100,000을 빼면 62일 대신 61일까지다', () => {
    const s = open();
    expect(payrollRunwayDay(s, config)).toBe(62);
    debt(s, 100_000);
    expect(pure(s, config, () => payrollRunwayDay(s, config))).toBe(61);
  });

  it('캠페인 마지막 63일째에 처음 부족해지면 62일을 반환한다', () => {
    const cfg = { ...config, campaignDays: 63 };
    const s = open(cfg);
    expect(pure(s, cfg, () => payrollRunwayDay(s, cfg))).toBe(62);
    const exact = { ...cfg, startingCash: { KRW: 160_000 * 63 } };
    expect(payrollRunwayDay(open(exact), exact)).toBeNull();
  });

  it('캠페인 마지막 날까지 충분하거나 급여가 없거나 종료했으면 null이다', () => {
    const cfg = { ...config, campaignDays: 62 };
    const s = open(cfg);
    expect(pure(s, cfg, () => payrollRunwayDay(s, cfg))).toBeNull();
    const noWages = { ...config, employees: config.employees.map((d) => ({ ...d, salaryPerDayMinor: 0 })) };
    expect(payrollRunwayDay(open(noWages), noWages)).toBeNull();
    s.day = 63;
    s.phase = 'ENDED';
    expect(payrollRunwayDay(s, cfg)).toBeNull();
  });
});

describe('TASK-0008 통화·경계·거절 결과', () => {
  it('미지급 USD 의무는 KRW 훈련의 자금과 실제 시작을 막지 않는다', () => {
    const cfg = { ...config, startingCash: { ...config.startingCash, KRW: 50_000 } };
    const s = open(cfg);
    post(s.ledger, { id: 'USD-DEBT', day: 1, currency: 'USD', reason: '다른 통화 미지급 의무 검증',
      lines: [{ account: 'CANCELLATION_EXPENSE', amount: 50_001 }, { account: 'ACCOUNTS_PAYABLE', amount: -50_001 }] });
    s.obligations.push({ id: 'USD-DEBT', currency: 'USD', amountMinor: 50_001, reasonKo: '미지급 의무', incurredDay: 1, paidDay: null });
    expect(pure(s, cfg, () => trainingPreview(s, cfg, 'EMP01'))).toMatchObject({
      allowed: true, availableBeforeMinor: 50_000, availableAfterMinor: 0,
    });
    const result = planState(s, cfg, [training]);
    expect(result.results[0]!.status).toBe('APPLIED');
    expect(fundsPosition(result.state, cfg, 'KRW').cash).toBe(0);
    expect(result.state.obligations).toEqual(s.obligations);
  });

  it.each([[80_000, 62], [80_001, 61]])('미지급 %i원을 한 번 빼면 마지막 완납일은 %i일이다', (unpaid, day) => {
    const s = open();
    debt(s, unpaid!);
    expect(pure(s, config, () => payrollRunwayDay(s, config))).toBe(day);
  });

  it('급여 가능일은 계약의 KRW 자금 예약을 빼지 않는다', () => {
    const cfg = structuredClone(config);
    cfg.routes[0]!.currency = 'KRW';
    cfg.routes[0]!.bookingFeeMinor = 100_000;
    cfg.offers.find((o) => o.id === 'OFFER_FWD_01')!.currency = 'KRW';
    const result = planState(open(cfg), cfg, [{ id: 'FWD', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01' }]);
    expect(result.results[0]!.status).toBe('APPLIED');
    expect(fundsPosition(result.state, cfg, 'KRW').reserved).toBe(100_000);
    expect(pure(result.state, cfg, () => payrollRunwayDay(result.state, cfg))).toBe(62);
  });

  it.each(['MISSING', 'EMP02'])('상태에 없는 직원 %s의 훈련 미리보기는 가상 경험치·레벨·능력을 만들지 않는다', (employeeId) => {
    const s = open();
    s.employees = s.employees.filter((e) => e.id !== employeeId);
    const preview = pure(s, config, () => trainingPreview(s, config, employeeId));
    const actual = planState(s, config, [{ ...training, employeeId }]).results[0]!;
    expect(actual.status).toBe('REJECTED');
    expect(preview).toMatchObject({ allowed: false, reasonKo: actual.reasonKo,
      xpGain: 0, levelAfter: null, statsAfter: null });
  });

  it.each([
    ['후보', 'EMP04', '고용 중인 직원이 아닙니다.'],
    ['없는 직원', 'MISSING', '고용 중인 직원이 아닙니다.'],
    ['근무 시작 전', 'EMP01', '귀솔은(는) 2일부터 업무를 맡을 수 있습니다.'],
    ['다른 도시', 'EMP01', '일반 훈련은 평택에서만 할 수 있습니다.'],
    ['자금 부족', 'EMP01', '훈련비 자금이 부족합니다. 필요 50,000원, 사용 가능 49,999원.'],
    ['업무 중', 'EMP01', '귀솔은(는) 다른 업무(항만 물류단지 현장 조사)를 진행 중입니다. 한 사람은 한 번에 업무 하나만 맡습니다.'],
  ])('훈련 거절 %s는 processedCommands 전체에 정확한 일자·종류·상태·이유만 추가한다', (reason, employeeId, reasonKo) => {
    const cfg = structuredClone(config);
    if (reason === '자금 부족') cfg.startingCash.KRW = 49_999;
    let s = open(cfg);
    if (reason === '근무 시작 전') emp(s).availableFromDay = 2;
    if (reason === '다른 도시') emp(s).locationCityId = 'HAIPHONG';
    if (reason === '업무 중') s = planState(s, cfg, [scout]).state;
    const before = structuredClone(s);
    const result = planState(s, cfg, [{ ...training, employeeId: employeeId! }]);
    expect(result.results[0]!.status).toBe('REJECTED');
    expect(result.state.processedCommands).toEqual({ ...before.processedCommands,
      TRAIN: { day: 1, type: 'START_TRAINING', status: 'REJECTED', reasonKo },
    });
    expect(result.state).toEqual({ ...before, processedCommands: result.state.processedCommands });
    expect(s).toEqual(before);
  });
});
