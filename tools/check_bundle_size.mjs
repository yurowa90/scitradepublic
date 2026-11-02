#!/usr/bin/env node
// 빌드 크기 한도 검사. 사용: node tools/check_bundle_size.mjs [dist 폴더]
// 종료 코드: 0 통과, 1 한도 초과, 2 사용법 오류, 읽을 파일 없음(index.html·참조 파일) 또는 읽기 오류.
import { collectDist, evaluateBudget, formatReport } from './bundle-size.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg.startsWith('-'))) {
  console.error('사용법: node tools/check_bundle_size.mjs [dist 폴더]');
  process.exitCode = 2;
} else {
  const dist = args[0] ?? 'dist';
  let c;
  try { c = collectDist(dist); }
  catch (error) {
    // 없는 파일 밖의 읽기 오류(권한, 고리 링크 등)도 한도 초과(1)와 섞이지 않게 2로 끝낸다(Claude 검수).
    console.error(`읽을 수 없음: ${error.message}`);
    process.exitCode = 2;
  }
  if (c?.missing.length) {
    for (const file of c.missing) console.error(`없음: ${file}`);
    console.error(`${dist}에서 읽을 파일이 없습니다. 먼저 빌드하세요`);
    process.exitCode = 2;
  } else if (c) {
    const v = evaluateBudget(c);
    console.log(formatReport(c, v).join('\n'));
    process.exitCode = v.ok ? 0 : 1;
  }
}
