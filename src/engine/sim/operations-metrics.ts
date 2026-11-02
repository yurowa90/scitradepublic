import { summarize } from '../ledger';
import { offerDef, prepWorkUnitsFor } from '../market';
import { storageCapacityLiters, storageUsedLiters, unpaidByCurrency } from '../operations';
import { weeklyBottleneck, type WeeklyBottleneck } from '../readers';
import { contractReport } from '../reports';
import type { GameState, ScenarioConfig } from '../types';
import { candidateFor, parseVariant } from './variants';
import type { ProjectionBooking } from './policies';
import { rejectionCounts, rejectionUnits, type RejectionUnits } from './operations-policy';

export function createOperationsCollector(config: ScenarioConfig, policyId: string) {
  const variant = parseVariant(policyId)!;
  const daily: { day: number; handlingUsedPt: number; handlingCapacityPt: number; storageUsedLiters: number; storageCapacityLiters: number; waitingTaskDays: number; waitingPt: number }[] = [];
  const bottlenecks: { day: number; pt: number; extraJobsPerWeek: number; usableAfter: number; otherPtPerWeek: number; storageDetail: WeeklyBottleneck['storageDetail'] }[] = [];
  const rejections = rejectionCounts();
  const rejectionsV2 = config.rules.rulesVersion === 'M2a-rules-4' ? rejectionUnits() : undefined;
  let departing = new Set<string>();
  const promised = new Map<string, ProjectionBooking>(), missed = new Set<string>();
  return {
    observeOpened(s: GameState) {
      departing = new Set(s.bookings.filter((b) => b.status === 'BOOKED' && b.departureDay === s.day).map((b) => b.id));
      if (!variant.hires.length && [8, 22, 29, 30, 31, 36, 50].includes(s.day)) for (const pt of [2, 3]) {
        const c = candidateFor(config, pt);
        if (c) { const b = weeklyBottleneck(s, config, c.id); bottlenecks.push({ day: s.day, pt, extraJobsPerWeek: b.extraJobsPerWeek, usableAfter: b.usableAfter, otherPtPerWeek: b.otherPtPerWeek, storageDetail: b.storageDetail }); }
      }
    },
    observeClosed(s: GameState, day: number, rejected: Record<string, number> = {}, projections: ProjectionBooking[] = [], units?: RejectionUnits) {
      if (rejectionsV2 && units) {
        for (const reason of Object.keys(rejectionsV2.candidate) as (keyof RejectionUnits['candidate'])[]) rejectionsV2.candidate[reason] += units.candidate[reason];
        rejectionsV2.pair += units.pair; rejectionsV2.quote += units.quote; rejectionsV2.skippedNotOpen += units.skippedNotOpen;
      }
      for (const p of projections) {
        promised.set(p.bookingId, p);
        if (p.departureDay === day) departing.add(p.bookingId);
      }
      for (const p of promised.values()) if (p.departureDay === day) {
        const b = s.bookings.find((b) => b.id === p.bookingId);
        if (departing.has(p.bookingId) && b?.status === 'CANCELLED' && s.tasks.some((t) => t.contractId === p.contractId
          && (t.status === 'QUEUED' || t.status === 'RUNNING'))) missed.add(p.contractId);
        promised.delete(p.bookingId);
      }
      const h = s.operations!.handlingLog.find((h) => h.day === day)!;
      daily.push({ day, handlingUsedPt: h.usedPt, handlingCapacityPt: h.capacityPt, storageUsedLiters: storageUsedLiters(s, config),
        storageCapacityLiters: storageCapacityLiters(s, config, day), waitingTaskDays: h.waits.length,
        waitingPt: h.waits.reduce((sum, w) => sum + w.wantPt - w.gotPt, 0) });
      for (const key of Object.keys(rejections) as (keyof typeof rejections)[]) rejections[key] += rejected[key] ?? 0;
    },
    finish(s: GameState) {
      const currencies = [...new Set([config.tradeCurrency, config.payrollCurrency])];
      const books = Object.fromEntries(currencies.map((currency) => {
        const b = summarize(s.ledger, currency);
        const business = { directTrade: 0, handlingForwarding: 0, standardForwarding: 0 };
        for (const c of s.contracts.filter((c) => c.currency === currency)) {
          const key = c.kind === 'DIRECT_TRADE' ? 'directTrade' : offerDef(s, config, c.serviceOfferId!)?.serviceClass === 'HANDLING' ? 'handlingForwarding' : 'standardForwarding';
          business[key] += contractReport(s, c).contribution;
        }
        return [currency, { currencyTransferNet: b.currencyTransferNet, rent: b.rentExpense, setup: b.facilitySetupExpense, space: b.spaceContractExpense, business }];
      }));
      const exchanges = Object.fromEntries((['USD_TO_KRW', 'KRW_TO_USD'] as const).map((direction) => [direction,
        s.operations!.exchanges.filter((x) => x.direction === direction).reduce((a, x) => ({ usdMinor: a.usdMinor + x.usdMinor, krwMinor: a.krwMinor + x.krwMinor, spreadKrwMinor: a.spreadKrwMinor + x.spreadKrwMinor }), { usdMinor: 0, krwMinor: 0, spreadKrwMinor: 0 })]));
      const f = s.operations!.failure;
      const forwardingPrep = [...config.offers, ...s.operations!.offers].filter((o) => o.kind === 'forwarding').map((o) => prepWorkUnitsFor(config, o, o.quantity));
      return { handlingJobs: s.contracts.filter((c) => c.kind === 'FORWARDING' && c.cancelledDay === null
        && offerDef(s, config, c.serviceOfferId!)?.serviceClass === 'HANDLING').length, projectionMisses: missed.size, outcome: s.operations!.outcome, failureDay: f?.day ?? null,
        failureObligation: f ? { currency: f.currency, amountMinor: f.amountMinor, incurredDay: f.incurredDay } : null,
        firstUnpaidDay: s.obligations.length ? Math.min(...s.obligations.map((o) => o.incurredDay)) : null,
        unpaidAtEnd: unpaidByCurrency(s, config).map(({ currency, amountMinor }) => ({ currency, amountMinor })), exchanges, currencies: books,
        warehouseWaitingTaskDays: daily.reduce((sum, d) => sum + d.waitingTaskDays, 0), warehouseWaitingPt: daily.reduce((sum, d) => sum + d.waitingPt, 0),
        utilization: daily, rejections, bottlenecks, ...(rejectionsV2 ? { rejectionsV2 } : {}),
        actualHires: variant.hires.map((h) => ({ pt: h.pt, plannedDay: h.day, actualDay: s.recruitment.candidates.find((c) => c.employeeId === candidateFor(config, h.pt)?.id)?.hiredDay ?? null })),
        maxBatchOffers: Math.max(0, ...s.operations!.batches.map((b) => b.offerIds.length)),
        forwardingPrepMin: Math.min(...forwardingPrep), forwardingPrepMax: Math.max(...forwardingPrep) };
    },
  };
}
export type OperationsMetrics = ReturnType<ReturnType<typeof createOperationsCollector>['finish']> & { staffUtilizationBasisPoints: number };
