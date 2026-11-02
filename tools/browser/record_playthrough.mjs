#!/usr/bin/env node
// 평택 본사 90일 운영(M2a-5 규칙 2) 하이라이트 플레이 영상을 녹화한다.
// 사용: node tools/browser/record_playthrough.mjs --dist <dist> --out <dir> [--minutes N] [--quick] [--hire]
// --hire: 면담 뒤 실제로 고용한다. 기본은 면담만 보여 준다. 고용하면 원화 일급이 늘어 이 시드에서는
//         35일 무렵 지급 경고가 뜨고 경영 실패·미지급으로 끝나기 쉽다(빨리 감기 정책 기준).
// - 빌드 폴더(dist)를 http://scitrade.local/ 로 오프라인 제공하고 다른 호스트는 막는다(lib.mjs와 같은 방식).
// - 장면마다 강조 테두리·자막을 넣고 읽을 시간만큼 멈춘다. --quick은 멈춤을 약 1초로 줄인 점검용이다.
// - 결과: <out>/scitrade-playthrough.webm, 같은 폴더의 .mp4(H.264, crf 28, yuv420p), JSON 요약(표준 출력).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, isInside, realOutputPath, resolveDistPath, contentType } from './lib.mjs';

const SCENARIO_ID = 'SCENARIO_M2_OPERATIONS';
const W = 1280, H = 800;
const CLICK_GAP_MS = 700; // 화면은 조작 뒤 500ms 동안 클릭을 무시한다(main.ts ignoreClicksUntil).
const FF_GAP_MS = 580; // 빨리 감기 구간의 조작 간격(500ms 무시 구간 바로 뒤).

function parseArgs(argv) {
  const opts = { dist: path.join(REPO_ROOT, 'dist'), out: null, minutes: 10, quick: false, hire: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') opts.dist = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--minutes') opts.minutes = Number(argv[++i]);
    else if (a === '--quick') opts.quick = true;
    else if (a === '--hire') opts.hire = true;
    else if (a === '--help' || a === '-h') { console.log('node tools/browser/record_playthrough.mjs --dist <dist> --out <dir> [--minutes N] [--quick] [--hire]'); process.exit(0); }
    else throw new Error(`모르는 인자: ${a}`);
  }
  if (!opts.out) throw new Error('--out <폴더>가 필요합니다');
  if (!Number.isFinite(opts.minutes) || opts.minutes <= 0) throw new Error('--minutes는 양수입니다');
  opts.dist = path.resolve(opts.dist);
  opts.out = path.resolve(opts.out);
  if (!fs.existsSync(path.join(opts.dist, 'index.html'))) throw new Error(`빌드 폴더에 index.html이 없습니다: ${opts.dist}`);
  if (isInside(realOutputPath(opts.out), fs.realpathSync(REPO_ROOT))) throw new Error('출력 폴더는 저장소 밖이어야 합니다');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
// 기본 10분 기준으로 멈춤 길이를 비례 조정한다. 빨리 감기 구간(하루 진행 반복)은 조정하지 않는다.
// 0.38은 10분 목표로 실측 보정한 값이다(조작·강조·빨리 감기 시간은 고정).
const SCALE = 0.38 * opts.minutes / 10;
fs.mkdirSync(opts.out, { recursive: true });
const rawDir = fs.mkdtempSync(path.join(opts.out, '.raw-'));

const { chromium } = createRequire(import.meta.url)(process.env.SCITRADE_PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');
const browser = await chromium.launch({ executablePath: process.env.SCITRADE_CHROMIUM || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: 'ko-KR',
  recordVideo: { dir: rawDir, size: { width: W, height: H } },
});
const blocked = new Set();
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === 'http://scitrade.local') {
    const file = resolveDistPath(opts.dist, url.pathname);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '파일이 없습니다' });
    return route.fulfill({ contentType: contentType(file), body: fs.readFileSync(file) });
  }
  blocked.add(url.hostname);
  return route.abort();
});
const page = await context.newPage();
const t0 = Date.now();
const pageErrors = [], consoleErrors = [], scenes = [], skipped = [], notes = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('dialog', (d) => d.accept());

const now = () => (Date.now() - t0) / 1000;
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const log = (...a) => console.error(`[${mmss(now())}]`, ...a);
/** 읽을 시간. --quick이면 약 1초. */
const hold = (sec) => page.waitForTimeout(opts.quick ? 1000 : Math.round(sec * 1000 * SCALE));
const gap = (ms = CLICK_GAP_MS) => page.waitForTimeout(ms);

