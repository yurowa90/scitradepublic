import { describe, expect, it, vi } from 'vitest';
import { parseSync } from 'rolldown/utils';
import { loadScenario } from '../content/scenario';
import { SETTLEMENT_LINE_KO } from '../ui/path11-labels';
import { commitDay, createGame, openDay } from './engine';
import { ACCOUNT_KIND, balance, emptyLedger, post, summarize, type Account } from './ledger';
import { openTradePairs } from './market';
import type { Currency } from './money';
import { balanceSheetAt, cashLockSummary, creditLockPreview, receivablesByTerm, settlementKrw } from './path11-readers';
import { quotePreview } from './readers';
import { creditTermOptions } from './readers-lazy';
import { receivableSchedule } from './reports-lazy';
import { fundsPosition } from './reservations';
import { claimFor, collectionPlan, defaultFor, referenceRate, usdToKrwMinor } from './risk';
import { policyById } from './sim/policies';
import { simulate } from './sim/sim';
import type { GameState, ScenarioConfig } from './types';

vi.mock('./risk', async (original) => {
  const m = await original<typeof import('./risk')>();
  return { ...m, claimFor: vi.fn(m.claimFor), collectionPlan: vi.fn(m.collectionPlan),
    defaultFor: vi.fn(m.defaultFor), referenceRate: vi.fn(m.referenceRate) };
});
const cfg = (seed = 2001) => ({ ...loadScenario('SCENARIO_M2_OPS_CREDIT'), seed });
const accounts = Object.keys(ACCOUNT_KIND) as Account[];
const codes: Currency[] = ['KRW', 'USD'];
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function idle(config: ScenarioConfig, day: number) {
  let state = createGame(config);
  while (state.day < day) state = commitDay(openDay(state, config).state, config, []).state;
  return openDay(state, config).state;
}
let run: { state: GameState; closed: Map<number, GameState> } | undefined;
function history() {
  if (!run) {
    const config = cfg(), closed = new Map<number, GameState>();
    const { state } = simulate(config, policyById('TERM_GREEDY')!, 2001, (s) => {
      if ([1, 30, 60].includes(s.day - 1)) closed.set(s.day - 1, structuredClone(s));
    });
    closed.set(state.day - 1, state);
    run = { state, closed };
  }
  return run;
}
let mixed: { state: GameState; config: ScenarioConfig } | undefined;
function mixedReceivables() {
  if (!mixed) for (let seed = 2001; seed <= 2010 && !mixed; seed++) {
    const config = cfg(seed);
    simulate(config, policyById('TERM_GREEDY')!, seed, (s) => {
      if (mixed) return;
      const contracts = receivableSchedule(s, config).map((i) => s.contracts.find((c) => c.id === i.contractId)!);
      if (contracts.some((c) => c.kind === 'FORWARDING')
        && contracts.some((c) => c.kind === 'DIRECT_TRADE' && (c.creditTermId ?? 'BASE') === 'BASE')
        && contracts.some((c) => c.kind === 'DIRECT_TRADE' && ['D15', 'D30'].includes(c.creditTermId ?? 'BASE'))) {
        mixed = { state: structuredClone(s), config };
      }
    });
  }
  if (!mixed) throw new Error('멈춤 조건: 시드 2001~2010에 세 종류의 열린 청구서가 함께 없습니다');
  return mixed;
}
function fxFixture() {
  for (let seed = 2001; seed <= 2010; seed++) {
    const config = cfg(seed), p = config.operations!.market.publish, day = p.firstDay + p.intervalDays;
    const state = idle(config, day);
    if (referenceRate(config, seed, day) !== referenceRate(config, seed, 0)) return { config, state, day };
  }
  throw new Error('멈춤 조건: 시드 2001~2010에서 8일 환율 변화가 없습니다');
}
function expenses() {
  const config = cfg(), state = idle(config, 15);
  // 8일: 3센트 두 줄은 38.73원 → 39원씩. 15일: 3센트는 38.46원 → 38원.
  post(state.ledger, { id: '손비용-8', day: 8, currency: 'USD', reason: '줄마다 반올림 검산', lines: [
    { account: 'TRAINING_EXPENSE', amount: 3 }, { account: 'TRAINING_EXPENSE', amount: 3 }, { account: 'CASH', amount: -6 },
  ] });
  post(state.ledger, { id: '손비용-15', day: 15, currency: 'USD', reason: '다른 날 환율 검산', lines: [
    { account: 'TRAINING_EXPENSE', amount: 3 }, { account: 'CASH', amount: -3 },
  ] });
  return { config, state };
}
function identity(result: NonNullable<ReturnType<typeof settlementKrw>>) {
  const total = (rows: { krwMinor: number }[]) => rows.reduce((sum, r) => sum + r.krwMinor, 0);
  const profit = result.income.reduce((sum, r) => sum + (ACCOUNT_KIND[r.account] === 'income' ? r.krwMinor : -r.krwMinor), 0);
  expect(total(result.assets) - total(result.liabilities)).toBe(total(result.equity) + profit + result.fxTranslationKrwMinor);
}

