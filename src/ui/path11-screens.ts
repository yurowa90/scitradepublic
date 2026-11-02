// 경로 11 화면은 공개된 읽기 값만 표시한다. 회사 상태는 엔진이 소유한다.
import { cityName } from '../engine/engine';
import { goodOf } from '../engine/catalog';
import { offerDef } from '../engine/market';
import { formatMoney } from '../engine/money';
import { creditTermOptions } from '../engine/readers-lazy';
import { cashLockSummary, creditLockPreview, receivablesByTerm, settlementKrw } from '../engine/path11-readers';
import type { Account } from '../engine/ledger';
import type { CreditTermId, GameState, ScenarioConfig } from '../engine/types';
import { esc } from './html';
import type { UiCommand } from './session';
import './path11.css';
import { SETTLEMENT_LINE_KO } from './path11-labels';

type Ui = ReturnType<typeof import('./session').initialUiState>;
type Statement = NonNullable<ReturnType<typeof settlementKrw>>;
const active = (config: ScenarioConfig) => config.rules.rulesVersion === 'M2a-rules-4';
const money = (minor: number) => esc(formatMoney('KRW', minor));
const termName = (config: ScenarioConfig, id: CreditTermId) => id === 'BASE' ? '대금일에 받기'
  : `${config.operations!.risk!.credit!.terms.find((t) => t.id === id)!.days}일 외상`;
