import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../content/scenario';
import { openTradePairs } from '../engine/market';
import { cashLockSummary, creditLockPreview, receivablesByTerm, settlementKrw } from '../engine/path11-readers';
import { creditTermOptions } from '../engine/readers-lazy';
import { formatMoney } from '../engine/money';
import { serializeSave } from '../engine/save';
import { policyById } from '../engine/sim/policies';
import { simulate } from '../engine/sim/sim';
import type { GameState, ScenarioConfig } from '../engine/types';
import { SETTLEMENT_LINE_KO } from './path11-labels';
import { startUi } from './main-testkit';

const histories = new Map<number, { config: ScenarioConfig; days: Map<number, GameState>; end: GameState }>();
function history(seed = 2001) {
  if (!histories.has(seed)) {
    const config = { ...loadScenario('SCENARIO_M2_OPS_CREDIT'), seed }, days = new Map<number, GameState>();
    const { state } = simulate(config, policyById('TERM_GREEDY')!, seed, (s) => {
      if ([8, 15, 22, 30, 31, 36, 61].includes(s.day)) days.set(s.day, structuredClone(s));
    });
    histories.set(seed, { config, days, end: state });
  }
  return histories.get(seed)!;
}
async function screen(day = 8, seed = 2001) {
  const h = history(seed), state = day === 0 ? h.end : h.days.get(day)!;
  const ui = await startUi(); vi.clearAllTimers();
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value) });
  await ui.importText(serializeSave(state));
  expect(ui.app.innerHTML).not.toContain('불러오지 못했습니다');
  return { ui, state, config: h.config, items };
}
const keyOf = (s: GameState, c: ScenarioConfig) => { const p = openTradePairs(s, c)[0]!; expect(p).toBeTruthy(); return `${p.buyOfferId}+${p.sellOfferId}`; };
const minor = (html: string, attr: string, value: string) => Number(html.match(new RegExp(`${attr}="${value}" data-minor="(-?\\d+)"`))![1]);
const rows = (html: string, caption: string) => {
  const body = html.match(new RegExp(`<caption>${caption}</caption>[\\s\\S]*?<tbody>([\\s\\S]*?)</tbody>`))![1]!;
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1]!.matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/g)].map((m) => m[1]!));
};
const money = (n: number) => formatMoney('KRW', n);
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('TASK-0077 경로 11 화면', () => {
  it('1 외상 기본·일반 수락·계획 수락·D15 문구·낭독과 한도 초과', async () => {
    for (const [term, action] of [['D30', 'accept'], ['D15', 'accept'], ['D30', 'accept-plan']] as const) {
      const { ui, state, config } = await screen();
      const key = ui.app.innerHTML.match(/data-action="accept-plan" data-key="([^"]+)"(?! disabled)/)?.[1] ?? keyOf(state, config), [buy, sell] = key.split('+');
      const radios = [...ui.app.innerHTML.matchAll(new RegExp(`<input[^>]*data-key="${key.replaceAll('+', '\\+')}"[^>]*>`, 'g'))];
      expect(radios).toHaveLength(3); expect(radios[0]![0]).toContain('value="BASE" checked');
      expect(ui.app.innerHTML).toContain(`data-p11-key="credit-${key}"><summary>조건 비교`);
      const collapsed = ui.app.innerHTML.split(`<p data-p11-summary="${key}">`)[1]!.split('<details')[0]!;
      expect(collapsed).toMatch(/^\d+일에 받음 · \d+일 묶임 · 그동안 견적 공개 \d+번 · 거래처 [ABC]등급 · 늦게 낼 수 있음<\/p>$/);
      // 고정 기록은 묶음 명령을 써서 BOOK_SAILING 이력이 없다. 화면 학습 관문만 연다.
      if (action === 'accept-plan') vi.spyOn(await import('./recruitment'), 'batchUnlocked').mockReturnValue(true);
      const before = ui.announcements.length;
      await ui.change({ action: 'credit-term', key, term }, term);
      const chosen = creditLockPreview(state, config, buy!, sell!).find((r) => r.termId === term)!;
      expect(ui.announcements.slice(before)).toEqual([`${chosen.paymentDueDay}일에 받음 · ${chosen.lockDays}일 묶임 · 그동안 견적 공개 ${chosen.publishesInWindow}번`]);
      const engine = await import('../engine/engine'), planned = vi.spyOn(engine, 'planState');
      if (action === 'accept-plan') await ui.click({ action, key });
      else await ui.click({ action, buy: buy!, sell: sell! });
      await ui.click({ action: 'save' });
      expect(planned.mock.calls.some((call) => call[2].some((c) => c.type === 'ACCEPT_TRADE' && c.creditTermId === term))).toBe(true);
      const pending = ui.app.innerHTML.match(/<ol class="pending">[\s\S]*?<\/ol>/)![0];
      expect(pending).toContain(term === 'D15' ? '15일 외상' : '30일 외상');
      if (term === 'D15') expect(pending).not.toContain('30일 외상');
    }
    const { ui, state, config } = await screen(22);
    const denied = openTradePairs(state, config).flatMap(({ buyOfferId: buy, sellOfferId: sell }) => creditLockPreview(state, config, buy, sell).filter((r) => !r.allowed).map((r) => ({ key: `${buy}+${sell}`, row: r })));
    expect(denied.length).toBeGreaterThan(0);
    for (const { key, row } of denied) {
      expect(ui.rendered({ action: 'credit-term', key, term: row.termId }).disabled).toBe(true);
      expect(ui.app.innerHTML).toContain(row.reasonKo!);
    }
  });

  it('2 비교표와 사실·질문 상자는 읽기 값과 A1~A3을 쓴다', async () => {
    const { ui, state, config } = await screen(), key = keyOf(state, config), [buy, sell] = key.split('+');
    await ui.change({ action: 'credit-term', key, term: 'D30' }, 'D30');
    const card = ui.app.innerHTML.split(`data-p11-key="credit-${key}"`)[1]!.split('</details>')[0]!;
    const options = creditTermOptions(state, config, buy!, sell!), previews = creditLockPreview(state, config, buy!, sell!);
    const values = rows(card, '조건별 비교');
    for (const [i, r] of previews.entries()) {
      expect(values[0]![i + 1]).toBe(formatMoney(config.tradeCurrency, options[i]!.saleAmountMinor));
      expect(values[1]![i + 1]).toBe(`${r.paymentDueDay}일`);
      expect(values[2]![i + 1]).toContain(money(r.cashOutKrwMinor));
      expect(values[3]![i + 1]).toBe(`${r.lockDays}일`); expect(values[4]![i + 1]).toBe(`${r.publishesInWindow}번`);
      expect(values[5]![i + 1]).toBe(r.termId === 'BASE' ? '—' : `${formatMoney(config.tradeCurrency, r.exposureAfterMinor)} / ${formatMoney(config.tradeCurrency, r.limitMinor)}`);
    }
    const r = previews.find((p) => p.termId === 'D30')!, cash = cashLockSummary(state, config)!;
    expect(card).toContain(`이 거래 뒤: ${money(cash.availableKrwMinor - r.cashOutKrwMinor)}`);
    expect(card).toContain(`더 받는 ${formatMoney(config.tradeCurrency, options[2]!.saleAmountMinor - options[0]!.saleAmountMinor)}`);
    const p = config.operations!.market.publish, days: number[] = [];
    for (let d = p.firstDay; d <= Math.min(p.lastDay, r.paymentDueDay); d += p.intervalDays) if (d > state.day) days.push(d);
    expect(days).toHaveLength(r.publishesInWindow); expect(card).toContain(`${days.join('·')}일에 좋은 견적`);
  });

  it('3 묶이는 돈·조건별 행과 0인 비율을 그대로 보인다', async () => {
    const { ui, state, config } = await screen(31), cash = cashLockSummary(state, config)!;
    expect(ui.app.innerHTML).toContain(`받을 돈으로 묶인 돈 ${money(cash.receivableKrwMinor)} · 쓸 수 있는 돈 ${money(cash.availableKrwMinor)} (묶인 비율 ${(cash.lockedShareBp! / 100).toFixed(2)}%)`);
    expect(rows(ui.app.innerHTML, '조건별 받을 돈')).toHaveLength(receivablesByTerm(state, config).rows.length);
    const module = await import('../engine/path11-readers');
    vi.spyOn(module, 'cashLockSummary').mockReturnValue({ ...cash, lockedShareBp: null });
    const { path11Cash } = await import('./path11-screens'), { initialUiState } = await import('./session');
    expect(path11Cash(state, config, initialUiState())).toContain('묶인 비율 —');
  });

  it('4 중간 날짜 경계·결산 검산·감액 부호·캠페인 끝 기준일', async () => {
    for (const day of [30, 31, 61]) {
      const { ui } = await screen(day), select = ui.app.innerHTML.match(/<select data-action="p11-asof">([\s\S]*?)<\/select>/)![1]!;
      expect(select.includes('value="30"')).toBe(day >= 31); expect(select.includes('value="60"')).toBe(day >= 61);
      expect(select).toContain(`어제 마감 (${day - 1}일)`);
    }
    for (const [seed, day] of [[2001, 31], [2005, 36], [2001, 0]] as const) {
      const { ui, state, config } = await screen(day, seed);
      if (day) await ui.click({ action: 'p11-dialog' });
      const asof = day ? day - 1 : config.campaignDays, html = ui.app.innerHTML.split('data-p11-asof=')[1]!;
      expect(html).toMatch(new RegExp(`^"${asof}"`));
      const st = settlementKrw(state, config, asof)!, full = ui.app.innerHTML;
      for (const r of [...st.income, ...st.assets, ...st.liabilities, ...st.equity]) {
        expect(minor(full, 'data-p11-account', r.account)).toBe(r.krwMinor);
        expect(full).toContain(SETTLEMENT_LINE_KO[r.account]);
      }
      const value = (account: string) => minor(full, 'data-p11-account', account);
      const income = st.income.reduce((n, r) => n + (['REVENUE', 'SALES_ALLOWANCE', 'FORWARDING_REVENUE'].includes(r.account) ? 1 : -1) * value(r.account), 0) + value('fxTranslationKrwMinor');
      const net = minor(full, 'data-p11-total', 'net'); expect(net).toBe(income);
      expect(st.assets.reduce((n, r) => n + value(r.account), 0) - st.liabilities.reduce((n, r) => n + value(r.account), 0)).toBe(st.equity.reduce((n, r) => n + value(r.account), 0) + net);
      expect(minor(full, 'data-p11-total', 'revenue')).toBe(value('REVENUE') + value('SALES_ALLOWANCE') + value('FORWARDING_REVENUE'));
      if (seed === 2005) expect(value('SALES_ALLOWANCE')).toBeLessThan(0);
      const nonzero = st.income.filter((r) => r.krwMinor !== 0).map((r) => r.account);
      const order = ['REVENUE', 'SALES_ALLOWANCE', 'FORWARDING_REVENUE', 'COST_OF_GOODS_SOLD', 'FORWARDING_COST', 'WAGE_EXPENSE', 'RECRUITMENT_EXPENSE', 'TRAINING_EXPENSE', 'CULTURE_EXPENSE', 'RENT_EXPENSE', 'FACILITY_SETUP_EXPENSE', 'SPACE_CONTRACT_EXPENSE', 'BAD_DEBT', 'CANCELLATION_EXPENSE', 'FX_SPREAD_EXPENSE', 'RECEIVABLE_CARRY'].filter((a) => nonzero.includes(a as typeof nonzero[number]));
      expect([...full.matchAll(/data-p11-account="([^"]+)"/g)].map((m) => m[1]).filter((a) => order.includes(a!)).slice(0, order.length)).toEqual(order);
    }
  }, 30000); // 날짜 셋 화면 생성: 부하 시 5초 초과(TASK-0078 검수에서 실측 5.46 s)

  it('5 놓친 견적은 기준일까지 기록별 통화 부족액을 보인다', async () => {
    for (const day of [15, 31, 61]) {
      const { ui, state } = await screen(day);
      if (day === 61) await ui.change({ action: 'p11-asof' }, '30');
      const asof = day === 61 ? 30 : day - 1, records = (state.operations!.unaffordable ?? []).filter((r) => r.day <= asof);
      const box = ui.app.innerHTML.split('<div class="p11 p11-missed">')[1]!.split('</div>')[0]!;
      expect([...box.matchAll(/data-p11-missed=/g)]).toHaveLength(records.length);
      for (const d of new Set(records.map((r) => r.day))) expect(box).toContain(`${d}일 ${records.filter((r) => r.day === d).length}건`);
      for (const r of records) for (const m of r.shortfalls) expect(box).toContain(`${m.currency} 필요 ${formatMoney(m.currency, m.needMinor)} / 가용 ${formatMoney(m.currency, m.availableMinor)}`);
      if (!records.length) expect(box).toContain('없음');
    }
  });

  it('6 확정 대손과 비율은 보이되 미래 확률·해설은 없다', async () => {
    const { ui, state, config } = await screen(36, 2005), key = keyOf(state, config);
    ui.fireApp('toggle', { target: { tagName: 'DETAILS', open: true, dataset: { p11Key: `credit-${key}` } } });
    await ui.click({ action: 'p11-dialog' });
    expect(ui.app.innerHTML).toContain(`data-p11-key="credit-${key}" open`);
    expect(minor(ui.app.innerHTML, 'data-p11-account', 'BAD_DEBT')).toBeGreaterThan(0);
    expect(ui.app.innerHTML).toContain('확정 대손');
    const nodes = ui.app.innerHTML.split(/<[^>]+>/); expect(nodes.some((t) => t.includes('%'))).toBe(true);
    for (const t of nodes) { expect(/대손/.test(t) && /%/.test(t)).toBe(false); expect(t).not.toMatch(/확률|기대|시드|모의|K-Sight|연체율/); }
  });

  it('8 운영 자료가 없는 첫 렌더에 새 선택지가 있고 선택·저장·불러오기가 이어진다', async () => {
    const ui = await startUi(); vi.clearAllTimers();
    const data = await import('../content/ops-data'); expect(data.opsData).toThrow(data.OPS_DATA_MISSING);
    expect(ui.app.innerHTML).toContain('<option value="SCENARIO_M2_OPS_CREDIT"');
    await ui.change({ action: 'scenario' }, 'SCENARIO_M2_OPS_CREDIT'); expect(data.opsData).not.toThrow();
    expect(ui.app.innerHTML).toContain('<option value="SCENARIO_M2_OPS_CREDIT" selected>');
    const { ui: loaded } = await screen(31);
    expect(loaded.app.innerHTML).toContain('<option value="SCENARIO_M2_OPS_CREDIT" selected>');
  });

  it('11 비교 열림은 수량 변경 뒤 유지하고 다음 날 닫으며 toggle은 캡처한다', async () => {
    const { ui } = await screen();
    const key = ui.app.innerHTML.match(/data-action="offer-quantity" data-key="([^"]+)"/)?.[1];
    expect(key).toBeTruthy();
    ui.fireApp('toggle', { target: { tagName: 'DETAILS', open: true, dataset: { p11Key: `credit-${key}` } } });
    const choices = ui.app.innerHTML.match(new RegExp(`data-action="offer-quantity" data-key="${key!.replaceAll('+', '\\+')}"[^>]*>([\\s\\S]*?)</select>`))![1]!;
    const values = [...choices.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThan(1);
    await ui.change({ action: 'offer-quantity', key: key! }, values[1]!);
    expect(ui.app.innerHTML).toContain(`data-p11-key="credit-${key}" open`);
    await ui.click({ action: 'end-day' }); expect(ui.app.innerHTML).not.toContain(`data-p11-key="credit-${key}" open`);
    const fs = await import('node:fs' as string) as { readFileSync(path: string, enc: string): string };
    expect(fs.readFileSync('src/ui/path11-screens.ts', 'utf8')).toMatch(/addEventListener\('toggle',[^;]+, true\)/);
  });
});

