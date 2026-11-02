import { beforeAll } from 'vitest';
import { setOpsData, setGrowthData } from './ops-data';

// 시험 모듈의 최상위 설정에는 자료만 필요하다. 엔진은 mock 등록 뒤에 불러온다.
setOpsData((await import('../../data/market_rules.json')).default);
setGrowthData((await import('../../data/growth_ladder.json')).default);
beforeAll(async () => { await import('./ops-data-entry'); });
