// 지급 경고와 실패 원인은 하루 진행으로 확정된 엔진 기록만 읽는다.
import { formatMoney } from '../engine/money';
import { paymentDefaultStatus } from '../engine/operations';
import type { CampaignSummary } from '../engine/reports';
import type { GameState, ScenarioConfig } from '../engine/types';
import { esc } from './html';

export function paymentAlert(state: GameState, config: ScenarioConfig): string {
  if (!config.operations || state.phase === 'ENDED') return '';
  const s = paymentDefaultStatus(state, config);
  if ((s.level !== 'WARNING' && s.level !== 'DANGER') || !s.oldest) return '';
  const o = s.oldest, r = s.recovery, lot = config.operations.fx.lotUsdMinor;
  const usd = (n: number) => formatMoney('USD', n);
  const deadline = s.failAtCloseOfDay! > config.campaignDays
    ? '캠페인이 끝날 때까지 못 갚으면 미지급을 남기고 끝납니다'
    : `${s.failAtCloseOfDay}일 마감까지 못 갚으면 경영 실패입니다`;
  const recovery = r.lotsToSurvive !== null && r.lotsToClearAll !== null
    ? `${r.lotsToClearAll > 0 ? `<li>밀린 원화를 모두 갚으려면 USD ${usd(r.lotsToClearAll * lot)}를 환전하세요(지금 쓸 수 있는 USD ${usd(r.usdAvailableLots * lot)})</li>` : ''}<li>${r.lotsToSurvive > 0 ? `오늘 마감에 실패하지 않으려면 최소 USD ${usd(r.lotsToSurvive * lot)}` : '오늘 마감에는 실패하지 않습니다'}</li>`
    : `<li>다음 수금: ${r.nextReceipt ? `${r.nextReceipt.day}일 ${usd(r.nextReceipt.amountMinor)}` : '없음'}</li><li>원화로 USD를 사려면 ${formatMoney('KRW', r.krwToUsdRequiredMinor!)}</li>`;
  return `<section class="payment-alert" aria-labelledby="payment-alert-h"><h3 id="payment-alert-h">지급 ${s.level === 'WARNING' ? '경고' : '위험'}</h3><p>${o.incurredDay}일 ${esc(o.reasonKo)} ${formatMoney(o.currency, o.amountMinor)}이 밀렸습니다</p><p>밀린 지 ${s.ageDays}일. ${s.dangerFromDay}일부터 위험, ${deadline}</p><ul>${recovery}${r.heldSpendingKo ? `<li>${esc(r.heldSpendingKo)}</li>` : ''}</ul><p class="muted small">실제로는 임금을 정한 날 지급해야 하며 하루 늦어도 체불입니다</p><button data-action="skip-to" data-target="exchange-h">환전 칸으로</button></section>`;
}

export function failureBlock(state: GameState, config: ScenarioConfig): string {
  if (!config.operations || state.operations?.outcome !== 'FAILED' || !state.operations.failure) return '';
  const f = state.operations.failure, lot = config.operations.fx.lotUsdMinor;
  const events = [f.warningEvent, f.dangerEvent].flatMap((event) => event ? [`<li>${event.day}일 ${event.level === 'WARNING' ? '경고' : '위험'}: ${event.lotsToClearAll === null ? 'USD 미지급' : `밀린 원화를 모두 갚는 데 USD ${formatMoney('USD', event.lotsToClearAll * lot)} 필요`}, 그때 쓸 수 있던 USD ${formatMoney('USD', event.usdAvailableMinor)}</li>`] : []);
  const optional = f.optionalKrwSpendBeforeFirstUnpaid.map((e) => `<li>${e.day}일 ${esc(e.reasonKo)} ${formatMoney('KRW', e.amountMinor)}</li>`);
  const commitments = f.usdCommitmentsSinceIncurred.map((c) => `<li>${c.day}일 ${c.kind === 'CONTRACT' ? '계약' : '선복 계약'} ${esc(c.id)} ${formatMoney('USD', c.amountMinor)}</li>`);
  const list = (items: string[]) => items.length ? `<ul>${items.join('')}</ul>` : '<p>없음</p>';
  return `<section class="failure" aria-labelledby="failure-h"><h3 id="failure-h" tabindex="-1">${f.day}일 경영 실패</h3><p>${f.incurredDay}일 ${esc(f.reasonKo)} ${formatMoney(f.currency, f.amountMinor)}를 ${config.operations.paymentDefault.failureAgeDays}일 동안 갚지 못했습니다</p><ul>${f.unpaidByCurrency.map((u) => `<li>미지급 ${u.currency}: ${formatMoney(u.currency, u.amountMinor)} · ${u.count}건</li>`).join('')}${f.cashByCurrency.map((c) => `<li>현금 ${c.currency}: ${formatMoney(c.currency, c.amountMinor)}</li>`).join('')}</ul>${events.length ? `<ul>${events.join('')}</ul>` : ''}<h4>첫 미지급 전 ${config.operations.paymentDefault.failureAgeDays}일 동안의 원화 선택 지출</h4>${list(optional)}<h4>미지급 뒤 새로 묶은 USD 약정</h4>${list(commitments)}<button data-action="restart">같은 시드로 다시 하기</button> <button data-action="skip-to" data-target="settlement-h">결산 보기</button></section>`;
}

export function operationsSettlement(sum: CampaignSummary): string {
  const o = sum.operations;
  if (!o) return '';
  const fixed = o.fixedCostsByCurrency.map((c) => {
    const rows: [string, number][] = [['임차료', c.rentExpense], ['확장 설치비', c.facilitySetupExpense], ['선복 요금', c.spaceContractExpense], ['환전 차감', c.fxSpreadExpense]];
    const used = rows.filter(([, value]) => value !== 0);
    return used.length ? `<table class="money fixed-costs"><caption>고정비 · ${c.currency}</caption>${used.map(([label, value]) => `<tr><th>${label}</th><td>${formatMoney(c.currency, value)}</td></tr>`).join('')}</table>` : `<p>${c.currency} 고정비 없음</p>`;
  }).join('');
  const exchanges = o.exchanges.length ? `<table class="money exchanges"><caption>환전 기록</caption><thead><tr><th>일</th><th>방향</th><th>USD</th><th>KRW</th><th>차감</th></tr></thead><tbody>${o.exchanges.map((e) => `<tr><td>${e.day}일</td><td>${e.direction === 'USD_TO_KRW' ? 'USD→KRW' : 'KRW→USD'}</td><td>${formatMoney('USD', e.usdMinor)}</td><td>${formatMoney('KRW', e.krwMinor)}</td><td>${formatMoney('KRW', e.spreadKrwMinor)}</td></tr>`).join('')}</tbody></table>` : '<p>환전 기록 없음</p>';
  return `<p>결과: ${o.outcome === 'FAILED' ? `경영 실패(${o.failure!.day}일)` : '완료'}</p><div class="books">${fixed}</div>${o.exchanges.length > 4 ? `<details><summary>환전 기록 (${o.exchanges.length}건)</summary>${exchanges}</details>` : exchanges}`;
}
