// 빌드에 싣는 캐릭터 칸 목록(character-fields.ts)과 vite.config.ts의 characterFieldsPlugin을 확인한다.
// 시험에서도 플러그인이 돌아, 아래 characters import는 남긴 칸만 가진 자료다. 전체 자료는 파일을 직접 읽는다.
import characters from '../../data/characters.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { characterFieldsPlugin, CHARACTERS_ID } from '../../vite.config';
import { CHARACTER_FIELDS, CHARACTER_IMPORTERS, droppedPaths, projectFields, releasedCharacters, type FieldShape, type Json } from './character-fields';
import { loadScenario, SCENARIO_IDS } from './scenario';

type Fs = {
  readFileSync: (path: URL, encoding: 'utf8') => string;
  readdirSync: (path: URL, options: { recursive: true }) => string[];
};
const fs = () => vi.importActual<Fs>('node:fs');
const fileText = async () => (await fs()).readFileSync(new URL('../../data/characters.json', import.meta.url), 'utf8');
const readFull = async () => JSON.parse(await fileText()) as Json;

type Hooks = {
  name: string;
  enforce?: string;
  apply?: unknown;
  configResolved: (config: { command: string }) => void;
  transform: { filter: { id: RegExp }; handler: (code: string, id: string) => { code: string; map: null; moduleType?: string } };
};

/** 항목들이 가진 칸 이름의 합집합(정렬). 일부 항목에만 있는 칸도 목록에 넣을 수 있으므로 항목마다 비교하지 않는다. */
const keyUnion = (items: object[]) => [...new Set(items.flatMap((item) => Object.keys(item)))].sort();

/** 모양에 적힌 경로 가운데 자료 어디에도 없는 것. 칸 이름이 바뀌어 목록에 낡은 이름이 남는 것을 잡는다. */
function missingPaths(value: Json, shape: FieldShape, path = ''): string[] {
  if (shape === true) return [];
  if (Array.isArray(shape)) {
    const items = Array.isArray(value) ? value : [];
    const missing = items.map((item) => new Set(missingPaths(item, shape[0], `${path}[]`)));
    return [...(missing[0] ?? [])].filter((p) => missing.every((set) => set.has(p)));
  }
  const record = (value ?? {}) as { [key: string]: Json };
  return Object.entries(shape as { readonly [key: string]: FieldShape }).flatMap(([key, inner]) => {
    const child = path ? `${path}.${key}` : key;
    return Object.hasOwn(record, key) ? missingPaths(record[key]!, inner, child) : [child];
  });
}

