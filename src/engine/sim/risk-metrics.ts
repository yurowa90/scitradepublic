import { loadRiskProfile, loadCreditProfile } from '../../content/scenario';
import { offerDef } from '../market';
import { contractRiskReport, preview } from '../reports';
import { krwToUsdMinor, referenceRate, usdToKrwMinor, withRiskLevelV2, defaultFor, receivedForInvoice } from '../risk';
import type { CreditTermId, GameState, ScenarioConfig } from '../types';
import type { SimMetrics } from './metrics';

export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3';
export type RiskLevelV2 = 'R0P' | 'R1' | 'R2' | 'R3' | 'R4';
export type RiskMeta = { rules?: never; level: RiskLevel; profileId: string; tuningRound: number; marketRulesSha256: string }
  | { rules: 'M2a-rules-4'; level: RiskLevelV2; profileId: string; tuningRound: number; marketRulesSha256: string };

export function simConfigV2(config: ScenarioConfig, level: RiskLevelV2, profileId: string): ScenarioConfig {
  return withRiskLevelV2(config, level, loadRiskProfile(profileId), loadCreditProfile(profileId));
}
export function rateAtV2(cfg: ScenarioConfig, seed: number, day: number): number {
  return referenceRate(cfg, seed, day);
}
export interface RiskContract {
  contractId: string;
  kind: GameState['contracts'][number]['kind'];
  sellOfferId: string | null;
  goodId: string;
  status: GameState['contracts'][number]['status'];
  class: '열린' | '완료' | '취소';
  onTime: boolean;
  realized: number;
  openFixedRateKrw: number;
  components: ReturnType<typeof contractRiskReport>['components'];
  evaluationDay: number;
  creditTermId?: CreditTermId;
  creditEligible?: GameState['contracts'][number]['creditEligible'];
  grade?: string;
  saleAmountMinor?: number;
  acceptedDay?: number;
  paymentDueDay?: number;
  saleKrwAtAcceptMinor?: number;
}
export interface RiskMetrics {
  analysisValueMinor?: number;
  contracts: RiskContract[];
  directAccepted: number;
  referenceRateBounds: boolean;
  credit?: ReturnType<typeof creditMetrics>;
}

/** 정책이 끝난 뒤에만 읽는다. 계약 손익은 엔진 보고서의 값을 그대로 옮긴다. */
export function riskMetrics(state: GameState, config: ScenarioConfig, metrics: SimMetrics, level: RiskLevel | RiskLevelV2): RiskMetrics {
  const cfg = { ...config, seed: state.rng.seed };
  const contracts = state.contracts.map((c): RiskContract => {
    const r = contractRiskReport(state, cfg, c.id);
    const purchaseCurrency = c.buyOfferId ? offerDef(state, cfg, c.buyOfferId)!.currency : c.currency;
    const p = preview(cfg, c.kind, c.originCityId, c.destinationCityId, c.acceptedDay,
      { purchase: c.purchaseAmountMinor, sale: c.saleAmountMinor }, c.deliveryDeadlineDay, c.paymentDueDay,
      { goodId: c.goodId, purchaseCurrency });
    const shipment = state.shipments.find((s) => s.contractId === c.id);
    if (!r.open && c.status !== 'COMPLETED' && c.status !== 'CANCELLED') throw new Error(`계약 분류 불가: ${c.id}`);
    return { contractId: c.id, kind: c.kind, sellOfferId: c.sellOfferId, goodId: c.goodId, status: c.status,
      class: r.open ? '열린' : c.status === 'COMPLETED' ? '완료' : '취소',
      onTime: p?.lateOnNextSailing === false && shipment?.arrivalDay != null
        && shipment.arrivalDay + cfg.terms.customsDays <= c.deliveryDeadlineDay,
      realized: r.realized, openFixedRateKrw: r.openFixedRateKrw, components: r.components, evaluationDay: r.evaluationDay,
      ...(cfg.rules.rulesVersion === 'M2a-rules-4' && c.kind === 'DIRECT_TRADE' ? {
        creditTermId: c.creditTermId!, creditEligible: c.creditEligible!,
        grade: cfg.operations!.risk!.profile.collections.byCounterparty.find((row) => row.counterpartyId === c.customerId)!.grade,
        saleAmountMinor: c.saleAmountMinor, acceptedDay: c.acceptedDay, paymentDueDay: c.paymentDueDay,
        saleKrwAtAcceptMinor: usdToKrwMinor(c.saleAmountMinor, rateAtV2(cfg, state.rng.seed, c.acceptedDay)),
      } : {}) };
  });
  const ops = cfg.operations!, fx = ops.risk?.profile.fx;
  let referenceRateBounds = false;
  if (fx) for (let day = ops.market.publish.firstDay; day <= ops.market.publish.lastDay; day += ops.market.publish.intervalDays) {
    const rate = referenceRate(cfg, state.rng.seed, day);
    if (rate === fx.minKrwPerUsd || rate === fx.maxKrwPerUsd) referenceRateBounds = true;
  }
  return { ...(level === 'R0' ? {} : { analysisValueMinor: metrics.currencies.USD!.netAssets
    + krwToUsdMinor(metrics.currencies.KRW!.netAssets, ops.fx.baseKrwPerUsd) }), contracts,
    directAccepted: contracts.filter((c) => c.kind === 'DIRECT_TRADE').length, referenceRateBounds,
    ...(cfg.rules.rulesVersion === 'M2a-rules-4' ? { credit: creditMetrics(state, cfg) } : {}) };
}