// ── 화면 위 덧칠: 강조 테두리와 장면 자막 ───────────────────────────────
const OVERLAY_CSS = `
.rec-hl { outline: 4px solid #ff7a1a !important; outline-offset: 3px !important; box-shadow: 0 0 0 9px rgba(255,122,26,.28) !important; border-radius: 6px; transition: outline-color .2s; }
#rec-caption { position: fixed; left: 16px; bottom: max(16px, calc(var(--toast-h, 0px) + 6px)); z-index: 2147483647; pointer-events: none; max-width: 560px;
  background: rgba(20,28,44,.88); color: #fff; font: 600 17px/1.35 system-ui, 'Noto Sans KR', sans-serif; padding: 10px 14px; border-radius: 10px;
  box-shadow: 0 6px 18px rgba(0,0,0,.25); }
#rec-caption small { display: block; font-weight: 400; font-size: 14px; opacity: .85; margin-top: 2px; }
#rec-caption .no { color: #ffb37a; margin-right: 6px; }
#rec-mark { position: fixed; right: 0; bottom: 0; width: 10px; height: 10px; z-index: 2147483647; pointer-events: none; background: #000; }`;
async function installOverlay() {
  await page.evaluate((css) => {
    if (document.getElementById('rec-style')) return;
    const s = document.createElement('style'); s.id = 'rec-style'; s.textContent = css; document.head.appendChild(s);
    const c = document.createElement('div'); c.id = 'rec-caption'; c.hidden = true; document.body.appendChild(c);
    // 장면 표지: 오른쪽 아래 모서리 10px 칸. 장면마다 자홍·청록을 번갈아 칠해 영상에서 장면 시작 시각을 읽는다.
    const m = document.createElement('div'); m.id = 'rec-mark'; document.body.appendChild(m);
  }, OVERLAY_CSS);
}
async function caption(no, title, sub = '') {
  await page.evaluate(({ no, title, sub }) => {
    const c = document.getElementById('rec-caption'); if (!c) return;
    c.hidden = false;
    c.innerHTML = '';
    const n = document.createElement('span'); n.className = 'no'; n.textContent = no;
    c.append(n, document.createTextNode(title));
    if (sub) { const s = document.createElement('small'); s.textContent = sub; c.append(s); }
  }, { no, title, sub });
}
/** 장면 시작: 시각을 기록하고 자막을 바꾼다. */
async function scene(title, sub = '') {
  const no = String(scenes.length + 1).padStart(2, '0');
  scenes.push({ no, title, start_s: Math.round(now() * 10) / 10, start: mmss(now()), day: await currentDay() });
  await page.evaluate((odd) => { const m = document.getElementById('rec-mark'); if (m) m.style.background = odd ? '#ff00ff' : '#00ffff'; }, scenes.length % 2 === 1);
  log(`장면 ${no} ${title}`);
  await caption(no, title, sub);
}
function skip(title, reason) { skipped.push({ title, reason }); log(`건너뜀: ${title} — ${reason}`); }
async function currentDay() {
  return page.evaluate(() => document.querySelector('.statusbar .date b')?.textContent?.trim() ?? null).catch(() => null);
}

