// DRAFT 8.1·8.5의 확정 표를 원본 자료와 대조한다. 이름은 상수로 복제하지 않는다.
import { describe, expect, it } from 'vitest';
import characters from '../../data/characters.json';

type Character = {
  id: string; species_ko: string; primary_role: string; attribute: string; rarity: string;
  stats: Record<string, number>; growth_focus: { primary_stat: string; secondary_stat: string };
  release_phase: string; encounter: { city_id: string; category: string; unlock_stage: string };
  conservation: { iucn_source?: string; iucn_status: string; cites_status: string; cites_appendix: string | null };
  signature_trait: { candidate_effect: { trigger_tag: string; target_score: string } };
};
const expected = [
  ["EMP66", "흰머리수리", "sales", "light", [70, 40, 65, 35, 50, 40], ["negotiation", "analysis"], "REGULATION_SOURCE_CHECK", "regulation_source_score", "representative_animal", "NEW_YORK"],
  ["EMP67", "캘리포니아바다사자", "sales", "water", [70, 40, 40, 35, 55, 60], ["negotiation", "coordination"], "PORT_FAIR_INTRO", "fair_intro_score", "representative_animal", "LOS_ANGELES"],
  ["EMP68", "청두루미", "sales", "wind", [70, 40, 55, 35, 40, 60], ["negotiation", "coordination"], "INCOTERMS_EXPLAIN", "incoterms_explain_score", "representative_animal", "DURBAN"],
  ["EMP69", "큰홍학", "sales", "fire", [65, 35, 70, 40, 45, 45], ["analysis", "negotiation"], "HS_CODE_EXPLAIN", "hs_code_explain_score", "representative_animal", "MUMBAI"],
  ["EMP70", "흑로", "operations", "water", [35, 70, 60, 45, 40, 50], ["operations", "analysis"], "TRANSSHIPMENT_PLAN", "transshipment_plan_score", "representative_animal", "DUBAI"],
  ["EMP71", "잔점박이물범", "operations", "shadow", [40, 70, 45, 50, 35, 60], ["operations", "coordination"], "CUTOFF_TRACKING", "cutoff_tracking_score", "representative_animal", "ROTTERDAM"],
  ["EMP72", "유럽울새", "sales", "fire", [70, 35, 60, 40, 45, 50], ["negotiation", "analysis"], "CARGO_INSURANCE_EXPLAIN", "insurance_explain_score", "representative_animal", "LONDON"],
  ["EMP73", "작은올빼미", "sales", "shadow", [65, 40, 70, 35, 45, 45], ["analysis", "negotiation"], "LC_TERMS_EXPLAIN", "lc_terms_score", "representative_animal", "PIRAEUS"],
  ["EMP74", "바바리마카크", "sales", "earth", [70, 40, 50, 35, 45, 60], ["negotiation", "coordination"], "RESTRICTED_ITEM_BRIEF", "restricted_item_score", "rare_animal", "TANGER_MED"],
  ["EMP75", "아프리카물수리", "sales", "wind", [65, 40, 45, 35, 70, 45], ["exploration", "negotiation"], "TRANSIT_ROUTE_BRIEF", "transit_route_score", "representative_animal", "MOMBASA"],
  ["EMP76", "갈색펠리컨", "operations", "light", [40, 70, 50, 35, 45, 60], ["operations", "coordination"], "CANAL_SLOT_PLAN", "canal_slot_score", "representative_animal", "PANAMA"],
  ["EMP77", "오렌지배지빠귀", "sales", "fire", [70, 45, 60, 35, 40, 50], ["negotiation", "analysis"], "IMPORT_LICENSE_BRIEF", "import_license_score", "representative_animal", "SANTOS"],
  ["EMP78", "동부회색캥거루", "sales", "earth", [65, 45, 50, 55, 40, 45], ["negotiation", "technology"], "WOOD_PACKAGING_BRIEF", "wood_packaging_score", "representative_animal", "MELBOURNE"],
  ["EMP79", "불도그", "sales", "fire", [70, 40, 50, 35, 40, 65], ["negotiation", "coordination"], "CLAIM_RESPONSE", "claim_response_score", "familiar_animal", "LONDON"],
  ["EMP80", "진돗개", "operations", "earth", [45, 70, 55, 35, 50, 45], ["operations", "analysis"], "PET_QUARANTINE_DOCS", "pet_quarantine_score", "familiar_animal", "PYEONGTAEK"],
  ["EMP81", "래브라도리트리버", "operations", "light", [40, 65, 60, 45, 50, 40], ["operations", "analysis"], "DECLARATION_GAP_CHECK", "declaration_gap_score", "familiar_animal", "YOKOHAMA"],
  ["EMP82", "제주마", "sales", "wind", [65, 45, 40, 35, 55, 60], ["negotiation", "coordination"], "GEO_INDICATION_BRIEF", "geo_indication_score", "familiar_animal", "BUSAN"],
  ["EMP83", "사바나코끼리", "sales", "fire", [65, 40, 60, 35, 45, 55], ["negotiation", "analysis"], "LISTING_BY_POPULATION", "population_listing_score", "rare_animal", "DURBAN"],
  ["EMP84", "유럽뱀장어", "operations", "shadow", [35, 65, 70, 45, 40, 45], ["analysis", "operations"], "SPECIES_LABEL_CHECK", "species_label_score", "rare_animal", "ROTTERDAM"],
  ["EMP85", "점박이해마", "sales", "water", [70, 35, 60, 40, 40, 55], ["negotiation", "analysis"], "PERMIT_FIRST_CHECK", "permit_check_score", "rare_animal", "SINGAPORE"],
] as const;
const statKeys = ['negotiation', 'operations', 'analysis', 'technology', 'exploration', 'coordination'];
async function original(): Promise<Character[]> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: string): string };
  return JSON.parse(fs.readFileSync(new URL('../../data/characters.json', import.meta.url), 'utf8')).items;
}

