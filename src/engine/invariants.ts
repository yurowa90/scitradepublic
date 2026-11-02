import { carryAccrued, divHalfAway, receivedForInvoice } from './risk';
import { offerDef } from './market';
import { operationsProblems } from './operations-invariants';
// 매일 마감 전에 검사하는 불변 조건. 실패는 게임 규칙 위반이 아니라 엔진 결함이다.

import { cultureProblems } from './culture-invariants';
import { findSailing, routeOf } from './catalog';
import { completionReward } from './growth';
import { isEmployed } from './employees';
import { balance, contractAmount } from './ledger';
import { applyBasisPoints, type Currency } from './money';
import { sailingLoad } from './reservations';
import type { GameState, ScenarioConfig } from './types';

export class InvariantError extends Error {}

export function checkInvariants(s: GameState, config: ScenarioConfig, opts: { closing?: boolean } = {}): void {
  const problems = [...cultureProblems(s, config, opts.closing ?? false), ...operationsProblems(s, config, opts.closing ?? false)];
  if (new Set(s.tasks.map((task) => task.id)).size !== s.tasks.length) problems.push('업무 ID는 유일해야 합니다');
  if (new Set(s.employees.map((emp) => emp.id)).size !== s.employees.length) problems.push('직원 ID는 유일해야 합니다');
  if (new Set(s.contracts.map((c) => c.id)).size !== s.contracts.length) problems.push('계약 ID는 유일해야 합니다');
  if (new Set(s.ledger.entries.map((e) => e.id)).size !== s.ledger.entries.length) problems.push('장부 항목 ID는 유일해야 합니다');
  const entryIds = new Set(s.ledger.entries.map((e) => e.id));
  const postedIds = Object.keys(s.ledger.postedIds);
  if (postedIds.length !== entryIds.size || postedIds.some((id) => !entryIds.has(id))) {
    problems.push('ledger.postedIds와 실제 원장 항목 ID가 다릅니다');
  }
  const candidateIds = new Set(s.recruitment.candidates.map((c) => c.employeeId));
  if (candidateIds.size !== s.recruitment.candidates.length) problems.push('영입 후보 직원 ID는 유일해야 합니다');
  const taskIds = new Set(s.tasks.map((t) => t.id));
  const employeeIds = new Set(s.employees.map((emp) => emp.id));
  for (const task of s.tasks) {
    if (task.kind === 'RECRUIT_QUEST' && (task.subjectId === null || !candidateIds.has(task.subjectId))) {
      problems.push(`${task.id}: 영입 의뢰 대상 ${task.subjectId} 후보가 없습니다`);
    }
    if (task.assignedEmployeeId !== null && !employeeIds.has(task.assignedEmployeeId)) {
      problems.push(`${task.id}: 업무 담당자 ${task.assignedEmployeeId} 직원이 없습니다`);
    }
  }
  for (const contract of s.contracts) {
    // 외상 조건은 판본 4 직접 무역에만 저장한다. 수락 때의 노출액은 다시 판정하지 않는다.
    if (config.rules.rulesVersion !== 'M2a-rules-4') {
      if (Object.hasOwn(contract, 'creditTermId') || Object.hasOwn(contract, 'creditEligible')) {
        problems.push(`${contract.id}: 이 규칙에는 외상 조건 키가 없어야 합니다`);
      }
    } else if (contract.kind === 'DIRECT_TRADE') {
      const term = config.operations?.risk?.credit?.terms.find((t) => t.id === contract.creditTermId);
      const sell = offerDef(s, config, contract.sellOfferId!);
      if (!term || !contract.creditEligible) problems.push(`${contract.id}: 외상 조건과 선택 가능 기록이 필요합니다`);
      if (!sell) problems.push(`${contract.id}: 판매 견적 ${contract.sellOfferId}이 없습니다`);
      if (term && sell) {
        const due = config.terms.paymentDueDay ?? sell.paymentDueDay ?? config.campaignDays;
        if (contract.paymentDueDay !== due + term.days) problems.push(`${contract.id}: 외상 결제일이 조건과 다릅니다`);
        if (contract.saleAmountMinor !== divHalfAway(sell.unitPriceMinor * contract.quantity * (10000 + term.premiumBp), 10000)) {
          problems.push(`${contract.id}: 외상 판매액이 조건과 다릅니다`);
        }
      }
    }
    if (!taskIds.has(contract.prepTaskId)) problems.push(`${contract.id}: 준비 업무 ${contract.prepTaskId}가 없습니다`);
    if (contract.ownerEmployeeId !== null && !employeeIds.has(contract.ownerEmployeeId)) {
      problems.push(`${contract.id}: 계약 담당자 ${contract.ownerEmployeeId} 직원이 없습니다`);
    }
  }
  for (const candidate of s.recruitment.candidates) {
    if (candidate.questTaskId !== null && !taskIds.has(candidate.questTaskId)) {
      problems.push(`${candidate.employeeId}: 영입 의뢰 업무 ${candidate.questTaskId}가 없습니다`);
    }
    if (!employeeIds.has(candidate.employeeId)) problems.push(`영입 후보 ${candidate.employeeId} 직원이 없습니다`);
  }
  const currencies = new Set<Currency>(s.ledger.entries.map((e) => e.currency));
  const kindOf = (contractId: string) => s.contracts.find((c) => c.id === contractId)?.kind;

  for (const entry of s.ledger.entries) {
    const sum = entry.lines.reduce((acc, l) => acc + l.amount, 0);
    if (sum !== 0) problems.push(`분개 ${entry.id} 불균형 (${sum})`);
  }

  for (const c of currencies) {
    const cash = balance(s.ledger, c, 'CASH');
    if (cash < 0) problems.push(`${c} 현금이 음수입니다 (${cash})`);

    // 회사 재고 장부는 회사 소유 화물만 담는다. 고객 화물은 장부가액이 없다.
    const inventory = balance(s.ledger, c, 'INVENTORY');
    let lotTotal = s.cargoLots
      .filter((l) => l.owner === 'COMPANY' && l.currency === c && l.status !== 'DELIVERED')
      .reduce((acc, l) => acc + l.carryingAmountMinor, 0);
    for (const contract of s.contracts) {
      if (contract.kind === 'DIRECT_TRADE' && c === contract.currency
        && offerDef(s, config, contract.buyOfferId!)?.currency !== contract.currency) {
        const usdInventory = contractAmount(s.ledger, 'USD', contract.id, 'INVENTORY');
        if (contract.deliveredDay !== null ? usdInventory !== 0 : usdInventory < 0) {
          problems.push(`혼합 계약 ${contract.id}의 USD 재고 잔액(${usdInventory})이 맞지 않습니다`);
        }
        lotTotal += contractAmount(s.ledger, c, contract.id, 'INVENTORY');
      }
    }
    if (inventory !== lotTotal) problems.push(`${c} 재고 장부(${inventory})와 회사 화물 장부가액 합계(${lotTotal})가 다릅니다`);

    const prepaid = balance(s.ledger, c, 'PREPAID_FREIGHT');
    const bookedPrepaid = s.bookings
      .filter((b) => b.status === 'BOOKED' && routeOf(config, b.routeId).currency === c)
      .reduce((acc, b) => acc + b.prepaidFreightMinor, 0);
    if (prepaid !== bookedPrepaid) problems.push(`${c} 선급운임(${prepaid})과 출항 전 예약 합계(${bookedPrepaid})가 다릅니다`);

    // 주선 진행원가 = 출항했지만 아직 인도하지 않은 운송 주선 화물의 운임.
    const wip = balance(s.ledger, c, 'FORWARDING_WIP');
    const inFlight = s.bookings
      .filter((b) => b.status === 'DEPARTED' && routeOf(config, b.routeId).currency === c && kindOf(b.contractId) === 'FORWARDING')
      .filter((b) => s.contracts.find((x) => x.id === b.contractId)?.deliveredDay === null)
      .reduce((acc, b) => acc + b.prepaidFreightMinor, 0);
    if (wip !== inFlight) problems.push(`${c} 주선 진행원가(${wip})와 운송 중인 고객 화물 운임 합계(${inFlight})가 다릅니다`);

    const receivable = balance(s.ledger, c, 'ACCOUNTS_RECEIVABLE');
    const openInvoices = s.invoices
      .filter((i) => i.currency === c && i.status !== 'PAID' && i.status !== 'WRITTEN_OFF')
      .reduce((acc, i) => acc + i.amountMinor - receivedForInvoice(s, i.id), 0);
    if (receivable !== openInvoices) problems.push(`${c} 매출채권(${receivable})과 미수 청구서 합계(${openInvoices})가 다릅니다`);

    const payable = balance(s.ledger, c, 'ACCOUNTS_PAYABLE');
    const openObligations = s.obligations
      .filter((o) => o.currency === c && o.paidDay === null)
      .reduce((acc, o) => acc + o.amountMinor, 0);
    if (payable !== openObligations) problems.push(`${c} 미지급금(${payable})과 미지급 의무 합계(${openObligations})가 다릅니다`);
  }

  // 새 종결·비용 값은 판본 4에만 허용한다. 이전 저장에는 새 값을 섞지 않는다.
  if (config.rules.rulesVersion !== 'M2a-rules-4') {
    if (s.invoices.some((i) => i.status === 'WRITTEN_OFF') || s.ledger.entries.some((e) =>
      e.lines.some((l) => l.account === 'BAD_DEBT' || l.account === 'RECEIVABLE_CARRY'))) {
      problems.push('대손·지연 이자는 규칙 4에서만 쓸 수 있습니다');
    }
  }
  for (const inv of s.invoices) {
    const carries = s.ledger.entries.filter((e) => e.id.startsWith(`CARRY-${inv.id}-`));
    const carrySum = carries.flatMap((e) => e.lines).filter((l) => l.account === 'RECEIVABLE_CARRY')
      .reduce((sum, l) => sum + l.amount, 0);
    if (carries.length && carrySum !== divHalfAway(carryAccrued(s, config, inv.id, Math.max(...carries.map((e) => e.day))), 10000)) {
      problems.push(`${inv.id}: 지연 이자 합계가 마지막 분개일 누적 이자와 다릅니다`);
    }
    if (inv.status !== 'WRITTEN_OFF') continue;
    const confirmationDay = inv.dueDay + (config.operations?.risk?.profile.collections.lateMaxDays ?? 0);
    if (confirmationDay > config.campaignDays) problems.push(`${inv.id}: 확정일이 캠페인 끝을 넘는 청구서는 대손 종결할 수 없습니다`);
    const prefix = `RECEIPT-RCPT-${inv.id}`;
    const receipts = s.ledger.entries.filter((e) => e.id === prefix || e.id.startsWith(`${prefix}-`));
    const recoveries = receipts.filter((e) => e.id === `${prefix}-R`);
    const badDebts = s.ledger.entries.filter((e) => e.id === `BADDEBT-${inv.id}`);
    const sum = (entries: typeof receipts, account: 'CASH' | 'BAD_DEBT') => entries.flatMap((e) => e.lines)
      .filter((l) => l.account === account).reduce((n, l) => n + l.amount, 0);
    const remaining = inv.amountMinor - sum(receipts.filter((e) => e.id !== `${prefix}-R` && e.day < confirmationDay), 'CASH');
    const recovery = applyBasisPoints(remaining, config.operations?.risk?.credit?.recoveryBp ?? 0);
    if (recoveries.length !== (recovery > 0 ? 1 : 0) || badDebts.length !== 1
      || sum(recoveries, 'CASH') !== recovery || sum(recoveries, 'CASH') + sum(badDebts, 'BAD_DEBT') !== remaining) {
      problems.push(`${inv.id}: 대손 회수·손실 분개 수와 합계가 확정 직전 잔액과 다릅니다`);
    }
    if ([...recoveries, ...badDebts].some((e) => e.day !== confirmationDay)) {
      problems.push(`${inv.id}: 대손 회수·손실 분개일이 확정일과 다릅니다`);
    }
    if ([...receipts, ...carries].some((e) => e.day > confirmationDay)) {
      problems.push(`${inv.id}: 대손 확정 뒤 수금·이자 분개가 있습니다`);
    }
    const contract = s.contracts.find((c) => c.id === inv.contractId);
    if (contract?.status !== 'COMPLETED' || contract.completedDay !== confirmationDay) {
      problems.push(`${inv.id}: 대손 종결 계약의 상태·완료일이 다릅니다`);
    }
  }

  for (const lot of s.cargoLots) {
    if (!Number.isInteger(lot.quantity) || lot.quantity <= 0) problems.push(`${lot.id} 수량 오류 (${lot.quantity})`);
    if (lot.owner === 'CUSTOMER' && lot.carryingAmountMinor !== 0) problems.push(`${lot.id} 고객 화물에 회사 장부가액이 있습니다`);
  }
  const departed = new Set<string>();
  const sailings = new Set<string>();
  for (const b of s.bookings) {
    if (b.status !== 'CANCELLED') sailings.add(b.sailingId);
    if (b.status !== 'DEPARTED') continue;
    if (departed.has(b.contractId)) problems.push(`${b.contractId}이(가) 두 번 출항했습니다`);
    departed.add(b.contractId);
  }
  for (const id of sailings) {
    const sailing = findSailing(config, id);
    if (!sailing) {
      problems.push(`${id}: 운항표에 없는 출항편 예약`);
      continue;
    }
    const load = sailingLoad(s, config, sailing);
    if (load.massGrams > load.capacityGrams || load.volumeLiters > load.capacityLiters) {
      problems.push(`${id}: 예약 화물이 선복 한도를 넘었습니다`);
    }
  }
  for (const emp of s.employees) {
    const def = config.employees.find((e) => e.id === emp.id);
    if (!def) problems.push(`${emp.id}: 직원 정의가 없습니다`);
    const awarded = Object.entries(s.xpAwardAmounts)
      .filter(([key]) => key.split('|')[0] === emp.id)
      .reduce((sum, [, amount]) => sum + amount, 0);
    if (!Number.isSafeInteger(emp.xp) || emp.xp !== (def?.growth?.startXp ?? 0) + awarded) {
      problems.push(`${emp.id}: 경험치와 시작 경험치·지급 합계가 다릅니다`);
    }
    const running = s.tasks.filter((t) => t.status === 'RUNNING' && t.assignedEmployeeId === emp.id);
    if (running.length && (!isEmployed(s, emp.id) || emp.availableFromDay > s.day)) {
      problems.push(`${emp.id}: 근무 가능한 고용 직원이 아닌데 진행 중 업무가 있습니다`);
    }
    const wages = s.ledger.entries.filter((e) => /^WAGE-D\d+-/.test(e.id) && e.id.endsWith(`-${emp.id}`));
    if (!isEmployed(s, emp.id) && wages.length) problems.push(`${emp.id}: 미고용 직원의 급여 기록`);
    if (wages.some((e) => e.day < emp.availableFromDay)) problems.push(`${emp.id}: 근무 시작일 이전 급여 기록`);
    if (running.length > 1) {
      problems.push(`${emp.id}에게 진행 중 업무가 ${running.length}건입니다`);
    }
  }

  for (const key of new Set([...Object.keys(s.xpAwards), ...Object.keys(s.xpAwardAmounts)])) {
    const [employeeId, eventId, rewardKind, extra] = key.split('|');
    const amount = s.xpAwardAmounts[key];
    const emp = s.employees.find((e) => e.id === employeeId);
    const def = config.employees.find((e) => e.id === employeeId);
    if (s.xpAwards[key] !== true || !Number.isSafeInteger(amount) || amount! <= 0
      || !eventId || extra !== undefined || !['TASK_COMPLETION_XP', 'TRAINING_XP', 'CULTURE_FIRST_XP'].includes(rewardKind ?? '')
      || !config.growth || !def?.growth || emp?.employmentStatus !== 'employed') {
      problems.push(`${key}: 경험치 지급 기록 오류`);
    }
    if (eventId?.startsWith('TASK-DONE-')) {
      const task = s.tasks.find((t) => `TASK-DONE-${t.id}` === eventId);
      if (!task || task.status !== 'DONE' || task.assignedEmployeeId !== employeeId) {
        problems.push(`${key}: 미완료·ABORTED 업무에는 경험치 기록이 없어야 합니다`);
      } else if (rewardKind !== completionReward(task.kind, config)?.rewardKind) {
        problems.push(`${key}: 업무 종류와 경험치 보상 종류가 다릅니다`);
      }
    }
  }
  for (const task of s.tasks.filter((t) => t.kind === 'TRAINING')) {
    const fees = s.ledger.entries.filter((e) => e.id === `TRAINING-FEE-${task.id}`);
    if (fees.length !== 1) problems.push(`${task.id}: 훈련비 중복 또는 누락 기록 (정확히 하나 필요)`);
  }
  for (const fee of s.ledger.entries.filter((e) => e.lines.some((l) => l.account === 'TRAINING_EXPENSE'))) {
    if (!s.tasks.some((t) => t.kind === 'TRAINING' && fee.id === `TRAINING-FEE-${t.id}`)) {
      problems.push(`${fee.id}: 훈련 업무 없는 훈련비 기록`);
    }
  }

  for (const candidate of s.recruitment.candidates) {
    if (candidate.stage === 'HIRED' && !isEmployed(s, candidate.employeeId)) {
      problems.push(`${candidate.employeeId}: 고용 확정 후보의 고용 상태 불일치`);
    }
    const signings = s.ledger.entries.filter((e) => e.id === `SIGNING-${candidate.employeeId}`);
    if (signings.length > 1) problems.push(`${candidate.employeeId}: 계약금 중복 기록`);
  }

  if (problems.length > 0) {
    throw new InvariantError(`${s.day}일 마감 검사 실패:\n- ${problems.join('\n- ')}`);
  }
}