// ── 스크롤·강조·클릭 ────────────────────────────────────────────────
/** 고정 상태 막대 아래로 부드럽게 스크롤한다. where: 'top'(막대 아래 16px) 또는 'center'. */
async function smoothTo(selector, where = 'top', index = 0) {
  const moved = await page.evaluate(({ selector, where, index }) => {
    const el = document.querySelectorAll(selector)[index];
    if (!el) return null;
    const scope = el.closest('.situation') ?? null;
    if (scope) { el.scrollIntoView({ behavior: 'smooth', block: where === 'center' ? 'center' : 'start' }); return true; }
    const bar = document.querySelector('.statusbar');
    const barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
    const r = el.getBoundingClientRect();
    const target = where === 'center'
      ? scrollY + r.top - (barBottom + (innerHeight - barBottom) / 2) + Math.min(r.height, innerHeight - barBottom - 40) / 2
      : scrollY + r.top - barBottom - 16;
    const top = Math.max(0, Math.round(target));
    if (Math.abs(top - scrollY) < 4) return false;
    window.scrollTo({ top, behavior: 'smooth' });
    // 가로 스크롤 틀(세계지도·시세표) 안의 요소도 부드럽게 보이게 한다.
    return true;
  }, { selector, where, index });
  if (moved === null) return false;
  if (moved) await page.waitForTimeout(opts.quick ? 450 : 1100);
  return true;
}
async function smoothBy(dy) {
  await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'smooth' }), dy);
  await page.waitForTimeout(opts.quick ? 450 : 1100);
}
async function smoothTop() {
  const y = await page.evaluate(() => scrollY);
  if (y < 2) return;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(opts.quick ? 450 : Math.min(1000, 350 + y / 4));
}
async function highlight(selector, ms = 1300, index = 0) {
  const ok = await page.evaluate(({ selector, index }) => {
    const el = document.querySelectorAll(selector)[index]; if (!el) return false;
    el.classList.add('rec-hl'); return true;
  }, { selector, index });
  if (!ok) return false;
  await page.waitForTimeout(opts.quick ? 300 : ms);
  return true;
}
async function unhighlight() {
  await page.evaluate(() => document.querySelectorAll('.rec-hl').forEach((e) => e.classList.remove('rec-hl'))).catch(() => {});
}
/** 보여 주며 누른다. 없거나 비활성이면 false. */
async function act(selector, { where = 'center', hl = 1300, scroll = true, index = 0 } = {}) {
  const state = await page.evaluate(({ selector, index }) => {
    const el = document.querySelectorAll(selector)[index];
    return el ? (el.disabled ? 'disabled' : 'ok') : 'missing';
  }, { selector, index });
  if (state !== 'ok') { log(`누를 수 없음(${state}): ${selector}`); return false; }
  if (scroll) await smoothTo(selector, where, index);
  await highlight(selector, hl, index);
  await page.locator(selector).nth(index).click({ timeout: 10000 });
  await unhighlight();
  await gap();
  return true;
}
/** 목록 상자 값을 강조하며 고른다. */
async function choose(selector, value, { hl = 1100 } = {}) {
  if (!(await page.$(selector))) { log(`목록 없음: ${selector}`); return false; }
  await smoothTo(selector, 'center');
  await highlight(selector, hl);
  await page.selectOption(selector, value);
  await unhighlight();
  await gap();
  return true;
}
/** container 안에서 text를 담은 가장 안쪽 요소에 data-rec 표시를 붙인다(위에서 첫 번째). */
async function tagText(container, text, tag) {
  return page.evaluate(({ container, text, tag }) => {
    const root = document.querySelector(container); if (!root) return false;
    const hits = [...root.querySelectorAll('li, p, div, tr, dd, td')].filter((e) => e.textContent.includes(text));
    const leaf = hits.find((e) => !hits.some((o) => o !== e && e.contains(o)));
    if (!leaf) return false;
    const row = leaf.closest('li, tr') ?? leaf;
    row.setAttribute('data-rec', tag); return true;
  }, { container, text, tag });
}
async function exists(selector) { return Boolean(await page.$(selector)); }
async function endDay(times = 1, { show = 900, gapMs = CLICK_GAP_MS } = {}) {
  for (let i = 0; i < times; i++) {
    if (await exists('#settlement-h') || await exists('#failure-h')) return false;
    const before = await currentDay();
    if (show > 0) await highlight('[data-action="end-day"]', opts.quick ? 200 : show);
    await page.click('[data-action="end-day"]');
    if (show > 0) await unhighlight();
    await gap(gapMs);
    const after = await currentDay();
    if (before === after && !(await exists('#settlement-h'))) { await gap(); await page.click('[data-action="end-day"]'); await gap(); }
  }
  return true;
}
/** 가장 이른 납기 안 출항편 예약 단추(⚠ 납기 초과가 아닌 것)의 선택자. */
async function bookSelector(contract) {
  return page.evaluate((contract) => {
    const bs = [...document.querySelectorAll(`[data-action="book"]${contract ? `[data-contract="${contract}"]` : ''}:not([disabled])`)];
    const b = bs.find((b) => !b.textContent.includes('납기 초과'));
    return b ? `[data-action="book"][data-contract="${b.dataset.contract}"][data-sailing="${b.dataset.sailing}"]` : null;
  }, contract);
}
async function newestContractId() {
  return page.evaluate(() => [...document.querySelectorAll('[id^="contract-h-"]')].map((h) => h.id.slice('contract-h-'.length)).sort().at(-1) ?? null);
}

