import growthLadder from '../../data/growth_ladder.json';
import { growthHooks } from '../engine/growth-ladder';
import marketRules from '../../data/market_rules.json';
import { OPS_DATA_MISSING, opsData, setOpsData, growthData, setGrowthData, growthEngine, setGrowthEngine } from './ops-data';

let previous: typeof marketRules | undefined;
try { previous = opsData(); }
catch (error) {
  if (!(error instanceof Error && error.message === OPS_DATA_MISSING)) throw error;
}
if (previous && JSON.stringify(previous) !== JSON.stringify(marketRules)) throw new Error('운영 자료가 이미 등록되어 있습니다.');
if (!previous) setOpsData(marketRules);

let previousGrowth: typeof growthLadder | undefined;
try { previousGrowth = growthData(); }
catch (error) {
  if (!(error instanceof Error && error.message === OPS_DATA_MISSING)) throw error;
}
if (previousGrowth && JSON.stringify(previousGrowth) !== JSON.stringify(growthLadder)) throw new Error('성장 자료가 이미 등록되어 있습니다.');
if (!previousGrowth) setGrowthData(growthLadder);
let previousEngine: typeof growthHooks | undefined;
try { previousEngine = growthEngine(); }
catch (error) {
  if (!(error instanceof Error && error.message === OPS_DATA_MISSING)) throw error;
}
if (previousEngine && (previousEngine.length !== growthHooks.length || previousEngine.some((fn, i) => fn !== growthHooks[i]))) throw new Error('성장 엔진이 이미 등록되어 있습니다.');
if (!previousEngine) setGrowthEngine(growthHooks);
