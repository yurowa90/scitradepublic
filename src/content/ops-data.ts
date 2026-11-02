type OpsData = typeof import('../../data/market_rules.json');
let value: OpsData | undefined;
export const OPS_DATA_MISSING = '운영 자료 없음';
export function opsData(): OpsData {
  if (!value) throw new Error(OPS_DATA_MISSING);
  return value;
}
export function setOpsData(data: OpsData) { value = data; }
export function resetOpsDataForTest() { value = undefined; }
