import { describe, expect, it } from 'vitest';

// 브라우저 없이 CSS와 보존한 단계 1 패치를 읽는다. Node 형식 의존성은 빌드에 더하지 않는다.
const fs = await import('node:fs' as string) as {
  readFileSync(path: string, encoding: string): string;
  readdirSync(path: string): string[];
};
const read = (path: string) => fs.readFileSync(path, 'utf8');
const style = read('src/ui/style.css');
const path11 = read('src/ui/path11.css');
const patch = read('tests/fixtures/theme-stage1.patch');
const readingSelectors = ['.offer', '.contract', 'table.money', '.market-table', '.settlement', '.recruit-site', '.roster'];
const lazyReadingSelectors = ['.p11 table'];

type Rule = { selectors: string[]; declarations: Record<string, string> };
function rules(css: string): Rule[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector!.trim().split(/\s*,\s*/),
    declarations: Object.fromEntries([...body!.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].map(([, key, value]) => [key!, value!.trim()])),
  }));
}
function rule(css: string, selector: string) {
  const found = rules(css).filter((r) => r.selectors.includes(selector));
  if (!found.length) throw new Error(`선택자 없음: ${selector}`);
  return Object.assign({}, ...found.map((r) => r.declarations)) as Record<string, string>;
}
function resolve(value: string, variables: Record<string, string>, seen: string[] = []): string {
  return value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    if (seen.includes(name) || variables[name] === undefined) throw new Error(`색 변수 확인: ${[...seen, name].join(' → ')}`);
    return resolve(variables[name]!, variables, [...seen, name]);
  });
}
function patchedSource(side: 'before' | 'after') {
  const lines = patch.slice(patch.indexOf('@@\n') + 3).split('\n');
  return lines.filter((line) => line.startsWith(' ') || line.startsWith(side === 'after' ? '+' : '-'))
    .map((line) => line.slice(1)).join('\n') + '\n';
}
const legacyTable: [string, string, string][] = [
  ['button:disabled', 'background', '#eee9df'],
  ['button:disabled', 'border-color', '#bcb4a4'],
  ['button.primary', 'color', '#fff'],
  ['.pipeline li', 'background', '#f1ece0'],
  ['.pipeline li.now', 'color', '#fff'],
  ['.card', 'background', 'linear-gradient(160deg, #fffaf0, #f3ead6)'],
  ['.card', 'border', '3px solid #ead9b0'],
  ['.card', 'box-shadow', '0 6px 0 #e0cfa3, var(--shadow)'],
  ['.card-tag', 'background', '#fff'],
  ['.card-tag.busy', 'color', '#fff'],
  ['.chip', 'background', '#fff'],
  ['.attr-light', 'color', '#a07812'],
  ['.attr-light', 'border-color', '#e8cf7a'],
  ['.attr-water', 'color', '#2d6fa8'],
  ['.attr-water', 'border-color', '#9cc6ea'],
  ['.card-placeholder', 'background', 'rgba(255,255,255,.8)'],
  ['.seg button[aria-pressed="true"]', 'color', '#fff'],
  ['.kind.kind-fwd', 'background', '#f3e6c8'],
  ['.kind.kind-fwd', 'color', '#7a5a14'],
  ['.offer.forwarding', 'border-color', '#e2cf9f'],
  ['.contract.forwarding', 'border-color', '#e2cf9f'],
  ['.bar', 'background', '#efe8d8'],
  ['.planner', 'background', '#f6fbff'],
  ['.progress-box', 'background', '#fbfaf5'],
  ['.sev-warn', 'color', '#8a5a00'],
  ['.role-sales', 'color', '#3a6ea5'],
  ['.role-sales', 'border-color', '#9cc6ea'],
  ['.role-operations', 'color', '#7a5a14'],
  ['.role-operations', 'border-color', '#e2cf9f'],
  ['table.roster tbody tr.is-selected', 'background', '#fff6d8'],
  ['.statusbar .primary:disabled', 'color', '#fff'],
  ['.queue-chip', 'background', '#f6fbff'],
  ['.map-detail', 'background', '#fffdf7'],
];
function luminance(hex: string) {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`6자리 색이 아님: ${hex}`);
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
}
function contrast(a: string, b: string) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
const root = rule(style, ':root');
function color(name: string, variables = root) { return resolve(variables[name]!, variables); }
function reading(css: string, selector: string) { return { ...root, ...rule(css, selector) }; }