describe('TASK-0081 출시 전 동물 20종', () => {
  it('원본은 85종이며 새 20종의 아이디는 시험 모듈에 없다', async () => {
    expect(await original()).toHaveLength(85);
    for (const [id] of expected) expect(characters.items.some((item) => item.id === id)).toBe(false);
  });

  it('확정 표의 직무·속성·능력·성장·태그·갈래·거점과 보전 구분을 지킨다', async () => {
    const full = await original();
    const added = full.filter((item) => expected.some(([id]) => item.id === id));
    expect(added.map((item) => item.id)).toEqual(expected.map(([id]) => id));
    for (const [id, species, role, attribute, stats, focus, trigger, target, category, city] of expected) {
      const item = added.find((item) => item.id === id)!;
      expect(item.species_ko, id).toBe(species);
      expect(item.primary_role, id).toBe(role);
      expect(item.attribute, id).toBe(attribute);
      expect(statKeys.map((key) => item.stats[key]), id).toEqual(stats);
      expect(Object.values(item.stats).reduce((sum, n) => sum + n, 0), id).toBe(300);
      expect(Object.values(item.stats).every((n) => n >= 35 && n <= 75), id).toBe(true);
      expect([item.growth_focus.primary_stat, item.growth_focus.secondary_stat], id).toEqual(focus);
      const highest = Object.entries(item.stats).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([key]) => key);
      expect(highest, id).toEqual(focus);
      expect(item.signature_trait.candidate_effect.trigger_tag, id).toBe(trigger);
      expect(item.signature_trait.candidate_effect.target_score, id).toBe(target);
      expect(item.encounter.category, id).toBe(category);
      expect(item.encounter.city_id, id).toBe(city);
      expect(item.release_phase, id).toBe('P2');
      expect(item.encounter.unlock_stage, id).toBe('P2');
      expect(item.rarity, id).toBe(category === 'familiar_animal' ? 'common' : category === 'rare_animal' ? 'rare' : 'uncommon');
      if (category === 'familiar_animal') {
        expect(item.conservation.iucn_status, id).toBe('NOT_APPLICABLE_DOMESTIC');
        expect(item.conservation.cites_status, id).toBe('not_applicable');
        expect(item.conservation.cites_appendix, id).toBeNull();
        expect(item.conservation).not.toHaveProperty('iucn_source');
      } else {
        expect(item.conservation.iucn_source, id).toBe('secondary');
      }
    }
    const counts = (values: string[]) => values.reduce<Record<string, number>>((result, value) => {
      result[value] = (result[value] ?? 0) + 1;
      return result;
    }, {});
    expect(counts(added.map((item) => item.primary_role))).toEqual({ sales: 14, operations: 6 });
    expect(counts(added.map((item) => item.attribute))).toEqual({ fire: 5, water: 3, wind: 3, earth: 3, light: 3, shadow: 3 });
    expect(counts(added.map((item) => item.rarity))).toEqual({ common: 4, uncommon: 12, rare: 4 });
    expect(counts(added.map((item) => item.encounter.category))).toEqual({ representative_animal: 12, rare_animal: 4, familiar_animal: 4 });
    expect(added.filter((item) => item.conservation.iucn_source === 'secondary')).toHaveLength(16);
  });
});