/** 수락 당시 날짜·한도와 실행이 끝난 뒤 수금 원장을 진단 재료로 모은다. */
function creditMetrics(state: GameState, config: ScenarioConfig) {
  const direct = state.contracts.filter((c) => c.kind === 'DIRECT_TRADE');
  const risk = config.operations!.risk!, credit = risk.credit!;
  const unconfirmed = state.invoices.filter((inv) => {
    const c = direct.find((c) => c.id === inv.contractId);
    return inv.status === 'OVERDUE' && c && defaultFor(config, state.rng.seed, c.sellOfferId!, c.customerId!, c.creditTermId!);
  });
  const amount = (account: 'BAD_DEBT' | 'RECEIVABLE_CARRY') => state.ledger.entries.flatMap((e) => e.lines)
    .filter((l) => l.account === account).reduce((sum, l) => sum + l.amount, 0);
  const termCounts = { BASE: 0, D15: 0, D30: 0 };
  let dateEligible = 0, dateLimitEligible = 0;
  for (const c of direct) {
    termCounts[c.creditTermId!]++;
    const offerDueDay = c.paymentDueDay - credit.terms.find((t) => t.id === c.creditTermId)!.days;
    const possible = credit.terms.filter((t) => t.id !== 'BASE'
      && offerDueDay + t.days + risk.profile.collections.lateMaxDays <= config.campaignDays);
    if (possible.length) dateEligible++;
    if (possible.some((t) => !c.creditEligible!.limitBlocked.includes(t.id as 'D15' | 'D30'))) dateLimitEligible++;
  }
  return {
    defaultsConfirmed: state.invoices.filter((inv) => inv.status === 'WRITTEN_OFF').length,
    badDebtMinor: amount('BAD_DEBT'), defaultsUnconfirmed: unconfirmed.length,
    unconfirmedMinor: unconfirmed.reduce((sum, inv) => sum + inv.amountMinor - receivedForInvoice(state, inv.id), 0),
    carryMinor: amount('RECEIVABLE_CARRY'), limitBlocked: direct.filter((c) => c.creditEligible!.limitBlocked.length > 0).length,
    termCounts,
    partialReceipts: state.invoices.filter((inv) => state.ledger.entries.some((e) => e.id === `RECEIPT-RCPT-${inv.id}-2`)).length,
    pendingPartialReceipts: state.invoices.filter((inv) =>
      state.ledger.entries.some((e) => e.id === `RECEIPT-RCPT-${inv.id}-1`)
      && !state.ledger.entries.some((e) => e.id === `RECEIPT-RCPT-${inv.id}-2`)).length,
    pendingOverdue: state.invoices.filter((inv) => inv.status === 'OVERDUE'
      && !state.ledger.entries.some((e) => e.id === `RECEIPT-RCPT-${inv.id}` || e.id.startsWith(`RECEIPT-RCPT-${inv.id}-`))).length,
    lateReceipts: state.invoices.filter((inv) => {
      const id = `RECEIPT-RCPT-${inv.id}`;
      const receipts = state.ledger.entries.filter((e) => e.id === id || e.id.startsWith(`${id}-`));
      return inv.status === 'PAID' && receipts.length === 1 && receipts[0]!.id === id && receipts[0]!.day > inv.dueDay;
    }).length,
    dateEligible, dateLimitEligible,
  };
}
