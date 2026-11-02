// 이름은 실행의 유일 키다. 기본값을 이름에 중복해서 쓰지 않는다.
import type { ScenarioConfig } from '../types';
export type Investment = 'none' | 'S' | 'E' | 'SE' | 'SE22';
export interface Variant { acceptance: string; react: boolean; investment: Investment; hires: { pt: number; day: number }[]; early: boolean }
export const ACCEPTANCE_IDS = ['IDLE', 'NO_FX', 'MAX_CONTRIBUTION', 'LATE_OK', 'ON_TIME_FIRST', 'ASSET_LIGHT', 'SEEDED_RANDOM', 'MARGIN_BUFFER', 'FOCUS', 'TERM_GREEDY', 'CREDIT_AWARE'];
export function variantName(v: Variant): string {
  return v.acceptance + (v.react ? '~fx:react' : '') + (v.investment !== 'none' ? `~inv:${v.investment}` : '')
    + (v.hires.length ? `~hire:${v.hires.map((h) => `${h.pt}pt@${h.day}`).join('+')}` : '') + (v.early ? '~scout:early' : '');
}
export function parseVariant(id: string): Variant | undefined {
  const match = /^([A-Z_]+)(~fx:react)?(?:~inv:(S|E|SE|SE22))?(?:~hire:((?:[23]pt@\d+)(?:\+[23]pt@\d+)*))?(~scout:early)?$/.exec(id);
  if (!match || !ACCEPTANCE_IDS.includes(match[1]!)) return undefined;
  const v: Variant = { acceptance: match[1]!, react: !!match[2], investment: (match[3] ?? 'none') as Investment,
    hires: match[4]?.split('+').map((h) => { const [pt, day] = h.split('pt@'); return { pt: Number(pt), day: Number(day) }; }) ?? [], early: !!match[5] };
  return v.hires.some((h) => h.day < 4 || !Number.isSafeInteger(h.day)) || variantName(v) !== id ? undefined : v;
}
export function candidateFor(config: ScenarioConfig, pt: number) {
  return config.employees.find((e) => config.recruitment?.candidateEmployeeIds.includes(e.id) && e.workUnitsPerDay === pt);
}
export type LateMode = 'base' | 'cap30' | 'flat200';
export function withLateMode(config: ScenarioConfig, mode: LateMode): ScenarioConfig {
  const copy = structuredClone(config);
  if (mode === 'cap30') copy.terms.lateDeliveryCapBasisPoints = 3000;
  if (mode === 'flat200') Object.assign(copy.terms, { lateDeliveryBasis: 'FLAT_ONCE', lateDeliveryPriceReductionMinor: 20000, lateDeliveryCapBasisPoints: null });
  return copy;
}
export function d03PolicyIds(mode: LateMode = 'base'): string[] {
  const ids = ['IDLE', 'NO_FX', 'MAX_CONTRIBUTION', 'LATE_OK', 'MAX_CONTRIBUTION~fx:react'];
  const investments: Investment[] = mode === 'base' ? ['none', 'S', 'E', 'SE', 'SE22'] : ['none', 'S', 'E', 'SE'];
  for (const acceptance of ['MAX_CONTRIBUTION', 'LATE_OK']) for (const investment of investments) {
    const v: Variant = { acceptance, investment, react: false, hires: [], early: false };
    ids.push(variantName(v));
    for (const pt of [2, 3]) for (const day of mode === 'base' ? [8, 29, 30, 31, 50] : [8, 30, 50]) ids.push(variantName({ ...v, hires: [{ pt, day }] }));
  }
  if (mode === 'base') {
    ids.push('MAX_CONTRIBUTION~inv:SE~hire:2pt@22+3pt@36');
    for (const [pt, investment] of [[2, 'SE'], [3, 'SE'], [2, 'none']] as const) ids.push(variantName({ acceptance: 'MAX_CONTRIBUTION', investment, hires: [{ pt, day: 30 }], early: true, react: false }));
  }
  return [...new Set(ids)];
}

export function bundleKindV2(level: 'R0P' | 'R1' | 'R2' | 'R3' | 'R4'): 'full' | 'reduced' {
  return level === 'R0P' || level === 'R4' ? 'full' : 'reduced';
}
export function d03PolicyIdsV2(level: Parameters<typeof bundleKindV2>[0]): string[] {
  const base = bundleKindV2(level) === 'full' ? d03PolicyIds('base').filter((id) => id !== 'FOCUS')
    : ['IDLE', 'NO_FX', 'MAX_CONTRIBUTION', 'LATE_OK'];
  return [...base, 'MARGIN_BUFFER', 'TERM_GREEDY', 'CREDIT_AWARE'];
}
