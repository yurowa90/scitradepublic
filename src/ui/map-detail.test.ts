// TASK-0035: D14 지도 상세 — 고르기 목록·지도 누르기(가까운 후보)·지도 아래 읽기 전용 상세 칸.
import { afterEach, describe, expect, it, vi } from 'vitest';
import routes from '../../data/routes.json';
import { loadScenario } from '../content/scenario';
import { createGame, openDay } from '../engine/engine';
import { serializeSave } from '../engine/save';
import { runDays, standardDayOneCommands } from '../engine/testkit';
import type { GameState, ScenarioConfig } from '../engine/types';
import { startUi } from './main-testkit';
import { mapMarks, nearestMarks, renderWorldMap, type MapMode } from './map';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
type Ui = Awaited<ReturnType<typeof startUi>>;
const m1 = loadScenario('SCENARIO_M1_ONE_TRADE');
const m2 = loadScenario('SCENARIO_M2_MULTI_TRADE');
const day1 = (config: ScenarioConfig) => openDay(createGame(config), config).state;
/** 1일 기본 명령 뒤 6일: 배가 항로 위에 있다. */
const sailing = (config: ScenarioConfig) => openDay(runDays(createGame(config), config, 6, { 1: standardDayOneCommands(config) }).state, config).state;
const STATES: [string, ScenarioConfig, GameState][] = [['M1 1일', m1, day1(m1)], ['M1 6일 운항 중', m1, sailing(m1)], ['M2 1일', m2, day1(m2)]];
const MODES: MapMode[] = ['route', 'world'];
const keysIn = (html: string) => [...html.matchAll(/data-mark="([^"]+)"/g)].map((m) => m[1]!);
const optionKeys = (html: string) => [...html.match(/<select data-action="map-pick" id="map-pick">[\s\S]*?<\/select>/)![0].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]!);
const pressEsc = (ui: Ui) => { const ev = { key: 'Escape', preventDefault: vi.fn() }; ui.fireDoc('keydown', ev); return ev; };
const schedule = (routes as unknown as { items: { id: string; schedule_basis?: { carrier_service_ko: string; checked_on: string; tolerance_days: number; note_ko: string } }[] }).items;