describe('TASK-0077 청크·예산 보호', () => {
  it('10 실제 빌드는 index·data JS와 index CSS만 첫 화면에 받는다', async () => {
    const fs = await import('node:fs' as string) as { readFileSync(p: string, e: string): string; mkdtempSync(p: string): string; rmSync(p: string, o: object): void };
    const vite = await import('vite' as string) as { build(o: object): Promise<unknown> };
    const bundle = await import('../../tools/bundle-size.mjs' as string) as { collectDist(p: string): { firstScreen: { file: string; gzip: number }[]; lazy: string[] }; pageRefs(p: string): { kind: string; href: string }[] };
    const dir = fs.mkdtempSync('/tmp/T77-build-');
    try {
      await vite.build({ logLevel: 'silent', define: { __BUILD_ID__: JSON.stringify('dev') }, build: { outDir: dir, emptyOutDir: true } });
      const result = bundle.collectDist(dir), html = fs.readFileSync(`${dir}/index.html`, 'utf8');
      expect(result.firstScreen.map((r) => r.file.replace(/-[^.]+\./, '.')).sort()).toEqual(['assets/data.js', 'assets/index.css', 'assets/index.js']);
      expect(bundle.pageRefs(html).filter((r) => r.kind === 'modulepreload').map((r) => r.href.replace(/-[^.]+\./, '.'))).toEqual(['assets/data.js']);
      const index = result.firstScreen.find((r) => /index-.*\.js$/.test(r.file))!.file, ops = result.lazy.find((f) => /ops-screens-.*\.js$/.test(f))!;
      expect(ops).toBeTruthy();
      for (const text of ['조건 비교', '자금 부족으로 못 받은 견적']) { expect(fs.readFileSync(`${dir}/${index}`, 'utf8')).not.toContain(text); expect(fs.readFileSync(`${dir}/${ops}`, 'utf8')).toContain(text); }
      // TASK-0077 몫 ≤ 300 B(기준 132,034) 위에 TASK-0078(화면 양식 B안) 승인 예산 ≤ 1,900 B(기준 132,330)를 더한 누적 상한이다(허브, 2026-11-01).
      expect(result.firstScreen.reduce((n, r) => n + r.gzip, 0)).toBeLessThanOrEqual(132330 + 1900);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);

  it('R1 클릭 갈래와 toggle 등록·대화상자 준비는 지연 화면으로 위임한다', async () => {
    const fs = await import('node:fs' as string) as { readFileSync(p: string, e: string): string };
    const source = fs.readFileSync('src/ui/main.ts', 'utf8');
    expect(source).not.toMatch(/case ['"]p11-(?:dialog|close)['"]/);
    expect(source).not.toMatch(/addEventListener\(['"]toggle['"]/);
    expect(source).not.toMatch(/opsScreens\??\.(?:path11Prepare|path11Dialog|path11DialogHtml)\(/);
    expect(source).toContain('opsScreens?.path11Handle(');
  });
});
