// 후보·직원·출항편의 원래 배열 순서를 보존한다. 식별자 이름은 선택 기준이 아니다.
import { decideOperations } from './operations-policy';
import { parseVariant } from './variants';
import { listSailings, routeBetween } from '../catalog';
import { isAvailableFromToday } from '../employees';
import { planCommands } from '../engine';
import { forwardingPreview, tradePairs, tradePreview, type QuotePreview } from '../reports';
import { drawUniform, type RngState } from '../rng';
import type { Command, EngineCommand, GameState, ScenarioConfig } from '../types';

const CANCEL_PROBABILITY = 0.05;
const ACCEPT_PROBABILITY = 0.5;

export interface ProjectionBooking { bookingId: string; contractId: string; readyDay: number; departureDay: number }
export interface PolicyDecision { commands: EngineCommand[]; rng: RngState; rejections?: Record<string, number>; projectionBookings?: ProjectionBooking[]; rejectionUnits?: import('./operations-policy').RejectionUnits }
export interface SimPolicy {
  id: string;
  labelKo: string;
  /** 입력 상태·설정·난수를 바꾸지 않는다. 엔진 난수와 정책 난수는 별개다. */
  decide(state: GameState, config: ScenarioConfig, rng: RngState): PolicyDecision;
}

type Acceptance = Extract<Command, { type: 'ACCEPT_TRADE' | 'ACCEPT_FORWARDING' }>;
interface Candidate { command: Acceptance; preview: QuotePreview }

function candidates(state: GameState, config: ScenarioConfig): Candidate[] {
  const open = new Set(state.offers.filter((o) => o.status === 'OPEN').map((o) => o.id));
  const valid = new Set(config.offers.filter((o) => open.has(o.id) && o.validUntilDay >= state.day).map((o) => o.id));
  const result: Candidate[] = [];
  for (const pair of tradePairs(config)) {
    if (!valid.has(pair.buyOfferId) || !valid.has(pair.sellOfferId)) continue;
    const preview = tradePreview(config, pair.buyOfferId, pair.sellOfferId, state.day);
    if (preview) result.push({ command: { id: '', type: 'ACCEPT_TRADE', ...pair }, preview });
  }
  if (config.rules.forwardingEnabled) {
    for (const offer of config.offers) {
      if (offer.kind !== 'forwarding' || !valid.has(offer.id)) continue;
      const preview = forwardingPreview(config, offer.id, state.day);
      if (preview) result.push({ command: { id: '', type: 'ACCEPT_FORWARDING', offerId: offer.id }, preview });
    }
  }
  return result;
}

