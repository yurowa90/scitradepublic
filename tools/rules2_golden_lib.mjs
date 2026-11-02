import { createHash } from 'node:crypto';

export const fields = bundle => ['scenarioId', 'policyId', 'seed', 'runHash', 'stateHash', ...(bundle === 'rules-2' ? ['probeHash'] : [])];
export const key = row => JSON.stringify([row.scenarioId, row.policyId, row.seed]);
export const ordered = rows => [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
export const withoutMeta = ({ meta, ...rest }) => rest;
export const hash = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
export function splitWorkers(rows, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('워커 수는 양의 정수여야 합니다');
  const groups = Array.from({ length: Math.min(count, rows.length) }, () => []);
  ordered(rows).forEach((row, i) => groups[i % groups.length].push(row));
  return groups;
}
export function parseGolden(text) {
  if (!text.endsWith('\n') || text.includes('\r')) throw new Error('LF와 마지막 LF가 필요합니다');
  const lines = text.slice(0, -1).split('\n');
  const match = /^# scitrade engine golden v1 \((rules-[12])\)$/.exec(lines[0]);
  if (!match || !/^#.+/.test(lines[1])) throw new Error('골든 설명 형식 오류');
  const bundle = match[1], columns = fields(bundle);
  if (lines[2] !== columns.join('\t')) throw new Error('골든 머리 줄 오류');
  const rows = lines.slice(3).map((line, i) => {
    const parts = line.split('\t');
    if (parts.length !== columns.length || !parts[0] || !parts[1] || !/^(0|[1-9][0-9]*)$/.test(parts[2]) || !Number.isSafeInteger(Number(parts[2])) || parts.slice(3).some(x => !/^[0-9a-f]{64}$/.test(x))) throw new Error(`골든 ${i + 4}줄 형식 오류`);
    return { ...Object.fromEntries(columns.map((c, j) => [c, parts[j]])), seed: Number(parts[2]) };
  });
  if (!rows.length) throw new Error('빈 실행 집합');
  for (let i = 1; i < rows.length; i++) if (key(rows[i - 1]) >= key(rows[i])) throw new Error('중복 실행 키 또는 줄 순서 오류');
  return { bundle, rows };
}
export function serializeGolden(bundle, rows) {
  const text = `# scitrade engine golden v1 (${bundle})\n# 실행·meta 제외 마지막 상태${bundle === 'rules-2' ? '·주간 탐침' : ''} JSON sha256; node tools/check_rules2_golden.mjs --write\n${fields(bundle).join('\t')}\n` + ordered(rows).map(r => fields(bundle).map(c => r[c]).join('\t')).join('\n') + '\n';
  parseGolden(text);
  return text;
}
export function checkSet(rows, expected, exact) {
  const allowed = new Set(expected.map(key)), actual = new Set(rows.map(key));
  if (!rows.length || actual.size !== rows.length || rows.some(r => !allowed.has(key(r))) || (exact && actual.size !== allowed.size)) throw new Error('골든 실행 집합 불일치');
}
export function executionSets(e) {
  const base = ['IDLE', 'NO_FX', 'MAX_CONTRIBUTION', 'LATE_OK'];
  const variants = ['MAX_CONTRIBUTION~fx:react', 'MAX_CONTRIBUTION~inv:SE~hire:2pt@30', 'LATE_OK~inv:SE~hire:3pt@30', 'MAX_CONTRIBUTION~inv:SE~hire:2pt@22+3pt@36', 'MAX_CONTRIBUTION~inv:SE~hire:2pt@30~scout:early'];
  if ([...base, ...variants].some(id => !e.d03PolicyIds('base').includes(id))) throw new Error('D03 변형 이름이 없습니다');
  const product = (scenarios, policies, seeds) => scenarios.flatMap(scenarioId => policies.flatMap(policyId => seeds.map(seed => ({ scenarioId, policyId, seed }))));
  return {
    'rules-2': ordered([...product(e.OPERATIONS_SCENARIO_IDS, base, e.SIM_SEEDS), ...product(e.OPERATIONS_SCENARIO_IDS, variants, e.SIM_SEEDS.slice(0, 5))]),
    'rules-1': ordered(product(e.SCENARIO_IDS, e.SIM_POLICIES.map(p => p.id), e.SIM_SEEDS)),
  };
}
