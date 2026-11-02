import { riskMetrics, type RiskLevel, type RiskLevelV2, type RiskMeta } from './risk-metrics';
import { createOperationsCollector } from './operations-metrics';
import { loadScenario, SCENARIO_IDS } from '../../content/scenario';
import { commitDay, createGame, openDay } from '../engine';
import { createRng } from '../rng';
import { ENGINE_VERSION, type GameState, type ScenarioConfig } from '../types';
import { createMetricsCollector, type SimMetrics } from './metrics';
import { policyById, SIM_POLICIES, type SimPolicy } from './policies';

export const SIM_FORMAT = 2;
/** 진단용 고정 시드 20개. 자료의 시드와 무관한 상수다. */
export const SIM_SEEDS: readonly number[] = Array.from({ length: 20 }, (_, i) => 1001 + i);
export interface SimRun {
  scenarioId: string;
  policyId: string;
  seed: number;
  commands: { applied: number; rejected: number; duplicate: number; appliedByType: Record<string, number> };
  metrics: SimMetrics;
}
export interface SimOutput {
  meta: { tool: 'scitrade-sim'; format: number; engineVersion: string; dataVersion: string;
    scenarioIds: string[]; policyIds: string[]; seeds: number[]; lateMode?: import('./variants').LateMode; risk?: RiskMeta };
  runs: SimRun[];
}

export function simulate(baseConfig: ScenarioConfig, policy: SimPolicy, seed: number, observe?: (state: GameState, commands: import('../types').EngineCommand[]) => void, risk?: RiskLevel | RiskLevelV2): { state: GameState; run: SimRun } {
  const config = { ...baseConfig, seed };
  let day = 1;
  try {
    let state = createGame(config);
    let policyRng = createRng(seed);
    const collector = createMetricsCollector(config);
    const counts: SimRun['commands'] = { applied: 0, rejected: 0, duplicate: 0, appliedByType: {
      ACCEPT_FORWARDING: 0, ACCEPT_TRADE: 0, ASSIGN_TASK: 0, BOOK_SAILING: 0, CANCEL_CONTRACT: 0, RESPOND_TO_DELAY: 0,
    } };
    const operations = config.operations ? createOperationsCollector(config, policy.id) : null;
    if (operations) Object.assign(counts.appliedByType, { EXCHANGE_CURRENCY: 0, EXPAND_WAREHOUSE: 0, SIGN_SPACE_CONTRACT: 0, SCOUT_SITE: 0, START_RECRUIT_QUEST: 0, HIRE_CANDIDATE: 0 });
    let iterations = 0;
    while (state.phase !== 'ENDED') {
      day = state.day;
      if (++iterations > config.campaignDays + 1) throw new Error('캠페인 실행 고리의 안전 한도를 넘었습니다.');
      const opened = openDay(state, config).state;
      operations?.observeOpened(opened);
      const { commands, rng, rejections, projectionBookings, rejectionUnits } = policy.decide(opened, config, policyRng);
      observe?.(opened, commands);
      const result = commitDay(opened, config, commands);
      if (result.alreadyClosed) throw new Error('이미 마감한 날을 다시 마감했습니다.');
      const types = new Map(commands.map((c) => [c.id, c.type]));
      for (const r of result.results) {
        if (r.status === 'APPLIED') {
          counts.applied++;
          const type = types.get(r.commandId)!;
          counts.appliedByType[type] = (counts.appliedByType[type] ?? 0) + 1;
        } else if (r.status === 'REJECTED') counts.rejected++;
        else counts.duplicate++;
      }
      operations?.observeClosed(result.state, opened.day, rejections, projectionBookings, rejectionUnits);
      collector.observeClosedDay(result.state, config, opened.day);
      state = result.state;
      policyRng = rng;
    }
    const metrics = collector.finish(state, config);
    const ops = operations?.finish(state);
    if (risk) metrics.risk = riskMetrics(state, config, metrics, risk);
    return { state, run: { scenarioId: config.id, policyId: policy.id, seed, commands: counts, metrics: { ...metrics,
      ...(ops ? { operations: { ...ops, staffUtilizationBasisPoints: metrics.staff.availableEmployeeDays
        ? Math.floor((metrics.staff.availableEmployeeDays - metrics.staff.idleEmployeeDays) * 10000 / metrics.staff.availableEmployeeDays) : 0 } } : {}) } } };
  } catch (error) {
    throw new Error(`[${config.id}/${policy.id}/${seed}/${day}] ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function runSuite(options: { scenarioIds?: readonly string[]; policyIds?: readonly string[]; seeds?: readonly number[] } = {}): SimOutput {
  const scenarioIds = [...(options.scenarioIds ?? SCENARIO_IDS)];
  const policyIds = [...(options.policyIds ?? SIM_POLICIES.map((p) => p.id))];
  const seeds = [...(options.seeds ?? SIM_SEEDS)];
  for (const id of scenarioIds) {
    if (!(SCENARIO_IDS as readonly string[]).includes(id)) throw new Error(`알 수 없는 시나리오: ${id}. 사용 가능: ${SCENARIO_IDS.join(', ')}`);
  }
  const policies = policyIds.map((id) => {
    const policy = policyById(id);
    if (!policy) throw new Error(`알 수 없는 정책: ${id}. 사용 가능: ${SIM_POLICIES.map((p) => p.id).join(', ')}`);
    return policy;
  });
  if (!scenarioIds.length || !policyIds.length || !seeds.length) throw new Error('시나리오·정책·시드 목록은 비어 있을 수 없습니다.');
  for (const seed of seeds) if (!Number.isSafeInteger(seed)) throw new Error(`시드는 안전한 정수여야 합니다: ${seed}`);
  for (const list of [scenarioIds, policyIds, seeds]) {
    if (new Set<string | number>(list).size !== list.length) throw new Error('시나리오·정책·시드 목록에 중복 값이 있습니다.');
  }
  const configs = scenarioIds.map((id) => loadScenario(id as (typeof SCENARIO_IDS)[number]));
  const runs: SimRun[] = [];
  for (const config of configs) for (const policy of policies) for (const seed of seeds) runs.push(simulate(config, policy, seed).run);
  return { meta: { tool: 'scitrade-sim', format: SIM_FORMAT, engineVersion: ENGINE_VERSION,
    dataVersion: configs[0]!.dataVersion, scenarioIds, policyIds, seeds }, runs };
}

export function serializeSimOutput(output: SimOutput): string { return JSON.stringify(output, null, 2) + '\n'; }
