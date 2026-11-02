import { describe, expect, it } from 'vitest';
import { loadRiskProfile, loadScenario } from '../../content/scenario';
import { createGame, openDay, planState } from '../engine';
import { post } from '../ledger';
import { contractRiskReport } from '../reports';
import { usdToKrwMinor, withRiskLevel } from '../risk';
import { createRng, drawUniform } from '../rng';
import type { Contract, GameState, OfferDef } from '../types';
import { d03Options, simMain, USAGE, type SimIo } from './cli';
import { mergeD03, requestedRisk, workerOptions } from './d03';
import { createMetricsCollector } from './metrics';
import { directTradeCandidates, termCandidate, type DirectCandidate } from './operations-policy';
import { policyById } from './policies';
import { rateAtV2, riskMetrics, simConfigV2, type RiskLevelV2 } from './risk-metrics';
import { riskTables } from './risk-tables';
import { serializeSimOutput, simulate, SIM_FORMAT, SIM_SEEDS, type SimOutput } from './sim';
import { bundleKindV2, d03PolicyIds, d03PolicyIdsV2 } from './variants';

const SCENARIO = 'SCENARIO_M2_OPS_COS_LAVER';
const SHA = 'a'.repeat(64);
const cfg = (level: RiskLevelV2 = 'R4') => simConfigV2({ ...loadScenario(SCENARIO), seed: 2001 }, level, 'RISK_PROFILE_V2');
const seven = ['creditTermId', 'creditEligible', 'grade', 'saleAmountMinor', 'acceptedDay', 'paymentDueDay', 'saleKrwAtAcceptMinor'] as const;
const cache = new Map<string, ReturnType<typeof simulate>>();
function simulation(policy: string, seed = 2001) {
  if (seed < 2001) throw new Error('시험 시드는 2001 이상입니다.');
  const key = `${policy}/${seed}`;
  if (!cache.has(key)) cache.set(key, simulate(cfg(), policyById(policy)!, seed, undefined, 'R4'));
  return cache.get(key)!;
}
function memoryIo() {
  const files = new Map<string, string>(), stdout: string[] = [], stderr: string[] = [];
  const io: SimIo = { readText: (p) => files.get(p)!, writeText: (p, s) => { files.set(p, s); },
    out: (s) => { stdout.push(s); }, err: (s) => { stderr.push(s); }, now: () => 0, marketRulesSha256: () => SHA };
  return { io, files, stdout, stderr };
}

// 다른 품목을 써서 손으로 지정하지 않은 교차 짝이 생기지 않게 한다.
function hand() {
  const config = cfg();
  config.terms.paymentDueDay = null;
  config.terms.prepWorkUnits = 1;
  config.operations!.prep.tradeExtraPerLot = 1;
  config.operations!.facility.handlingWorkUnitsPerDay = 100;
  const state = openDay(createGame(config), config).state;
  const buys = [...config.offers, ...state.operations!.offers].filter((o) => o.kind === 'supplier');
  const sells = [...config.offers, ...state.operations!.offers].filter((o) => o.kind === 'customer');
  config.offers = [];
  state.offers = []; state.operations!.offers = [];
  post(state.ledger, { id: '시험-자본', day: 1, currency: 'KRW', reason: '손 고정물 자본',
    lines: [{ account: 'CASH', amount: 100000000 }, { account: 'OPENING_EQUITY', amount: -100000000 }] });
  function add(id: string, goodIndex: number, grade: string, quantity = 3, price = 12347, due = 40, deadline = 50) {
    const goodId = config.operations!.market.trade.goods[goodIndex]!.goodId;
    const b = buys[0]!, template = sells[0]!;
    const customer = config.operations!.risk!.profile.collections.byCounterparty.find((r) => r.grade === grade)!.counterpartyId;
    const buy: OfferDef = { ...b, goodId, id: `Q${id}`, quantity, quantityStep: quantity, maxQuantity: quantity, unitPriceMinor: 1301, publishDay: 1, validUntilDay: 7 };
    const sell: OfferDef = { ...template, goodId, id: `P${id}`, quantity, quantityStep: quantity, maxQuantity: quantity, unitPriceMinor: price,
      counterpartyId: customer, publishDay: 1, validUntilDay: 7, paymentDueDay: due, deliveryDeadlineDay: deadline };
    for (const o of [buy, sell]) { state.operations!.offers.push(o); state.offers.push({ id: o.id, status: 'OPEN' }); }
    return { buy, sell };
  }
  return { config, state, add };
}
function candidate(f: ReturnType<typeof hand>, sell: OfferDef): DirectCandidate {
  return directTradeCandidates(f.state, f.config, 1).find((c) => c.sellOfferId === sell.id)!;
}
function decision(f: ReturnType<typeof hand>, id: string) {
  const d = policyById(id)!.decide(f.state, f.config, createRng(2001));
  const result = planState(f.state, f.config, d.commands);
  expect(result.results.every((r) => r.status === 'APPLIED'), JSON.stringify(result.results)).toBe(true);
  return { d, state: result.state };
}