describe('TASK-0075 경로 11 읽기', () => {
  it('1가 열린 상태의 정상 잔액·이익·계정 선언 순서는 원장과 같다', () => {
    const { config, state } = mixedReceivables();
    const result = balanceSheetAt(state, config, state.day);
    expect(result.byCurrency.map((r) => r.currency)).toEqual(codes);
    for (const row of result.byCurrency) {
      for (const [key, kind] of [['assets', 'asset'], ['liabilities', 'liability'], ['equity', 'equity']] as const) {
        expect(row[key].map((r) => r.account)).toEqual(accounts.filter((a) => ACCOUNT_KIND[a] === kind));
        for (const r of row[key]) expect(r.amountMinor).toBe(balance(state.ledger, row.currency, r.account));
      }
      expect(row.retainedMinor).toBe(summarize(state.ledger, row.currency).profit);
    }
  }, 60000);

  it('1나 끝 원장의 지난 날짜를 실제 1·30·60·끝 마감 원장과 대조한다', () => {
    const { state, closed } = history();
    expect([...closed.keys()]).toEqual([1, 30, 60, 90]);
    for (const [day, snapshot] of closed) {
      expect(snapshot.ledger.entries.some((e) => e.day === day), `${day}일 당일 분개`).toBe(true);
      for (const row of balanceSheetAt(state, cfg(), day).byCurrency) {
        for (const r of [...row.assets, ...row.liabilities, ...row.equity]) {
          expect(r.amountMinor, `${day}일 ${row.currency} ${r.account}`).toBe(balance(snapshot.ledger, row.currency, r.account));
        }
        expect(row.retainedMinor, `${day}일 ${row.currency} 이익`).toBe(summarize(snapshot.ledger, row.currency).profit);
      }
      identity(settlementKrw(state, cfg(), day)!);
    }
  }, 60000);

  it('2 공개일은 왼쪽을 빼고 대금일을 포함하며 마지막 공개일에서 끝난다', () => {
    const config = cfg(), p = config.operations!.market.publish, state = idle(config, 8);
    expect(p).toMatchObject({ firstDay: 1, intervalDays: 7, lastDay: 78, validDays: 3 });
    const pair = openTradePairs(state, config)[0]!;
    config.terms.paymentDueDay = 15;
    const rows = creditLockPreview(state, config, pair.buyOfferId, pair.sellOfferId);
    // 공개일 1+7k: (8,15]에는 15 하나, (8,30]에는 15·22·29 세 번이다.
    expect(rows.map((r) => r.publishesInWindow)).toEqual([1, 3, 5]);
    expect(rows.map((r) => r.lockDays)).toEqual([7, 22, 37]);
    const quote = quotePreview(state, config, pair);
    for (const row of rows) {
      expect(row.cashOut).toEqual([...quote.cashNeedByCurrency!].sort((a, b) => a.currency < b.currency ? -1 : 1));
      expect(row.cashOutKrwMinor).toBe(row.cashOut.reduce((sum, r) => sum + (r.currency === 'KRW' ? r.amountMinor : usdToKrwMinor(r.amountMinor, 1291)), 0));
    }
    config.terms.paymentDueDay = 100;
    // (8,100]에서 15·22·…·78: (78−15)/7+1 = 10번이다.
    expect(creditLockPreview(state, config, pair.buyOfferId, pair.sellOfferId).map((r) => r.publishesInWindow)).toEqual([10, 10, 10]);
  });

  it.each([[1, 2, 6667], [31, 1, 313], [0, 0, null], [-2, 1, null]] as const)(
    '3 가용 %i·미수 %i의 잠김 비율은 %s', (available, receivable, expected) => {
      const config = cfg(), state = createGame(config);
      state.ledger = emptyLedger();
      if (available) post(state.ledger, { id: '손현금', day: 0, currency: 'KRW', reason: '비율 검산',
        lines: [{ account: 'CASH', amount: available }, { account: 'OPENING_EQUITY', amount: -available }] });
      state.invoices = [{ id: '손청구서', contractId: '손계약', currency: 'KRW', amountMinor: receivable,
        issuedDay: 1, dueDay: 10, status: 'OUTSTANDING', receiptIds: [] }];
      // 20000÷3=6666 나머지2 → 6667. 10000÷32=312 나머지16 → 절반도 313.
      const result = cashLockSummary(state, config)!;
      expect(result.availableKrwMinor).toBe(available); expect(result.receivableKrwMinor).toBe(receivable);
      expect(result.lockedShareBp).toBe(expected);
    });

  it('4가 시작 USD 자금만의 환율 변동 손익을 손 계산한다', () => {
    const { state, config, day } = fxFixture(), seed = state.rng.seed;
    const r0 = referenceRate(config, seed, 0), r1 = referenceRate(config, seed, day);
    expect(r1).not.toBe(r0);
    expect(state.ledger.entries.filter((e) => e.currency === 'USD').map((e) => [e.id, e.day])).toEqual([['OPENING-USD', 0]]);
    const x = config.startingCash.USD!;
    // 300000센트 × (1291−1300)/100 = −27000원(시드 2001).
    const result = settlementKrw(state, config, day)!;
    expect(result.fxTranslationKrwMinor).toBe(usdToKrwMinor(x, r1) - usdToKrwMinor(x, r0));
    identity(result);
  });

  it('4나 수익·비용은 각 분개일 환율이고 자산·부채는 결산일 환율이다', () => {
    const { state, config } = expenses();
    expect(referenceRate(config, 2001, 8)).toBe(1291); expect(referenceRate(config, 2001, 15)).toBe(1282);
    const result = settlementKrw(state, config, 15)!;
    const expected = usdToKrwMinor(3, 1291) * 2 + usdToKrwMinor(3, 1282);
    expect(expected).toBe(116); expect(expected).not.toBe(usdToKrwMinor(3, 1282) * 3);
    expect(result.income.find((r) => r.account === 'TRAINING_EXPENSE')!.krwMinor).toBe(expected);
    for (const row of [...result.assets, ...result.liabilities]) {
      expect(row.krwMinor).toBe(balance(state.ledger, 'KRW', row.account) + usdToKrwMinor(balance(state.ledger, 'USD', row.account), 1282));
    }
    identity(result);
    // 수익·매출 감액·환전 자본도 정상 잔액 부호와 분개일 환율을 따른다.
    for (const [account, amount] of [['REVENUE', -13], ['SALES_ALLOWANCE', 2], ['CURRENCY_TRANSFER', -17]] as const) {
      post(state.ledger, { id: `손-${account}`, day: 8, currency: 'USD', reason: '정상 잔액 부호 검산',
        lines: [{ account, amount }, { account: 'CASH', amount: -amount }] });
    }
    const extra = settlementKrw(state, config, 15)!;
    expect(extra.income.find((r) => r.account === 'REVENUE')!.krwMinor).toBe(168);
    expect(extra.income.find((r) => r.account === 'SALES_ALLOWANCE')!.krwMinor).toBe(-26);
    expect(extra.equity.find((r) => r.account === 'CURRENCY_TRANSFER')!.krwMinor).toBe(219);
    identity(extra);
  });

  it('4다 FX 층을 끄면 고정 환율의 환산 차이는 0이다', () => {
    const config = cfg(); config.operations!.risk!.layers = config.operations!.risk!.layers.filter((l) => l !== 'FX');
    const state = idle(config, 15), result = settlementKrw(state, config, 15)!;
    expect(result.rateAsOf).toBe(referenceRate(config, 2001, 0));
    expect(result.fxTranslationKrwMinor).toBe(0); identity(result);
  });

  it('5 비용은 원장 줄마다 반올림한 합이며 같은 날 합산 후 환산과 다르다', () => {
    const { state, config } = expenses();
    // 줄별 39+39+38=116원, 날짜별 합산은 round(6×12.91)+round(3×12.82)=77+38=115원.
    const expected = usdToKrwMinor(3, 1291) * 2 + usdToKrwMinor(3, 1282);
    expect(expected).not.toBe(usdToKrwMinor(6, 1291) + usdToKrwMinor(3, 1282));
    expect(settlementKrw(state, config, 15)!.income.find((r) => r.account === 'TRAINING_EXPENSE')!.krwMinor).toBe(expected);
  });

  it('6 외상·BASE·주선의 열린 청구서를 빠짐없이 별도 묶고 연체 상태를 센다', () => {
    const { state, config } = mixedReceivables(), schedule = receivableSchedule(state, config);
    const result = receivablesByTerm(state, config), lock = cashLockSummary(state, config)!;
    expect(state.rng.seed).toBeGreaterThanOrEqual(2001);
    expect(result.rows.some((r) => r.termId !== 'BASE')).toBe(true);
    expect(result.rows.some((r) => r.termId === 'BASE' && r.grade !== null)).toBe(true);
    expect(result.rows.some((r) => r.termId === 'BASE' && r.grade === null)).toBe(true);
    for (const currency of codes) {
      expect(result.rows.filter((r) => r.currency === currency).reduce((sum, r) => sum + r.outstandingMinor, 0))
        .toBe(schedule.filter((i) => i.currency === currency).reduce((sum, i) => sum + i.outstandingMinor, 0));
      expect(lock.available.find((r) => r.currency === currency)!.amountMinor).toBe(fundsPosition(state, config, currency).available);
    }
    expect(result.rows.reduce((sum, r) => sum + r.count, 0)).toBe(schedule.length);
    expect(result.totalKrwMinor).toBe(lock.receivableKrwMinor);
    expect(lock.available.map((r) => r.currency)).toEqual(codes);
    expect(lock.receivable.map((r) => r.currency)).toEqual(codes);
    // 결제일 당일 OVERDUE도 overdueDays=0과 별개로 세어야 한다.
    const copy = structuredClone(state);
    for (const [index, i] of schedule.entries()) {
      const invoice = copy.invoices.find((v) => v.id === i.invoiceId)!;
      invoice.status = index % 2 ? 'OUTSTANDING' : 'OVERDUE'; invoice.dueDay = copy.day;
    }
    const rows = receivablesByTerm(copy, config).rows;
    for (const row of rows) {
      const members = schedule.filter((i) => {
        const c = copy.contracts.find((c) => c.id === i.contractId)!;
        const grade = c.kind === 'FORWARDING' ? null : config.operations!.risk!.profile.collections.byCounterparty.find((g) => g.counterpartyId === c.customerId)!.grade;
        return (c.creditTermId ?? 'BASE') === row.termId && grade === row.grade && i.currency === row.currency;
      });
      expect(row.count).toBe(members.length);
      expect(row.overdueCount).toBe(members.filter((i) => copy.invoices.find((v) => v.id === i.invoiceId)!.status === 'OVERDUE').length);
    }
    expect(rows.reduce((sum, r) => sum + r.overdueCount, 0)).toBe(Math.ceil(schedule.length / 2));
    const key = (r: typeof rows[number]) => `${['BASE', 'D15', 'D30'].indexOf(r.termId)}:${r.grade ?? '~'}:${r.currency}`;
    expect(rows.map(key)).toEqual(rows.map(key).sort());
  }, 60000);

  it('7 BASE 노출은 그대로이며 D30 노출만 할증 판매액을 더한다', () => {
    const { state, config } = mixedReceivables(), pair = openTradePairs(state, config)[0]!;
    const options = creditTermOptions(state, config, pair.buyOfferId, pair.sellOfferId);
    const rows = creditLockPreview(state, config, pair.buyOfferId, pair.sellOfferId);
    for (const [index, option] of options.entries()) {
      expect(rows[index]).toMatchObject({ allowed: option.allowed, reasonKo: option.reasonKo, limitMinor: option.limitMinor,
        exposureAfterMinor: option.exposureMinor + (option.termId === 'BASE' ? 0 : option.saleAmountMinor) });
    }
    expect(options.find((r) => r.termId === 'D30')!.saleAmountMinor).toBeGreaterThan(options.find((r) => r.termId === 'BASE')!.saleAmountMinor);
  });

  it('8 얼린 상태에서 다섯 함수는 순수하고 결과 추첨·미래 환율을 읽지 않는다', () => {
    const { state, config } = mixedReceivables(), s = frozen(structuredClone(state)), before = JSON.stringify(s);
    const pair = openTradePairs(s, config)[0]!;
    vi.mocked(claimFor).mockClear(); vi.mocked(collectionPlan).mockClear(); vi.mocked(defaultFor).mockClear(); vi.mocked(referenceRate).mockClear();
    expect(creditLockPreview(s, config, pair.buyOfferId, pair.sellOfferId)).toHaveLength(3);
    receivablesByTerm(s, config); cashLockSummary(s, config); balanceSheetAt(s, config, s.day); settlementKrw(s, config, s.day);
    expect(JSON.stringify(s)).toBe(before);
    for (const fn of [claimFor, collectionPlan, defaultFor]) expect(fn).not.toHaveBeenCalled();
    const days = vi.mocked(referenceRate).mock.calls.map((args) => args[2]);
    expect(days.length).toBeGreaterThan(0); expect(days.every((day) => day <= s.day)).toBe(true);
    expect(() => balanceSheetAt(s, config, s.day + 1)).toThrow();
    expect(() => settlementKrw(s, config, s.day + 1)).toThrow();
  });

  it.each(['SCENARIO_M2_MULTI_TRADE', 'SCENARIO_M2_OPERATIONS'] as const)('9 %s 규칙 경계와 모든 계정 이름', (id) => {
    const config = { ...loadScenario(id), seed: 2001 }, state = createGame(config);
    expect(creditLockPreview(state, config, '', '')).toEqual([]);
    expect(receivablesByTerm(state, config)).toEqual({ rows: [], totalKrwMinor: 0 });
    expect(balanceSheetAt(state, config, state.day).byCurrency.length).toBeGreaterThan(0);
    if (!config.operations) {
      expect(cashLockSummary(state, config)).toBeNull(); expect(settlementKrw(state, config, state.day)).toBeNull();
    } else {
      expect(cashLockSummary(state, config)).not.toBeNull(); identity(settlementKrw(state, config, state.day)!);
    }
    for (const account of accounts) expect(SETTLEMENT_LINE_KO[account]).toBeTruthy();
    expect(SETTLEMENT_LINE_KO.fxTranslationKrwMinor).toBe('환율 변동 손익');
  });
});

