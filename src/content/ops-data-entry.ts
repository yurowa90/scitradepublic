import marketRules from '../../data/market_rules.json';
import { OPS_DATA_MISSING, opsData, setOpsData } from './ops-data';

let previous: typeof marketRules | undefined;
try { previous = opsData(); }
catch (error) {
  if (!(error instanceof Error && error.message === OPS_DATA_MISSING)) throw error;
}
if (previous && JSON.stringify(previous) !== JSON.stringify(marketRules)) throw new Error('운영 자료가 이미 등록되어 있습니다.');
if (!previous) setOpsData(marketRules);
