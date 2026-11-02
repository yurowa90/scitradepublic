// 규칙 2 화면은 계획 상태의 읽기 함수가 돌려준 금액과 예측만 표시한다.
import { commitDay } from '../engine/engine';
import type { UiCommand } from './session';
import { cityName, goodOf } from '../engine/catalog';
import { marketTable } from '../engine/market-lazy';
import { MINOR_PER_MAJOR, formatMoney } from '../engine/money';
import { paymentDefaultStatus } from '../engine/operations';
import { payrollRunwayDay } from '../engine/previews';
import { upcomingPayments } from '../engine/reports';
import { exchangePreview, type OperationsQuotePreview } from '../engine/readers';
import { fmtM3 } from '../engine/reservations';
import type { Contract, ExchangeDirection, GameState, ScenarioConfig } from '../engine/types';
import { payrollRunwayKo } from './growth';
import { esc } from './html';
import { qtyKo } from './reports';

import { counterpartyNameKo } from './ops-labels';
export { counterpartyNameKo } from './ops-labels';

export function marketBlock(view: GameState, config: ScenarioConfig): string {
  return `<section class="market-table" aria-labelledby="market-h"><h3 id="market-h">시세표</h3><p class="muted small">지수는 돈이 아닙니다</p><div class="table-scroll" id="market-scroll" tabindex="0" role="region" aria-label="시세표 (가로로 넘겨 보기)"><table class="money"><thead><tr><th>도시 · 상품 · 매수/매도</th><th>기준가 (USD/단위)</th><th>지수</th><th>관측</th><th>다음 관측</th><th>견적</th></tr></thead><tbody>${marketTable(view, config).map((r) => `<tr><th>${esc(cityName(config, r.cityId))} · ${esc(goodOf(config, r.goodId).nameKo)} · ${r.side === 'BUY' ? '매수' : '매도'}</th><td>${formatMoney(r.currency, r.basePriceMinor)}/단위</td><td>${r.indexPoints}</td><td>${r.observedDay}일 · ${r.ageDays}일 전 관측</td><td>${view.phase === 'ENDED' ? '없음(캠페인 종료)' : r.nextObservationDay === null ? '새 관측 없음' : `${r.nextObservationDay}일`}</td><td>${r.hasQuoteInBatch ? '이번 묶음 견적 있음' : '—'}</td></tr>`).join('')}</tbody></table></div></section>`;
}

/** 계약 카드 제목과 같은 종류·번호·화물·항로 문구. */
export function contractTitleKo(c: Contract, config: ScenarioConfig): string {
  return `${c.kind === 'FORWARDING' ? '운송 주선' : '직접 무역'} ${c.id} · ${qtyKo(config, c.goodId, c.quantity)} ${cityName(config, c.originCityId)} → ${cityName(config, c.destinationCityId)}`;
}

export function quantityControl(key: string, q: OperationsQuotePreview, config: ScenarioConfig, goodId: string, minimum: number, reasonId?: string): string {
  const options: string[] = [];
  for (let n = minimum; n <= q.maxQuantity; n += q.quantityStep) {
    options.push(`<option value="${n}"${n === q.quantity ? ' selected' : ''}>${esc(qtyKo(config, goodId, n))}</option>`);
  }
  if (options.length === 1) return `<span class="quantity-value">수량 ${esc(qtyKo(config, goodId, minimum))}</span>`;
  return `<label>수량 고르기 <select data-action="offer-quantity" data-key="${esc(key)}"${reasonId ? ` aria-describedby="${esc(reasonId)}"` : ''}>${options.join('')}</select></label>`;
}