async function nodeFiles() {
  return await import('node:fs' as string) as { readFileSync(path: string, encoding: string): string; existsSync(path: string): boolean;
    rmSync(path: string, options: object): void };
}
async function staticClosure(overrides = new Map<string, string>()) {
  const fs = await nodeFiles();
  const path = await import('node:path' as string) as { resolve(...parts: string[]): string; dirname(p: string): string };
  const seen = new Set<string>(), root = path.resolve('.');
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.endsWith('.ts')) return;
    const source = overrides.get(file.slice(root.length + 1)) ?? fs.readFileSync(file, 'utf8');
    const parsed = parseSync(file, source);
    expect(parsed.errors, file).toEqual([]);
    for (const node of parsed.program.body) {
      let specifier: string | undefined;
      if (node.type === 'ImportDeclaration' && node.importKind !== 'type'
        && (!node.specifiers.length || node.specifiers.some((s) => s.type !== 'ImportSpecifier' || s.importKind !== 'type'))) specifier = node.source.value;
      if ((node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && node.exportKind !== 'type'
        && (node.type === 'ExportAllDeclaration' || node.specifiers.some((s) => s.exportKind !== 'type'))) specifier = node.source?.value;
      if (!specifier?.startsWith('.')) continue;
      const stem = path.resolve(path.dirname(file), specifier);
      const target = [stem, `${stem}.ts`, `${stem}/index.ts`].find((p) => fs.existsSync(p));
      if (!target) throw new Error(`정적 의존 파일을 찾지 못했습니다: ${specifier}`);
      visit(target);
    }
  }
  visit(path.resolve('src/ui/main.ts'));
  return [...seen].map((p) => p.slice(root.length + 1));
}
function outsideFirstScreen(files: string[]) {
  for (const target of ['src/engine/path11-readers.ts', 'src/ui/path11-labels.ts']) expect(files).not.toContain(target);
}

