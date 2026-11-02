// data/characters.json에서 화면·엔진이 읽는 칸 목록. 빌드는 이 칸만 싣는다(vite.config.ts의 characterFieldsPlugin).
// 자료 파일과 tools/validate_data.py는 전체 자료를 그대로 쓴다. 여기 없는 칸은 설계·근거 기록용이다.
// 새 칸을 읽는 작업은 같은 커밋에서 이 목록에 더한다. 빠뜨리면 시험(vitest)과 개발 서버에서 그 칸을 읽는 순간 오류가 난다.
// 새 실행 코드 파일에서 characters.json을 import하면 CHARACTER_IMPORTERS에도 더한다.
// 시험에서만 설계 전용 칸을 읽어야 하면 여기 더하지 말고 파일을 직접 읽는다(character-fields.test.ts의 readFull). 여기 더하면 빌드에도 실린다.

/** true는 그 값을 통째로 남긴다. 객체는 안쪽 칸만 남긴다. 배열 안 항목은 [모양] 하나로 적는다. */
export type FieldShape = true | { readonly [key: string]: FieldShape } | readonly [FieldShape];

export const CHARACTER_FIELDS = {
  items: [{
    id: true, // scenario.ts toEmployee, recruitment.ts species·단서 찾기
    creature_kind: true, // scenario.ts: character.creatureKind (지금 화면에서는 쓰지 않음)
    visual_motif: true, // scenario.ts: character.visualMotif → 카드 문구
    art_direction: { asset_status: true }, // scenario.ts: character.assetStatus (지금 화면에서는 쓰지 않음)
    stats: true, // scenario.ts: growth.baseStats로 통째로 복사한다(능력 6개, 파일 순서 그대로)
    attribute: true, // scenario.ts: character.attribute → 카드 배경·속성 칩·동료 걸러보기
    species_ko: true, // recruitment.ts: 후보 카드·영입 패널의 종 이름
    recruitment: { story_clue: true }, // recruitment.ts: 영입 패널의 단서
    xp_total: true, // scenario.ts: growth.startXp
    growth_focus: { primary_stat: true, secondary_stat: true }, // scenario.ts: growth.primaryStat·secondaryStat
  }],
} as const satisfies { readonly [key: string]: FieldShape };

/** characters.json을 import하는 실행 코드 파일(시험 파일 제외, 저장소 뿌리 기준). */
export const CHARACTER_IMPORTERS = ['src/content/scenario.ts', 'src/ui/recruitment.ts'] as const;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 아직 출시하지 않은 자료는 빌드·시험·개발 서버에서 함께 제외한다. */
export const UNRELEASED_PHASES = ['P2'] as const;

/** 원본과 항목 순서를 보존하며 출시된 항목 목록의 사본을 돌려준다. */
export function releasedCharacters(full: Json): { [key: string]: Json; items: Json[] } {
  const document = full as { [key: string]: Json; items: { [key: string]: Json }[] };
  return { ...document, items: document.items.filter((item) =>
    !UNRELEASED_PHASES.some((phase) => phase === item.release_phase)) };
}

/** 모양에 적힌 칸만 남긴 사본을 만든다. 칸 순서는 자료 파일의 순서를 따른다. 모양에 있는데 자료에 없는 칸은 건너뛴다. */
export function projectFields(value: Json, shape: FieldShape): Json {
  if (shape === true) return value;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) throw new Error('배열 모양인데 자료가 배열이 아닙니다.');
    return value.map((item) => projectFields(item, shape[0]));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('객체 모양인데 자료가 객체가 아닙니다.');
  const kept = shape as { readonly [key: string]: FieldShape };
  const out: { [key: string]: Json } = {};
  for (const [key, inner] of Object.entries(value)) {
    if (Object.hasOwn(kept, key)) out[key] = projectFields(inner, kept[key]!);
  }
  return out;
}

/** 자료에는 있으나 모양에서 뺀 칸의 경로. 'items[].rarity'처럼 쓴다. 처음 나온 순서, 중복 없이. */
export function droppedPaths(value: Json, shape: FieldShape, path = ''): string[] {
  if (shape === true || value === null || typeof value !== 'object') return [];
  if (Array.isArray(shape)) {
    const seen = new Set<string>();
    for (const item of Array.isArray(value) ? value : []) for (const p of droppedPaths(item, shape[0], `${path}[]`)) seen.add(p);
    return [...seen];
  }
  if (Array.isArray(value)) return [];
  const kept = shape as { readonly [key: string]: FieldShape };
  const seen = new Set<string>();
  for (const [key, inner] of Object.entries(value)) {
    const child = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(kept, key)) seen.add(child);
    else for (const p of droppedPaths(inner, kept[key]!, child)) seen.add(p);
  }
  return [...seen];
}