// ── 빨리 감기(자동 운영) ────────────────────────────────────────────
// 새 견적이 있으면 직접 무역·운송 주선을 하나씩 받고, 비는 직원에 준비를 맡기고, 납기 안 출항편을 예약한다.
// 지급 경고가 보이면 거래를 멈추고 쓸 수 있는 USD로 환전한다.
async function autoDay({ trade = true, maxLots = 10 } = {}) {
  const fast = async (sel) => { if (!(await exists(sel))) return false; await page.click(sel); await gap(FF_GAP_MS); return true; };
  if (await exists('.payment-alert')) {
    const n = await page.$$eval('select[data-action="exchange-amount"] option', (o) => o.length).catch(() => 0);
    if (n) { await page.selectOption('select[data-action="exchange-amount"]', String(Math.min(n, maxLots))); await gap(400); }
    await fast('[data-action="exchange"]');
  } else if (trade) {
    await fast('[data-action="accept"]:not([disabled])');
    await fast('[data-action="accept-fwd"]:not([disabled])');
  }
  for (let k = 0; k < 4 && await fast('[data-action="assign"]:not([disabled])'); k++);
  for (let k = 0; k < 4; k++) { const s = await bookSelector(); if (!s) break; await page.click(s); await gap(FF_GAP_MS); }
  await smoothTop();
}
async function fastForward(untilDay, { stopOnAlert = false, trade = true } = {}) {
  for (let guard = 0; guard < 120; guard++) {
    if (await exists('#settlement-h') || await exists('#failure-h')) return 'ended';
    const day = parseInt(await currentDay(), 10);
    if (day >= untilDay) return 'day';
    if (stopOnAlert && await exists('.payment-alert')) return 'alert';
    await autoDay({ trade });
    await endDay(1, { show: 0, gapMs: FF_GAP_MS });
  }
  return 'guard';
}