describe('지도 표시 목록(map.ts)', () => {
  it.each(STATES.flatMap(([name, config, state]) => MODES.map((mode) => [name, mode, config, state] as const)))('%s %s: 표시 열쇠는 그린 지도의 data-mark와 같은 집합이고 겹치지 않으며 표시마다 누를 점이 하나다', (_name, mode, config, state) => {
    const html = renderWorldMap(state, config, mode);
    const keys = mapMarks(state, config, mode).map((m) => m.key);
    expect([...keysIn(html)].sort()).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(html.match(/data-mark-dot/g)!.length).toBe(keys.length);
  });

  it('운항 중인 배도 표시 목록에 있다', () => {
    const [, config, state] = STATES[1]!;
    expect(mapMarks(state, config, 'route').filter((m) => m.key.startsWith('ship:')).length).toBeGreaterThan(0);
    expect(mapMarks(day1(m1), m1, 'route').filter((m) => m.key.startsWith('ship:'))).toEqual([]);
  });

  it('고른 표시 하나만 picked 이름과 고리를 갖고, 고르지 않으면 고리가 없다', () => {
    const [, config, state] = STATES[1]!;
    for (const mode of MODES) {
      expect(renderWorldMap(state, config, mode)).not.toContain('pick-ring');
      for (const mark of mapMarks(state, config, mode)) {
        const html = renderWorldMap(state, config, mode, { picked: mark.key });
        expect(html.match(/class="pick-ring"/g)!.length).toBe(1);
        expect([...html.matchAll(/class="[^"]* picked" data-mark="([^"]+)"/g)].map((m) => m[1])).toEqual([mark.key]);
      }
    }
  });

  it('상세 글에 실제 선사·서비스 이름과 노선 근거 메모를 쓰지 않는다', () => {
    const texts = STATES.flatMap(([, config, state]) => MODES.flatMap((mode) => mapMarks(state, config, mode).flatMap((m) => [m.nameKo, m.group, ...m.lines]))).join('\n');
    const bases = schedule.map((r) => r.schedule_basis).filter((b): b is NonNullable<typeof b> => Boolean(b));
    expect(bases.length).toBeGreaterThan(0);
    for (const basis of bases) {
      for (const word of basis.carrier_service_ko.split(/\s+/)) expect(texts).not.toContain(word);
      expect(texts).not.toContain(basis.note_ko);
    }
  });

  it('운항 근거가 있는 이번 시나리오 노선은 확인 날짜와 오차를 거점 상세에 적는다', () => {
    const marks = mapMarks(day1(m2), m2, 'route');
    for (const route of m2.routes) {
      const basis = schedule.find((r) => r.id === route.id)?.schedule_basis;
      if (!basis) continue;
      const line = `(선사 요일표로 확인 ${basis.checked_on}, 오차 ±${basis.tolerance_days}일. 게임은 요일 없이 단순화)`;
      expect(marks.find((m) => m.key === `hub:${route.fromCityId}`)!.lines.some((l) => l.startsWith(`${route.id} `) && l.endsWith(line))).toBe(true);
    }
  });

  it('가까운 표시는 반지름 22 안만, 가까운 순서로 돌려준다', () => {
    const pts = [{ key: 'a', x: 100, y: 100 }, { key: 'b', x: 110, y: 100 }, { key: 'c', x: 122, y: 100 }, { key: 'd', x: 122.1, y: 100 }];
    expect(nearestMarks(pts, 100, 100)).toEqual(['a', 'b', 'c']);
    expect(nearestMarks(pts, 109, 100)).toEqual(['b', 'a', 'c', 'd']);
    expect(nearestMarks(pts, 300, 300)).toEqual([]);
    expect(nearestMarks(pts, 100, 100, 5)).toEqual(['a']);
  });
});

describe('지도 고르기 화면(main.ts)', () => {
  it.each([['M1', m1], ['M2', m2]] as const)('%s: 목록은 보이는 지도의 표시를 빠짐없이 한 번씩 담고 처음 값은 ‘고르세요’다', async (_name, config) => {
    const ui = await startUi(config);
    for (const mode of MODES) {
      ui.click({ action: 'map-mode', mode });
      const options = optionKeys(ui.app.innerHTML);
      expect(options[0]).toBe('');
      expect(options.slice(1).sort()).toEqual(keysIn(ui.app.innerHTML).sort());
      expect(ui.app.innerHTML).toContain('<option value="" selected>고르세요</option>');
      expect(ui.app.innerHTML).not.toContain('id="map-detail"');
    }
  });

  it('배가 운항 중이면 목록에 배 묶음이 있고 지도 표시와 같다', async () => {
    const ui = await startUi(m1);
    await ui.importText(serializeSave(sailing(m1)));
    const options = optionKeys(ui.app.innerHTML).slice(1);
    expect(options.some((k) => k.startsWith('ship:'))).toBe(true);
    expect(options.sort()).toEqual(keysIn(ui.app.innerHTML).sort());
    expect(ui.app.innerHTML).toContain('<optgroup label="운항 중인 배">');
  });

  it('목록 · 지도 틀 · 안내 · 상세 칸 · 범례 순서이고 안내 문구가 바뀌었다', async () => {
    const ui = await startUi(m2);
    const key = mapMarks(day1(m2), m2, 'route')[0]!.key;
    ui.change({ action: 'map-pick' }, key);
    const html = ui.app.innerHTML;
    const at = (s: string) => html.indexOf(s);
    expect(at('id="map-pick"')).toBeGreaterThan(0);
    expect(at('id="map-pick"')).toBeLessThan(at('data-map-frame'));
    expect(at('data-map-frame')).toBeLessThan(at('id="map-detail"'));
    expect(at('id="map-detail"')).toBeLessThan(at('class="map-legend"'));
    expect(html).toContain('목록에서 고르거나 지도의 거점·해협·배를 누르면 지도 아래에 자세한 내용이 나옵니다.');
    expect(html).not.toContain('마우스를 올리면');
  });

  it('목록에서 고르면 지도 고리·상세 칸·목록 값이 같은 표시이고 상세는 그 표시의 글을 모두 보인다', async () => {
    const ui = await startUi(m2);
    for (const mark of mapMarks(day1(m2), m2, 'route')) {
      ui.change({ action: 'map-pick' }, mark.key);
      const html = ui.app.innerHTML;
      expect(html).toContain(`<option value="${mark.key}" selected>`);
      expect(html).toMatch(new RegExp(`class="[^"]* picked" data-mark="${mark.key}"`));
      const detail = html.match(/<div class="map-detail" id="map-detail">[\s\S]*?<\/div>/)![0];
      expect(detail).toContain(`<h3 id="map-detail-h" tabindex="-1">${mark.nameKo} <small>${mark.group}</small></h3>`);
      expect(detail).toContain(`<ul>${mark.lines.map((l) => `<li>${l}</li>`).join('')}</ul>`);
      expect(detail).toContain('<button data-action="map-close">닫기</button>');
    }
  });

  it('Esc로 지도 상세를 닫고 목록으로 초점을 돌려주며 500ms 동안 누름을 막는다', async () => {
    const ui = await startUi(m2);
    ui.change({ action: 'map-pick' }, mapMarks(day1(m2), m2, 'route')[0]!.key);
    vi.advanceTimersByTime(501);
    const ev = pressEsc(ui);
    expect(ev.preventDefault).toHaveBeenCalledOnce();
    expect(ui.app.innerHTML).not.toContain('id="map-detail"');
    expect(ui.app.innerHTML).toContain('<option value="" selected>고르세요</option>');
    expect(ui.focusIds.at(-1)).toBe('map-pick');
    vi.advanceTimersByTime(499); ui.clickNow({ action: 'map-mode', mode: 'world' });
    expect(ui.app.innerHTML).toContain('data-mode="world" aria-pressed="false"');
    const second = pressEsc(ui);
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it('닫기 단추로 닫아도 목록으로 초점을 돌려준다', async () => {
    const ui = await startUi(m2);
    ui.change({ action: 'map-pick' }, mapMarks(day1(m2), m2, 'route')[0]!.key);
    ui.click({ action: 'map-close' });
    expect(ui.app.innerHTML).not.toContain('id="map-detail"');
    expect(ui.focusIds.at(-1)).toBe('map-pick');
  });

  it('지도 범위를 바꿔도 고른 표시가 새 지도에 있으면 남고, 없으면 지운다', async () => {
    const ui = await startUi(m2);
    const route = mapMarks(day1(m2), m2, 'route').map((m) => m.key);
    const worldOnly = mapMarks(day1(m2), m2, 'world').find((m) => !route.includes(m.key))!.key;
    ui.change({ action: 'map-pick' }, route[0]!);
    ui.click({ action: 'map-mode', mode: 'world' });
    expect(ui.app.innerHTML).toContain(`<option value="${route[0]}" selected>`);
    ui.change({ action: 'map-pick' }, worldOnly);
    ui.click({ action: 'map-mode', mode: 'route' });
    expect(ui.app.innerHTML).not.toContain('id="map-detail"');
    expect(ui.app.innerHTML).not.toContain('class="pick-ring"');
    // 다시 전 세계로 돌아가도 지운 표시가 되살아나지 않는다.
    ui.click({ action: 'map-mode', mode: 'world' });
    expect(ui.app.innerHTML).not.toContain('id="map-detail"');
    expect(ui.app.innerHTML).toContain('<option value="" selected>고르세요</option>');
  });

  it('처음부터 뒤에는 고른 표시가 없다', async () => {
    const ui = await startUi(m2);
    ui.change({ action: 'map-pick' }, mapMarks(day1(m2), m2, 'route')[0]!.key);
    ui.click({ action: 'restart' });
    expect(ui.app.innerHTML).not.toContain('id="map-detail"');
  });

  it('지도를 누르면 22px 안의 표시가 하나면 고르고, 여럿이면 후보 단추를, 없으면 아무것도 하지 않는다', async () => {
    const ui = await startUi(m2);
    const [a, b] = mapMarks(day1(m2), m2, 'route').map((m) => m.key);
    ui.bounds[`mark:${a}`] = { left: 95, right: 105, top: 95, bottom: 105, width: 10, height: 10 };
    ui.bounds[`mark:${b}`] = { left: 125, right: 135, top: 95, bottom: 105, width: 10, height: 10 };
    ui.tapMap(300, 300);
    expect(ui.app.innerHTML).not.toContain('id="map-detail"');
    ui.tapMap(100, 112);
    expect(ui.app.innerHTML).toContain(`<option value="${a}" selected>`);
    ui.tapMap(115, 100);
    expect(ui.app.innerHTML).toContain('<h3 id="map-detail-h" tabindex="-1">이 근처에 여러 곳이 있습니다</h3>');
    expect([...ui.app.innerHTML.matchAll(/data-action="map-near" data-mark="([^"]+)"/g)].map((m) => m[1])).toEqual([a, b]);
    expect(ui.app.innerHTML).not.toContain('class="pick-ring"');
    ui.click({ action: 'map-near', mark: b! });
    expect(ui.app.innerHTML).toContain(`<option value="${b}" selected>`);
    expect(ui.focusIds.at(-1)).toBe('map-detail-h');
  });

  it('이름표를 누르면 거리와 상관없이 그 표시를 고른다', async () => {
    const ui = await startUi(m2);
    const key = mapMarks(day1(m2), m2, 'route')[2]!.key;
    ui.tapMap(5000, 5000, key);
    expect(ui.app.innerHTML).toContain(`<option value="${key}" selected>`);
  });

  it('성장 상세를 연 뒤 지도에서 고르면 Esc는 지도 상세부터 닫는다', async () => {
    const ui = await startUi(m2);
    const first = m2.employees[0]!.id;
    ui.click({ action: 'select-card', emp: first });
    ui.click({ action: 'detail', emp: first });
    ui.change({ action: 'map-pick' }, mapMarks(day1(m2), m2, 'route')[0]!.key);
    vi.advanceTimersByTime(501);
    pressEsc(ui);
    expect(ui.app.innerHTML).not.toContain('id="map-detail"');
    expect(ui.app.innerHTML).toMatch(new RegExp(`data-action="detail" data-emp="${first}"[^>]*aria-expanded="true"`));
  });
});
