import { hash, withoutMeta } from './rules2_golden_lib.mjs';
export { hash, withoutMeta };

export const fields = () => ['scenarioId', 'riskLevel', 'policyId', 'seed', 'runHash', 'stateHash', 'probeHash'];
export const key = row => JSON.stringify([row.scenarioId, row.riskLevel, row.policyId, row.seed]);
export const ordered = rows => [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
export function splitWorkers(rows, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('워커 수는 양의 정수여야 합니다');
  const groups = Array.from({ length: Math.min(count, rows.length) }, () => []);
  ordered(rows).forEach((row, i) => groups[i % groups.length].push(row));
  return groups;
}
export function parseGolden(text) {
  if (!text.endsWith('\n') || text.includes('\r')) throw new Error('LF와 마지막 LF가 필요합니다');
  const lines = text.slice(0, -1).split('\n');
  const match = /^# scitrade engine golden v1 \(rules-3\)$/.exec(lines[0]);
  const profiles = /^# profileRaw=([0-9a-f]{64}) profileLoaded=([0-9a-f]{64}) ; .+$/.exec(lines[1]);
  if (!match || !profiles) throw new Error('골든 설명 형식 오류');
  const columns = fields();
  if (lines[2] !== columns.join('\t')) throw new Error('골든 머리 줄 오류');
  const rows = lines.slice(3).map((line, i) => {
    const parts = line.split('\t');
    if (parts.length !== columns.length || !parts[0] || !/^R[0-3]$/.test(parts[1]) || !parts[2] || !/^(0|[1-9][0-9]*)$/.test(parts[3]) || !Number.isSafeInteger(Number(parts[3])) || parts.slice(4).some(x => !/^[0-9a-f]{64}$/.test(x))) throw new Error(`골든 ${i + 4}줄 형식 오류`);
    return { ...Object.fromEntries(columns.map((c, j) => [c, parts[j]])), seed: Number(parts[3]) };
  });
  if (!rows.length) throw new Error('빈 실행 집합');
  for (let i = 1; i < rows.length; i++) if (key(rows[i - 1]) >= key(rows[i])) throw new Error('중복 실행 키 또는 줄 순서 오류');
  return { profileRaw: profiles[1], profileLoaded: profiles[2], rows };
}
export function serializeGolden(profiles, rows) {
  const text = `# scitrade engine golden v1 (rules-3)\n# profileRaw=${profiles.profileRaw} profileLoaded=${profiles.profileLoaded} ; 실행·meta 제외 마지막 상태·주간 탐침·공시일 견적 JSON sha256; node tools/check_rules3_golden.mjs --write\n${fields().join('\t')}\n` + ordered(rows).map(r => fields().map(c => r[c]).join('\t')).join('\n') + '\n';
  parseGolden(text);
  return text;
}
export function checkSet(rows, expected, exact) {
  const allowed = new Set(expected.map(key)), actual = new Set(rows.map(key));
  if (!rows.length || actual.size !== rows.length || rows.some(r => !allowed.has(key(r))) || (exact && actual.size !== allowed.size)) throw new Error('골든 실행 집합 불일치');
}
export function executionSet() {
  const scenarios = ['SCENARIO_M2_OPERATIONS', 'SCENARIO_M2_OPS_COSMETICS', 'SCENARIO_M2_OPS_COS_LAVER'];
  return ordered(scenarios.flatMap(scenarioId => ['R0', 'R1', 'R2', 'R3'].flatMap(riskLevel =>
    (riskLevel === 'R3' ? ['IDLE', 'NO_FX', 'MAX_CONTRIBUTION', 'LATE_OK', 'MARGIN_BUFFER', 'MAX_CONTRIBUTION~fx:react'] : ['NO_FX', 'MAX_CONTRIBUTION']).flatMap(policyId =>
      [2001, 2002, 2003].map(seed => ({ scenarioId, riskLevel, policyId, seed }))))));
}
