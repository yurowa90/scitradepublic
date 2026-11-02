import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, formatBytes, pageRefs, cssUrls, isFontSheet, evaluateBudget, sizeOf, collectDist, formatReport } from './bundle-size.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scitrade-bundle-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const tools = path.dirname(fileURLToPath(import.meta.url));
const copied = path.join(tmp, '경로 시험', 'tools');
fs.mkdirSync(copied, { recursive: true });
for (const file of ['bundle-size.mjs', 'check_bundle_size.mjs']) fs.copyFileSync(path.join(tools, file), path.join(copied, file));
fs.symlinkSync(path.join(tmp, '경로 시험'), path.join(tmp, '링크'), 'dir');
const cliPaths = [path.join(copied, 'check_bundle_size.mjs'), path.join(tmp, '링크', 'tools', 'check_bundle_size.mjs')];
const emptyFonts = () => ({ stylesheets: [], files: [] });
const chunk = (raw, gzip = 100, file = 'assets/a.js') => ({ file, raw, gzip });
const budget = chunks => ({ chunks, firstScreen: chunks, fonts: emptyFonts() });
const write = (dist, file, content) => {
  const target = path.join(dist, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'number' ? Buffer.alloc(content, 0x61) : content);
};
const fakeDist = (name, files) => {
  const dist = path.join(tmp, name);
  fs.mkdirSync(dist, { recursive: true });
  for (const [file, content] of Object.entries(files)) write(dist, file, content);
  return dist;
};
const cliRun = (cli, args, cwd = tmp) => {
  const stdout = path.join(tmp, 'stdout'), stderr = path.join(tmp, 'stderr');
  const outFd = fs.openSync(stdout, 'w'), errFd = fs.openSync(stderr, 'w');
  let result;
  // 샌드박스의 자식 파이프 제한을 피하고 출력은 임시 파일로 받는다.
  try { result = spawnSync(process.execPath, [cli, ...args], { cwd, stdio: ['ignore', outFd, errFd] }); }
  finally { fs.closeSync(outFd); fs.closeSync(errFd); }
  assert.ifError(result.error);
  return { ...result, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') };
};

test('index.html에서 script·modulepreload·stylesheet 참조를 문서 순서로 고른다', () => {
  const html = `<link rel="icon" href="data:," />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=X&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="./fonts/fonts.css" />
<!-- <script type="module" src="./assets/old.js"></script> -->
<script>window.x = 1</script>
<script type="module" crossorigin src="./assets/index-A.js"></script>
<link rel="modulepreload" crossorigin href="./assets/data-B.js">
<link rel='preload' href='./assets/map.png' as='image'>
<link rel="stylesheet" crossorigin href="./assets/index-C.css?v=1">`;
  assert.deepEqual(pageRefs(html), [
    { kind: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=X&display=swap', external: true },
    { kind: 'stylesheet', href: 'fonts/fonts.css', external: false },
    { kind: 'script', href: 'assets/index-A.js', external: false },
    { kind: 'modulepreload', href: 'assets/data-B.js', external: false },
    { kind: 'stylesheet', href: 'assets/index-C.css', external: false },
  ]);
  assert.deepEqual(pageRefs(`<SCRIPT SRC='/assets/a.js#x'></SCRIPT><LINK HREF=/assets/b.js REL='preload MODULEPRELOAD stylesheet' /><link href="//e.com/x.css" rel=stylesheet><script src=data:text/javascript,a></script><link href="HTTPS://e.com/y.css?q=1" rel=stylesheet>`), [
    { kind: 'script', href: 'assets/a.js', external: false },
    { kind: 'modulepreload', href: 'assets/b.js', external: false },
    { kind: 'stylesheet', href: '//e.com/x.css', external: true },
    { kind: 'stylesheet', href: 'HTTPS://e.com/y.css?q=1', external: true },
  ]);
  assert.equal(formatBytes(1234567), '1,234,567 B');
  assert.deepEqual(pageRefs('<link rel=stylesheet href=./assets/x.css/>'), [
    { kind: 'stylesheet', href: 'assets/x.css', external: false },
  ]);
  assert.equal(formatBytes(0), '0 B');
  assert.deepEqual(LIMITS, { chunkRaw: 500000, firstScreenRaw: 600000, firstScreenGzip: 140000, fontsRaw: 5000000 });
  assert.ok(Object.isFrozen(LIMITS));
});

test('스타일시트의 url()을 스타일시트 위치 기준으로 풀고 data:·외부·중복을 뺀다', () => {
  const css = `/* url(skip.woff2) */ @font-face{src:url(a/x.woff2) format('woff2')} @font-face{src:url("a/x.woff2")} @font-face{src:url('../b/y.woff2?v=2')} @font-face{src:url(/fonts/c/z.woff2)} .i{background:url(data:image/png;base64,AA)} @import url(https://e.com/z.css);`;
  assert.deepEqual(cssUrls(css, 'fonts/fonts.css'), ['fonts/a/x.woff2', 'b/y.woff2', 'fonts/c/z.woff2']);
  assert.deepEqual(cssUrls('url() url(" ") URL(./a.woff2#v) url(//e.com/x) url(DATA:abc)', 'fonts/fonts.css'), ['fonts/a.woff2']);
});

test('JS 청크 한도: 500,000 B는 통과하고 500,001 B는 실패한다', () => {
  assert.deepEqual(evaluateBudget(budget([chunk(500000)])), {
    ok: true, reasons: [], overChunks: [], firstScreen: { files: 1, raw: 500000, gzip: 100 }, fonts: { stylesheets: 0, files: 0, raw: 0 },
  });
  assert.deepEqual(evaluateBudget(budget([chunk(500001)])), {
    ok: false, reasons: ['JS 청크 1개 한도 초과'], overChunks: ['assets/a.js'], firstScreen: { files: 1, raw: 500001, gzip: 100 }, fonts: { stylesheets: 0, files: 0, raw: 0 },
  });
});

test('청크가 모두 한도 안이어도 첫 화면 합계가 넘으면 실패한다', () => {
  assert.deepEqual(evaluateBudget(budget([chunk(400000, 60000), chunk(400000, 60000, 'assets/b.js')])), {
    ok: false, reasons: ['첫 화면 원본 합계 한도 초과'], overChunks: [], firstScreen: { files: 2, raw: 800000, gzip: 120000 }, fonts: { stylesheets: 0, files: 0, raw: 0 },
  });
  assert.deepEqual(evaluateBudget(budget([chunk(100000, 70001), chunk(100000, 70000)])).reasons, ['첫 화면 gzip 합계 한도 초과']);
  assert.deepEqual(evaluateBudget(budget([chunk(300000, 70000), chunk(300000, 70000)])).reasons, []);
});

test('글꼴 한도: 5,000,000 B는 통과하고 5,000,001 B는 실패한다', () => {
  const withFonts = raw => ({ chunks: [], firstScreen: [], fonts: { stylesheets: [{ file: 'fonts/fonts.css', raw: 1 }], files: [{ file: 'fonts/a.woff2', raw: raw - 1 }] } });
  assert.deepEqual(evaluateBudget(withFonts(5000000)).reasons, []);
  assert.deepEqual(evaluateBudget(withFonts(5000001)).reasons, ['글꼴 합계 한도 초과']);
  const allOver = { ...budget([chunk(600001, 140001)]), fonts: withFonts(5000001).fonts };
  assert.deepEqual(evaluateBudget(allOver).reasons, ['JS 청크 1개 한도 초과', '첫 화면 원본 합계 한도 초과', '첫 화면 gzip 합계 한도 초과', '글꼴 합계 한도 초과']);
});

test('나중에 받는 JS는 첫 화면 합계에서 빠지고 청크 한도는 받는다', () => {
  const dist = fakeDist('나중 JS', {
    'index.html': '<script src="./assets/index.js"></script><link rel="modulepreload" href="./assets/data.js"><link rel="stylesheet" href="./assets/index.css">',
    'assets/index.js': 1000, 'assets/data.js': 500000, 'assets/index.css': 300, 'assets/later.js': 500001,
  });
  const c = collectDist(dist), v = evaluateBudget(c);
  assert.deepEqual(c.firstScreen.map(({ file, raw }) => [file, raw]), [['assets/index.js', 1000], ['assets/data.js', 500000], ['assets/index.css', 300]]);
  assert.deepEqual(c.lazy, ['assets/later.js']);
  assert.deepEqual([v.ok, v.reasons, v.overChunks, v.firstScreen.raw], [false, ['JS 청크 1개 한도 초과'], ['assets/later.js'], 501300]);
  const gz = file => formatBytes(c.chunks.find(s => s.file === file).gzip);
  assert.deepEqual(formatReport(c, v), [
    'JS 청크 3개 (하나에 500,000 B 이하):',
    `  assets/data.js 500,000 B, gzip ${gz('assets/data.js')} — 첫 화면`,
    `  assets/index.js 1,000 B, gzip ${gz('assets/index.js')} — 첫 화면`,
    `  assets/later.js 500,001 B, gzip ${gz('assets/later.js')} — 나중에 받음 — 한도 초과`,
    `첫 화면 JS·CSS 3개: 501,300 B (한도 600,000 B), gzip ${formatBytes(v.firstScreen.gzip)} (한도 140,000 B)`,
    '글꼴: index.html이 fonts/ 스타일시트를 부르지 않는다',
    '판정: 실패 — JS 청크 1개 한도 초과',
  ]);
  assert.deepEqual(sizeOf(dist, 'assets/index.js'), { file: 'assets/index.js', raw: 1000, gzip: zlib.gzipSync(Buffer.alloc(1000, 0x61), { level: 9 }).length });
  write(dist, 'index.html', '<script src="./assets/index.js"></script><script src="./assets/index.js?v=1"></script>');
  assert.equal(collectDist(dist).firstScreen.length, 1);
});

test('fonts/ 스타일시트는 글꼴 줄로 따로 세고 첫 화면 합계에 넣지 않는다', () => {
  const css = '@font-face{src:url(a/x.woff2)}@font-face{src:url(b/y.woff2)}';
  const dist = fakeDist('글꼴', {
    'index.html': '<link rel="stylesheet" href="./fonts/fonts.css" /><script src="./assets/index.js"></script>',
    'fonts/fonts.css': css, 'fonts/a/x.woff2': 1000, 'fonts/b/y.woff2': 2000, 'fonts/OFL.txt': 99, 'assets/index.js': 500,
  });
  const c = collectDist(dist), v = evaluateBudget(c), cssLength = Buffer.byteLength(css);
  assert.deepEqual(v.firstScreen, { files: 1, raw: 500, gzip: sizeOf(dist, 'assets/index.js').gzip });
  assert.deepEqual(v.fonts, { stylesheets: 1, files: 2, raw: cssLength + 3000 });
  const lines = formatReport(c, v);
  assert.ok(lines.includes(`글꼴: 스타일시트 1개 ${formatBytes(cssLength)} + 글꼴 파일 2개 3,000 B = ${formatBytes(cssLength + 3000)} (한도 5,000,000 B). 첫 화면 합계에 넣지 않는다`));
  assert.ok(!lines.some(line => line.startsWith('외부 참조')));
  assert.ok(!lines.includes('글꼴: index.html이 fonts/ 스타일시트를 부르지 않는다'));
  write(dist, 'assets/index.css', 300);
  write(dist, 'index.html', '<link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet" /><link href="https://e.com/y.css" rel="stylesheet" /><script src="./assets/index.js"></script><link rel="stylesheet" href="./assets/index.css">');
  const before = collectDist(dist), beforeLines = formatReport(before, evaluateBudget(before));
  assert.ok(beforeLines.includes('글꼴: index.html이 fonts/ 스타일시트를 부르지 않는다'));
  // 청크 1개, 첫 화면 2개(JS+CSS)라 두 개수가 다르다. 외부 참조는 공백 하나로 잇는다(Claude 검수).
  assert.ok(beforeLines.some(line => line.startsWith('첫 화면 JS·CSS 2개: 800 B ')));
  assert.ok(beforeLines.includes('외부 참조 2개(크기를 재지 않는다): https://fonts.googleapis.com/css2?family=X https://e.com/y.css'));
  assert.ok(!beforeLines.some(line => line.startsWith('글꼴: 스타일시트')));
  assert.ok(isFontSheet({ kind: 'stylesheet', href: 'fonts/fonts.css', external: false }));
  for (const ref of [
    { kind: 'script', href: 'fonts/a.js', external: false },
    { kind: 'stylesheet', href: 'fonts/fonts.css', external: true },
    { kind: 'stylesheet', href: 'assets/fonts.css', external: false },
    { kind: 'stylesheet', href: 'assets/fonts/x.css', external: false },
  ]) assert.equal(isFontSheet(ref), false);
  // 같은 스타일시트를 두 번 불러도, 두 스타일시트가 같은 글꼴 파일을 가리켜도 한 번만 센다(Claude 검수).
  write(dist, 'fonts/more.css', '@font-face{src:url(a/x.woff2)}');
  write(dist, 'index.html', '<link rel="stylesheet" href="./fonts/fonts.css" /><link rel="stylesheet" href="./fonts/fonts.css?v=2" /><link rel="stylesheet" href="./fonts/more.css" /><script src="./assets/index.js"></script>');
  const twice = evaluateBudget(collectDist(dist)).fonts;
  assert.deepEqual([twice.stylesheets, twice.files], [2, 2]);
});

test('참조한 파일이 없으면 missing에 적는다', () => {
  const dist = fakeDist('없는 참조', {
    'index.html': '<link rel="stylesheet" href="./fonts/fonts.css" /><script src="./assets/gone.js"></script><script src="./assets/gone.js"></script>',
    'fonts/fonts.css': '@font-face{src:url(x.woff2)}',
  });
  assert.deepEqual(collectDist(dist), { missing: ['assets/gone.js', 'fonts/x.woff2'], chunks: [], firstScreen: [], lazy: [], fonts: emptyFonts(), external: [] });
  assert.deepEqual(collectDist(path.join(tmp, '없는 폴더')), { missing: ['index.html'], chunks: [], firstScreen: [], lazy: [], fonts: emptyFonts(), external: [] });
  fs.mkdirSync(path.join(dist, 'assets', 'gone.js'), { recursive: true });
  assert.deepEqual(collectDist(dist).missing, ['assets/gone.js', 'fonts/x.woff2']);
  // 글꼴 스타일시트 자체가 없을 때도 missing에 적는다(Claude 검수).
  const noSheet = fakeDist('없는 글꼴 시트', { 'index.html': '<link rel="stylesheet" href="./fonts/gone.css" /><script src="./assets/a.js"></script>', 'assets/a.js': 10 });
  assert.deepEqual(collectDist(noSheet).missing, ['fonts/gone.css']);
});

test('CLI: 한도 안이면 종료 0이고 판정 줄을 쓴다(한글·공백 경로, 링크 폴더)', () => {
  const dist = fakeDist('dist', { 'index.html': '<script src="./assets/a.js"></script>', 'assets/a.js': 1000 });
  for (const cli of cliPaths) {
    for (const args of [[dist], []]) {
      const r = cliRun(cli, args);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trimEnd().split('\n').at(-1), '판정: 통과');
      assert.ok(!r.stdout.includes('판정: 실패'));
      assert.equal(r.stderr, '');
    }
  }
});

test('CLI: 한도를 넘으면 종료 1이다(한글·공백 경로, 링크 폴더)', () => {
  const dist = fakeDist('한도 초과', { 'index.html': '<script src="./assets/a.js"></script>', 'assets/a.js': 500001 });
  for (const cli of cliPaths) {
    const r = cliRun(cli, [dist]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout.trimEnd().split('\n').at(-1), '판정: 실패 — JS 청크 1개 한도 초과');
    assert.ok(!r.stdout.includes('판정: 통과'));
    assert.equal(r.stderr, '');
  }
});

test('CLI: dist/index.html이 없으면 종료 2다(한글·공백 경로, 링크 폴더)', () => {
  const dist = fakeDist('빈 폴더', {});
  for (const cli of cliPaths) {
    const r = cliRun(cli, [dist]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `없음: index.html\n${dist}에서 읽을 파일이 없습니다. 먼저 빌드하세요\n`);
    const loop = path.join(tmp, '고리 링크');
    if (!fs.existsSync(loop)) { fs.mkdirSync(loop); fs.symlinkSync('index.html', path.join(loop, 'index.html')); }
    const broken = cliRun(cli, [loop]);
    assert.equal(broken.status, 2);
    assert.equal(broken.stdout, '');
    assert.match(broken.stderr, /^읽을 수 없음: ELOOP/);
    for (const args of [[dist, dist], ['-x']]) {
      const invalid = cliRun(cli, args);
      assert.equal(invalid.status, 2);
      assert.equal(invalid.stdout, '');
      assert.equal(invalid.stderr, '사용법: node tools/check_bundle_size.mjs [dist 폴더]\n');
    }
  }
});