export function operationsQuoteFacts(q: OperationsQuotePreview, view: GameState, config: ScenarioConfig): string[] {
  const facts = [`준비 ${q.prepWorkUnits}pt`, `부피 ${fmtM3(q.volumeLiters)}`, `보관 후 사용량/한도 ${fmtM3(q.storageAfterLiters)} / ${fmtM3(q.storageCapacityLiters)}`];
  if (q.serviceClass === 'HANDLING') {
    facts[0] = `준비 ${q.prepWorkUnits}pt — 직원 시간이 많이 듭니다`;
    facts.push(`준비 1pt당 기여이익 ${formatMoney('USD', q.contributionPerPrepPtMinor)}`);
  }
  if (q.lateDeliveryReductionMinor > 0 && q.arrivalDay !== null) {
    const amount = formatMoney('USD', config.terms.lateDeliveryPriceReductionMinor);
    const reduction = formatMoney('USD', q.lateDeliveryReductionMinor);
    if (config.terms.lateDeliveryBasis === 'PER_LATE_DAY_CAPPED') {
      const days = q.arrivalDay + config.terms.customsDays - q.deliveryDeadlineDay;
      const cap = config.terms.lateDeliveryCapBasisPoints;
      const limit = cap === null ? '' : `, 최대 계약 금액의 ${cap / 100}%까지`;
      facts.push(`납기 ${days}일 늦으면 하루 ${amount}씩${limit} 감액됩니다 — 이 계획으로는 ${reduction}`);
    } else facts.push(`납기를 넘기면 한 번 ${amount} 감액됩니다 — 이 계획으로는 ${reduction}`);
  }
  for (const affected of q.affectedContracts.filter((c) => c.missesSailing)) {
    const contract = view.contracts.find((c) => c.id === affected.contractId)!;
    facts.push(`${contractTitleKo(contract, config)} — 이 견적을 받으면 출항을 놓칩니다`);
  }
  if (q.arrivalDay !== null && q.arrivalDay + config.terms.customsDays > config.campaignDays) {
    facts.push(`${config.campaignDays}일 캠페인 안에 인도되지 않습니다. 결산에 미인도로 남습니다.`);
  } else if (q.arrivalDay === null && q.allowed) facts.push('실을 출항편이 아직 정해지지 않았습니다');
  return facts;
}

/** 묶음 수만 UI에 보관한다. 자금이 줄어도 최소 한 묶음을 보여 거절 이유를 읽을 수 있게 한다. */
export function exchangeSelection(view: GameState, config: ScenarioConfig, direction: ExchangeDirection, selectedLots: number) {
  const lot = config.operations!.fx.lotUsdMinor;
  const one = exchangePreview(view, config, direction, lot);
  const availableLots = direction === 'USD_TO_KRW'
    ? Math.floor(one.usdAvailableBefore / lot) : Math.floor(one.krwAvailableBefore / one.krwMinor);
  const maxLots = Math.max(1, Math.min(50, availableLots));
  const lots = Number.isSafeInteger(selectedLots) ? Math.max(1, Math.min(maxLots, selectedLots)) : 1;
  return { lots, maxLots, usdMinor: lots * lot };
}

export const fxLotKo = (config: ScenarioConfig) => `${config.operations!.fx.lotUsdMinor / MINOR_PER_MAJOR.USD} USD`;