const details = (ui: Ui, key: string, title: string, body: string) => `<details data-p11-key="${esc(key)}"${ui.path11Open.includes(key) ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
const table = (caption: string, headers: string[], rows: string) => `<table class="money"><caption>${caption}</caption><thead><tr>${headers.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
const cells = (values: string[]) => `<tr>${values.map((v, i) => i === 0 ? `<th scope="row">${v}</th>` : `<td>${v}</td>`).join('')}</tr>`;

export function path11Term(config: ScenarioConfig, ui: Ui, key: string): { creditTermId?: CreditTermId } {
  return active(config) ? { creditTermId: ui.creditTerms[key] ?? 'BASE' } : {};
}
export function path11CommandLabel(config: ScenarioConfig, command: UiCommand): string {
  return active(config) && command.type === 'ACCEPT_TRADE' && command.creditTermId && command.creditTermId !== 'BASE'
    ? ` · ${termName(config, command.creditTermId)}` : '';
}
export function path11Prepare(s: GameState, config: ScenarioConfig, ui: Ui) {
  if (!active(config)) return;
  if (ui.creditTermsDay !== s.day) {
    ui.creditTerms = {}; ui.path11Open = []; ui.creditTermsDay = s.day;
  }
  for (const key of Object.keys(ui.creditTerms)) {
    if (key.split('+').some((id) => s.offers.find((o) => o.id === id)?.status !== 'OPEN')) delete ui.creditTerms[key];
  }
  const days = [30, 60].filter((d) => d <= s.day - 1);
  if (ui.path11AsOfDay !== null && !days.includes(ui.path11AsOfDay)) ui.path11AsOfDay = null;
}
function selectedPreview(s: GameState, config: ScenarioConfig, ui: Ui, key: string, quantity?: number) {
  const [buy, sell] = key.split('+');
  return creditLockPreview(s, config, buy!, sell!, quantity).find((r) => r.termId === (ui.creditTerms[key] ?? 'BASE'))!;
}
function summary(row: ReturnType<typeof creditLockPreview>[number]) {
  return `${row.paymentDueDay}일에 받음 · ${row.lockDays}일 묶임 · 그동안 견적 공개 ${row.publishesInWindow}번`;
}
export function path11Credit(s: GameState, config: ScenarioConfig, ui: Ui, key: string, quantity: number): string {
  if (!active(config)) return '';
  const [buy, sell] = key.split('+');
  const options = creditTermOptions(s, config, buy!, sell!, quantity);
  const previews = creditLockPreview(s, config, buy!, sell!, quantity);
  const chosen = ui.creditTerms[key] ?? 'BASE';
  const row = previews.find((r) => r.termId === chosen)!;
  const option = options.find((r) => r.termId === chosen)!;
  const cash = cashLockSummary(s, config)!;
  const sale = (value: number) => esc(formatMoney(config.tradeCurrency, value));
  const publish = config.operations!.market.publish, days: number[] = [];
  for (let d = publish.firstDay; d <= Math.min(publish.lastDay, row.paymentDueDay); d += publish.intervalDays) if (d > s.day) days.push(d);
  const compareRow = (label: string, value: (r: typeof row, i: number) => string) => cells([label, ...previews.map(value)]);
  const comparison = table('조건별 비교', ['항목', ...options.map((o) => `${termName(config, o.termId)}${o.termId === chosen ? ' (고름)' : ''}`)],
    compareRow('판매대금', (_r, i) => sale(options[i]!.saleAmountMinor))
    + compareRow('대금 받는 날', (r) => `${r.paymentDueDay}일`)
    + compareRow('묶이는 돈', (r) => `${money(r.cashOutKrwMinor)}<small>${r.cashOut.map((m) => esc(formatMoney(m.currency, m.amountMinor))).join(' · ')}</small>`)
    + compareRow('묶이는 기간', (r) => `${r.lockDays}일`)
    + compareRow('그 사이 견적 공개', (r) => `${r.publishesInWindow}번`)
    + compareRow('외상 한도 사용', (r) => r.termId === 'BASE' ? '—' : `${sale(r.exposureAfterMinor)} / ${sale(r.limitMinor)}`));
  return `<div class="p11"><fieldset><legend>대금 받는 조건</legend><div class="p11-terms">${options.map((o) => {
    const term = config.operations!.risk!.credit!.terms.find((t) => t.id === o.termId)!;
    const id = `p11-${key}-${o.termId}`;
    return `<label><input type="radio" name="p11-${esc(key)}" data-action="credit-term" data-key="${esc(key)}" data-term="${o.termId}" value="${o.termId}"${chosen === o.termId ? ' checked' : ''}${o.allowed ? '' : ` disabled aria-describedby="${esc(id)}"`}><span>${termName(config, o.termId)}<small>${o.paymentDueDay}일 · 판매가 ${term.premiumBp ? `+${term.premiumBp / 100}%` : '그대로'}</small>${o.allowed ? '' : `<small id="${esc(id)}">${esc(o.reasonKo ?? '')}</small>`}</span></label>`;
  }).join('')}</div></fieldset><p data-p11-summary="${esc(key)}">${summary(row)} · 거래처 ${esc(option.grade)}등급 · 늦게 낼 수 있음</p>${details(ui, `credit-${key}`, '조건 비교', comparison
    + `<div aria-hidden="true">${previews.map((r) => `<div>${termName(config, r.termId)} <meter min="0" max="${previews.at(-1)!.lockDays}" value="${r.lockDays}"></meter></div>`).join('')}</div>`
    + `<div class="why"><h4>지금 회사 돈</h4><p>지금 쓸 수 있는 돈(원화 환산): ${money(cash.availableKrwMinor)}</p><p>이 거래 뒤: ${money(cash.availableKrwMinor - row.cashOutKrwMinor)}</p><p>이미 받을 돈(원화 환산): ${money(cash.receivableKrwMinor)}</p></div>`
    + `<div class="why"><h4>생각해 볼 질문</h4>${chosen === 'BASE' ? '' : `<p>${termName(config, chosen)}으로 더 받는 ${sale(option.saleAmountMinor - options.find((o) => o.termId === 'BASE')!.saleAmountMinor)}와, ${row.lockDays}일 동안 묶이는 ${money(row.cashOutKrwMinor)} 가운데 어느 쪽이 더 클까요?</p>`}${days.length ? `<p>${days.join('·')}일에 좋은 견적이 나오면 무슨 돈으로 사겠습니까?</p>` : ''}</div>`)}</div>`;
}

export function path11Cash(s: GameState, config: ScenarioConfig, ui: Ui): string {
  if (!active(config)) return '';
  const cash = cashLockSummary(s, config)!;
  const terms = receivablesByTerm(s, config);
  return `<div class="p11"><h3>묶이는 돈</h3><p>받을 돈으로 묶인 돈 ${money(cash.receivableKrwMinor)} · 쓸 수 있는 돈 ${money(cash.availableKrwMinor)} (묶인 비율 ${cash.lockedShareBp === null ? '—' : `${(cash.lockedShareBp / 100).toFixed(2)}%`})</p>${details(ui, 'cash', '통화별·조건별', table('통화별 돈', ['통화', '쓸 수 있는 돈', '받을 돈'], cash.available.map((m) => cells([m.currency, esc(formatMoney(m.currency, m.amountMinor)), esc(formatMoney(m.currency, cash.receivable.find((r) => r.currency === m.currency)!.amountMinor))])).join(''))
    + table('조건별 받을 돈', ['조건', '등급', '통화', '남은 금액', '건수', '연체 건수'], terms.rows.map((r) => cells([termName(config, r.termId), r.grade ?? '주선', r.currency, esc(formatMoney(r.currency, r.outstandingMinor)), String(r.count), String(r.overdueCount)])).join('')))}</div>`;
}

function assetBar(statement: Statement): string {
  const total = statement.assets.reduce((n, r) => n + r.krwMinor, 0);
  if (total <= 0 || statement.assets.some((r) => r.krwMinor < 0)) return '';
  const rows = statement.assets.map((r) => ({ ...r, percent: Math.round(r.krwMinor * 1000 / total) / 10 }));
  return `<div class="p11-bar" role="img" aria-label="${esc(`자산 구성: ${rows.map((r) => `${SETTLEMENT_LINE_KO[r.account]} ${r.percent}%`).join(' · ')}`)}">${rows.map((r) => `<span style="flex-basis:${r.percent}%" title="${esc(SETTLEMENT_LINE_KO[r.account])}"></span>`).join('')}</div>`;
}
const revenues: Account[] = ['REVENUE', 'SALES_ALLOWANCE', 'FORWARDING_REVENUE'];
const costs: Account[] = ['COST_OF_GOODS_SOLD', 'FORWARDING_COST'];
const overheads: Account[] = ['WAGE_EXPENSE', 'RECRUITMENT_EXPENSE', 'TRAINING_EXPENSE', 'CULTURE_EXPENSE', 'RENT_EXPENSE', 'FACILITY_SETUP_EXPENSE', 'SPACE_CONTRACT_EXPENSE', 'BAD_DEBT', 'CANCELLATION_EXPENSE'];
const other: Account[] = ['FX_SPREAD_EXPENSE', 'RECEIVABLE_CARRY'];
export function path11Statement(s: GameState, config: ScenarioConfig, asOfDay: number, ui: Ui): string {
  if (!active(config)) return '';
  const st = settlementKrw(s, config, asOfDay)!;
  const value = (account: Account) => st.income.find((r) => r.account === account)!.krwMinor;
  const total = (accounts: Account[]) => accounts.reduce((n, a) => n + value(a), 0);
  const revenue = total(revenues), gross = revenue - total(costs), operating = gross - total(overheads);
  const net = operating - total(other) + st.fxTranslationKrwMinor;
  const zeros: string[] = [];
  const line = (account: Account, minor: number) => {
    const html = `<tr data-p11-account="${account}" data-minor="${minor}"><th scope="row">${esc(SETTLEMENT_LINE_KO[account])}</th><td>${money(minor)}</td></tr>`;
    if (minor === 0) { zeros.push(html); return ''; }
    return html;
  };
  const subtotal = (id: string, label: string, minor: number) => `<tr class="total" data-p11-total="${id}" data-minor="${minor}"><th scope="row">${label}</th><td>${money(minor)}</td></tr>`;
  const group = (name: string, accounts: Account[]) => `<tr><th scope="rowgroup" colspan="2">${name}</th></tr>${accounts.map((a) => line(a, value(a))).join('')}`;
  const income = group('영업수익', revenues) + subtotal('revenue', '영업수익 소계', revenue) + group('매출원가', costs) + subtotal('gross', '매출총이익', gross)
    + group('판매비와관리비', overheads) + subtotal('operating', '영업이익', operating) + group('영업외', other)
    + `<tr data-p11-account="fxTranslationKrwMinor" data-minor="${st.fxTranslationKrwMinor}"><th scope="row">${SETTLEMENT_LINE_KO.fxTranslationKrwMinor}</th><td>${money(st.fxTranslationKrwMinor)}</td></tr>` + subtotal('net', '당기순이익', net);
  const balance = ([['자산', st.assets], ['부채', st.liabilities], ['자본', st.equity]] as const).map(([name, rows]) => `<tr><th scope="rowgroup" colspan="2">${name}</th></tr>${rows.map((r) => line(r.account, r.krwMinor)).join('')}${name === '자본' ? subtotal('retained', '쌓인 이익', net) : ''}`).join('');
  return `<div class="p11" data-p11-asof="${asOfDay}"><p>원화로 환산했습니다. 손익은 거래한 날의 참고 환율, 재무상태는 ${asOfDay}일 참고 환율 ${money(st.rateAsOf)}/$로 바꿨습니다.</p><div class="p11-statements">${table(`손익계산서 · 1~${asOfDay}일`, ['항목', '금액'], income)}${table(`재무상태표 · ${asOfDay}일 마감`, ['항목', '금액'], balance)}</div>${details(ui, `zero-${asOfDay}`, '0원 항목', table('0원 항목', ['항목', '금액'], zeros.join('')))}<small>분류 검토 중</small></div>`;
}
export function path11Missed(s: GameState, config: ScenarioConfig, asOfDay: number, ui: Ui): string {
  if (!active(config)) return '';
  const records = (s.operations?.unaffordable ?? []).filter((r) => r.day <= asOfDay);
  const days = [...new Set(records.map((r) => r.day))].sort((a, b) => a - b);
  return `<div class="p11 p11-missed"><h4>자금 부족으로 못 받은 견적</h4>${days.length ? days.map((day) => {
    const rows = records.filter((r) => r.day === day);
    const body = rows.map((r) => {
      const buy = offerDef(s, config, r.buyOfferId)!, sell = offerDef(s, config, r.sellOfferId)!;
      return `<p data-p11-missed="${day}">${esc(goodOf(config, buy.goodId).nameKo)} · ${esc(cityName(config, buy.cityId))}→${esc(cityName(config, sell.cityId))} — ${r.shortfalls.map((m) => `${m.currency} 필요 ${esc(formatMoney(m.currency, m.needMinor))} / 가용 ${esc(formatMoney(m.currency, m.availableMinor))}`).join(' · ')}</p>`;
    }).join('');
    return rows.length > 3 ? details(ui, `missed-${day}`, `${day}일 ${rows.length}건`, body) : `<h5>${day}일 ${rows.length}건</h5>${body}`;
  }).join('') : '<p>없음</p>'}</div>`;
}
export function path11Report(s: GameState, config: ScenarioConfig, ui: Ui): string {
  if (!active(config)) return '';
  let html = path11Cash(s, config, ui);
  if (s.day - 1 < 1) return html;
  const day = ui.path11AsOfDay ?? s.day - 1;
  const st = settlementKrw(s, config, day)!;
  html += `<div class="p11"><h3>중간 재무상태</h3><label>기준일 <select data-action="p11-asof">${[30, 60].filter((d) => d <= s.day - 1).map((d) => `<option value="${d}"${d === ui.path11AsOfDay ? ' selected' : ''}>${d}일</option>`).join('')}<option value=""${ui.path11AsOfDay === null ? ' selected' : ''}>어제 마감 (${s.day - 1}일)</option></select></label>${assetBar(st)}${table(`${day}일 재무상태`, ['항목', '금액'], ['CASH', 'ACCOUNTS_RECEIVABLE', 'INVENTORY', 'ACCOUNTS_PAYABLE'].map((account) => {
    const row = [...st.assets, ...st.liabilities].find((r) => r.account === account)!;
    return cells([esc(SETTLEMENT_LINE_KO[row.account]), money(row.krwMinor)]);
  }).join(''))}<button data-action="p11-dialog">재무제표 보기</button></div>${path11Missed(s, config, day, ui)}`;
  return html;
}
export function path11Settlement(s: GameState, config: ScenarioConfig, asOfDay: number, ui: Ui, books: string): string {
  return active(config) ? `${path11Statement(s, config, asOfDay, ui)}${details(ui, 'books', '통화별 장부', books)}` : books;
}

export function path11Toggle(ev: Event, ui: Ui) {
  const el = ev.target as HTMLDetailsElement;
  const key = el.dataset?.p11Key;
  if (!key) return;
  ui.path11Open = ui.path11Open.filter((k) => k !== key);
  if (el.open) ui.path11Open.push(key);
}
export function path11Change(ev: Event, s: GameState, config: ScenarioConfig, ui: Ui, render: () => void, live: HTMLElement, liveRegionText: typeof import('./session').liveRegionText): boolean {
  if (!active(config)) return false;
  const el = ev.target as HTMLInputElement;
  if (el.dataset.action === 'credit-term') {
    const key = el.dataset.key!, term = el.value as CreditTermId;
    const [buy, sell] = key.split('+');
    const quantity = ui.offerQuantities[key];
    if (!creditTermOptions(s, config, buy!, sell!, quantity).some((o) => o.termId === term && o.allowed)) return true;
    ui.creditTerms[key] = term;
    render();
    live.textContent = liveRegionText(live.textContent ?? '', summary(selectedPreview(s, config, ui, key, quantity)));
    return true;
  }
  if (el.dataset.action === 'p11-asof') {
    const day = Number(el.value);
    ui.path11AsOfDay = el.value && [30, 60].includes(day) && day <= s.day - 1 ? day : null;
    render(); return true;
  }
  return false;
}
/** 대화상자 바깥 형제 요소를 막고 닫으면 원래 inert를 복원한다. */
let restoreBackground: (() => void) | undefined;
export function path11Dialog(app: HTMLElement, s: GameState, config: ScenarioConfig, ui: Ui) {
  restoreBackground?.(); restoreBackground = undefined;
  if (!active(config) || !ui.path11DialogOpen || s.day <= 1) return;
  const root = document.getElementById('p11-dialog');
  if (!root) return;
  const restored: { el: HTMLElement; inert: boolean }[] = [];
  for (const el of Array.from(app.children ?? []) as HTMLElement[]) if (el !== root) { restored.push({ el, inert: el.inert }); el.inert = true; }
  restoreBackground = () => { for (const { el, inert } of restored) el.inert = inert; };
  root.onkeydown = (ev) => {
    if (ev.key !== 'Tab') return;
    const controls = Array.from(root.querySelectorAll<HTMLElement>('button, summary, select'));
    const first = controls[0], last = controls.at(-1);
    if (ev.shiftKey && (document.activeElement === first || document.activeElement?.id === 'p11-dialog-h')) { ev.preventDefault(); last?.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
  };
}
export function path11DialogHtml(s: GameState, config: ScenarioConfig, ui: Ui): string {
  if (!active(config) || !ui.path11DialogOpen || s.day <= 1) return '';
  const day = ui.path11AsOfDay ?? s.day - 1;
  return `<section id="p11-dialog" class="panel p11-dialog" role="dialog" aria-modal="true" aria-labelledby="p11-dialog-h"><h2 id="p11-dialog-h" tabindex="-1">${day}일 마감 재무제표</h2><button data-action="p11-close">닫기</button>${path11Statement(s, config, day, ui)}${path11Missed(s, config, day, ui)}</section>`;
}

/** 경로 11의 클릭과 초점 이동은 지연 화면에서 처리한다. */
export function path11Handle(action: string | undefined, app: HTMLElement, ui: Ui, render: (skipFocus?: boolean) => void, opened: (key: 'path11') => void, opener: (el: HTMLElement | null) => void): boolean {
  if (action !== 'p11-dialog' && action !== 'p11-close') return false;
  ui.path11DialogOpen = action === 'p11-dialog';
  if (ui.path11DialogOpen) opened('path11');
  render(true);
  if (ui.path11DialogOpen) document.getElementById('p11-dialog-h')?.focus({ preventScroll: true });
  else opener(app.querySelector<HTMLElement>('[data-action="p11-dialog"]'));
  return true;
}
let toggleApp: HTMLElement | undefined;
let toggleUi: Ui;
/** 그리기 전 상태·열림을 준비하고 그린 뒤 대화상자 바깥을 막는다. */
export function path11Render(after: boolean, app: HTMLElement, s: GameState, view: GameState, config: ScenarioConfig, ui: Ui): string {
  if (after) { path11Dialog(app, s, config, ui); return ''; }
  toggleUi = ui;
  if (toggleApp !== app) {
    toggleApp = app;
    app.addEventListener('toggle', (ev) => path11Toggle(ev, toggleUi), true);
  }
  path11Prepare(view, config, ui);
  return path11DialogHtml(s, config, ui);
}