// 읽기 칸 자체와 그 자손을 모두 찾는다. .panel h3처럼 넓게 적용되는 장식은 아래의 해제 규칙으로 검사한다.
function isReadingSelector(selector: string) {
  return [...readingSelectors, ...lazyReadingSelectors].some((base) => selector === base || selector.startsWith(`${base} `)
    || selector.startsWith(`${base}>`) || selector.startsWith(`${base}:`) || selector.startsWith(`${base}.`));
}

describe('TASK-0078 색 변수와 장식', () => {
  it('1 단계 1 대응표와 전체 선언은 원래 화면 값을 보존한다', () => {
    expect(patch).toContain('@@ -1,');
    const stage1 = patchedSource('after'), original = patchedSource('before');
    const vars = rule(stage1, ':root'), oldVars = rule(original, ':root');
    for (const [selector, property, literal] of legacyTable) {
      const value = rule(stage1, selector)[property]!;
      expect(value, `${selector} ${property}의 변수화`).toContain('var(--');
      expect(resolve(value, vars), `${selector} ${property}`).toBe(resolve(literal, oldVars));
    }
    // 새 변수 정의만 지우고 참조를 되돌리면 주석·공백까지 원본과 같아야 한다.
    let restored = stage1;
    for (const [name, value] of Object.entries(vars)) {
      if (name in oldVars) continue;
      restored = restored.replace(new RegExp(`^  ${name}: [^;]+;\\n`, 'm'), '').replaceAll(`var(${name})`, value);
    }
    expect(restored).toBe(original);
  });

  it('2 틀·모든 읽기 칸·단추·초점의 색 짝은 WCAG 대비를 넘는다', () => {
    const pairs: [string, string, string, number][] = [
      ['틀 본문', '--navy', '--paper', 4.5], ['틀 흐린 글', '--navy-soft', '--paper', 4.5],
      ['틀 링크', '--sky-deep', '--paper', 4.5], ['틀 경고', '--warn', '--paper', 4.5],
      ['주 단추', '--on-accent', '--gold', 4.5], ['일반 단추', '--btn-fg', '--cream', 4.5],
      ['금선', '--gold', '--paper', 3], ['초점', '--sky-deep', '--paper', 3],
    ];
    for (const [label, fg, bg, minimum] of pairs) expect(contrast(color(fg), color(bg)), label).toBeGreaterThanOrEqual(minimum);
    for (const [css, selectors] of [[style, readingSelectors], [path11, lazyReadingSelectors]] as const) {
      for (const selector of selectors) {
        const vars = reading(css, selector);
        for (const name of ['--navy', '--navy-soft', '--sky-deep', '--warn', '--ok', '--role-sales-fg', '--fwd-fg']) {
          expect(contrast(color(name, vars), color('--paper', vars)), `${selector} ${name}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(color('--btn-fg', vars), color('--cream', vars)), `${selector} 단추`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // 대비가 좋은 변수만 두고 실제 선택자는 다른 변수를 쓰는 회귀도 거부한다.
    expect(rule(style, 'button').color).toBe('var(--btn-fg)');
    expect(rule(style, 'button.primary').color).toBe('var(--on-accent)');
    expect(rule(style, 'button.primary').background).toBe('var(--gold)');
    expect(rule(style, '.role-sales').color).toBe('var(--role-sales-fg)');
  });

  it('3가 읽기 칸의 글자·테두리는 금색을 쓰지 않는다', () => {
    for (const css of [style, path11]) {
      for (const r of rules(css).filter((r) => r.selectors.some(isReadingSelector))) {
        const selector = r.selectors.find(isReadingSelector)!;
        const base = [...readingSelectors, ...lazyReadingSelectors].find((s) => selector.startsWith(s))!;
        const vars = { ...reading(base === '.p11 table' ? path11 : style, base), ...r.declarations };
        for (const [name, value] of Object.entries(r.declarations)) {
          if (name !== 'color' && !/^border(?:-|$)/.test(name)) continue;
          expect(value, `${selector} ${name}`).not.toMatch(/--gold|#c9a24a/i);
          expect(resolve(value, vars), `${selector} ${name}의 계산값`).not.toMatch(/#c9a24a/i);
        }
      }
    }
  });

  it('3나 읽기 칸 자손은 장식 슬롯을 쓰지 않고 h3 배경을 해제한다', () => {
    for (const [css, selectors] of [[style, readingSelectors], [path11, lazyReadingSelectors]] as const) {
      for (const r of rules(css)) {
        const usesOrnament = Object.entries(r.declarations).some(([name, value]) => !name.startsWith('--') && /var\(--orn-/.test(value));
        if (usesOrnament) expect(r.selectors.some(isReadingSelector), r.selectors.join(', ')).toBe(false);
      }
      for (const selector of selectors) expect(rule(css, `${selector} h3`).background).toBe('none');
    }
    expect(style).not.toMatch(/\.p11\b/);
  });

  it('3다 청화·주홍 리터럴은 글자색에 없다', () => {
    for (const css of [style, path11]) {
      for (const r of rules(css)) expect(r.declarations.color ?? '').not.toMatch(/#(?:3a6ea5|b8452f)\b/i);
    }
  });

  it('3라 UI CSS에는 청해파·운문 경로가 없다', () => {
    for (const file of fs.readdirSync('src/ui').filter((f) => f.endsWith('.css'))) {
      const css = read(`src/ui/${file}`).replace(/(?:%[\da-f]{2})+/gi, (encoded) => decodeURIComponent(encoded));
      expect(css, file).not.toContain('a8 8 0 0 1 16 0');
      expect(css, file).not.toContain('M2 17c0-5 5-8 9-5');
    }
    expect(color('--orn-card')).toBe('none');
    expect(color('--orn-corner')).toBe('none');
    expect(color('--orn-divider')).toBe('none');
  });

  it('4 장식 슬롯의 규칙에는 움직임 선언이 없다', () => {
    for (const css of [style, path11]) {
      for (const r of rules(css)) {
        if (!Object.entries(r.declarations).some(([name, value]) => name.startsWith('--orn-') || /var\(--orn-/.test(value))) continue;
        expect(Object.keys(r.declarations).filter((name) => /^(?:animation|transition)(?:-|$)/.test(name)), r.selectors.join(', ')).toEqual([]);
      }
    }
  });
  it('5 상아 칸과 그림 칸은 밝은 입력 판을 쓰고 그림 칸 글자는 밝은 바탕 짝이다(세션 B 실측, 허브 수정)', () => {
    for (const selector of readingSelectors) expect(rule(style, selector)['color-scheme'], selector).toBe('light');
    for (const selector of lazyReadingSelectors) expect(rule(path11, selector)['color-scheme'], selector).toBe('light');
    const art = rule(style, '.card-art');
    expect(art['color-scheme']).toBe('light');
    expect(art['--navy-soft']).toBe('#4a5672');
    expect(art['--sky']).toBe('#dbe6f2');
    // 세션 B 실측(TASK-0079): 그림 칸 '대기' 칩은 밝은 바탕이어야 흐린 글자(--navy-soft)와 6.13:1이 된다.
    expect(art['--tag-bg']).toBe('#f3ead6');
  });
});
