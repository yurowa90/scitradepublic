import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGolden, serializeGolden, checkSet, splitWorkers, ordered, executionSets } from './rules2_golden_lib.mjs';
import { defaults, loadEngine, execute } from './check_rules2_golden.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scitrade-golden-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cli = fileURLToPath(new URL('./check_rules2_golden.mjs', import.meta.url));
const source = parseGolden(fs.readFileSync(defaults['rules-2'], 'utf8'));
const sample = source.rows.filter(r => r.seed === 1001 && ['IDLE', 'MAX_CONTRIBUTION'].includes(r.policyId));
assert.equal(sample.length, 2);
function cliRun(rows = sample, args = [], transform = text => text) {
  const golden = path.join(tmp, 'sample.tsv');
  fs.writeFileSync(golden, transform(serializeGolden('rules-2', rows)));
  const stdout = path.join(tmp, 'stdout'), stderr = path.join(tmp, 'stderr');
  const outFd = fs.openSync(stdout, 'w'), errFd = fs.openSync(stderr, 'w');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let result;
  try { result = spawnSync(process.execPath, [cli, '--golden', golden, '--workers', '1', ...args], { cwd: tmp, env, stdio: ['ignore', outFd, errFd], timeout: 29000 }); }
  finally { fs.closeSync(outFd); fs.closeSync(errFd); }
  assert.ifError(result.error);
  return { ...result, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') };
}
const check = (r, code) => assert.equal(r.status, code, r.stdout + r.stderr);
test('부분 집합 두 실행이 일치한다', { timeout: 30000 }, () => check(cliRun(), 0));
for (const field of ['stateHash', 'runHash', 'probeHash']) test(`${field} 한 글자 변경을 찾는다`, { timeout: 30000 }, () => {
  const rows = structuredClone(sample);
  rows[0][field] = rows[0][field].slice(0, -1) + (rows[0][field].endsWith('0') ? '1' : '0');
  const r = cliRun(rows);
  check(r, 1); assert.match(r.stdout, new RegExp(field)); assert.ok(r.stdout.includes('IDLE'));
});
test('묶음 밖 정책을 실행 전에 거부한다', { timeout: 30000 }, () => {
  const rows = structuredClone(sample); rows[0].policyId = 'ABSENT';
  const r = cliRun(rows); check(r, 2); assert.ok(!r.stderr.includes('회, 워커'));
});
test('중복 줄을 거부한다', { timeout: 30000 }, () => check(cliRun(sample, [], text => text + text.split('\n')[3] + '\n'), 2));
test('16진수가 아닌 해시를 거부한다', { timeout: 30000 }, () => check(cliRun(sample, [], text => text.replace(sample[0].stateHash, 'g' + sample[0].stateHash.slice(1))), 2));
test('깨진 머리 줄을 거부한다', { timeout: 30000 }, () => check(cliRun(sample, [], text => text.replace('scenarioId\t', 'broken\t')), 2));
test('저장소 안 dump와 링크를 거부한다', { timeout: 30000 }, () => {
  check(cliRun(sample, ['--dump', path.dirname(defaults['rules-2'])]), 2);
  const link = path.join(tmp, 'repo-link'); fs.symlinkSync(path.dirname(defaults['rules-2']), link);
  check(cliRun(sample, ['--dump', path.join(link, 'missing')]), 2);
});
test('임시 경로에 실행·상태 파일 네 개를 쓴다', { timeout: 30000 }, () => {
  const dump = path.join(tmp, 'dump'); check(cliRun(sample, ['--dump', dump]), 0);
  assert.equal(fs.readdirSync(dump).length, 4);
  for (const row of sample) for (const kind of ['run', 'state']) {
    const obj = JSON.parse(fs.readFileSync(path.join(dump, `${row.scenarioId}__${row.policyId}__${row.seed}.${kind}.json`), 'utf8'));
    assert.equal('meta' in obj, false);
  }
});
test('기본 집합은 누락·추가를 모두 거부한다', () => {
  checkSet(source.rows, source.rows, true);
  assert.throws(() => checkSet(source.rows.slice(1), source.rows, true));
  assert.throws(() => checkSet([...source.rows, { ...source.rows[0], policyId: 'ABSENT' }], source.rows, true));
  checkSet(sample, source.rows, false);
});
test('워커 1개와 4개 분할은 같은 실행 집합을 보존한다', () => {
  for (const count of [1, 4]) assert.deepEqual(ordered(splitWorkers(source.rows, count).flat()), source.rows);
  const groups = splitWorkers(source.rows, 4);
  source.rows.forEach((row, i) => assert.deepEqual(groups[i % 4][Math.floor(i / 4)], row));
});
test('탐침은 실행 결과와 마지막 상태를 바꾸지 않는다', { timeout: 30000 }, async () => {
  const e = await loadEngine();
  assert.deepEqual(executionSets(e)['rules-2'], source.rows.map(({ scenarioId, policyId, seed }) => ({ scenarioId, policyId, seed })));
  const withProbe = execute(e, 'rules-2', sample[1], true), withoutProbe = execute(e, 'rules-2', sample[1], false);
  assert.equal(withProbe.row.runHash, withoutProbe.row.runHash);
  assert.equal(withProbe.row.stateHash, withoutProbe.row.stateHash);
  assert.ok(withProbe.probeApplied.cancel > 0);
});
test('형식 검사는 빈 자료·CRLF·끝 LF 누락·정렬 오류를 거부한다', () => {
  const text = serializeGolden('rules-2', sample);
  for (const invalid of [text.slice(0, -1), text.replaceAll('\n', '\r\n'), text.split('\n').slice(0, 3).join('\n') + '\n', [...text.trimEnd().split('\n').slice(0, 3), ...text.trimEnd().split('\n').slice(3).reverse()].join('\n') + '\n']) assert.throws(() => parseGolden(invalid));
});
