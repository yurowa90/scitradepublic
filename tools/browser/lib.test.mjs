import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, loadProfiles, selectProfiles, validateScenario, loadScenario, resolveDistPath, contentType, fontCacheKey, checkExpectations, isInside } from './lib.mjs';
const names = ['smoke', 'day-anchor', 'culture-result-flow3', 'local-tab-position', 'report-contract-link', 'schedule-toggle', 'crew-facet', 'campaign-end', 'route-map-fit', 'queue-chip', 'card-detail', 'card-detail-low', 'interview-hire', 'side-anchor', 'map-detail'];
const scenarioFile = name => path.join(REPO_ROOT, 'tools/browser/scenarios', `${name}.json`);
const profiles = loadProfiles().profiles;

test('프로필 일곱 개와 실제 배율', () => {
  assert.equal(loadProfiles().chromePadPx, 87);
  assert.equal(profiles.length, 7);
  assert.deepEqual(new Set(profiles.map(p => p.id)), new Set(['l1366', 'cb1366t', 'ipadAirL', 'ipadminiL', 'ipadmini6L', 'l1920', 't1000']));
  for (const p of profiles) { assert.ok([p.width, p.height, p.scale].every(Number.isInteger)); assert.ok([1, 2].includes(p.scale)); }
});
test('프로필 선택은 종류와 목록 순서를 지킨다', () => {
  assert.equal(selectProfiles(profiles, 'all').length, 7);
  assert.equal(selectProfiles(profiles, 'touch').length, 5);
  assert.equal(selectProfiles(profiles, 'mouse').length, 2);
  assert.deepEqual(selectProfiles(profiles, 'l1366,t1000').map(p => p.id), ['l1366', 't1000']);
  assert.deepEqual(selectProfiles(profiles, ['t1000', 'l1366']).map(p => p.id), ['t1000', 'l1366']);
  assert.throws(() => selectProfiles(profiles, 'unknown'));
});
test('묶음 시나리오 검증', () => {
  for (const name of names) assert.deepEqual(validateScenario(loadScenario(scenarioFile(name))), []);
});
test('잘못된 단계와 기대를 거절한다', () => {
  const base = loadScenario(scenarioFile('smoke'));
  // 기대(expect)를 비워 smoke의 기대가 덧붙는 오류를 내지 않게 하고, 경우마다 자기 오류 문구를 확인한다(Claude 검수).
  const cases = [
    [{ steps: [{ do: 'unknown' }] }, '모르는 동작'],
    [{ steps: [{ do: 'tap' }] }, '선택자가 필요합니다'],
    [{ steps: [{ do: 'measure', what: 'overflow-x' }] }, 'name이 필요합니다'],
    [{ steps: [{ do: 'measure', name: 'v', what: 'moved', ref: 'unknown' }] }, '정의되지 않은 ref'],
    [{ expect: [{ value: 'unknown', min: 0, max: 1 }] }, '기대 값이 정의되지 않았습니다'],
    [{ steps: [{ do: 'measure', name: 'overflow_x_day1', what: 'overflow-x' }], expect: [{ value: 'overflow_x_day1', min: 2, max: 1 }] }, '기대 범위가 올바르지 않습니다'],
    [{ steps: [{ do: 'measure', name: 'v', what: 'unknown', selector: '#x' }] }, '모르는 측정'],
    [{ profiles: ['unknown'] }, '모르는 프로필'],
    [{ steps: [{ do: 'remember', name: 'v', selector: '#test' }, { do: 'measure', name: 'v', what: 'overflow-x' }] }, 'name이 중복됩니다'],
    [{ steps: [{ do: 'select', selector: '#x' }] }, 'value와 index 가운데 하나만 씁니다'],
    [{ steps: [{ do: 'select', selector: '#x', value: 'a', index: 1 }] }, 'value와 index 가운데 하나만 씁니다'],
    [{ steps: [{ do: 'select', selector: '#x', index: -1 }] }, 'index는 0 이상 정수입니다'],
  ];
  assert.deepEqual(validateScenario({ ...base, expect: [], steps: [{ do: 'measure', name: 'ok1', what: 'overflow-x' }] }), []);
  assert.deepEqual(validateScenario({ ...base, expect: [], steps: [{ do: 'select', selector: '#x', index: 1 }] }), []);
  for (const [change, message] of cases) {
    const errors = validateScenario({ ...base, expect: [], ...change });
    assert.ok(errors.some(e => e.includes(message)), `${message}: ${JSON.stringify(errors)}`);
  }
});
test('요소 폭과 부모 안 왼쪽 위치 측정', () => {
  const base = { ...loadScenario(scenarioFile('smoke')), expect: [] };
  const steps = [
    { do: 'measure', name: 'w', what: 'width', selector: '[data-map-frame] > svg' },
    { do: 'measure', name: 'band', what: 'left-from-parent', selector: '[data-map-frame] > svg' },
    { do: 'remember', name: 'map', selector: '#world-h' },
    { do: 'measure', name: 'w_ref', what: 'width', ref: 'map' },
  ];
  assert.deepEqual(validateScenario({ ...base, steps, expect: [{ value: 'band', min: 0, max: 1.5 }] }), []);
  for (const what of ['width', 'left-from-parent']) {
    assert.deepEqual(validateScenario({ ...base, steps: [{ do: 'measure', name: 'v', what }] }), [`1단계 measure: 선택자 또는 ref가 필요합니다`]);
  }
});
test('정적 경로의 상위 이동을 막는다', () => {
  const root = path.join(os.tmpdir(), 'static-path-test');
  assert.equal(resolveDistPath(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveDistPath(root, '/assets/a.js'), path.join(root, 'assets/a.js'));
  assert.equal(resolveDistPath(root, '/../x'), null);
  assert.equal(resolveDistPath(root, '/%2e%2e/x'), null);
  assert.equal(resolveDistPath(root, '/%zz'), null);
  assert.ok(isInside(path.join(root, 'assets'), root));
  assert.ok(!isInside(`${root}-other`, root));
});
test('응답 형식 표와 기본 형식', () => {
  const entries = { html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', svg: 'image/svg+xml', json: 'application/json', woff2: 'font/woff2', odd: 'application/octet-stream' };
  for (const [ext, type] of Object.entries(entries)) assert.equal(contentType(`a.${ext}`), type);
});
test('글꼴 CSS만 사용자 에이전트를 캐시 키에 넣는다', () => {
  const css = 'https://fonts.googleapis.com/css2?family=Example', font = 'https://fonts.gstatic.com/example.woff2';
  assert.notEqual(fontCacheKey(css, 'first'), fontCacheKey(css, 'second'));
  assert.equal(fontCacheKey(font, 'first'), fontCacheKey(font, 'second'));
  assert.match(fontCacheKey(font, ''), /^[a-f0-9]{40}$/);
});
test('자료에서 만든 금지 이름·ID가 시나리오와 사용법에 없다', () => {
  const read = name => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', `${name}.json`), 'utf8'));
  const words = new Set();
  for (const h of read('world').items) {
    words.add(h.id);
    for (const p of h.name_ko.split(/[·()]/).map(s => s.trim()).filter(s => s.length >= 2)) words.add(p);
  }
  for (const name of ['market_offers', 'characters', 'employees', 'culture_activities', 'venues', 'contacts']) for (const item of read(name).items) words.add(item.id);
  function walk(obj) {
    if (Array.isArray(obj)) obj.forEach(walk);
    else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) { if (k === 'event_instance_id' && typeof v === 'string') words.add(v); walk(v); }
  }
  walk(read('scenarios'));
  for (const file of [...names.map(scenarioFile), path.join(REPO_ROOT, 'tools/browser/README.md')]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const word of words) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = /^[\x00-\x7f]+$/.test(word) ? new RegExp(`\\b${escaped}\\b`) : new RegExp(escaped);
      assert.ok(!pattern.test(text), `금지 문자열: ${path.basename(file)} ${word}`);
    }
  }
});
test('기대 범위와 없는 값 및 적용 프로필', () => {
  const scenario = { expect: [{ value: 'v', min: 0, max: 2, profiles: 'all' }] };
  assert.ok(checkExpectations(scenario, [{ profile: 'l1366', values: { v: 1 } }], profiles).ok);
  assert.ok(!checkExpectations(scenario, [{ profile: 'l1366', values: { v: 3 } }], profiles).ok);
  assert.ok(!checkExpectations(scenario, [{ profile: 'l1366', values: {} }], profiles).ok);
  scenario.expect[0].profiles = 'touch';
  assert.deepEqual(checkExpectations(scenario, [{ profile: 'l1366', values: {} }], profiles), { ok: true, results: [] });
});
test('명령줄 dry-run과 저장소 안 쓰기 경로 거절', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scitrade-browser-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'index.html'), '<html></html>');
    // 샌드박스의 자식 파이프 제한을 피하고 출력은 임시 파일로 받는다.
    const run = extra => {
      const stdout = path.join(tmp, 'stdout'), stderr = path.join(tmp, 'stderr');
      const outFd = fs.openSync(stdout, 'w'), errFd = fs.openSync(stderr, 'w');
      let result;
      try { result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools/browser/measure.mjs'), '--dist', tmp, '--scenario', scenarioFile('smoke'), '--dry-run', ...extra], { stdio: ['ignore', outFd, errFd] }); }
      finally { fs.closeSync(outFd); fs.closeSync(errFd); }
      assert.ifError(result.error);
      return { ...result, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') };
    };
    for (const name of names) {
      const result = run(['--scenario', scenarioFile(name)]);
      assert.equal(result.status, 0, result.stderr);
      const expected = selectProfiles(profiles, JSON.parse(fs.readFileSync(scenarioFile(name), 'utf8')).profiles).map(p => p.id);
      assert.deepEqual(JSON.parse(result.stdout).profiles, expected);
    }
    assert.equal(run(['--out', path.join(REPO_ROOT, 'inside.json')]).status, 2);
    assert.equal(run(['--font-cache', path.join(REPO_ROOT, 'inside-cache')]).status, 2);
    const linked = path.join(tmp, 'linked'); fs.symlinkSync(REPO_ROOT, linked);
    assert.equal(run(['--out', path.join(linked, 'inside.json')]).status, 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
