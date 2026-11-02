type OpsData = typeof import('../../data/market_rules.json');
let value: OpsData | undefined;
export const OPS_DATA_MISSING = '운영 자료 없음';
export function opsData(): OpsData {
  if (!value) throw new Error(OPS_DATA_MISSING);
  return value;
}
export function setOpsData(data: OpsData) { value = data; }
type GrowthData = typeof import('../../data/growth_ladder.json');
type GrowthEngine = typeof import('../engine/growth-ladder').growthHooks;
let growthValue: GrowthData | undefined;
let growthFns: GrowthEngine | undefined;
export function growthData(): GrowthData {
  if (!growthValue) throw new Error(OPS_DATA_MISSING);
  return growthValue;
}
export function setGrowthData(data: GrowthData) { growthValue = data; }
export function growthEngine(): GrowthEngine {
  if (!growthFns) throw new Error(OPS_DATA_MISSING);
  return growthFns;
}
export function setGrowthEngine(fns: GrowthEngine) { growthFns = fns; }
export function resetOpsDataForTest() { value = undefined; growthValue = undefined; growthFns = undefined; }