describe('TASK-0075 첫 화면 밖 확인', () => {
  it('10가 값 정적 import·재수출 닫힘과 음성 대조 둘', async () => {
    outsideFirstScreen(await staticClosure());
    const fs = await nodeFiles(), main = fs.readFileSync('src/ui/main.ts', 'utf8'), readers = fs.readFileSync('src/engine/readers.ts', 'utf8');
    const direct = await staticClosure(new Map([['src/ui/main.ts', `${main}\nimport { settlementKrw } from '../engine/path11-readers';`]]));
    const reexport = await staticClosure(new Map([['src/engine/readers.ts', `${readers}\nexport { settlementKrw } from './path11-readers';`]]));
    expect(() => outsideFirstScreen(direct)).toThrow(); expect(() => outsideFirstScreen(reexport)).toThrow();
    // 타입 import 세 형태와 동적 import는 값 정적 닫힘을 늘리지 않는다.
    outsideFirstScreen(await staticClosure(new Map([['src/ui/main.ts', `${main}\n
      import type { settlementKrw as A } from '../engine/path11-readers';
      import { type settlementKrw as B } from '../engine/path11-readers';
      type C = typeof import('../engine/path11-readers');
      const d = () => import('../engine/path11-readers');`]])));
  });

  it('10나 실제 빌드의 고유 문자열은 운영 지연 청크에만 들어간다', async () => {
    const fs = await nodeFiles(), dir = '/tmp/T75-test-dist';
    const vite = await import('vite' as string) as { build(config: object): Promise<unknown> };
    const bundle = await import('../../tools/bundle-size.mjs' as string) as { collectDist(path: string): {
      lazy: string[]; firstScreen: { file: string }[]; chunks: { file: string }[];
    } };
    try {
      await vite.build({ logLevel: 'silent', build: { outDir: dir, emptyOutDir: true } });
      const dist = bundle.collectDist(dir);
      for (const marker of ['경로 11 결산일은 현재 날짜를 넘을 수 없습니다', '관세는 매입원가에 넣음(K-IFRS 1002.11)']) {
        const containing = dist.chunks.filter((c) => fs.readFileSync(`${dir}/${c.file}`, 'utf8').includes(marker));
        expect(containing).toHaveLength(1);
        expect(containing[0]!.file).toMatch(/ops-screens-.*\.js$/);
        expect(dist.lazy).toContain(containing[0]!.file);
        for (const chunk of dist.firstScreen) expect(fs.readFileSync(`${dir}/${chunk.file}`, 'utf8')).not.toContain(marker);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
