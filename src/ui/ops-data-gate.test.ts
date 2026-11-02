import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SITUATION_BUTTON, startUi } from './main-testkit';
import { loadScenario } from '../content/scenario';
import { createGame, openDay } from '../engine/engine';
import { serializeSave } from '../engine/save';

const opsId = 'SCENARIO_M2_OPERATIONS', legacyId = 'SCENARIO_M2_MULTI_TRADE';
const saves = Object.fromEntries(([opsId, 'SCENARIO_M2_OPS_CREDIT'] as const).map((id) => {
  const config = { ...loadScenario(id), seed: 2001 };
  return [id, serializeSave(openDay(createGame(config), config).state)];
}));
let calls = 0, failures = 0;
let gate: Promise<void> | undefined;
const order: string[] = [];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  calls = failures = 0; gate = undefined; order.length = 0;
  vi.doMock('./lazy', async (original) => {
    const real = await original<typeof import('./lazy')>();
    return { ...real, lazyScreen<T>(loader: () => Promise<T>) {
      return real.lazyScreen(async () => {
        if (!loader.toString().includes('ops-screens')) return loader();
        calls++; order.push('관문 시작');
        await gate;
        if (failures-- > 0) throw new Error('시험용 자료 수신 실패');
        const result = await loader(); order.push('관문 성공'); return result;
      });
    } };
  });
});
afterEach(() => { vi.doUnmock('./lazy'); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fresh() {
  const ui = await startUi(); vi.clearAllTimers();
  const data = await import('../content/ops-data');
  const session = await import('./session');
  const real = session.loadSaveText;
  const spy = vi.spyOn(session, 'loadSaveText').mockImplementation((text) => { order.push('저장 읽기'); return real(text); });
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value) });
  return { ui, data, spy, items };
}
const pending = (html: string) => html.match(/<ol class="pending">[\s\S]*?<\/ol>/)?.[0];
const select = (html: string) => html.match(/<select data-action="scenario">[\s\S]*?<\/select>/)?.[0];
async function snapshot(ctx: Awaited<ReturnType<typeof fresh>>) {
  await ctx.ui.click({ action: 'save' });
  return { state: ctx.items.get('scitrade-save'), pending: pending(ctx.ui.app.innerHTML), select: select(ctx.ui.app.innerHTML) };
}
function missing(data: Awaited<ReturnType<typeof fresh>>['data']) { expect(data.opsData).toThrow(new Error(data.OPS_DATA_MISSING)); }

