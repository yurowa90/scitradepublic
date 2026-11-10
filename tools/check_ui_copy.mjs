#!/usr/bin/env node
// 학생 화면 원문의 괄호 조사 재유입을 막는다. 시험·저장 fixture는 대상이 아니다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkUiCopy(root = 'src/ui') {
  const findings = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.(?:ts|css)$/.test(file) || /\.test\.ts$/.test(file)) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/을\(를\)|은\(는\)|이\(가\)|와\(과\)|\(으\)로|으로\(로\)/.test(line)) findings.push(`${file}:${i + 1}`);
      });
    }
  };
  walk(root);
  return findings;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkUiCopy();
  console.log(findings.length ? findings.join('\n') : '학생 화면 괄호 조사: 0건');
  process.exitCode = findings.length ? 1 : 0;
}
