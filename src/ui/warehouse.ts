// 본사 운영 값은 엔진 읽기 함수와 실제 명령 계획에서 읽는다.
import { findSailing } from '../engine/catalog';
import { planState } from '../engine/engine';
import { formatMoney } from '../engine/money';
import { handlingCapacityPt, storageCapacityLiters } from '../engine/operations';
import { warehouseSummary, weeklyBottleneck } from '../engine/readers';
import type { GameState, ScenarioConfig } from '../engine/types';
import { esc } from './html';
import type { UiCommand } from './session';

const m3 = (liters: number) => `${liters / 1000} m³`;
import { constraintLabel, routeLabel } from './ops-labels';
export { constraintLabel, routeLabel } from './ops-labels';
function pendingExpansion(state: GameState, view: GameState) {
  return !state.operations?.expansions.length ? view.operations?.expansions[0] : undefined;
}

export function weeklyBottleneckTable(state: GameState, view: GameState, config: ScenarioConfig): string {
  if (!config.operations) return '';
  const q = weeklyBottleneck(view, config), d = q.storageDetail, expansion = pendingExpansion(state, view);
  const storage = d.windowDays > 0
    ? `지난 ${d.windowDays}일 다른 화물이 창고를 가장 많이 쓴 날 ${m3(d.otherPeakLiters)}(평균 ${m3(d.otherOccupancyLiters)}), 작업 화물은 평균 ${d.handlingDwellDays}일 머묾. 가장 많이 쓴 날 기준으로 계산합니다`
    : `아직 쌓인 기록이 없어 기본값(머묾 ${d.handlingDwellDays}일)으로 계산했습니다`;
  return `<table class="weekly-bottleneck"><caption>다음 주에 받을 수 있는 작업 포함 주선(건/주) — 추정</caption><thead><tr><th scope="col">제약</th><th scope="col">지금</th></tr></thead><tbody>${q.rows.map((r) => {
    const basis = [r.constraint === 'STAFF' ? `다른 일에 주당 ${q.otherPtPerWeek}pt` : '', r.constraint === 'STORAGE' ? storage : '',
      expansion && (r.constraint === 'STORAGE' || r.constraint === 'WAREHOUSE_HANDLING') ? `${expansion.effectiveDay}일 확장 뒤 한도는 아직 넣지 않았습니다` : ''].filter(Boolean).join('. ');
    return `<tr data-constraint="${r.constraint}"><th scope="row">${constraintLabel(r.constraint)}${basis ? `<small>${esc(basis)}</small>` : ''}</th><td>${r.before === null ? '아직 묶음 없음' : r.before}${q.binding.before.includes(r.constraint) ? ' <span>← 가장 좁음</span>' : ''}</td></tr>`;
  }).join('')}</tbody></table><p class="muted small">이 표는 지난 기록의 평균·최고를 다음 주에 그대로 놓은 추정입니다. 도착이 몰리면 실제로는 더 적게 처리합니다.</p>`;
}

export function investmentBlock(state: GameState, view: GameState, config: ScenarioConfig, pending: UiCommand[], open?: boolean): string {
  const o = config.operations;
  if (!o) return '';
  const expansion = view.operations?.expansions[0], effectiveDay = state.day + o.facility.expansion.effectiveAfterDays;
  // 확정 상태에 기존 대기열과 후보를 한 번씩만 적용한다.
  const preview = (cmd: UiCommand) => planState(state, config, [...pending, cmd]);
  let warehouse: string;
  if (expansion) warehouse = `<p>${expansion.effectiveDay}일부터 창고 확장${expansion.effectiveDay > view.day ? ' 예정' : ' 적용됨'}</p>`;
  else {
    const plan = preview({ id: 'UI-PREVIEW-EXPAND', type: 'EXPAND_WAREHOUSE' });
    const result = plan.results.at(-1)!;
    warehouse = `<p>설치비 ${formatMoney('KRW', o.facility.expansion.setupFeeMinor)} · 효력일 ${effectiveDay}일</p><dl><dt>보관 한도 (전 → 후)</dt><dd>${m3(storageCapacityLiters(view, config, effectiveDay))} → ${m3(storageCapacityLiters(plan.state, config, effectiveDay))}</dd><dt>처리 한도 (전 → 후)</dt><dd>${handlingCapacityPt(view, config, effectiveDay)}pt → ${handlingCapacityPt(plan.state, config, effectiveDay)}pt</dd><dt>임차료 증액</dt><dd>${formatMoney('KRW', o.facility.expansion.rentIncreaseMinor)} · ${o.fixedCosts.rent.periodDays}일마다</dd></dl>${result.status === 'APPLIED' ? '' : `<p class="reason">${esc(result.reasonKo)}</p>`}<button data-action="expand-warehouse">창고 확장을 오늘 할 일에 넣기</button>`;
  }
  const space = o.spaceContract.routeIds.map((routeId) => {
    const existing = view.operations?.spaceContracts.find((c) => c.routeId === routeId);
    const plan = existing ? null : preview({ id: `UI-PREVIEW-SPACE-${routeId}`, type: 'SIGN_SPACE_CONTRACT', routeId });
    const contract = existing ?? plan?.state.operations?.spaceContracts.find((c) => c.routeId === routeId);
    const result = plan?.results.at(-1);
    const period = contract ? `${contract.firstSailingDay}일 편부터 ${contract.lastSailingDay}일 편까지 ${contract.sailingCount}편` : '';
    return `<div class="space-contract"><h5>${esc(routeLabel(config, routeId))}</h5><p>편당 ${formatMoney('USD', o.spaceContract.feeMinor)} · 편마다 +${m3(o.spaceContract.extraLiters)}·+${o.spaceContract.extraGrams / 1000} kg · 쓰지 않아도 냄, 해지 없음</p>${existing ? `<p>${period} 계약됨</p>` : `${period ? `<p>계약 예정: ${period}</p>` : ''}${result?.status !== 'APPLIED' ? `<p class="reason">${esc(result?.reasonKo ?? '')}</p>` : ''}<button data-action="sign-space-contract" data-route="${esc(routeId)}">선복 계약을 오늘 할 일에 넣기</button>`}</div>`;
  }).join('');
  const waiting = pending.filter((c) => c.type === 'EXPAND_WAREHOUSE' || c.type === 'SIGN_SPACE_CONTRACT').length;
  const signed = view.operations!.spaceContracts.length;
  const summary = [expansion ? `창고 확장${expansion.effectiveDay > view.day ? ` 예정 ${expansion.effectiveDay}일` : ' 적용됨'}` : '창고 확장', signed ? `선복 계약 ${signed}노선` : '선복 계약'].join('·');
  const expanded = open ?? (waiting > 0 || !!expansion || signed > 0);
  return `<details class="investments" id="investment-details"${expanded ? ' open' : ''}><summary id="investment-h">투자 — ${summary}${waiting ? `(대기 ${waiting}건)` : ''}</summary><div class="investment"><h5>창고 확장</h5>${warehouse}</div><div class="investment"><h5>선복 장기 계약</h5>${space}</div></details>`;
}

