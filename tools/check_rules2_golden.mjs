import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runnerImport } from 'vite';
import { key, ordered, withoutMeta, hash, splitWorkers, parseGolden, serializeGolden, checkSet, executionSets } from './rules2_golden_lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const defaults = { 'rules-2': path.join(root, 'tests/golden/rules2-d03.tsv'), 'rules-1': path.join(root, 'tests/golden/rules1-run.tsv') };
export async function loadEngine() {
  return (await runnerImport(fileURLToPath(new URL('./rules2_golden_entry.ts', import.meta.url)), { configFile: false, logLevel: 'error' })).module;
}
export function execute(e, bundle, row, probes = true) {
  const config = bundle === 'rules-2' ? e.withLateMode(e.loadScenario(row.scenarioId), 'base') : e.loadScenario(row.scenarioId);
  const cfg = { ...config, seed: row.seed }, digest = createHash('sha256');
  const probeApplied = { cancel: 0, k2u: 0 };
  const put = value => digest.update(JSON.stringify(value), 'utf8');
  const plan = (opened, command, kind) => {
    const result = e.planState(opened, cfg, [command]);
    put(result.results); put(withoutMeta(result.state));
    probeApplied[kind] += result.results.filter(r => r.status === 'APPLIED').length;
  };
  const observe = opened => {
    if (opened.day % 7 !== 0) return;
    for (const c of opened.contracts.filter(c => c.status === 'ACTIVE' || c.status === 'IN_PROGRESS')) plan(opened, { id: 'GOLDEN-CANCEL', type: 'CANCEL_CONTRACT', contractId: c.id }, 'cancel');
    plan(opened, { id: 'GOLDEN-K2U', type: 'EXCHANGE_CURRENCY', direction: 'KRW_TO_USD', usdAmountMinor: cfg.operations.fx.lotUsdMinor }, 'k2u');
    put(e.paymentDefaultStatus(opened, cfg));
    for (const currency of ['USD', 'KRW']) put(e.fundsPosition(opened, cfg, currency));
    put(e.cashReservations(opened, cfg)); put(e.upcomingPayments(opened, cfg));
    put(e.campaignSummary(opened, cfg)); put(e.marketTable(opened, cfg));
    for (const c of opened.contracts) put(e.contractReport(opened, c));
    for (const d of ['USD_TO_KRW', 'KRW_TO_USD']) put(e.exchangePreview(opened, cfg, d, cfg.operations.fx.lotUsdMinor));
  };
  const { run, state } = e.simulate(config, e.policyById(row.policyId), row.seed, bundle === 'rules-2' && probes ? observe : undefined);
  try {
    const text = e.serializeSave(state);
    const loaded = e.deserializeSave(text, { config, dataVersion: config.dataVersion, rulesVersion: config.rules.rulesVersion });
    if (e.serializeSave(loaded) !== text) throw new Error('저장 바이트가 달라졌습니다');
  } catch (error) { throw Object.assign(new Error(`${key(row)} 저장 왕복 실패: ${error.message}`), { exitCode: 1 }); }
  const rest = withoutMeta(state);
  return { row: { ...row, runHash: hash(run), stateHash: hash(rest), ...(bundle === 'rules-2' ? { probeHash: digest.digest('hex') } : {}) }, run, state: rest, probeApplied };
}
// 존재하지 않는 목적지도 가장 가까운 부모의 realpath로 검사한다.
function realDestination(target) {
  const absolute = path.resolve(target);
  try { return fs.realpathSync(absolute); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return path.join(realDestination(path.dirname(absolute)), path.basename(absolute)); }
}
async function runRows(e, bundle, rows, workers, dump) {
  const start = performance.now();
  const consume = result => {
    if (dump) {
      const stem = `${result.row.scenarioId}__${result.row.policyId}__${result.row.seed}`;
      fs.writeFileSync(path.join(dump, `${stem}.run.json`), JSON.stringify(result.run));
      fs.writeFileSync(path.join(dump, `${stem}.state.json`), JSON.stringify(result.state));
    }
    return result.row;
  };
  let results;
  if (workers === 1) results = rows.map(row => consume(execute(e, bundle, row)));
  else {
    const active = [];
    try {
      results = (await Promise.all(splitWorkers(rows, workers).map(group => new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { bundle, rows: group, dump } });
        active.push(worker);
        let received = false;
        worker.on('message', message => {
          received = true;
          if (message.error) reject(Object.assign(new Error(message.error), { exitCode: message.exitCode }));
          else resolve(message.rows);
        });
        worker.on('error', reject);
        worker.on('exit', code => { if (code || !received) reject(new Error(`워커 종료 오류: ${code}`)); });
      })))).flat();
    } finally { await Promise.all(active.map(worker => worker.terminate())); }
  }
  console.error(`${bundle}: ${rows.length}회, 워커 ${workers}개, ${((performance.now() - start) / 1000).toFixed(3)}초`);
  return ordered(results);
}
export async function main(args) {
  console.error(`Node ${process.versions.node}, ICU ${process.versions.icu}`);
  if ((1234567.5).toLocaleString('ko-KR') !== '1,234,567.5') throw new Error('한국어 ICU 숫자 형식이 기준과 다릅니다');
  let write = false, golden, dump, workers = Math.min(os.availableParallelism(), 8);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`중복 옵션: ${arg}`);
    seen.add(arg);
    if (arg === '--write') write = true;
    else if (['--golden', '--dump', '--workers'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`옵션 값이 없습니다: ${arg}`);
      if (arg === '--golden') golden = value;
      if (arg === '--dump') dump = value;
      if (arg === '--workers') { if (!/^[1-9][0-9]*$/.test(value)) throw new Error('잘못된 워커 수'); workers = Number(value); }
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!Number.isSafeInteger(workers) || workers < 1 || (write && golden)) throw new Error('잘못된 옵션 조합 또는 워커 수');
  if (dump) {
    dump = realDestination(dump);
    const relative = path.relative(fs.realpathSync(root), dump);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('dump는 저장소 밖 경로여야 합니다');
  }
  if (write) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scitrade-golden-git-'));
    const output = path.join(tmp, 'diff'), fd = fs.openSync(output, 'w');
    try {
      const result = spawnSync('git', ['diff', '--stat', '--', 'src', 'data', 'schemas'], { cwd: root, stdio: ['ignore', fd, fd] });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error('git diff 실행 실패');
      if (fs.readFileSync(output, 'utf8').trim()) throw new Error('엔진·자료·스키마 변경 중에는 골든을 쓸 수 없습니다');
    } finally { fs.closeSync(fd); fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const e = await loadEngine(), sets = executionSets(e);
  const selections = write ? Object.keys(defaults).map(bundle => ({ bundle, rows: sets[bundle] })) : (golden ? [golden] : Object.values(defaults)).map(file => {
    const parsed = parseGolden(fs.readFileSync(file, 'utf8'));
    const canonical = fs.realpathSync(file);
    const defaultBundle = Object.keys(defaults).find(b => canonical === realDestination(defaults[b]));
    if (defaultBundle && parsed.bundle !== defaultBundle) throw new Error('기본 골든 묶음 불일치');
    checkSet(parsed.rows, sets[parsed.bundle], !!defaultBundle);
    return parsed;
  });
  if (dump) fs.mkdirSync(dump, { recursive: true });
  const counts = { 'rules-2': 0, 'rules-1': 0 }, differences = [], totals = { runHash: 0, stateHash: 0, probeHash: 0 };
  for (const selection of selections) {
    const { bundle, rows } = selection;
    const actual = await runRows(e, bundle, rows, workers, dump);
    counts[bundle] = rows.length;
    if (write) {
      fs.mkdirSync(path.dirname(defaults[bundle]), { recursive: true });
      fs.writeFileSync(defaults[bundle], serializeGolden(bundle, actual));
    } else rows.forEach((row, i) => {
      const changed = Object.keys(totals).filter(field => row[field] !== actual[i][field]);
      if (changed.length) { differences.push(`${key(row)}: ${changed.join(', ')}`); changed.forEach(field => totals[field]++); }
    });
  }
  if (write) for (const [bundle, file] of Object.entries(defaults)) checkSet(parseGolden(fs.readFileSync(file, 'utf8')).rows, sets[bundle], true);
  if (differences.length) {
    differences.slice(0, 10).forEach(line => console.log(line));
    console.log(`다른 줄 ${differences.length}개 (runHash ${totals.runHash}, stateHash ${totals.stateHash}, probeHash ${totals.probeHash})`);
    return 1;
  }
  console.log(`엔진 골든 ${write ? '기록' : '일치'}: rules-2 ${counts['rules-2']}회, rules-1 ${counts['rules-1']}회`);
  return 0;
}
if (!isMainThread) {
  try {
    const e = await loadEngine();
    const rows = workerData.rows.map(row => {
      const result = execute(e, workerData.bundle, row);
      if (workerData.dump) {
        const stem = `${row.scenarioId}__${row.policyId}__${row.seed}`;
        for (const field of ['run', 'state']) fs.writeFileSync(path.join(workerData.dump, `${stem}.${field}.json`), JSON.stringify(result[field]));
      }
      return result.row;
    });
    parentPort.postMessage({ rows });
  } catch (error) { parentPort.postMessage({ error: error.message, exitCode: error.exitCode ?? 2 }); }
} else if (isMainThread && import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 2; }
}
