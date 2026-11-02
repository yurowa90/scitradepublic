import { isRiskRules, receivedForInvoice, referenceRate } from './risk';
import { offerDef } from './market';
// 저장 복원과 마감이 함께 쓰는 운영 규칙 검사. 경제 값은 수정하지 않는다.
import { storageUsedLiters, storageCapacityLiters, handlingCapacityPt, fixedCostsDue } from './operations';
import { summarize } from './ledger';
import { MINOR_PER_MAJOR } from './money';
import type { GameState, ScenarioConfig } from './types';

export function operationsProblems(s: GameState, config: ScenarioConfig, closing: boolean): string[] {
  const problems: string[] = [];
  if ((s.operations !== null) !== (config.operations !== null)) problems.push('설정과 상태의 operations 유무가 다릅니다');
  const o = s.operations, c = config.operations;
  if (!o || !c) return problems;
  const seen = new Set<string>();
  let previousDay = 0;
  for (const row of o.unaffordable ?? []) {
    const key = JSON.stringify([row.day, row.buyOfferId, row.sellOfferId]);
    if (row.day < previousDay || row.day > s.day || seen.has(key)) problems.push('놓친 견적의 날짜 순서·현재 날짜·짝 중복이 올바르지 않습니다');
    previousDay = row.day;
    seen.add(key);
  }
  for (const inv of s.invoices) {
    const received = receivedForInvoice(s, inv.id);
    if (received > inv.amountMinor) problems.push(`${inv.id}: 받은 금액(${received})이 청구액(${inv.amountMinor})을 넘습니다`);
    if (inv.status === 'PAID' && received !== inv.amountMinor) problems.push(`${inv.id}: 수금 완료인데 받은 금액(${received})이 청구액(${inv.amountMinor})과 다릅니다`);
  }
  for (const entry of s.ledger.entries.filter((e) => e.id.startsWith('CLAIM-'))) {
    const contract = s.contracts.find((v) => v.id === entry.contractId);
    if (!contract || contract.kind !== 'DIRECT_TRADE') problems.push(`${entry.id}: 클레임 분개는 직접 무역 계약에만 있어야 합니다`);
    const amount = entry.lines.filter((l) => l.account === 'SALES_ALLOWANCE').reduce((n, l) => n + l.amount, 0);
    if (contract && amount > contract.saleAmountMinor - contract.priceReductionMinor) {
      problems.push(`${entry.id}: 클레임(${amount})이 늦은 감액 뒤 판매액(${contract.saleAmountMinor - contract.priceReductionMinor})을 넘습니다`);
    }
  }
  if (storageUsedLiters(s, config) > storageCapacityLiters(s, config)) problems.push('보관량이 창고 보관 한도를 넘었습니다');
  const lastClosed = closing ? s.day : Math.max(0, ...s.closedDays);
  for (const row of o.handlingLog) {
    if (row.day > lastClosed || row.usedPt < 0 || row.usedPt > row.capacityPt || row.capacityPt !== handlingCapacityPt(s, config, row.day)) problems.push('창고 처리량이 하루 처리 한도를 넘었습니다');
    for (const a of row.waits) {
      const t = s.tasks.find((t) => t.id === a.taskId);
      const e = config.employees.find((e) => e.id === t?.assignedEmployeeId);
      if (!t || !e || a.wantPt > e.workUnitsPerDay || a.gotPt > a.wantPt || a.gotPt < 0) problems.push('업무별 창고 배분량이 직원 처리량을 넘었습니다');
    }
  }
  const visibleDay = o.outcome === 'FAILED' ? o.failure?.day ?? lastClosed : closing ? s.day + 1 : s.day;
  const publish = c.market.publish;
  const expectedCount = Math.max(0, Math.floor((Math.min(visibleDay, publish.lastDay) - publish.firstDay) / publish.intervalDays) + 1);
  if (o.batches.length !== expectedCount || o.batches.some((b, i) => b.k !== i || b.publishDay !== publish.firstDay + i * publish.intervalDays || b.publishDay > visibleDay)
    || o.offers.some((v) => v.publishDay > visibleDay || !o.batches.some((b) => b.k === v.batchK && b.publishDay === v.publishDay && b.offerIds.includes(v.id)))) problems.push('공개 묶음·견적에 미래 공개 또는 누락이 있습니다');
  for (const offer of [...config.offers, ...o.offers].filter((v) => v.kind !== 'forwarding')) {
    if (!(offer.quantityStep > 0 && offer.quantity >= offer.quantityStep && offer.quantity % offer.quantityStep === 0
      && offer.maxQuantity >= offer.quantity && offer.maxQuantity % offer.quantityStep === 0)) problems.push('견적의 수량·단위·최대 수량이 맞지 않습니다');
  }
  const allIds = [...config.offers, ...o.offers].map((v) => v.id);
  if (new Set(allIds).size !== allIds.length || new Set(s.offers.map((v) => v.id)).size !== s.offers.length) problems.push('생성 견적 ID는 유일해야 합니다');
  if (s.offers.length !== allIds.length || allIds.some((id) => !s.offers.some((v) => v.id === id))
    || o.batches.flatMap((b) => b.offerIds).some((id) => !allIds.includes(id))) problems.push('공개 묶음과 견적 정의·상태가 다릅니다');
  const counterpartyIds = new Set(c.market.counterparties.map((v) => v.id));
  const cityIds = new Set(config.cities.map((v) => v.id));
  const goodIds = new Set(config.goods.map((v) => v.id));
  const templateIds = new Set(c.market.forwarding.templates.map((v) => v.id));
  for (const offer of o.offers) {
    if (!counterpartyIds.has(offer.counterpartyId)) problems.push('생성 견적이 설정에 없는 거래처를 가리킵니다');
    if (!cityIds.has(offer.cityId)) problems.push('생성 견적이 설정에 없는 도시를 가리킵니다');
    if (offer.destinationCityId !== null && !cityIds.has(offer.destinationCityId)) problems.push('생성 견적이 설정에 없는 도착 도시를 가리킵니다');
    if (!goodIds.has(offer.goodId)) problems.push('생성 견적이 설정에 없는 품목을 가리킵니다');
    if (offer.templateId !== null && !templateIds.has(offer.templateId)) problems.push('생성 견적이 설정에 없는 견본을 가리킵니다');
  }
  for (const batch of o.batches) {
    for (const row of batch.rows) {
      if (!cityIds.has(row.cityId)) problems.push('공개 묶음 시세 행이 설정에 없는 도시를 가리킵니다');
      if (!goodIds.has(row.goodId)) problems.push('공개 묶음 시세 행이 설정에 없는 품목을 가리킵니다');
    }
    for (const row of batch.index) if (!goodIds.has(row.goodId)) problems.push('공개 묶음 지수가 설정에 없는 품목을 가리킵니다');
    for (const row of batch.counterpartyPct ?? []) if (!goodIds.has(row.goodId)) problems.push('공개 묶음 거래처 보정률이 설정에 없는 품목을 가리킵니다');
    for (const row of batch.maxLots ?? []) if (!goodIds.has(row.goodId)) problems.push('공개 묶음 최대 묶음 수가 설정에 없는 품목을 가리킵니다');
    for (const row of batch.destinations ?? []) {
      if (!cityIds.has(row.cityId)) problems.push('공개 묶음 목적지가 설정에 없는 도시를 가리킵니다');
      if (!goodIds.has(row.goodId)) problems.push('공개 묶음 목적지가 설정에 없는 품목을 가리킵니다');
    }
    for (const id of batch.templateIds) if (!templateIds.has(id)) problems.push('공개 묶음 견본 목록이 설정에 없는 견본을 가리킵니다');
  }
  for (const contract of s.contracts) {
    if (contract.kind !== 'DIRECT_TRADE') continue;
    const buy = offerDef(s, config, contract.buyOfferId!), sell = offerDef(s, config, contract.sellOfferId!);
    if (buy && sell && (buy.currency !== sell.currency || buy.currency !== contract.currency)
      && !(isRiskRules(config.rules.rulesVersion) && buy.currency === 'KRW' && sell.currency === 'USD' && contract.currency === 'USD')) {
      problems.push('혼합 통화 계약은 매입 KRW·판매 USD·계약 USD여야 합니다');
    }
  }
  for (const fx of o.exchanges) {
    const usd = s.ledger.entries.filter((e) => e.id === `${fx.id}-USD` && e.currency === 'USD');
    const krw = s.ledger.entries.filter((e) => e.id === `${fx.id}-KRW` && e.currency === 'KRW');
    const transfer = (entries: typeof usd) => entries.flatMap((e) => e.lines).filter((l) => l.account === 'CURRENCY_TRANSFER').reduce((sum, l) => sum + l.amount, 0);
    if (usd.length !== 1 || krw.length !== 1 || transfer(usd) * (isRiskRules(config.rules.rulesVersion) ? referenceRate(config, s.rng.seed, fx.day) : c.fx.baseKrwPerUsd) / MINOR_PER_MAJOR.USD !== -transfer(krw)) problems.push('환전 분개 짝 또는 통화 간 이체가 다릅니다');
  }
  for (const currency of new Set(s.ledger.entries.map((e) => e.currency))) {
    const b = summarize(s.ledger, currency);
    if (b.totalAssets - b.accountsPayable !== b.openingEquity + b.profit + b.currencyTransferNet) problems.push(`${currency} 통화별 순자산 항등식이 다릅니다`);
  }
  for (let day = 1; day <= lastClosed; day++) {
    for (const cost of fixedCostsDue(s, config, day)) {
      if (s.ledger.entries.filter((e) => e.id === cost.id && e.currency === cost.currency && e.day === day).length !== 1) problems.push(`${cost.id}: 고정비 분개 중복 또는 누락`);
    }
  }
  const failure = o.failure;
  const cause = failure && s.obligations.find((ob) => ob.id === failure.obligationId);
  const failed = s.phase === 'ENDED' && failure !== null && cause?.paidDay === null && cause.incurredDay + c.paymentDefault.failureAgeDays <= failure.day
    && failure.incurredDay === cause.incurredDay && failure.amountMinor === cause.amountMinor && failure.currency === cause.currency
    && failure.day === lastClosed;
  if ((o.outcome === 'FAILED') !== !!failed || (o.outcome !== 'FAILED' && failure !== null)
    || (o.outcome === 'IN_PROGRESS' && s.phase === 'ENDED')
    || (o.outcome === 'COMPLETED' && (s.phase !== 'ENDED' || !s.closedDays.includes(config.campaignDays)))) problems.push('캠페인 실패·완료 표시가 상태와 다릅니다');
  if (o.expansions.length > c.facility.expansion.maxCount || o.expansions.some((e) => e.effectiveDay !== e.orderedDay + c.facility.expansion.effectiveAfterDays)) problems.push('창고 확장 횟수 또는 효력일 오류');
  if (new Set(o.spaceContracts.map((v) => v.routeId)).size !== o.spaceContracts.length) problems.push('선복 계약은 노선당 한 건이어야 합니다');
  return problems;
}