export function warehouseBlock(state: GameState, view: GameState, config: ScenarioConfig, pending: UiCommand[], open?: boolean): string {
  if (!config.operations) return '';
  const q = warehouseSummary(view, config), expansion = pendingExpansion(state, view);
  const rows: [string, string][] = [
    ['수요', `최근 묶음 ${q.demand.batchPublishDay === null ? '공개 없음' : `${q.demand.batchPublishDay}일 공개`} · 열린 견적 준비 ${q.demand.openPrepPt}pt·부피 ${m3(q.demand.openVolumeLiters)} · 최근 4묶음 견적 pt / 받은 pt: ${q.demand.recent.map((b) => `${b.publishDay}일 ${b.offeredPrepPt}pt / ${b.acceptedPrepPt}pt`).join(' · ') || '아직 묶음 없음'}`],
    ['직원', `본사 하루 처리 ${q.staff.workUnitsPerDay}pt · 오늘 남는 ${q.staff.idleWorkUnitsToday}pt`],
    ['창고 처리', `오늘 한도 ${q.handling.capacityPtToday}pt · 계획 사용 ${q.handling.plannedUsePtToday}pt · 대기 업무 ${q.handling.waitTaskCount}건·대기 ${q.handling.waitPt}pt`],
    ['보관', `사용 ${m3(q.storage.usedLiters)} / 한도 ${m3(q.storage.capacityLiters)} · 미배정 회사 화물 ${m3(q.storage.heldUnallocatedLiters)}`],
    ['선복', q.sailings.map((s) => { const sailing = findSailing(config, s.sailingId)!; return `${routeLabel(config, sailing.routeId)} ${sailing.departureDay}일 편: 사용 ${m3(s.usedLiters)} / 한도 ${m3(s.capacityLiters)} · ${s.usedGrams / 1000} / ${s.capacityGrams / 1000} kg`; }).join(' · ') || '다음 출항편 없음'],
  ];
  const changed = state.operations?.expansions[0]?.effectiveDay === state.day
    ? `<p>한도가 ${storageCapacityLiters(state, config, state.day - 1) / 1000} → ${m3(storageCapacityLiters(state, config, state.day))}로 늘어 사용률이 내려갔습니다</p>` : '';
  const planned = expansion ? `<p>${expansion.effectiveDay}일부터 창고 한도가 ${m3(storageCapacityLiters(view, config, expansion.effectiveDay))}·처리 ${handlingCapacityPt(view, config, expansion.effectiveDay)}pt로 늘어납니다(확장 예정)</p>` : '';
  return `<section class="warehouse" aria-labelledby="warehouse-h"><h4 id="warehouse-h">본사·창고</h4><table class="warehouse-summary"><tbody>${rows.map(([name, value]) => `<tr><th scope="row">${name}</th><td>${esc(value)}</td></tr>`).join('')}</tbody></table>${changed}${planned}${weeklyBottleneckTable(state, view, config)}${investmentBlock(state, view, config, pending, open)}</section>`;
}