export function exchangeBlock(view: GameState, config: ScenarioConfig, direction: ExchangeDirection, selectedLots: number, selection?: ReturnType<typeof exchangeSelection>): string {
  const { lots, maxLots, usdMinor } = selection ?? exchangeSelection(view, config, direction, selectedLots);
  const options = Array.from({ length: maxLots }, (_, i) => {
    const n = i + 1;
    return `<option value="${n}"${n === lots ? ' selected' : ''}>${formatMoney('USD', n * config.operations!.fx.lotUsdMinor)} (${n}묶음)</option>`;
  }).join('');
  const q = exchangePreview(view, config, direction, usdMinor), fx = config.operations!.fx;
  const usd = (n: number) => formatMoney('USD', n), krw = (n: number) => formatMoney('KRW', n);
  const runway = (n: number | null) => payrollRunwayKo(n, view.day, config.campaignDays);
  const amountControl = maxLots === 1
    ? `<span class="exchange-amount-value">금액 ${usd(usdMinor)} (${lots}묶음)</span>`
    : `<label>금액 (${fxLotKo(config)} 단계) <select data-action="exchange-amount">${options}</select></label>`;
  const descriptions = [q.warningKo ? 'exchange-warning' : '', q.reasonKo ? 'exchange-reason' : ''].filter(Boolean).join(' ');
  const fees = direction === 'USD_TO_KRW' ? upcomingPayments(view, config, config.campaignDays).filter((p) => p.kind === 'SPACE_FEE' && p.day !== null) : [];
  const upcoming = fees.length ? `<p>앞으로 낼 선복 요금 ${usd(fees.reduce((sum, p) => sum + p.amountMinor, 0))}(${fees.length}편, 다음 ${Math.min(...fees.map((p) => p.day!))}일). 출항 ${config.operations!.spaceContract.reserveDaysAhead}일 전부터 쓸 수 있는 USD에서 묶입니다.</p>` : '';
  return `<section class="exchange" aria-labelledby="exchange-h"><h3 id="exchange-h" tabindex="-1">환전</h3><p>게임용 고정 환율 ${fx.buyKrwPerUsd.toLocaleString('ko-KR')}원(받을 때) · ${fx.sellKrwPerUsd.toLocaleString('ko-KR')}원(살 때)</p><label>방향 <select data-action="exchange-direction"><option value="USD_TO_KRW"${direction === 'USD_TO_KRW' ? ' selected' : ''}>USD→KRW</option><option value="KRW_TO_USD"${direction === 'KRW_TO_USD' ? ' selected' : ''}>KRW→USD</option></select></label> ${amountControl}<dl><dt>내는 금액</dt><dd>${direction === 'USD_TO_KRW' ? usd(usdMinor) : krw(q.krwMinor)}</dd><dt>받는 금액</dt><dd>${direction === 'USD_TO_KRW' ? krw(q.krwMinor) : usd(usdMinor)}</dd><dt>차감</dt><dd>${krw(q.spreadKrwMinor)}</dd><dt>쓸 수 있는 USD (전 → 후)</dt><dd>${usd(q.usdAvailableBefore)} → ${usd(q.usdAvailableAfter)}</dd><dt>원화 급여 가능일 (임차료 포함, 전 → 후)</dt><dd>${runway(q.runwayBefore)} → ${runway(q.runwayAfter)}</dd></dl><p>자동 환전은 없습니다</p>${upcoming}${q.warningKo ? `<p class="reason" id="exchange-warning">${esc(q.warningKo)}</p>` : ''}${q.reasonKo ? `<p class="reason" id="exchange-reason">${esc(q.reasonKo)}</p>` : ''}<button data-action="exchange"${descriptions ? ` aria-describedby="${descriptions}"` : ''}>환전을 오늘 할 일에 넣기</button></section>`;
}

export function paymentStatusKo(view: GameState, config: ScenarioConfig): string {
  if (view.phase === 'ENDED') {
    if (view.operations?.outcome === 'FAILED') return '경영 실패';
    return view.obligations.some((o) => o.paidDay === null) ? '종료 · 남은 미지급 있음(결산 참고)' : '종료 · 지급 정상';
  }
  const status = paymentDefaultStatus(view, config);
  if (status.level === 'NONE') return '지급 정상';
  if (status.level === 'FAILED') return '경영 실패';
  const stage = status.level === 'WARNING' ? '경고' : '위험';
  const remaining = Math.max(0, status.failAtCloseOfDay! - view.day);
  return `${stage} · 실패까지 ${remaining}일${status.failAtCloseOfDay! > config.campaignDays ? ` · ${config.campaignDays}일 캠페인이 끝날 때까지 갚지 못하면 미지급을 남기고 끝납니다` : ''}`;
}

export function operationsTopbar(view: GameState, config: ScenarioConfig, state = view, pending: UiCommand[] = []): string {
  const level = paymentDefaultStatus(state, config).level;
  let forecast = '';
  if (state.phase !== 'ENDED' && pending.length && (level === 'WARNING' || level === 'DANGER')) {
    try { forecast = `<small class="payment-forecast">하루 진행 뒤 예상: ${esc(paymentStatusKo(commitDay(state, config, pending).state, config))}</small>`; } catch { /* 실행 불가능한 계획은 예상 줄을 생략한다. */ }
  }
  return `<div class="stat" title="임차료 포함 · 대기 중인 명령 반영" aria-describedby="runway-description"><span>원화 급여 가능일</span><b>${state.phase === 'ENDED' ? '캠페인 종료' : payrollRunwayKo(payrollRunwayDay(view, config), view.day, config.campaignDays)}</b><small id="runway-description" class="visually-hidden">임차료 포함 · 대기 중인 명령 반영</small></div><div class="stat" title="확정 기준" aria-describedby="payment-description"><span>지급 상태</span><b>${esc(paymentStatusKo(state, config))}</b><small id="payment-description" class="visually-hidden">확정 기준</small>${forecast}</div>`;
}
