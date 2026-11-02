// 출시 전 자료가 실행 모듈과 배포 청크로 새지 않는지 원본 자료와 대조한다.
import { describe, expect, it } from 'vitest';
import characters from '../../data/characters.json';

type Character = {
  id: string; species_ko: string; name_ko: string; release_phase: string; attribute: string;
  stats: Record<string, number>; encounter: { unlock_stage: string };
  signature_trait: { candidate_effect: { trigger_tag: string } };
};
async function original() {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: string): string };
  return (JSON.parse(fs.readFileSync(new URL('../../data/characters.json', import.meta.url), 'utf8')) as { items: Character[] }).items;
}
const ids = ['EMP61', 'EMP62', 'EMP63', 'EMP64', 'EMP65'];

describe('TASK-0080 출시 전 동료', () => {
  it('원본 85종 중 새 다섯 종은 시험 모듈에서 제외한다', async () => {
    expect(await original()).toHaveLength(85);
    for (const id of ids) expect(characters.items.some((item) => item.id === id)).toBe(false);
  });

  it('새 다섯 종은 능력치·속성·출시 단계와 이름·태그 유일성을 지킨다', async () => {
    const full = await original();
    const added = full.filter((item) => ids.includes(item.id));
    expect(added.map((item) => item.id)).toEqual(ids);
    expect(added.map((item) => item.attribute)).toEqual(['light', 'wind', 'earth', 'water', 'shadow']);
    for (const item of added) {
      expect(Object.values(item.stats).reduce((sum, n) => sum + n, 0)).toBe(300);
      expect(Object.values(item.stats).every((n) => n >= 35 && n <= 75)).toBe(true);
      expect(item.release_phase).toBe('P2');
      expect(item.encounter.unlock_stage).toBe('P2');
      expect(full.filter((other) => other.name_ko === item.name_ko)).toHaveLength(1);
      expect(full.filter((other) => other.signature_trait.candidate_effect.trigger_tag === item.signature_trait.candidate_effect.trigger_tag)).toHaveLength(1);
    }
  });

  it('실제 빌드의 모든 청크에서 P2 이름·태그를 제외하고 기존 이름은 남긴다', async () => {
    const fs = await import('node:fs' as string) as {
      readFileSync(path: string, encoding: string): string;
      readdirSync(path: string): string[];
      rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
    };
    const vite = await import('vite' as string) as { build(config: object): Promise<unknown> };
    const dir = '/tmp/T81-test-dist';
    try {
      await vite.build({ logLevel: 'silent', build: { outDir: dir, emptyOutDir: true } });
      const files = fs.readdirSync(`${dir}/assets`).filter((name) => name.endsWith('.js'));
      const full = await original();
      const pending = full.filter((item) => item.release_phase === 'P2');
      const addedIds = new Set(Array.from({ length: 20 }, (_, i) => `EMP${66 + i}`));
      const existingSpecies = new Set(full.filter((item) => !addedIds.has(item.id)).map((item) => item.species_ko));
      const uniqueSpecies = full.filter((item) => addedIds.has(item.id) && !existingSpecies.has(item.species_ko));
      expect(pending).toHaveLength(25);
      for (const file of files) {
        const text = fs.readFileSync(`${dir}/assets/${file}`, 'utf8');
        for (const item of uniqueSpecies) expect(text, file).not.toContain(item.species_ko);
        for (const item of pending) {
          expect(text, file).not.toContain(item.id);
          expect(text, file).not.toContain(item.name_ko);
          expect(text, file).not.toContain(item.signature_trait.candidate_effect.trigger_tag);
        }
      }
      const data = files.find((name) => /^data-.*\.js$/.test(name));
      expect(data).toBeTruthy();
      expect(fs.readFileSync(`${dir}/assets/${data}`, 'utf8')).toContain('귀솔');
      expect(fs.readFileSync(`${dir}/assets/${data}`, 'utf8')).toContain('EMP60');
      expect(fs.readFileSync(`${dir}/assets/${data}`, 'utf8')).toContain('고래상어');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