async function nodeIo() {
  const fs = await import('node:fs' as string) as { mkdtempSync(p: string): string; readFileSync(p: string, encoding: string): string;
    writeFileSync(p: string, s: string): void; rmSync(p: string, options: object): void };
  const os = await import('node:os' as string) as { tmpdir(): string };
  const cp = await import('node:child_process' as string) as { execFile(file: string, args: string[], options: object,
    cb: (error: Error | null, stdout: string, stderr: string) => void): void };
  return { fs, dir: () => fs.mkdtempSync(`${os.tmpdir()}/risk-v2-`), exec: (args: string[]) => new Promise<string>((resolve, reject) =>
    cp.execFile('node', ['src/engine/sim/run.mjs', ...args], { maxBuffer: 16 * 1024 * 1024 },
      (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(out))) };
}

describe('TASK-0068a 실행기 v2', () => {
  it('1 CLI 도움말 전문과 옵션·시드 경계', () => {
    expect(USAGE).toBe(`사용법:
  sim run [--scenarios A,B] [--policies X,Y] [--seeds N] [--out PATH]
  sim d03 [--risk R0|R1|R2|R3] [--scenarios A,B] [--round 0~3] [--seed-base N] [--seeds N] [--seed-from N] [--seed-to N] [--late base|cap30|flat200] [--workers N] [--out PATH]
  sim d03 --risk-v2 R0P|R1|R2|R3|R4 --seed-base N [--profile ID] [--round 0~3] [--scenarios A] [--seeds N] [--seed-from N] [--seed-to N] [--late base|cap30|flat200] [--workers N] [--out PATH]
  sim d03 --tables-from a.json,b.json [--late base|cap30|flat200]
  sim risk-compare A B
  sim v2-tables FILE
  sim risk-compare-v2 A B
  sim v2-report R0P R1 R2 R3 R4 [--r0 FILE]
  sim v3-tables FILE
  sim v3-report --base R0P,R1,R2,R3,R4 [--base-r0 FILE] [--oos R0P,R1,R2,R3,R4] [--oos-r0 FILE]
  sim compare BEFORE AFTER [--limit N]
  sim summary FILE
  sim help | --help
run의 시드 수 N은 기본 목록의 앞 1~20개입니다. 비교 표시 한도는 0 이상의 정수입니다.
D03의 --seed-base N은 시드 목록을 N~N+(시드 수−1)로 바꿉니다(시드 수 기본 20, 최대 40). --seed-base 없이 시드 수는 20 이하입니다. 분할 번호는 이 목록에 적용됩니다.
종료 코드: 0 성공, 1 비교 결과 다름, 2 사용법·입력·실행 오류, 3 v3 J1 관문 실패(출력은 모두 냄).
`);
    const base = ['--risk-v2', 'R4', '--seed-base', '2001'];
    for (const args of [
      ['--risk-v2', 'R4'], ['--profile', 'RISK_PROFILE_V2'], [...base, '--risk', 'R3'],
      [...base, '--profile', 'RISK_PROFILE_DEFAULT'], [...base, '--scenarios', 'SCENARIO_M2_OPS_COS'],
      [...base, '--seeds', '41'], ['--seeds', '21'], ['--risk-v2', 'R0', '--seed-base', '2001'],
    ]) {
      // 필수 시드 검사를 지우는 변형에서도 금지 시드 실행에 들어가지 않는다.
      expect(() => d03Options(args), args.join(' ')).toThrow();
      expect(simMain(['d03', ...args], memoryIo().io), args.join(' ')).toBe(2);
    }
    for (const id of ['TERM_GREEDY', 'CREDIT_AWARE']) for (const action of ['d03', 'run']) {
      expect(simMain([action, '--policies', id], memoryIo().io)).toBe(2);
    }
    expect(() => d03Options(['--seed-base', '9007199254740953', '--seeds', '40'])).toThrow('시드 기준값');
    expect(d03Options(['--seed-base', '9007199254740952', '--seeds', '40']).seeds.at(-1)).toBe(Number.MAX_SAFE_INTEGER);
    const forty = d03Options([...base, '--seeds', '40']);
    expect(forty).toMatchObject({ profileId: 'RISK_PROFILE_V2', riskV2: true, risk: 'R4', scenarioIds: [SCENARIO] });
    expect(forty.seeds).toHaveLength(40); expect(forty.seeds.at(-1)).toBe(2040);
    expect(d03Options([...base, '--seeds', '3', '--seed-from', '2']).seeds).toEqual([2002, 2003]);
    expect(d03Options([]).seeds).toEqual(SIM_SEEDS); expect(SIM_SEEDS).toHaveLength(20);
    expect(requestedRisk({ ...d03Options(['--round', '2', '--risk-v2', 'R1', '--seed-base', '2001']), marketRulesSha256: SHA }))
      .toEqual({ rules: 'M2a-rules-4', level: 'R1', profileId: 'RISK_PROFILE_V2', tuningRound: 2, marketRulesSha256: SHA });
  });

  it('2 전체·축소 묶음과 v1 보존', () => {
    for (const level of ['R0P', 'R4'] as const) {
      expect(bundleKindV2(level)).toBe('full');
      expect(d03PolicyIdsV2(level)).toEqual([...d03PolicyIds('base'), 'MARGIN_BUFFER', 'TERM_GREEDY', 'CREDIT_AWARE']);
      expect(d03PolicyIdsV2(level)).not.toContain('FOCUS');
    }
    for (const level of ['R1', 'R2', 'R3'] as const) {
      expect(bundleKindV2(level)).toBe('reduced');
      expect(d03PolicyIdsV2(level)).toEqual(['IDLE', 'NO_FX', 'MAX_CONTRIBUTION', 'LATE_OK', 'MARGIN_BUFFER', 'TERM_GREEDY', 'CREDIT_AWARE']);
    }
    for (const id of ['TERM_GREEDY', 'CREDIT_AWARE']) expect(d03PolicyIds()).not.toContain(id);
  });

  it('3 정책 조건 선택: 날짜·한도·C 등급·기준 명령', () => {
    const f = hand(), a = f.add('긴', 0, 'A'), b = f.add('중간', 1, 'B', 5, 11003, 46);
    const blocked = f.add('한도', 0, 'C', 7, 14009);
    f.config.operations!.risk!.credit!.limits.find((l) => l.grade === 'C')!.limitMinor = 100;
    for (const [sell, expected] of [[a.sell, 'D30'], [b.sell, 'D15'], [blocked.sell, 'BASE']] as const) {
      expect(termCandidate(f.state, f.config, candidate(f, sell), 'TERM_GREEDY', 1).creditTermId).toBe(expected);
    }
    for (const sell of [a.sell, b.sell]) expect(termCandidate(f.state, f.config, candidate(f, sell), 'CREDIT_AWARE', 1))
      .toEqual(termCandidate(f.state, f.config, candidate(f, sell), 'TERM_GREEDY', 1));
    f.config.operations!.risk!.credit!.limits.find((l) => l.grade === 'C')!.limitMinor = 400000;
    expect(termCandidate(f.state, f.config, candidate(f, blocked.sell), 'CREDIT_AWARE', 1).creditTermId).toBe('BASE');
    const commands = decision(f, 'MAX_CONTRIBUTION').d.commands.filter((c) => c.type === 'ACCEPT_TRADE');
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(Object.hasOwn(c, 'creditTermId')).toBe(false);
  });

  it('3 같은 날 한도: 생성 때 D30인 둘째 후보를 수락 직전 BASE로 다시 고른다', () => {
    const f = hand(), first = f.add('첫', 0, 'B', 5, 20011), second = f.add('둘', 1, 'B', 3, 16007);
    const limit = f.config.operations!.risk!.credit!.limits.find((l) => l.grade === 'B')!;
    limit.limitMinor = 110000;
    for (const sell of [first.sell, second.sell]) expect(termCandidate(f.state, f.config, candidate(f, sell), 'TERM_GREEDY', 1).creditTermId).toBe('D30');
    const result = decision(f, 'TERM_GREEDY');
    expect(result.state.contracts.map((c) => [c.sellOfferId, c.creditTermId])).toEqual([[first.sell.id, 'D30'], [second.sell.id, 'BASE']]);
  });

  it('4 가산 판매액은 기여에 그대로 더하고 v1 후보 값은 보존한다', () => {
    const f = hand(), { sell } = f.add('나머지', 0, 'A', 7, 12347), c = candidate(f, sell);
    const t = termCandidate(f.state, f.config, c, 'TERM_GREEDY', 1);
    expect((c.sale * 10600) % 10000).not.toBe(0);
    expect(t.sale).toBe(Math.floor((c.sale * 10600 + 5000) / 10000));
    expect(t.contribution - c.contribution).toBe(t.sale - c.sale);
    expect(t.sale).toBeGreaterThan(c.sale);
    const old = termCandidate(f.state, f.config, c, 'MAX_CONTRIBUTION', 1);
    expect(old).toEqual({ creditTermId: undefined, sale: c.sale, contribution: c.contribution, preview: c.preview });
    expect(old.preview).toBe(c.preview);
  });

  it('5 RiskContract 일곱 칸은 v2 직접 무역에만 있고 상태·환율·성분과 같다', () => {
    const { state, run } = simulation('TERM_GREEDY'), config = cfg();
    expect(run.metrics.risk!.contracts.some((c) => c.kind === 'FORWARDING')).toBe(true);
    for (const c of run.metrics.risk!.contracts) {
      if (c.kind === 'FORWARDING') { for (const key of seven) expect(Object.hasOwn(c, key)).toBe(false); continue; }
      const source = state.contracts.find((s) => s.id === c.contractId)!;
      for (const key of seven) expect(Object.hasOwn(c, key), key).toBe(true);
      expect(c).toMatchObject({ creditTermId: source.creditTermId, creditEligible: source.creditEligible,
        saleAmountMinor: source.saleAmountMinor, acceptedDay: source.acceptedDay, paymentDueDay: source.paymentDueDay,
        grade: config.operations!.risk!.profile.collections.byCounterparty.find((r) => r.counterpartyId === source.customerId)!.grade,
        saleKrwAtAcceptMinor: usdToKrwMinor(source.saleAmountMinor, rateAtV2(config, 2001, source.acceptedDay)) });
      expect(c.components).toEqual(contractRiskReport(state, config, source.id).components);
    }
    const v1 = simulate(withRiskLevel({ ...loadScenario(SCENARIO), seed: 2001 }, 'R3', loadRiskProfile('RISK_PROFILE_DEFAULT')),
      policyById('MAX_CONTRIBUTION')!, 2001, undefined, 'R3').run;
    expect(v1.metrics.risk!.contracts.length).toBeGreaterThan(0);
    for (const c of v1.metrics.risk!.contracts) for (const key of seven) expect(Object.hasOwn(c, key)).toBe(false);
    expect(Object.hasOwn(v1.metrics.risk!, 'credit')).toBe(false);
    expect(Object.hasOwn(v1.metrics.operations!, 'rejectionsV2')).toBe(false);
  }, 60000);

  it('6 진단 U: 확정 1·미확정 2, 배타 수금, 날짜·한도 경계', () => {
    const f = hand(), { sell } = f.add('원형', 0, 'A');
    const template = decision(f, 'MAX_CONTRIBUTION').state.contracts[0]!;
    const risk = f.config.operations!.risk!;
    for (const p of risk.credit!.pDefaultBpByGrade) p.pDefaultBp = p.grade === 'B' ? 0 : 10000;
    risk.profile.collections.lateMinDays = 4; risk.profile.collections.lateMaxDays = 15;
    f.state.day = 90; f.state.phase = 'ENDED';
    f.state.contracts = []; f.state.invoices = []; f.state.ledger.entries = []; f.state.ledger.postedIds = {};
    const customer = (grade: string) => risk.profile.collections.byCounterparty.find((r) => r.grade === grade)!.counterpartyId;
    function invoice(id: string, status: GameState['invoices'][number]['status'], amount: number, due: number, patch: Partial<Contract> = {}) {
      const c: Contract = { ...template, id, status: status === 'PAID' || status === 'WRITTEN_OFF' ? 'COMPLETED' : 'IN_PROGRESS',
        invoiceId: id, saleAmountMinor: amount, deliveredDay: 10, paymentDueDay: due,
        creditTermId: 'BASE', creditEligible: { dateRule: false, limitBlocked: [] }, ...patch };
      f.state.contracts.push(c);
      f.state.invoices.push({ id, contractId: id, currency: 'USD', amountMinor: amount, issuedDay: 10, dueDay: due, status, receiptIds: [] });
      return c;
    }
    function receipt(id: string, suffix: string, day: number, amount: number) {
      post(f.state.ledger, { id: `RECEIPT-RCPT-${id}${suffix}`, contractId: id, day, currency: 'USD', reason: '손 수금',
        lines: [{ account: 'CASH', amount }, { account: 'ACCOUNTS_RECEIVABLE', amount: -amount }] });
    }
    invoice('확정', 'WRITTEN_OFF', 10103, 20); receipt('확정', '-R', 35, 3031);
    invoice('미확정1', 'OVERDUE', 21007, 79);
    invoice('미확정2', 'OVERDUE', 31009, 83, { customerId: customer('C') }); receipt('미확정2', '', 83, 7003);
    invoice('대손아님', 'OVERDUE', 41011, 80, { customerId: customer('B') });
    invoice('지연', 'PAID', 51013, 41); receipt('지연', '', 48, 51013);
    invoice('부분', 'PAID', 61019, 43); receipt('부분', '', 43, 25007); receipt('부분', '-2', 51, 36012);
    invoice('회수', 'PAID', 71023, 44); receipt('회수', '-R', 59, 71023);
    for (const [account, amount] of [['BAD_DEBT', 7072], ['RECEIVABLE_CARRY', 317]] as const) post(f.state.ledger, {
      id: account === 'BAD_DEBT' ? 'BADDEBT-확정' : 'CARRY-확정', contractId: '확정', day: 35, currency: 'USD', reason: '손 비용', lines: [{ account, amount }, { account: 'OPENING_EQUITY', amount: -amount }] });
    // 먼저 수금 진단만 검산한 뒤 별도 날짜 경계 3건으로 분모를 고정한다.
    let m = riskMetrics(f.state, f.config, createMetricsCollector(f.config).finish(f.state, f.config), 'R4');
    expect(m.credit).toMatchObject({ defaultsConfirmed: 1, defaultsUnconfirmed: 2, unconfirmedMinor: 45013,
      badDebtMinor: 7072, carryMinor: 317, partialReceipts: 1, lateReceipts: 1 });
    f.state.contracts = [] ; f.state.invoices = [];
    invoice('날짜90', 'OVERDUE', 11003, 75, { creditTermId: 'D15', creditEligible: { dateRule: true, limitBlocked: [] } });
    invoice('날짜91', 'OVERDUE', 13007, 61);
    invoice('한도막힘', 'OVERDUE', 17011, 60, { creditEligible: { dateRule: true, limitBlocked: ['D15'] } });
    m = riskMetrics(f.state, f.config, createMetricsCollector(f.config).finish(f.state, f.config), 'R4');
    expect(m.credit).toMatchObject({ dateEligible: 2, dateLimitEligible: 1, limitBlocked: 1, termCounts: { BASE: 2, D15: 1, D30: 0 } });
    expect(sell.paymentDueDay).toBe(40);
  });

  it('7 손 기제: C만 BASE로 갈리고 A·B는 두 정책에서 같다', () => {
    const f = hand(), a = f.add('A', 0, 'A'), c = f.add('C', 1, 'C', 5, 17003);
    const b = f.add('B', 0, 'B', 7, 19001);
    // 매입·판매를 공개일로 짝지어 같은 품목의 다른 후보와 섞이지 않게 한다.
    b.buy.publishDay = b.sell.publishDay = 0;
    const tg = decision(f, 'TERM_GREEDY').state.contracts, ca = decision(f, 'CREDIT_AWARE').state.contracts;
    expect(tg).toHaveLength(3); expect(ca).toHaveLength(3);
    expect(tg.find((x) => x.sellOfferId === c.sell.id)!.creditTermId).toBe('D30');
    expect(ca.find((x) => x.sellOfferId === c.sell.id)!.creditTermId).toBe('BASE');
    for (const sell of [a.sell, b.sell]) {
      expect(tg.find((x) => x.sellOfferId === sell.id)!.creditTermId).toBe('D30');
      expect(ca.find((x) => x.sellOfferId === sell.id)!.creditTermId).toBe('D30');
    }
  });

  it('8 시드 기제: CREDIT_AWARE의 C 비BASE는 0건', () => {
    const witnesses: number[] = [];
    for (const seed of [2001, 2002, 2003]) {
      const ca = simulation('CREDIT_AWARE', seed).run.metrics.risk!.contracts;
      expect(ca.filter((c) => c.grade === 'C' && c.creditTermId !== 'BASE')).toHaveLength(0);
      if (simulation('TERM_GREEDY', seed).run.metrics.risk!.contracts.some((c) => c.grade === 'C' && c.creditTermId !== 'BASE')) witnesses.push(seed);
    }
    // 자연 시드에 갈림 사건이 없어도 위 손 고정물이 기제를 검증한다.
    console.info(`기제 시험: ${witnesses.length ? `TERM_GREEDY C 비BASE 시드 ${witnesses.join(', ')}` : '손 고정물로만 확인'}`);
  }, 60000);

  it('9 R4 CLI 스모크: 메타·요약·정책별 조건 합계', async () => {
    const n = await nodeIo(), dir = n.dir(), path = `${dir}/smoke.json`, mem = memoryIo();
    mem.io.writeText = (p, s) => n.fs.writeFileSync(p, s);
    try {
      expect(simMain(['d03', '--risk-v2', 'R4', '--policies', 'MAX_CONTRIBUTION,TERM_GREEDY,CREDIT_AWARE', '--seed-base', '2001', '--seeds', '2', '--out', path], mem.io), mem.stderr.join('')).toBe(0);
      expect(mem.stdout).toEqual(['v2 실행 6회 · 단계 R4 · 프로필 RISK_PROFILE_V2 · 시드 2001~2002 (표는 TASK-0068b)\n']);
      const output = JSON.parse(n.fs.readFileSync(path, 'utf8')) as SimOutput;
      expect(Object.keys(output.meta.risk!)).toEqual(['rules', 'level', 'profileId', 'tuningRound', 'marketRulesSha256']);
      expect(output.meta.risk).toEqual({ rules: 'M2a-rules-4', level: 'R4', profileId: 'RISK_PROFILE_V2', tuningRound: 0, marketRulesSha256: SHA });
      expect(output.runs).toHaveLength(6);
      for (const r of output.runs) {
        expect(Object.values(r.metrics.risk!.credit!.termCounts).reduce((a, b) => a + b, 0)).toBe(r.metrics.risk!.directAccepted);
        expect(r.metrics.risk!.analysisValueMinor).toBeTypeOf('number');
      }
      const bad = structuredClone(output); bad.meta.risk!.profileId = '다름';
      expect(() => mergeD03([bad], 'base', output.meta.risk)).toThrow('위험 메타');
    } finally { n.fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);

  it('10 거절 단위: onTime 1·짝 1·견적 1·OPEN 건너뜀 2와 simulate 전달', () => {
    const f = hand(), p1 = f.add('1', 0, 'A', 3, 30011), p3 = f.add('2', 1, 'B', 5, 17003, 40, 1);
    p1.buy.maxQuantity = p1.sell.maxQuantity = 6;
    const p2: OfferDef = { ...p1.sell, id: 'P추가', maxQuantity: 3, unitPriceMinor: 13007 };
    f.state.operations!.offers.push(p2); f.state.offers.push({ id: p2.id, status: 'OPEN' });
    const { d, state } = decision(f, 'MAX_CONTRIBUTION');
    expect(state.contracts.map((c) => [c.sellOfferId, c.quantity])).toEqual([[p1.sell.id, 6]]);
    const expected = { candidate: { funds: 0, storage: 0, handling: 0, sailing: 0, staff: 0, onTime: 1, credit: 0 }, pair: 1, quote: 1, skippedNotOpen: 2 };
    expect(d.rejectionUnits).toEqual(expected);
    expect(p3.sell.deliveryDeadlineDay).toBe(1);
    // 손 결정의 계측을 실제 simulate 수집 경로로 보내 끝 출력까지 검증한다.
    const result = simulate(f.config, { id: 'MAX_CONTRIBUTION', labelKo: '손 거절', decide(opened, _config, rng) {
      return { commands: [], rng, ...(opened.day === 1 ? { rejectionUnits: d.rejectionUnits } : {}) };
    } }, 2001, undefined, 'R4');
    expect(result.run.metrics.operations!.rejectionsV2).toEqual(expected);
  }, 60000);

  it('11 워커 1·2 JSON 바이트와 v2 메타 일치', async () => {
    const n = await nodeIo(), dir = n.dir();
    try {
      for (const workers of [1, 2]) await n.exec(['d03', '--risk-v2', 'R1', '--seed-base', '2001', '--seeds', '3', '--policies', 'MAX_CONTRIBUTION,TERM_GREEDY', '--workers', String(workers), '--out', `${dir}/${workers}.json`]);
      const one = n.fs.readFileSync(`${dir}/1.json`, 'utf8');
      expect(n.fs.readFileSync(`${dir}/2.json`, 'utf8')).toBe(one);
      const output = JSON.parse(one) as SimOutput;
      expect(output.meta.risk).toMatchObject({ rules: 'M2a-rules-4', level: 'R1', profileId: 'RISK_PROFILE_V2' });
      expect(output.meta.risk!.marketRulesSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(output.meta.seeds).toEqual([2001, 2002, 2003]);
      const options = { ...d03Options(['--risk-v2', 'R1', '--seed-base', '2001', '--seeds', '3']), marketRulesSha256: SHA };
      expect(workerOptions(options, 0, 2).seeds).toEqual([2001, 2003]);
      expect(requestedRisk(workerOptions(options, 1, 2))).toEqual(requestedRisk(options));
    } finally { n.fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);

  it('12 v1 비교·표는 같은 시드·프로필·sha의 v2 R1/R2도 rules로 거절한다', () => {
    const mem = memoryIo();
    const result = simulation('MAX_CONTRIBUTION');
    const output = (level: 'R1' | 'R2'): SimOutput => ({ meta: { tool: 'scitrade-sim', format: SIM_FORMAT, engineVersion: result.state.meta.engineVersion,
      dataVersion: result.state.meta.dataVersion, scenarioIds: [SCENARIO], policyIds: ['MAX_CONTRIBUTION'], seeds: [2001], lateMode: 'base',
      risk: { rules: 'M2a-rules-4', level, profileId: 'RISK_PROFILE_V2', tuningRound: 0, marketRulesSha256: SHA } }, runs: [result.run] });
    mem.files.set('R1.json', serializeSimOutput(output('R1'))); mem.files.set('R2.json', serializeSimOutput(output('R2')));
    expect(simMain(['risk-compare', 'R1.json', 'R2.json'], mem.io)).toBe(2);
    expect(mem.stderr.at(-1)).toContain('v1 risk-compare는 rules 메타');
    expect(simMain(['d03', '--tables-from', 'R1.json'], mem.io)).toBe(2);
    expect(mem.stderr.at(-1)).toContain('v1 --tables-from은 rules 메타');
    expect(() => riskTables(output('R1'))).toThrow('rules 메타');
  }, 60000);
});


describe('TASK-0068a R1 판별력', () => {
  it('policy-1 조건 기여 정렬은 창고 하나를 Y에, BASE 정렬은 X에 준다', () => {
    const f = hand(), x = f.add('X', 0, 'A', 3, 10001, 76), y = f.add('Y', 1, 'B', 3, 9901, 40);
    // 화장품 60 L 또는 김 30 L는 각각 들어가지만 합계 90 L는 들어가지 않는다.
    f.config.operations!.facility.storageLiters = 67;
    const cx = candidate(f, x.sell), cy = candidate(f, y.sell);
    const tx = termCandidate(f.state, f.config, cx, 'TERM_GREEDY', 1);
    const ty = termCandidate(f.state, f.config, cy, 'TERM_GREEDY', 1);
    expect(cx.contribution).toBe(11688); expect(cy.contribution).toBe(11388);
    expect(tx.creditTermId).toBe('BASE'); expect(ty.creditTermId).toBe('D30');
    expect(ty.contribution).toBe(13170); expect(ty.contribution).toBeGreaterThan(tx.contribution);
    expect((cy.sale * 10600) % 10000).not.toBe(0);
    expect(decision(f, 'TERM_GREEDY').state.contracts.map((c) => c.sellOfferId)).toEqual([y.sell.id]);
    expect(decision(f, 'MAX_CONTRIBUTION').state.contracts.map((c) => c.sellOfferId)).toEqual([x.sell.id]);
  });

  it('policy-1 BASE 적자라도 D30 가산으로 흑자면 수락한다', () => {
    const f = hand(), { sell } = f.add('가산흑자', 1, 'B', 3, 6001);
    const c = candidate(f, sell), t = termCandidate(f.state, f.config, c, 'TERM_GREEDY', 1);
    expect(c.contribution).toBe(-312); expect(t.contribution).toBe(768);
    expect(t.creditTermId).toBe('D30');
    expect(decision(f, 'TERM_GREEDY').state.contracts.map((c) => [c.sellOfferId, c.creditTermId])).toEqual([[sell.id, 'D30']]);
    expect(decision(f, 'MAX_CONTRIBUTION').state.contracts).toHaveLength(0);
  });

  it('policy-2 한도 소진 뒤 BASE 적자는 credit에만 세고 짝과 견적에도 센다', () => {
    const f = hand(), first = f.add('한도소진', 0, 'B', 5, 20011), second = f.add('재평가적자', 1, 'B', 3, 6001);
    f.config.operations!.risk!.credit!.limits.find((l) => l.grade === 'B')!.limitMinor = 106058;
    expect(first.sell.counterpartyId).toBe(second.sell.counterpartyId);
    for (const sell of [first.sell, second.sell]) {
      const t = termCandidate(f.state, f.config, candidate(f, sell), 'TERM_GREEDY', 1);
      expect(t.creditTermId).toBe('D30'); expect(t.contribution).toBeGreaterThan(0);
    }
    const { d, state } = decision(f, 'TERM_GREEDY');
    expect(state.contracts.map((c) => [c.sellOfferId, c.saleAmountMinor])).toEqual([[first.sell.id, 106058]]);
    const t = termCandidate(state, f.config, candidate(f, second.sell), 'TERM_GREEDY', 1);
    expect(t.creditTermId).toBe('BASE'); expect(t.contribution).toBe(-312);
    expect(d.rejectionUnits).toEqual({ candidate: { funds: 0, storage: 0, handling: 0, sailing: 0, staff: 0, onTime: 0, credit: 1 },
      pair: 1, quote: 1, skippedNotOpen: 0 });
    expect(Object.hasOwn(d.rejections!, 'credit')).toBe(false);
    expect(d.rejections).toEqual({ funds: 0, storage: 0, handling: 0, sailing: 0, staff: 0, onTime: 0 });
  });

  it.each(['TERM_GREEDY', 'CREDIT_AWARE'])('policy-4 %s는 BASE 키를 명시한다', (id) => {
    const f = hand(), { sell } = f.add('명시BASE', 0, 'C', 7, 14009, 76);
    const commands = decision(f, id).d.commands.filter((c) => c.type === 'ACCEPT_TRADE');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.sellOfferId).toBe(sell.id);
    expect(Object.hasOwn(commands[0]!, 'creditTermId') && commands[0]!.creditTermId === 'BASE').toBe(true);
  });

  it.each(['R0P', 'R1', 'R4'] as const)('compat-1 %s CLI 기본 묶음 메타', (level) => {
    const mem = memoryIo();
    expect(simMain(['d03', '--risk-v2', level, '--seed-base', '2001', '--seeds', '1', '--out', 'default.json'], mem.io), mem.stderr.join('')).toBe(0);
    const output = JSON.parse(mem.files.get('default.json')!) as SimOutput;
    // 출력 직렬화는 정책 ID를 정렬한다.
    expect(output.meta.policyIds).toEqual(d03PolicyIdsV2(level).sort());
    expect(output.runs.map((r) => r.policyId).sort()).toEqual(d03PolicyIdsV2(level).sort());
  }, 600000);

  it('metrics-5·6 엔진 수금 ID의 완료 두 칸과 미결 두 칸은 배타적이다', () => {
    const f = hand(); f.add('수금원형', 0, 'A');
    const template = decision(f, 'MAX_CONTRIBUTION').state.contracts[0]!;
    f.state.day = 90; f.state.phase = 'ENDED';
    f.state.contracts = []; f.state.invoices = []; f.state.ledger.entries = []; f.state.ledger.postedIds = {};
    const rows = [
      { id: '지연전액', amount: 11003, due: 31, status: 'PAID', receipts: [['', 38, 11003]] },
      { id: '분할완료', amount: 17011, due: 43, status: 'PAID', receipts: [['-1', 43, 6804], ['-2', 54, 10207]] },
      { id: '분할미결', amount: 23003, due: 83, status: 'OVERDUE', receipts: [['-1', 83, 9201]] },
      { id: '연체미결', amount: 31013, due: 87, status: 'OVERDUE', receipts: [] },
    ] as const;
    for (const row of rows) {
      f.state.contracts.push({ ...template, id: row.id, invoiceId: row.id, saleAmountMinor: row.amount, paymentDueDay: row.due,
        deliveredDay: 10, status: row.status === 'PAID' ? 'COMPLETED' : 'IN_PROGRESS' });
      f.state.invoices.push({ id: row.id, contractId: row.id, currency: 'USD', amountMinor: row.amount,
        issuedDay: 10, dueDay: row.due, status: row.status, receiptIds: row.receipts.map(([suffix]) => `RCPT-${row.id}${suffix}`) });
      for (const [suffix, day, amount] of row.receipts) post(f.state.ledger, { id: `RECEIPT-RCPT-${row.id}${suffix}`,
        contractId: row.id, day, currency: 'USD', reason: '엔진 형식 손 수금',
        lines: [{ account: 'CASH', amount }, { account: 'ACCOUNTS_RECEIVABLE', amount: -amount }] });
    }
    const count = (state: GameState) => {
      const c = riskMetrics(state, f.config, createMetricsCollector(f.config).finish(state, f.config), 'R4').credit!;
      return [c.lateReceipts, c.partialReceipts, c.pendingPartialReceipts, c.pendingOverdue];
    };
    expect(count(f.state)).toEqual([1, 1, 1, 1]);
    expect(count(f.state).reduce((a, b) => a + b, 0)).toBe(rows.length);
    // 합만 같은 잘못된 분류도 잡도록 청구서별로 어느 칸에 속하는지 확인한다.
    rows.forEach((row, i) => {
      const one = structuredClone(f.state);
      one.invoices = one.invoices.filter((inv) => inv.id === row.id);
      expect(count(one)).toEqual(rows.map((_, j) => Number(i === j)));
    });
    const writtenOff = structuredClone(f.state);
    // 1센트의 회수액은 0으로 반올림되므로 수금 없는 대손 확정도 제외한다.
    Object.assign(writtenOff.invoices.find((inv) => inv.id === '연체미결')!, { status: 'WRITTEN_OFF', amountMinor: 1, dueDay: 70 });
    Object.assign(writtenOff.contracts.find((c) => c.id === '연체미결')!, { status: 'COMPLETED', saleAmountMinor: 1, paymentDueDay: 70 });
    post(writtenOff.ledger, { id: 'BADDEBT-연체미결', contractId: '연체미결', day: 85, currency: 'USD', reason: '손 대손 확정',
      lines: [{ account: 'BAD_DEBT', amount: 1 }, { account: 'ACCOUNTS_RECEIVABLE', amount: -1 }] });
    expect(count(writtenOff)).toEqual([1, 1, 1, 0]);
  });

  it('metrics-1 수락 환산액은 R0P 매일 시작 환율, R4 첫 걸음의 독립 계산과 같다', () => {
    const f = hand(); f.add('환산', 0, 'A', 7, 12347);
    const template = decision(f, 'MAX_CONTRIBUTION').state.contracts[0]!;
    const value = (config: ReturnType<typeof cfg>, day: number) => {
      const state = structuredClone(f.state);
      state.contracts = [{ ...template, acceptedDay: day }];
      return riskMetrics(state, config, createMetricsCollector(config).finish(state, config), config.operations!.risk!.layers.length ? 'R4' : 'R0P')
        .contracts[0]!.saleKrwAtAcceptMinor;
    };
    const r0 = cfg('R0P'), r4 = cfg('R4'), fx = r4.operations!.risk!.profile.fx;
    const amount = template.saleAmountMinor;
    const atStart = Math.floor((amount * fx.startKrwPerUsd + 50) / 100);
    for (let day = 1; day <= 90; day++) expect(value(r0, day), `R0P ${day}일`).toBe(atStart);
    expect(value(r4, 1)).toBe(atStart);
    // rateAtV2/referenceRate를 기대값 계산에 사용하지 않는다.
    const draw = drawUniform({ seed: 2001, cursors: { 'FX-REF': 1 } }, 'FX-REF').value;
    const step = Math.floor(draw * (2 * fx.stepBp + 1)) - fx.stepBp;
    const rate = Math.max(fx.minKrwPerUsd, Math.min(fx.maxKrwPerUsd, Math.floor((fx.startKrwPerUsd * (10000 + step) + 5000) / 10000)));
    expect(rate).not.toBe(fx.startKrwPerUsd);
    const day = r4.operations!.market.publish.firstDay + r4.operations!.market.publish.intervalDays;
    expect(value(r4, day)).toBe(Math.floor((amount * rate + 50) / 100));
    expect(value(r4, day)).not.toBe(atStart);
    expect((amount * rate) % 100).not.toBe(0);
  });

  it('metrics-3 서로 다른 두 날의 거절 단위를 모두 더한다', () => {
    const first = { candidate: { funds: 1, storage: 2, handling: 3, sailing: 4, staff: 5, onTime: 6, credit: 7 }, pair: 8, quote: 9, skippedNotOpen: 10 };
    const second = { candidate: { funds: 11, storage: 13, handling: 17, sailing: 19, staff: 23, onTime: 29, credit: 31 }, pair: 37, quote: 41, skippedNotOpen: 43 };
    const days: number[] = [];
    const result = simulate(cfg(), { id: 'MAX_CONTRIBUTION', labelKo: '여러 날 손 거절', decide(opened, _config, rng) {
      if (opened.day === 2 || opened.day === 5) days.push(opened.day);
      return { commands: [], rng, ...(opened.day === 2 ? { rejectionUnits: first } : opened.day === 5 ? { rejectionUnits: second } : {}) };
    } }, 2001, undefined, 'R4');
    expect(days).toEqual([2, 5]);
    expect(result.run.metrics.operations!.rejectionsV2).toEqual({
      candidate: { funds: 12, storage: 15, handling: 20, sailing: 23, staff: 28, onTime: 35, credit: 38 }, pair: 45, quote: 50, skippedNotOpen: 53 });
  });

  it('metrics-4 D30만 한도에 막힌 이른 결제일은 D15로 가능하다', () => {
    const f = hand(); f.add('날짜원형', 0, 'A');
    const template = decision(f, 'MAX_CONTRIBUTION').state.contracts[0]!;
    f.state.contracts = [{ ...template, id: 'D15가능', creditTermId: 'BASE', paymentDueDay: 41,
      creditEligible: { dateRule: true, limitBlocked: ['D30'] } }];
    const count = () => riskMetrics(f.state, f.config, createMetricsCollector(f.config).finish(f.state, f.config), 'R4').credit;
    expect(count()).toMatchObject({ dateEligible: 1, dateLimitEligible: 1, limitBlocked: 1 });
    f.state.contracts.push({ ...template, id: '둘다막힘', creditTermId: 'BASE', paymentDueDay: 43,
      creditEligible: { dateRule: true, limitBlocked: ['D15', 'D30'] } });
    expect(count()).toMatchObject({ dateEligible: 2, dateLimitEligible: 1, limitBlocked: 2 });
  });

  it('compat-2 v1과 v2의 양방향 비교 및 v2 표 입력은 거절한다', () => {
    const mem = memoryIo();
    expect(simMain(['d03', '--risk', 'R1', '--scenarios', SCENARIO, '--policies', 'IDLE', '--seed-base', '2001', '--seeds', '1', '--out', 'v1.json'], mem.io)).toBe(0);
    expect(simMain(['d03', '--risk-v2', 'R1', '--policies', 'IDLE', '--seed-base', '2001', '--seeds', '1', '--out', 'v2.json'], mem.io)).toBe(0);
    for (const files of [['v1.json', 'v2.json'], ['v2.json', 'v1.json']]) {
      expect(simMain(['risk-compare', ...files], mem.io)).toBe(2);
      expect(mem.stderr.at(-1)).toContain('v1 risk-compare는 rules 메타');
    }
    expect(simMain(['d03', '--tables-from', 'v2.json'], mem.io)).toBe(2);
    expect(mem.stderr.at(-1)).toContain('v1 --tables-from은 rules 메타');
  });
});
