import { describe, expect, it } from 'vitest';
import { parseSync } from 'rolldown/utils';

async function nodeFiles() {
  return await import('node:fs' as string) as { readFileSync(path: string, encoding: string): string; existsSync(path: string): boolean;
    rmSync(path: string, options: object): void };
}
async function staticClosure(overrides = new Map<string, string>()) {
  const fs = await nodeFiles();
  const path = await import('node:path' as string) as { resolve(...parts: string[]): string; dirname(p: string): string };
  const seen = new Set<string>(), root = path.resolve('.');
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.endsWith('.ts')) return;
    const source = overrides.get(file.slice(root.length + 1)) ?? fs.readFileSync(file, 'utf8');
    const parsed = parseSync(file, source);
    expect(parsed.errors, file).toEqual([]);
    for (const node of parsed.program.body) {
      let specifier: string | undefined;
      if (node.type === 'ImportDeclaration' && node.importKind !== 'type'
        && (!node.specifiers.length || node.specifiers.some((s) => s.type !== 'ImportSpecifier' || s.importKind !== 'type'))) specifier = node.source.value;
      if ((node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && node.exportKind !== 'type'
        && (node.type === 'ExportAllDeclaration' || node.specifiers.some((s) => s.exportKind !== 'type'))) specifier = node.source?.value;
      if (!specifier?.startsWith('.')) continue;
      const stem = path.resolve(path.dirname(file), specifier);
      const target = [stem, `${stem}.ts`, `${stem}/index.ts`].find((p) => fs.existsSync(p));
      if (!target) throw new Error(`정적 의존 파일을 찾지 못했습니다: ${specifier}`);
      visit(target);
    }
  }
  visit(path.resolve('src/ui/main.ts'));
  return [...seen].map((p) => p.slice(root.length + 1));
}
const targets = ['readers', 'reports', 'market', 'previews'].map((m) => `src/engine/${m}-lazy.ts`).concat('src/content/ops-data-entry.ts');
function outside(files: string[]) { for (const file of targets) expect(files).not.toContain(file); }
function walk(node: any, visit: (node: any) => void) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
// 1회차 부록 4의 index export 식별자 사용 횟수 탐지를 그대로 적용한다.
function lazyOnlyExports(file: string, source: string) {
  const nodes = parseSync(file, source).program.body;
  const names = nodes.filter((n) => n.type === 'ExportNamedDeclaration' && !n.source).flatMap((n: any) => n.specifiers);
  return names.flatMap((e: any) => {
    let count = 0;
    for (const n of nodes) if (n.type !== 'ExportNamedDeclaration') walk(n, (x) => { if (x.type === 'Identifier' && x.name === e.local.name) count++; });
    if (count !== 1) return [];
    const declaration = nodes.find((n: any) => n.id?.name === e.local.name) as any;
    // 허용하는 setter는 인수 하나를 모듈 변수에 넣는 문장 하나뿐이다.
    const statements = declaration?.body?.body;
    const assignment = statements?.[0]?.expression;
    const setter = declaration?.type === 'FunctionDeclaration' && declaration.params.length === 1 && statements.length === 1
      && assignment?.type === 'AssignmentExpression' && assignment.operator === '='
      && assignment.left.type === 'Identifier' && assignment.right.type === 'Identifier'
      && assignment.right.name === declaration.params[0].name;
    return [setter ? 'setOpsData' : `허용하지 않은 export: ${e.local.name}`];
  }).sort();
}

describe('TASK-0076 첫 화면 경계', () => {
  it('정적 닫힘은 지연 함수와 자료 진입점을 제외하고 재수출 음성을 거부한다', async () => {
    outside(await staticClosure());
    const fs = await nodeFiles(), source = fs.readFileSync('src/engine/readers.ts', 'utf8');
    const closure = await staticClosure(new Map([['src/engine/readers.ts', source + "\nexport { creditTermOptions } from './readers-lazy';"]]));
    expect(() => outside(closure)).toThrow();
  });
  it('값 동적 import 대상은 셋이며 자료 import와 시험 reset의 원천 경계가 지켜진다', () => {
    const sources = import.meta.glob('../**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const dynamic: string[] = [], dataImports: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      if (file.endsWith('.test.ts')) continue;
      const parsed = parseSync(file, source); expect(parsed.errors).toEqual([]);
      walk(parsed.program, (node) => {
        if (file.startsWith('../ui/') && !file.endsWith('-testkit.ts') && node.type === 'ImportExpression') dynamic.push(node.source.value);
        if (node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.source.value.endsWith('/market_rules.json')) dataImports.push(file);
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'resetOpsDataForTest') {
          expect(file).toBe('../content/ops-data-setup.ts');
        }
      });
    }
    // TASK-0079: 신수 나전 틀 CSS와 사무실 장면이 지연 대상으로 더해졌다.
    expect(dynamic.sort()).toEqual(['./card-najeon.css', './culture-panel', './office-scene', './ops-screens', './situation']);
    expect(dataImports).toEqual(['../content/ops-data-entry.ts']);
  });
  it('실제 빌드의 고유 자료 표지는 지연에만 있고 탐지 허용 목록은 setOpsData 하나다', async () => {
    const fs = await nodeFiles(), dir = '/tmp/T76-test-dist';
    const vite = await import('vite' as string) as { build(config: object): Promise<unknown> };
    const bundle = await import('../../tools/bundle-size.mjs' as string) as { collectDist(path: string): {
      lazy: string[]; firstScreen: { file: string }[]; chunks: { file: string }[];
    } };
    // 원문 고유성을 유지하려고 표지 문자열을 시험 코드에 복제하지 않는다.
    const rules = JSON.parse(fs.readFileSync('data/market_rules.json', 'utf8'));
    const marker = rules.counterparties[2].name_ko as string;
    try {
      await vite.build({ logLevel: 'silent', build: { outDir: dir, emptyOutDir: true } });
      const dist = bundle.collectDist(dir);
      const containing = dist.chunks.filter((c) => fs.readFileSync(`${dir}/${c.file}`, 'utf8').includes(marker));
      expect(containing).toHaveLength(1); expect(dist.lazy).toContain(containing[0]!.file);
      for (const c of dist.firstScreen) expect(fs.readFileSync(`${dir}/${c.file}`, 'utf8')).not.toContain(marker);
      const index = dist.firstScreen.find((c) => /index-.*\.js$/.test(c.file))!;
      const code = fs.readFileSync(`${dir}/${index.file}`, 'utf8');
      expect(lazyOnlyExports(index.file, code)).toEqual(['setOpsData']);
      // 허용 목록을 늘린 V13은 탐지되지 않은 함수가 추가되어도 실패한다.
      expect(lazyOnlyExports(index.file, code)).not.toEqual(['creditTermOptions', 'setOpsData']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