describe('캐릭터 자료 빌드 칸', () => {
  afterEach(() => { vi.doUnmock('../../data/characters.json'); vi.resetModules(); });

  it('칸 고르기는 목록의 칸만 파일 순서대로 남기고 뺀 칸의 경로를 돌려준다', () => {
    const sample: Json = {
      rules: ['r'],
      items: [
        { extra: 1, id: 'A', nest: { drop: 2, keep: 1 }, all: { x: [1] } },
        { id: 'B', nest: { keep: 3 }, more: true },
      ],
    };
    const shape: FieldShape = { items: [{ all: true, nest: { keep: true }, id: true }] };
    expect(JSON.stringify(projectFields(sample, shape))).toBe('{"items":[{"id":"A","nest":{"keep":1},"all":{"x":[1]}},{"id":"B","nest":{"keep":3}}]}');
    expect(droppedPaths(sample, shape)).toEqual(['rules', 'items[].extra', 'items[].nest.drop', 'items[].more']);
    expect(() => projectFields({ items: 1 }, shape)).toThrow('배열 모양인데 자료가 배열이 아닙니다.');
    expect(() => projectFields({ items: [1] }, shape)).toThrow('객체 모양인데 자료가 객체가 아닙니다.');
  });

  it('목록의 칸은 모두 자료 파일에 있다', async () => {
    expect(missingPaths(await readFull(), CHARACTER_FIELDS)).toEqual([]);
  });

  it('시험에서 불러온 자료는 파일을 목록대로 자른 것과 글자까지 같다', async () => {
    const full = await readFull();
    expect(JSON.stringify(characters)).toBe(JSON.stringify(projectFields(releasedCharacters(full), CHARACTER_FIELDS)));
    expect(Object.keys(characters)).toEqual(['items']);
    expect(characters.items).toHaveLength(releasedCharacters(full).items.length);
    expect(keyUnion(characters.items)).toEqual(Object.keys(CHARACTER_FIELDS.items[0]).sort());
  });

  it('뺀 칸을 읽거나 쓰면 고칠 파일을 알려 주는 오류가 나고 남긴 칸은 그대로 읽고 쓴다', async () => {
    const item = characters.items[0]! as Record<string, unknown>;
    expect(droppedPaths(await readFull(), CHARACTER_FIELDS)).toContain('items[].rarity');
    expect(() => item.rarity).toThrow('data/characters.json의 items[].rarity 칸은 빌드에 싣지 않는 칸입니다. 화면·엔진에서 쓰려면 src/content/character-fields.ts의 CHARACTER_FIELDS에 더하세요.');
    expect(() => { item.rarity = 'R'; }).toThrow('items[].rarity');
    expect(() => (item.recruitment as Record<string, unknown>).mode).toThrow('items[].recruitment.mode');
    expect(() => (item.art_direction as Record<string, unknown>).proportions).toThrow('items[].art_direction.proportions');
    expect(() => (characters as Record<string, unknown>).rules).toThrow('data/characters.json의 rules 칸');
    expect(Object.keys(item)).not.toContain('rarity');
    const clue = characters.items[0]!.recruitment.story_clue;
    try {
      characters.items[0]!.recruitment.story_clue = '바꾼 단서';
      expect(characters.items[0]!.recruitment.story_clue).toBe('바꾼 단서');
    } finally {
      characters.items[0]!.recruitment.story_clue = clue;
    }
  });

  it('플러그인은 characters.json만 잡고 빌드에서는 남긴 칸만 JSON 글로 넘긴다', async () => {
    const plugin = characterFieldsPlugin() as unknown as Hooks;
    expect([plugin.name, plugin.enforce, plugin.apply]).toEqual(['scitrade:character-fields', 'pre', undefined]);
    expect(plugin.transform.filter.id).toBe(CHARACTERS_ID);
    expect(['/r/data/characters.json', 'C:\\r\\data\\characters.json'].map((id) => CHARACTERS_ID.test(id))).toEqual([true, true]);
    expect(['/r/data/character_rules.json', '/r/data/employees.json', '/r/src/characters.json', '/r/data/characters.json?raw'].map((id) => CHARACTERS_ID.test(id))).toEqual([false, false, false, false]);
    const text = await fileText();
    const full = JSON.parse(text) as Json;
    plugin.configResolved({ command: 'build' });
    const built = plugin.transform.handler(text, '/r/data/characters.json');
    expect(built).toEqual({ code: JSON.stringify(projectFields(releasedCharacters(full), CHARACTER_FIELDS)), map: null });
    const parsed = JSON.parse(built.code) as { items: Record<string, unknown>[] };
    expect(Object.keys(parsed)).toEqual(['items']);
    expect(keyUnion(parsed.items)).toEqual(Object.keys(CHARACTER_FIELDS.items[0]).sort());
    plugin.configResolved({ command: 'serve' });
    const served = plugin.transform.handler(text, '/r/data/characters.json');
    expect(served.moduleType).toBe('js');
    expect(served.code).toContain('src/content/character-fields.ts의 CHARACTER_FIELDS에 더하세요');
  });

  it('남긴 칸으로 만든 시나리오 설정은 전체 자료로 만든 설정과 같다', async () => {
    const projected = SCENARIO_IDS.map((id) => loadScenario(id));
    const full = await readFull();
    vi.resetModules();
    vi.doMock('../../data/characters.json', () => ({ default: full }));
    const { loadScenario: loadWithFull } = await import('./scenario');
    expect(SCENARIO_IDS.map((id) => loadWithFull(id))).toEqual(projected);
  });

  it('characters.json을 import하는 실행 코드 파일은 CHARACTER_IMPORTERS와 같다', async () => {
    const { readdirSync, readFileSync } = await fs();
    const src = new URL('../', import.meta.url);
    const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"`][^'"`]*characters\.json[^'"`]*['"`]/;
    const found = readdirSync(src, { recursive: true })
      .map((file) => file.split('\\').join('/'))
      .filter((file) => /\.(?:ts|mts|js|mjs)$/.test(file) && !file.endsWith('.test.ts'))
      .filter((file) => importPattern.test(readFileSync(new URL(file, src), 'utf8')))
      .map((file) => `src/${file}`)
      .sort();
    expect(found).toEqual([...CHARACTER_IMPORTERS].sort());
  });
});
