import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runnerImport } from 'vite';
import { key, ordered, withoutMeta, hash, splitWorkers, parseGolden, serializeGolden, checkSet, executionSet } from './rules3_golden_lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const defaultGolden = path.join(root, 'tests/golden/rules3-risk.tsv');
export async function loadEngine() {
  return (await runnerImport(fileURLToPath(new URL('./rules3_golden_entry.ts', import.meta.url)), { configFile: false, logLevel: 'error' })).module;
}
export function execute(e, row, probes = true, quoteProbes = true) {
  const config = e.withRiskLevel(e.withLateMode(e.loadScenario(row.scenarioId), 'base'), row.riskLevel, e.loadRiskProfile('RISK_PROFILE_DEFAULT'));
  const cfg = { ...config, seed: row.seed }, digest = createHash('sha256');
  const probeApplied = { cancel: 0, k2u: 0, risk: 0, tradeQuote: 0, forwardingQuote: 0 };
  const put = value => digest.update(JSON.stringify(value), 'utf8');
  const plan = (opened, command, kind) => {
    const result = e.planState(opened, cfg, [command]);
    put(result.results); put(withoutMeta(result.state));
    probeApplied[kind] += result.results.filter(r => r.status === 'APPLIED').length;
  };
  const observe = opened => {
    if (quoteProbes && opened.day % 7 === 1) {
      for (const pair of e.openTradePairs(opened, cfg)) {
        put(e.quotePreview(opened, cfg, pair)); probeApplied.tradeQuote++;
      }
      const ids = opened.offers.filter(o => o.status === 'OPEN').map(o => o.id).filter(id => {
        const def = e.offerDef(opened, cfg, id);
        return def?.kind === 'forwarding' && def.publishDay <= opened.day && opened.day <= def.validUntilDay;
      }).sort();
      for (const offerId of ids) {
        put(e.quotePreview(opened, cfg, { offerId })); probeApplied.forwardingQuote++;
      }
    }
    if (opened.day % 7 !== 0) return;
    for (const c of opened.contracts.filter(c => c.status === 'ACTIVE' || c.status === 'IN_PROGRESS')) plan(opened, { id: 'GOLDEN-CANCEL', type: 'CANCEL_CONTRACT', contractId: c.id }, 'cancel');
    plan(opened, { id: 'GOLDEN-K2U', type: 'EXCHANGE_CURRENCY', direction: 'KRW_TO_USD', usdAmountMinor: cfg.operations.fx.lotUsdMinor }, 'k2u');
    put(e.paymentDefaultStatus(opened, cfg));
    for (const currency of ['USD', 'KRW']) put(e.fundsPosition(opened, cfg, currency));
    put(e.cashReservations(opened, cfg)); put(e.upcomingPayments(opened, cfg));
    put(e.campaignSummary(opened, cfg)); put(e.marketTable(opened, cfg));
    for (const c of opened.contracts) put(e.contractReport(opened, c));
    for (const d of ['USD_TO_KRW', 'KRW_TO_USD']) put(e.exchangePreview(opened, cfg, d, cfg.operations.fx.lotUsdMinor));
    for (const c of opened.contracts.filter(c => c.kind === 'DIRECT_TRADE')) {
      put(e.contractRiskReport(opened, cfg, c.id)); probeApplied.risk++;
    }
    put(e.tariffSchedule(opened, cfg)); put(e.receivableSchedule(opened, cfg));
    put(e.referenceRate(cfg, row.seed, opened.day));
  };
  const policy = e.policyById(row.policyId);
  if (!policy) throw new Error(`정책이 없습니다: ${row.policyId}`);
  const { run, state } = e.simulate(config, policy, row.seed, probes ? observe : undefined, row.riskLevel);
  try {
    const text = e.serializeSave(state);
    const loaded = e.deserializeSave(text, { config, dataVersion: config.dataVersion, rulesVersion: config.rules.rulesVersion });
    if (e.serializeSave(loaded) !== text) throw new Error('저장 바이트가 달라졌습니다');
  } catch (error) { throw Object.assign(new Error(`${key(row)} 저장 왕복 실패: ${error.message}`), { exitCode: 1 }); }
  const rest = withoutMeta(state);
  return { row: { ...row, runHash: hash(run), stateHash: hash(rest), probeHash: digest.digest('hex') }, run, state: rest, probeApplied };
}
// 존재하지 않는 목적지도 가장 가까운 부모의 realpath로 검사한다.
function realDestination(target) {
  const absolute = path.resolve(target);
  try { return fs.realpathSync(absolute); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return path.join(realDestination(path.dirname(absolute)), path.basename(absolute)); }
}
async function runRows(e, rows, workers, dump, quoteProbes) {
  const start = performance.now();
  const consume = result => { dumpResult(result, dump, quoteProbes); return result.row; };
  let results;
  if (workers === 1) results = rows.map(row => consume(execute(e, row, true, quoteProbes)));
  else {
    const active = [];
    try {
      results = (await Promise.all(splitWorkers(rows, workers).map(group => new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { rows: group, dump, quoteProbes } });
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
  console.error(`rules-3: ${rows.length}회, 워커 ${workers}개, ${((performance.now() - start) / 1000).toFixed(3)}초`);
  return ordered(results);
}
export async function main(args) {
  console.error(`Node ${process.versions.node}, ICU ${process.versions.icu}`);
  if ((1234567.5).toLocaleString('ko-KR') !== '1,234,567.5') throw new Error('한국어 ICU 숫자 형식이 기준과 다릅니다');
  let write = false, golden, dump, quoteProbes = true, workers = Math.min(os.availableParallelism(), 8);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`중복 옵션: ${arg}`);
    seen.add(arg);
    if (arg === '--write') write = true;
    else if (arg === '--no-quote-probe') quoteProbes = false;
    else if (['--golden', '--dump', '--workers'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`옵션 값이 없습니다: ${arg}`);
      if (arg === '--golden') golden = value;
      if (arg === '--dump') dump = value;
      if (arg === '--workers') { if (!/^[1-9][0-9]*$/.test(value)) throw new Error('잘못된 워커 수'); workers = Number(value); }
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!Number.isSafeInteger(workers) || workers < 1 || (write && golden)) throw new Error('잘못된 옵션 조합 또는 워커 수');
  if (!quoteProbes && (write || !golden || !dump || realDestination(golden) === realDestination(defaultGolden))) throw new Error('--no-quote-probe는 기본 경로가 아닌 골든과 dump가 함께 필요합니다');
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
  const expected = executionSet();
  const selection = write ? { rows: expected } : parseGolden(fs.readFileSync(golden ?? defaultGolden, 'utf8'));
  checkSet(selection.rows, expected, !golden || realDestination(golden) === realDestination(defaultGolden));
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/market_rules.json'), 'utf8')).risk_profiles.find(p => p.id === 'RISK_PROFILE_DEFAULT');
  if (!raw) throw new Error('위험 프로필 원문이 없습니다');
  const profileRaw = hash(raw);
  if (!write && profileRaw !== selection.profileRaw) throw new Error('위험 프로필 RISK_PROFILE_DEFAULT 원문 자료가 골든과 다릅니다');
  const e = await loadEngine();
  for (const row of expected) if (!e.policyById(row.policyId)) throw new Error(`정책이 없습니다: ${row.policyId}`);
  const profileLoaded = hash(e.loadRiskProfile('RISK_PROFILE_DEFAULT'));
  const loaderChanged = !write && profileLoaded !== selection.profileLoaded;
  if (loaderChanged) console.error('위험 프로필 로더 출력이 골든과 다릅니다(엔진 변경)');
  if (dump) fs.mkdirSync(dump, { recursive: true });
  const actual = await runRows(e, selection.rows, workers, dump, quoteProbes);
  const differences = [], totals = { runHash: 0, stateHash: 0, probeHash: 0 };
  if (write) {
    fs.writeFileSync(defaultGolden, serializeGolden({ profileRaw, profileLoaded }, actual));
    checkSet(parseGolden(fs.readFileSync(defaultGolden, 'utf8')).rows, expected, true);
  } else selection.rows.forEach((row, i) => {
    const changed = Object.keys(totals).filter(field => row[field] !== actual[i][field]);
    if (changed.length) { differences.push(`${key(row)}: ${changed.join(', ')}`); changed.forEach(field => totals[field]++); }
  });
  if (differences.length) {
    differences.slice(0, 10).forEach(line => console.log(line));
    console.log(`다른 줄 ${differences.length}개 (runHash ${totals.runHash}, stateHash ${totals.stateHash}, probeHash ${totals.probeHash})`);
    return 1;
  }
  if (loaderChanged) return 1;
  console.log(`rules-3 골든 ${write ? '기록' : '일치'}: ${actual.length}회`);
  return 0;
}
function dumpResult(result, dump, quoteProbes) {
  if (!dump) return;
  const { row } = result;
  const stem = `${row.scenarioId}__${row.riskLevel}__${row.policyId}__${row.seed}`;
  for (const field of ['run', 'state']) fs.writeFileSync(path.join(dump, `${stem}.${field}.json`), JSON.stringify(result[field]));
  if (!quoteProbes) fs.writeFileSync(path.join(dump, `${stem}.hashes.json`), JSON.stringify(Object.fromEntries(['runHash', 'stateHash', 'probeHash'].map(k => [k, row[k]]))));
}

if (!isMainThread) {
  try {
    const e = await loadEngine();
    const rows = workerData.rows.map(row => {
      const result = execute(e, row, true, workerData.quoteProbes);
      dumpResult(result, workerData.dump, workerData.quoteProbes);
      return result.row;
    });
    parentPort.postMessage({ rows });
  } catch (error) { parentPort.postMessage({ error: error.message, exitCode: error.exitCode ?? 2 }); }
} else if (isMainThread && import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 2; }
}
