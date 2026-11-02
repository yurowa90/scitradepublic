import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../assets/asset-index.json';
import type { CharacterSprite } from './assets';
import { spriteHtml } from './sprite';

const sheet: CharacterSprite = { path: 'assets/characters/EMP01/work.png', frameWidth: 32, frameHeight: 32,
  rows: ['idle', 'walk', 'work', 'happy'], framesPerRow: 4, frameMs: 180 };

describe('동료 스프라이트', () => {
  afterEach(() => { vi.doUnmock('../assets/asset-index.json'); vi.resetModules(); });
  it('줄 위치·4칸 넘김·기기 배율을 CSS 속성으로 전달한다', () => {
    const html = spriteHtml(sheet, { row: 'work', scaleN: 3 });
    expect(html).toContain('--sprite-row: 2');
    expect(html).toContain('--sprite-scale: 3');
    expect(html).toContain('--sprite-w: 32px');
    expect(html).toContain('steps(4)');
    expect(html).toContain('animation-duration: 720ms');
    expect(html).toContain('pixel-art');
  });
  it('다른 칸 수와 직사각형 칸의 크기·줄 위치를 사용한다', () => {
    const html = spriteHtml({...sheet,frameWidth:24,frameHeight:16,framesPerRow:6}, {row:'happy',scaleN:2});
    expect(html).toContain('steps(6)'); expect(html).toContain('animation-duration: 1080ms');
    expect(html).toContain('--sprite-h: 16px'); expect(html).toContain('--sprite-row: 3');
  });
  it('이름이 있으면 img 역할과 이스케이프한 접근 이름을 단다', () => {
    const html = spriteHtml(sheet, { row: 'happy', scaleN: 2, label: '업무 "완료" <동료>' });
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="업무 &quot;완료&quot; &lt;동료&gt;"');
    expect(html).not.toContain('aria-hidden');
  });
  it('장식 그림이면 접근 트리에서 숨긴다', () => {
    const html = spriteHtml(sheet, { row: 'idle', scaleN: 1 });
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });
  it('없는 줄과 정수가 아닌 배율은 거절한다', () => {
    expect(() => spriteHtml(sheet, { row: 'missing', scaleN: 1 })).toThrow();
    expect(() => spriteHtml(sheet, { row: 'idle', scaleN: 1.5 })).toThrow();
  });
  it('현재 승인된 동료 그림이 없어서 자리표시자를 유지한다', async () => {
    vi.doMock('../assets/asset-index.json', () => ({ default: { ...manifest, assets: [] } }));
    const { characterSprite, characterImage } = await import('./assets');
    for (const id of ['EMP01', 'EMP02', 'EMP03', 'EMP04', 'EMP05', 'EMP06']) {
      expect(characterSprite(id)).toBeNull();
      expect(characterImage(id, 'card')).toBeNull();
    }
  });
  it('승인된 그림은 슬롯 규격을 읽고 미승인 그림은 쓰지 않는다', async () => {
    vi.doMock('../assets/asset-index.json', () => ({ default: { ...manifest, assets: [
      ...manifest.assets.filter((a) => a.kind !== 'character'),
      { id: 'TEST_CARD', kind: 'character', employee_id: 'EMP01', slot: 'card', path: 'card.png', status: 'approved' },
      { id: 'TEST_PORTRAIT', kind: 'character', employee_id: 'EMP01', slot: 'portrait', path: 'portrait.png', status: 'approved' },
      { id: 'TEST_WORK', kind: 'character', employee_id: 'EMP01', slot: 'work', path: 'work.png', status: 'approved' },
      { id: 'TEST_DRAFT', kind: 'character', employee_id: 'EMP02', slot: 'work', path: 'draft.png', status: 'draft' },
    ] } }));
    const assets = await import('./assets');
    expect(assets.characterImage('EMP01', 'card')).toEqual({ path: 'card.png', logicalWidth: 96, logicalHeight: 128 });
    expect(assets.characterImage('EMP01', 'portrait')).toEqual({path:'portrait.png',logicalWidth:48,logicalHeight:48});
    expect(assets.characterImage('EMP01', 'work')).toEqual({path:'work.png',logicalWidth:192,logicalHeight:192});
    expect(assets.characterSprite('EMP01')).toEqual({ ...sheet, frameWidth: 48, frameHeight: 48, path: 'work.png' });
    expect(assets.characterSprite('EMP02')).toBeNull();
    const { crewCard } = await import('./card');
    const { loadScenario } = await import('../content/scenario');
    const { createGame } = await import('../engine/engine');
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const html = crewCard(config.employees.find((employee) => employee.id === 'EMP01')!, createGame(config), false, config);
    expect(html).toContain('class="card-img pixel-art"');
    expect(html).toContain('width="96" height="128" data-pixel-w="96" data-pixel-h="128"');
    expect(html).not.toContain('그림 미제작');
  });
});