describe('TASK-0076 화면 자료 관문', () => {
  it('기본 첫 렌더 SHA와 3일 진행은 자료 없이 성공한다', async () => {
    const ctx = await fresh();
    expect(ctx.ui.app.innerHTML.match(/<option value="SCENARIO_M2_OPS_CREDIT"[^>]*>[^<]*<\/option>/g)).toHaveLength(1);
    // TASK-0079: 카드 종류 클래스와 '사무실 보기' 단추 두 조각만 걷는다.
    const html = ctx.ui.app.innerHTML.replace(/ creature-(animal|myth_inspired|none)/g, '').replace(/<button[^>]*data-action="open-office"[^>]*>사무실 보기<\/button>/g, '').replace(/<option value="SCENARIO_M2_OPS_CREDIT"[^>]*>[^<]*<\/option>/g, '').replace(SITUATION_BUTTON, '').replace(/빌드 [^<]+/, '빌드 dev');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html)))].map((n) => n.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe('06654dd41520d48e0c625f5b9fd45c130ce434d8e761c76b13c63ab34927c05e');
    for (let i = 0; i < 3; i++) await ctx.ui.click({ action: 'end-day' });
    expect(calls).toBe(0); missing(ctx.data);
    expect(JSON.parse((await snapshot(ctx)).state!).state.day).toBe(4);
  });
  it.each([1, 2])('운영 선택 %i회 실패는 상태를 보존한다', async (count) => {
    const ctx = await fresh(); await ctx.ui.click({ action: 'accept' });
    const before = await snapshot(ctx); failures = count;
    const selector = { ...ctx.ui.rendered({ action: 'scenario' }), value: opsId };
    for (let i = 0; i < count; i++) {
      selector.value = opsId; await ctx.ui.changeTarget(selector);
      expect(selector.value).toBe(legacyId); missing(ctx.data);
      expect(ctx.ui.app.innerHTML).toContain(i ? '새로 고침' : '다시 눌러');
      expect(await snapshot(ctx)).toEqual(before);
    }
    if (count === 1) {
      await ctx.ui.change({ action: 'scenario' }, opsId);
      expect(ctx.data.opsData()).toBeDefined(); expect(ctx.ui.doc.title).toContain('운영'); expect(calls).toBe(2);
    } else {
      await ctx.ui.change({ action: 'scenario' }, opsId); expect(calls).toBe(2); missing(ctx.data);
    }
  });
  it.each(['import', 'scitrade-save', 'scitrade-m1-save', 'credit'])('%s 저장은 관문 성공 뒤 읽는다', async (mode) => {
    const ctx = await fresh(), text = saves[mode === 'credit' ? 'SCENARIO_M2_OPS_CREDIT' : opsId]!;
    let release!: () => void; gate = new Promise<void>((resolve) => { release = resolve; });
    if (mode.startsWith('scitrade')) ctx.items.set(mode, text);
    const loading = mode.startsWith('scitrade') ? ctx.ui.click({ action: 'load' }) : ctx.ui.importText(text);
    await flush(); expect(calls).toBe(1); expect(ctx.spy).not.toHaveBeenCalled(); missing(ctx.data);
    release(); await loading;
    expect(order).toEqual(['관문 시작', '관문 성공', '저장 읽기']);
    expect(ctx.spy).toHaveBeenCalledOnce(); expect(ctx.spy.mock.results[0]!.value).not.toHaveProperty('errorKo');
    expect(ctx.data.opsData()).toBeDefined(); expect((await snapshot(ctx)).state).toBe(text);
  });
  it.each(['import', 'scitrade-save', 'scitrade-m1-save'])('%s 관문 실패는 저장을 읽지 않고 상태를 보존한다', async (mode) => {
    const ctx = await fresh(); await ctx.ui.click({ action: 'accept' });
    const before = await snapshot(ctx); failures = 2;
    for (let i = 0; i < 2; i++) {
      if (mode === 'import') await ctx.ui.importText(saves[opsId]!);
      else { ctx.items.clear(); ctx.items.set(mode, saves[opsId]!); await ctx.ui.click({ action: 'load' }); }
      expect(ctx.ui.app.innerHTML).toContain(i ? '새로 고침' : '다시 눌러');
      expect(ctx.spy).not.toHaveBeenCalled(); missing(ctx.data); expect(await snapshot(ctx)).toEqual(before);
    }
  });
  it.each([false, true])('판본 6 저장: 관문 실패=%s', async (fail) => {
    const ctx = await fresh(); await ctx.ui.click({ action: 'accept' }); const before = await snapshot(ctx);
    // 기존 code-split 시험의 opsSaveV6 고정물을 그대로 읽는다.
    const source = import.meta.glob('./code-split.test.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const line = source['./code-split.test.ts']!.match(/^const opsSave = (.*);$/m)![1]!;
    const opsSaveV6 = (JSON.parse(line) as string).replace('"formatVersion":7', '"formatVersion":6');
    failures = fail ? 1 : 0; await ctx.ui.importText(opsSaveV6); expect(calls).toBe(1);
    if (fail) { missing(ctx.data); expect(ctx.spy).not.toHaveBeenCalled(); expect(ctx.ui.app.innerHTML).toContain('다시 눌러'); expect(ctx.ui.app.innerHTML).not.toContain('이전 저장 형식'); }
    else { expect(order).toEqual(['관문 시작', '관문 성공', '저장 읽기']); expect(ctx.ui.app.innerHTML).toContain('이전 저장 형식(판본 6)'); }
    expect(await snapshot(ctx)).toEqual(before);
  });
});
