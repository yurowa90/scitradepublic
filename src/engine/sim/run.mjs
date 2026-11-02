// 화면 없는 비교 실행기의 Node 진입점. 시계·파일·워커는 이 경계에서만 쓴다.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runnerImport } from 'vite';

const entry = fileURLToPath(new URL('./cli.ts', import.meta.url));
try {
  const { module } = await runnerImport(entry, { configFile: false, logLevel: 'error' });
  const io = {
    marketRulesSha256: () => createHash('sha256').update(readFileSync(new URL('../../../data/market_rules.json', import.meta.url))).digest('hex'),
    readText: (path) => readFileSync(path, 'utf8'), writeText: (path, text) => writeFileSync(path, text),
    out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text), now: () => performance.now(),
  };
  if (!isMainThread) {
    parentPort.postMessage(module.runD03(workerData));
  } else if (process.argv[2] === 'd03') {
    const options = module.d03Options(process.argv.slice(3));
    if (options.risk) options.marketRulesSha256 = io.marketRulesSha256();
    if (options.workers === 1 || options.tablesFrom) process.exitCode = module.simMain(process.argv.slice(2), io);
    else {
      const start = performance.now(), count = Math.min(options.workers, options.seeds.length);
      const outputs = await Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: module.workerOptions(options, i, count) });
        worker.once('message', resolve); worker.once('error', reject);
        worker.once('exit', (code) => { if (code) reject(new Error(`워커 종료 코드 ${code}`)); });
      })));
      const output = module.mergeD03(outputs, options.late, module.requestedRisk(options));
      module.writeD03(output, io, options.out);
      io.err(`실행 ${output.runs.length}회 · ${((performance.now() - start) / 1000).toFixed(2)}초 · 워커 ${count}개\n`);
    }
  } else process.exitCode = module.simMain(process.argv.slice(2), io);
} catch (error) {
  process.stderr.write(`비교 실행기 오류: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
