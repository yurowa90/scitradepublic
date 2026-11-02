#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { REPO_ROOT, loadProfiles, loadScenario, selectProfiles, isInside, realOutputPath, runProfile, checkExpectations } from './lib.mjs';

const usage = '사용법: node tools/browser/measure.mjs --dist <빌드 폴더> --scenario <시나리오 파일> [--profiles all|touch|mouse|id,id] [--out <파일>] [--font-cache <폴더>]... [--offline-fonts] [--dry-run]';
async function main() {
  const opts = { fontCaches: [], offlineFonts: false, dryRun: false };
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-h' || arg === '--help') { console.log(usage); return 0; }
      if (arg === '--offline-fonts') opts.offlineFonts = true;
      else if (arg === '--dry-run') opts.dryRun = true;
      else if (['--dist', '--scenario', '--profiles', '--out', '--font-cache'].includes(arg)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다`);
        if (arg === '--font-cache') opts.fontCaches.push(realOutputPath(value));
        else opts[arg.slice(2)] = value;
      } else throw new Error(`알 수 없는 옵션: ${arg}`);
    }
    if (!opts.dist || !opts.scenario) throw new Error('빌드 폴더와 시나리오가 필요합니다');
    const distDir = path.resolve(opts.dist);
    if (!fs.statSync(path.join(distDir, 'index.html')).isFile()) throw new Error('index.html이 없습니다');
    const out = opts.out ? realOutputPath(opts.out) : null;
    if (!opts.fontCaches.length) opts.fontCaches.push(realOutputPath(path.join(os.tmpdir(), 'scitrade-font-cache')));
    const repo = fs.realpathSync(REPO_ROOT);
    if ((out && isInside(out, repo)) || isInside(opts.fontCaches[0], repo)) throw new Error('측정 출력과 첫 글꼴 캐시는 저장소 밖이어야 합니다');
    const { chromePadPx, profiles } = loadProfiles();
    const scenario = loadScenario(path.resolve(opts.scenario));
    const selected = selectProfiles(profiles, opts.profiles ?? scenario.profiles);
    if (opts.dryRun) {
      console.log(JSON.stringify({ dry_run: true, scenario: scenario.id, profiles: selected.map(p => p.id), steps: scenario.steps.length }, null, 2));
      return 0;
    }
    const runs = [];
    for (const profile of selected) runs.push(await runProfile({ distDir, scenario, profile, chromePadPx, fontCaches: opts.fontCaches, offlineFonts: opts.offlineFonts }));
    const expect = checkExpectations(scenario, runs, profiles);
    const ok = runs.every(r => r.status === 'ok' && r.size_ok && r.fonts_ok && r.page_errors.length === 0) && expect.ok;
    const result = { schema: 'scitrade-browser-measure/1', scenario: scenario.id, dist: distDir, dist_index_sha256: createHash('sha256').update(fs.readFileSync(path.join(distDir, 'index.html'))).digest('hex'), chromium: runs[0]?.chromium ?? null, runs, expect: expect.results, ok };
    const text = JSON.stringify(result, null, 2) + '\n';
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text);
      for (const run of runs) {
        const expectations = expect.results.filter(e => e.profile === run.profile);
        console.log(`${run.profile}: ${JSON.stringify(run.values)} 기대 ${expectations.length === 0 ? '없음' : expectations.every(e => e.ok) ? '통과' : '실패'}, 실행 ${run.status}, 글꼴 ${run.fonts_ok ? '통과' : '실패'}${run.error ? ` | ${run.error.split('\n')[0]}` : ''}`);
      }
    } else process.stdout.write(text);
    return ok ? 0 : 1;
  } catch (error) { console.error(`설정 오류: ${error.message}\n${usage}`); return 2; }
}
process.exitCode = await main();