function decide(id: string, state: GameState, config: ScenarioConfig, initialRng: RngState): PolicyDecision {
  if (config.operations) return decideOperations(id, parseVariant(id)!, state, config, initialRng);
  const commands: Command[] = [];
  let rng = initialRng;
  if (id === 'IDLE') return { commands, rng };
  const random = id === 'SEEDED_RANDOM';
  const draw = () => {
    const next = drawUniform(rng, 'sim.policy.SEEDED_RANDOM');
    rng = next.rng;
    return next.value;
  };
  const nextId = () => `SIM-${id}-D${String(state.day).padStart(3, '0')}-${String(commands.length + 1).padStart(2, '0')}`;
  const fits = (command: Command) => planCommands(state, config, [...commands, command]).at(-1)?.status === 'APPLIED';
  const addIfFits = (command: Command) => { if (fits(command)) commands.push(command); };
  const employees = state.employees.filter((e) => isAvailableFromToday(state, e.id));
  const sailings = (routeId: string) => listSailings(config, routeId, state.day + 1).slice(0, 3);
  // 결정적 정책은 첫 성공에서 멈춘다. 무작위 정책만 가능한 목록 전체를 만든다.
  const choose = (options: Command[]) => {
    if (random) {
      const feasible = options.filter(fits);
      if (feasible.length) commands.push(feasible[Math.floor(draw() * feasible.length)]!);
    } else {
      const first = options.find(fits);
      if (first) commands.push(first);
    }
  };

  for (const decision of state.delayDecisions) {
    if (decision.choice === null) addIfFits({ id: nextId(), type: 'RESPOND_TO_DELAY',
      noticeId: decision.noticeId, shipmentId: decision.shipmentId, choice: 'KEEP_SHIPMENT_BOOKING' });
  }
  const unshipped = state.contracts.filter((c) => (c.status === 'ACTIVE' || c.status === 'IN_PROGRESS')
    && !state.shipments.some((s) => s.contractId === c.id));
  if (random) {
    for (const contract of unshipped) {
      if (draw() < CANCEL_PROBABILITY) addIfFits({ id: nextId(), type: 'CANCEL_CONTRACT', contractId: contract.id });
    }
  }
  for (const task of state.tasks) {
    if (task.status !== 'QUEUED' || task.contractId === null) continue;
    choose(employees.map((e) => ({ id: nextId(), type: 'ASSIGN_TASK', taskId: task.id, employeeId: e.id })));
  }
  for (const contract of unshipped) {
    if (contract.bookingId !== null && !state.bookings.some((b) => b.id === contract.bookingId && b.status === 'CANCELLED')) continue;
    const route = routeBetween(config, contract.originCityId, contract.destinationCityId);
    if (route) choose(sailings(route.id).map((s) => ({ id: nextId(), type: 'BOOK_SAILING', contractId: contract.id, sailingId: s.id })));
  }

  let offers = candidates(state, config);
  if (!random) {
    offers = offers.filter((c) => c.preview.contributionBeforePayroll > 0
      && (id !== 'ASSET_LIGHT' || c.preview.kind === 'FORWARDING'));
    // 안정 정렬이므로 동점은 직접 무역 다음 운송 주선의 원래 순서다.
    offers.sort((a, b) => (id === 'ON_TIME_FIRST' ? a.preview.deliveryDeadlineDay - b.preview.deliveryDeadlineDay : 0)
      || b.preview.contributionBeforePayroll - a.preview.contributionBeforePayroll);
  }
  for (const candidate of offers) {
    if (random && draw() >= ACCEPT_PROBABILITY) continue;
    const plans: Command[] = [];
    for (const sailing of sailings(candidate.preview.routeId)) {
      if (id === 'ON_TIME_FIRST' && sailing.scheduledArrivalDay + config.terms.customsDays > candidate.preview.deliveryDeadlineDay) continue;
      for (const employee of employees) {
        if (!random) {
          const units = candidate.preview.kind === 'DIRECT_TRADE' ? config.terms.prepWorkUnits : config.terms.forwardingPrepWorkUnits;
          const speed = config.employees.find((e) => e.id === employee.id)!.workUnitsPerDay;
          if (speed <= 0 || state.day + Math.ceil(units / speed) - 1 > sailing.departureDay) continue;
        }
        const command: Command = { ...candidate.command, id: nextId(), plan: { employeeId: employee.id, sailingId: sailing.id } };
        if (fits(command)) {
          plans.push(command);
          if (!random) break;
        }
      }
      if (!random && plans.length) break;
    }
    if (plans.length) commands.push(plans[random ? Math.floor(draw() * plans.length) : 0]!);
  }
  return { commands, rng };
}

export const SIM_POLICIES: readonly SimPolicy[] = [
  ['IDLE', '아무것도 하지 않음'],
  ['MAX_CONTRIBUTION', '기여이익 우선'],
  ['ON_TIME_FIRST', '납기 우선'],
  ['ASSET_LIGHT', '자산 적게'],
  ['SEEDED_RANDOM', '무작위 탐색(시드)'],
].map(([id, labelKo]) => ({ id: id!, labelKo: labelKo!, decide: (state, config, rng) => decide(id!, state, config, rng) }));

export const EXTRA_POLICIES: readonly SimPolicy[] = [['NO_FX', '환전하지 않음'], ['LATE_OK', '늦은 인도도 수락']].map(([id, labelKo]) => ({ id: id!, labelKo: labelKo!,
  decide: (state, config, rng) => config.operations ? decide(id!, state, config, rng) : decide('MAX_CONTRIBUTION', state, config, rng) }));
export function policyById(id: string): SimPolicy | undefined {
  const existing = [...SIM_POLICIES, ...EXTRA_POLICIES].find((p) => p.id === id);
  if (existing) return existing;
  const variant = parseVariant(id);
  return variant ? { id, labelKo: id, decide: (state, config, rng) => config.operations
    ? decideOperations(id, variant, state, config, rng) : decide('MAX_CONTRIBUTION', state, config, rng) } : undefined;
}
