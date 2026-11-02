import { receivedForInvoice } from './risk';
import { compareText } from './reports';
import type { GameState, ScenarioConfig } from './types';
export function receivableSchedule(s: GameState, _config: ScenarioConfig) {
  return s.invoices.filter((i) => i.status !== 'PAID' && i.status !== 'WRITTEN_OFF').map((i) => ({
    invoiceId: i.id, contractId: i.contractId, currency: i.currency, dueDay: i.dueDay,
    outstandingMinor: i.amountMinor - receivedForInvoice(s, i.id), overdueDays: Math.max(0, s.day - i.dueDay),
  })).sort((a, b) => a.dueDay - b.dueDay || compareText(a.invoiceId, b.invoiceId));
}