// ── 녹화 본편 ──────────────────────────────────────────────────────
let summaryError = null;
try {
  await page.goto('http://scitrade.local/index.html');
  await page.waitForSelector('[data-action="end-day"]', { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await installOverlay();

  // 1. 시작 화면과 시나리오 고르기
  await scene('시작 화면 — Scitrade 시제품', '기본 시나리오(복수 계약)로 열립니다');
  await hold(8);
  await highlight('select[data-action="scenario"]', 2000);
  await hold(5);
  await unhighlight();
  await scene('시나리오 선택 — 평택 본사 90일 운영', '규칙 2(M2a-5): 반복 견적·창고·환전·직접 무역+운송 주선');
  await choose('select[data-action="scenario"]', SCENARIO_ID, { hl: 1800 });
  await page.waitForSelector('#market-h');
  await installOverlay();
  await hold(10);

  // 2. 본사 상단 막대
  await scene('본사 상태 막대', '날짜·거래 현금(USD)·운영 현금(KRW)·원화 급여 가능일·지급 상태');
  await highlight('.statusbar .day', 2600); await unhighlight();
  // .stat 순서: 거래 현금, 사용 가능, 운영 현금, 원화 급여 가능일, 지급 상태, 다음 수금
  for (const i of [0, 1, 2, 3, 4, 5]) { await highlight('.statusbar .stat', 2400, i); await unhighlight(); }
  await highlight('[data-action="end-day"]', 2400); await unhighlight();
  await hold(4);

  // 3. 시세표
  await scene('시세표 — 도시·상품별 기준가', '지수와 관측일, 이번 묶음 견적 여부');
  await smoothTo('#market-h', 'top');
  await highlight('#market-h', 1500); await unhighlight();
  await hold(18);

  // 4. 견적판
  await scene('견적판 — 이번 주에 생성된 견적 카드', '직접 무역 2건 · 운송 주선 2건');
  await smoothTo('.offer-board', 'top');
  await hold(9);
  const offerCards = await page.$$eval('.offer-board > *:not(.board-title)', (els) => els.length).catch(() => 0);
  for (let i = 0; i < Math.min(offerCards, 4); i++) {
    await smoothTo('.offer-board > *:not(.board-title)', 'top', i);
    await hold(6);
  }

  // 5. 직접 무역 수락 → 준비 배정 → 운송편 예약
  await scene('직접 무역 수락 — 의류 평택→하이퐁', '견적 수락 → 수출 준비 담당 배정 → 출항편 예약');
  await smoothTo('[data-action="accept"][data-buy="OFFER_BUY_01"]', 'center');
  await hold(5);
  if (await act('[data-action="accept"][data-buy="OFFER_BUY_01"]', { hl: 2200 })) {
    const ct = await newestContractId();
    await hold(5);
    await act(`[data-action="assign"][data-task]:not([disabled])`, { hl: 1800 });
    await hold(3);
    const b = await bookSelector(ct);
    if (b) await act(b, { hl: 1800 }); else skip('직접 무역 운송편 예약', '납기 안 출항편 단추가 없음');
    await smoothTo(`#contract-h-${ct}`, 'top');
    await hold(10);
  } else skip('직접 무역 수락', 'OFFER_BUY_01 수락 단추가 없거나 비활성');

  // 6. 운송 주선 수락
  await scene('운송 주선 수락 — 고객 화물 가구 평택→하이퐁', '화주의 화물을 맡아 서비스 매출을 얻습니다');
  if (await act('[data-action="accept-fwd"][data-offer="OFFER_FWD_01"]', { hl: 2200 })) {
    const ct = await newestContractId();
    await hold(4);
    const assign = await page.evaluate((ct) => {
      const b = [...document.querySelectorAll('[data-action="assign"]:not([disabled])')].find((b) => b.closest('.contract')?.querySelector(`#contract-h-${ct}`));
      return b ? `[data-action="assign"][data-task="${b.dataset.task}"][data-emp="${b.dataset.emp}"]` : null;
    }, ct);
    if (assign) await act(assign, { hl: 1800 }); else skip('운송 주선 준비 배정', '비어 있는 직원 단추가 없음');
    await hold(2);
    const b = await bookSelector(ct);
    if (b) await act(b, { hl: 1800 }); else skip('운송 주선 운송편 예약', '납기 안 출항편 단추가 없음');
    await smoothTo(`#contract-h-${ct}`, 'top');
    await hold(10);
  } else skip('운송 주선 수락', 'OFFER_FWD_01 수락 단추가 없거나 비활성');

  // 7. 환전
  await scene('환전 — USD를 원화로', '임차료·급여는 원화. 자동 환전은 없습니다');
  await smoothTo('#exchange-h', 'top');
  await hold(6);
  if (await exists('select[data-action="exchange-amount"]')) await choose('select[data-action="exchange-amount"]', '3', { hl: 1800 });
  await hold(6);
  if (!(await act('[data-action="exchange"]', { hl: 1800 }))) skip('환전 넣기', '환전 단추가 없음');
  await smoothTo('#exchange-h', 'top');
  await hold(8);

  // 8. 오늘 할 일·자원 예약
  await scene('오늘 할 일과 자원 예약', '하루 진행 때 이 순서로 실행 · 같은 돈·사람·선복을 두 번 쓰지 않습니다');
  await smoothTo('#queue-h', 'top');
  await hold(10);
  await smoothTo('#res-h', 'top');
  await hold(10);

  // 9. 동료 명단
  await scene('동료 명단 — 동물 직원 카드', '직무·속성 필터와 운영표');
  await smoothTo('#crew-h', 'top');
  await hold(6);
  await act('[data-action="crew-filter"][data-filter="busy"]', { hl: 1200, scroll: false });
  await hold(4);
  await act('[data-action="crew-filter"][data-filter="all"]', { hl: 900, scroll: false });
  await smoothBy(420);
  await hold(6);
  await smoothTo('#recruit-h', 'top');
  await hold(6);

  // 10. 창고·막힌 곳
  await scene('창고와 막힌 곳 — 운영 지표', '보관 용량·처리량, 업무 부하, 병목 9종');
  if (await smoothTo('#warehouse-h', 'top')) {
    await hold(12);
    await smoothTo('.bottleneck', 'center');
    await hold(10);
  } else skip('창고·막힌 곳', '#warehouse-h가 없음');

  // 11. 첫 하루 진행
  await scene('하루 진행 — 1일 → 2일', '명령이 실행되고 화물이 출항합니다');
  await smoothTop();
  await hold(3);
  await endDay(1, { show: 1800 });
  await hold(6);
  await smoothTo('#log-h', 'top');
  await hold(10);

  // 12. 세계지도 — 운항 중인 화물
  await scene('세계지도 — 운항 중인 화물', '이번 항로 보기 · 전 세계 보기 · 지점 고르기');
  await smoothTo('#world-h', 'top');
  await hold(8);
  if (await act('[data-action="map-mode"][data-mode="world"]', { hl: 1200 })) {
    await hold(6);
    const opt = await page.$$eval('#map-pick option', (os) => os.find((o) => o.textContent.includes('싱가포르'))?.value ?? os[3]?.value).catch(() => null);
    if (opt) { await choose('#map-pick', opt); await smoothTo('#map-detail-h', 'top'); await hold(6); }
    await act('[data-action="map-mode"][data-mode="route"]', { hl: 900 });
    await smoothTo('#world-h', 'top');
    await hold(4);
  }

  // 13. 동료 현장 조사(영입 1단계)
  await scene('동료 영입 — 항만 물류단지 현장 조사', '조사 → 영입 의뢰 → 면담 → 고용');
  if (!(await act('[data-action="scout"][data-venue="VEN_PORT"]:not([disabled])', { hl: 1800 }))) skip('현장 조사', '조사 단추가 비활성');
  await hold(6);

  // 14. 상황실
  await scene('상황실 지도 — 브리핑과 레이어', '운항 화물·항로·항만·야간 불빛·국가 지표');
  await smoothTo('#world-h', 'top');
  if (await act('[data-action="situation"]', { hl: 1500, scroll: false })) {
    await page.waitForSelector('#situation-h');
    await hold(10);
    if (await exists('[data-situation="next"]:not([disabled])')) { await act('[data-situation="next"]', { scroll: false }); await hold(7); }
    await act('[data-situation="free"]', { scroll: false, index: 0 });
    await hold(3);
    for (const layer of ['nightlights', 'ports', 'ports', 'countries', 'countries']) {
      if (await act(`label[for="situation-${layer}"]`, { scroll: false, hl: 900 })) await hold(layer === 'nightlights' ? 7 : 3);
    }
    await act('[data-situation="all"]', { scroll: false });
    await hold(6);
    await act('[data-situation="table"]', { scroll: false });
    await hold(8);
    await act('[data-situation="close"]', { scroll: false });
  } else skip('상황실', '상황실 단추가 없음');
  await hold(2);

  // 15. 2일 → 3일, 영입 의뢰와 현지 활동
  await endDay(1);
  await scene('동료 영입 — 후보 발견과 영입 의뢰', '조사로 찾은 후보에게 의뢰를 맡깁니다');
  if (await act('[data-action="recruit-quest"]:not([disabled])', { hl: 1800 })) await hold(8);
  else skip('영입 의뢰', '후보가 없거나 의뢰 단추 비활성');

  await scene('평택 현지 — 문화생활·현지 탐방', '직원 1명을 보내 만난 사람의 말을 네 칸으로 기록');
  if (await act('#local-tab', { where: 'top', hl: 1500 })) {
    await page.waitForSelector('[data-action="culture-act"]');
    await smoothTo('#local-tab', 'top');
    await hold(8);
    await act('[data-action="culture-act"][data-activity="CA02"]', { hl: 1400 });
    await hold(4);
    if (await act('[data-action="culture-emp"]:not([disabled])', { hl: 1400 })) {
      await hold(4);
      await act('[data-action="culture-queue"]:not([disabled])', { hl: 1500 });
      await hold(5);
    } else skip('현지 활동 직원 고르기', '비어 있는 직원 없음');
    await act('[data-action="culture-close"][data-where="head"]', { hl: 900 });
  } else skip('평택 현지', '#local-tab 없음');

  // 16. 3일 → 4일: 현지 활동 결과
  await smoothTop();
  await endDay(1, { show: 1400 });
  await scene('현지 활동 결과 — 네 칸 기록', '알게 된 점·범위·말하지 않는 것·아직 모르는 것');
  if (await act('[data-action="culture-result"]', { scroll: false, hl: 1500 })) {
    await hold(14);
    await act('[data-action="culture-close"][data-where="head"]', { hl: 900 });
  } else skip('현지 활동 결과', '결과 보기 알림이 없음');

  // 17. 면담과 고용
  await endDay(1);
  await scene(opts.hire ? '면담과 고용 — 새 동료 영입' : '면담 — 영입 후보의 비용 확인', '계약금·일급·남은 기간 급여·하루 처리량');
  if (await act('[data-action="interview"]', { hl: 1500 })) {
    await smoothTo('[id^="interview-h-"]', 'top');
    await hold(14);
    if (opts.hire) {
      if (await act('[data-action="hire"]', { hl: 1800 })) { await hold(4); await endDay(1); await smoothTo('#crew-h', 'top'); await hold(8); }
      else skip('고용', '고용 단추 비활성');
    } else if (await exists('[data-action="hire"]:not([disabled])')) {
      await caption(scenes.at(-1).no, '면담 — 고용 단추와 비용', '일급·계약금이 원화 고정비를 늘립니다 — 이번 판은 고용 보류');
      await smoothTo('[data-action="hire"]', 'center');
      await highlight('[data-action="hire"]', 3500); await unhighlight();
      await hold(6);
    } else skip('고용', '고용 단추 비활성');
  } else skip('면담', '면담 가능한 후보 없음');

  // 18. 도착과 일정
  await smoothTop();
  await fastForward(8, { trade: false });
  await scene('화물 도착 — 하이퐁 인도와 채권', '7일 도착·인도, 대금은 10일 수금 예정(채권)');
  await smoothTo('#log-h', 'top');
  if (await tagText('.log', '도착: 하이퐁', 'arrive')) await highlight('[data-rec="arrive"]', 2200);
  await unhighlight();
  await hold(10);
  await smoothTo('#trade-h', 'top');
  await hold(5);
  await scene('앞으로 7일 일정', '급여일·예약 마감일·도착 예정일');
  if (await act('[data-action="schedule-toggle"]', { where: 'center', hl: 1300 })) {
    await smoothTo('[data-action="schedule-toggle"]', 'top');
    await hold(12);
    await act('[data-action="schedule-toggle"]', { hl: 700 });
  } else skip('일정', '일정 단추 없음');

  // 19. 새 주의 견적
  await smoothTop();
  await scene('8일 — 새 주의 견적 공개', '매주 새 견적이 생성됩니다');
  await smoothTo('.offer-board', 'top');
  await hold(10);
  await autoDay();
  await hold(4);

  // 20. 경영 보고
  await scene('경영 보고 — 손익과 현금', '현금과 이익이 다른 이유');
  await smoothTo('#report-h', 'top');
  await hold(12);
  await smoothBy(560);
  await hold(8);

  // 21. 빨리 감기 → 31일(둘째 달 임차료)
  await scene('빨리 감기 — 9일 → 32일', '새 견적을 받고 준비·예약을 반복합니다');
  await smoothTop();
  let ff = await fastForward(32, { stopOnAlert: true });
  if (ff === 'day') {
    await scene('월 정산 — 31일 창고 임차료·급여 지급', '임차료는 30일마다, 급여는 날마다 원화(KRW)로 나갑니다');
    // 임차료는 기록(로그)에 남지 않고 운영 장부(KRW)의 '창고 임차료' 행에 쌓인다.
    await smoothTo('#report-h', 'top');
    await hold(4);
    if (await tagText('section[aria-labelledby="report-h"]', '창고 임차료', 'rent')) {
      await smoothTo('[data-rec="rent"]', 'center');
      await highlight('[data-rec="rent"]', 3200); await unhighlight();
    } else skip('월 정산 임차료 행 강조', "경영 보고에서 '창고 임차료' 행을 찾지 못함");
    await hold(10);
    await smoothTo('#log-h', 'top');
    await hold(6);
    await scene('빨리 감기 — 32일 → 지급 경고까지', '원화 급여 가능일이 줄어듭니다');
    await smoothTop();
    ff = await fastForward(999, { stopOnAlert: true });
  }

  // 22. 지급 경고와 환전
  if (ff === 'alert') {
    await scene('지급 경고 — 원화가 모자랍니다', '가장 오래된 미지급이 14일 남으면 경영 실패');
    await highlight('.statusbar .stat', 2200, 4); await unhighlight();
    await smoothTo('.payment-alert', 'top');
    await hold(14);
    await scene('환전으로 미지급 갚기', '경고 칸의 안내대로 USD를 원화로 바꿉니다');
    await act('.payment-alert [data-action="skip-to"]', { hl: 1500, scroll: false });
    await smoothTo('#exchange-h', 'top');
    const n = await page.$$eval('select[data-action="exchange-amount"] option', (o) => o.length).catch(() => 0);
    if (n) await choose('select[data-action="exchange-amount"]', String(Math.min(n, 10)));
    await hold(6);
    await act('[data-action="exchange"]', { hl: 1500 });
    await hold(4);
    await smoothTop();
    await endDay(1, { show: 1400 });
    await hold(8);
  } else skip('지급 경고', `빨리 감기 결과 ${ff}: 경고가 나타나지 않음`);

  // 23. 캠페인 끝까지
  if (!(await exists('#settlement-h')) && !(await exists('#failure-h'))) {
    await scene('빨리 감기 — 캠페인 마지막 날까지', '지급 경고가 뜨면 환전하고 계속 운영합니다');
    await smoothTop();
    ff = await fastForward(999);
    if (ff !== 'ended') {
      // 마지막 날은 새 계약 없이 넘긴다.
      for (let i = 0; i < 5 && !(await exists('#settlement-h')) && !(await exists('#failure-h')); i++) await endDay(1);
    }
  }

  // 24. 최종 결산
  const failed = await exists('#failure-h');
  await scene(failed ? '경영 실패와 결산' : '90일 캠페인 결산', '통화마다 따로 결산 · USD와 KRW는 더하지 않습니다');
  await page.waitForSelector('#settlement-h', { timeout: 15000 });
  await smoothTo(failed ? '#failure-h' : '#settlement-h', 'top');
  await hold(14);
  await smoothTo('.settlement .books', 'top');
  await hold(14);
  await smoothBy(520);
  await hold(12);
  await smoothTop();
  await scene('마무리 — 최종 상태 막대', '90일 운영 끝');
  await hold(16);
} catch (error) {
  summaryError = error.stack || error.message;
  log('오류:', summaryError);
  await page.screenshot({ path: path.join(opts.out, 'record-error.png') }).catch(() => {});
}

const durationWall = now();
const video = page.video();
await context.close();
await browser.close();
const rawPath = await video.path();
const webm = path.join(opts.out, 'scitrade-playthrough.webm');
const mp4 = path.join(opts.out, 'scitrade-playthrough.mp4');
fs.renameSync(rawPath, webm);
fs.rmSync(rawDir, { recursive: true, force: true });
let ffmpegError = null;
try {
  execFileSync(process.env.SCITRADE_FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'medium', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4], { stdio: ['ignore', 'inherit', 'inherit'] });
} catch (e) { ffmpegError = e.message; }
/** 영상의 장면 표지(오른쪽 아래 10px)를 10fps로 읽어 장면 시작 시각을 찾는다. 녹화 지연으로 벽시계와 어긋나는 것을 바로잡는다. */
function videoSceneTimes(file, count) {
  try {
    const fps = 10;
    const raw = execFileSync(process.env.SCITRADE_FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `fps=${fps},crop=6:6:${W - 8}:${H - 8},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
    const kinds = [];
    for (let i = 0; i + 2 < raw.length; i += 3) {
      const [r, g, b] = [raw[i], raw[i + 1], raw[i + 2]];
      kinds.push(r > 200 && g < 70 && b > 200 ? 'M' : r < 70 && g > 200 && b > 200 ? 'C' : null);
    }
    // 0.5초(5프레임) 이상 이어진 같은 색 구간만 장면으로 본다. 다시 그리기 중 잠깐 섞인 프레임을 걸러 낸다.
    const runs = [];
    for (let i = 0; i < kinds.length; i++) {
      if (!kinds[i]) continue;
      const last = runs.at(-1);
      if (last && last.kind === kinds[i] && last.end === i - 1) last.end = i;
      else runs.push({ kind: kinds[i], start: i, end: i });
    }
    const times = [];
    let expect = 'M';
    for (const r of runs) {
      if (times.length >= count) break;
      if (r.kind === expect && r.end - r.start + 1 >= 5) { times.push(Math.round((r.start / fps) * 10) / 10); expect = expect === 'M' ? 'C' : 'M'; }
    }
    return times.length === count ? times : null;
  } catch { return null; }
}
const probe = (file) => {
  try { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim()); } catch { return null; }
};
const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : null);
const vt = videoSceneTimes(webm, scenes.length);
if (vt) scenes.forEach((sc, i) => { sc.wall_s = sc.start_s; sc.start_s = vt[i]; sc.start = mmss(vt[i]); });
else notes.push('영상 장면 표지를 읽지 못해 장면 시각은 벽시계 기준입니다');
const summary = {
  ok: !summaryError && !ffmpegError && pageErrors.length === 0,
  scenario: SCENARIO_ID,
  quick: opts.quick,
  minutes_target: opts.minutes,
  duration_s: { wall: Math.round(durationWall * 10) / 10, webm: probe(webm), mp4: fs.existsSync(mp4) ? probe(mp4) : null },
  files: { webm, webm_bytes: size(webm), mp4: fs.existsSync(mp4) ? mp4 : null, mp4_bytes: size(mp4) },
  scene_times_from: vt ? 'video-marker' : 'wall-clock',
  scenes,
  notes,
  chapters_txt: scenes.map((s) => `${s.start} ${s.title}`).join('\n'),
  skipped,
  page_errors: pageErrors,
  console_errors: consoleErrors,
  blocked_hosts: [...blocked].sort(),
  error: summaryError,
  ffmpeg_error: ffmpegError,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
