import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SITUATION_BUTTON, startUi } from './main-testkit';
import { loadScenario } from '../content/scenario';
import { commitDay, createGame, openDay } from '../engine/engine';
import { serializeSave } from '../engine/save';
import { runToCampaignEnd } from '../engine/testkit';
import { tradePairs } from '../engine/reports';
import { initialUiState } from './session';

// TASK-0087 학생 문구 수정 뒤 채집. 빌드 표시를 dev로 맞춘 전체 HTML의 SHA-256.
const BASE_HTML = {"first": "58a5feda72f574f1d3732657c1159528a3e973728cf7b7318ce177c2ff8de595", "panel": "cf99c7e51d70498ca9fadc370d41f136bc20c4168e981387819fdeb4bf058e91", "ops": "f637f474d94bc5306e194e71b33c5b60166479c168128fd005f955c68f2fa286"};
const BASE_COPY = {
  "local": "(city) => `${city} 현지`",
  "closeLocal": "(city) => `${city} 현지 닫기`",
  "book": "(city) => `${city} 기록장`",
  "bookToggle": "(city, open) => `${city} 기록장 ${open ? \"닫기\" : \"열기\"}`",
  "close": "닫기",
  "newResult": "새 기록 있음",
  "places": "(count) => `장소 ${count}곳`",
  "intro": "열어 보기만 하면 시간·돈이 들지 않습니다. 날짜는 위쪽 ‘하루 진행 ▶’으로만 넘어갑니다.",
  "venues": {
    "VEN_TRADE": [
      "견적·계약은 ‘거래·계약’ 칸의 견적판에서 합니다.",
      "견적·계약은 ‘거래·계약’ 칸, 동료 현장 조사는 ‘동료’ 칸에서 합니다."
    ],
    "VEN_PORT": [
      "운송편 예약은 각 계약 카드에서 합니다.",
      "운송편 예약은 각 계약 카드, 동료 현장 조사는 ‘동료’ 칸에서 합니다."
    ],
    "VEN_LOUNGE": [
      "이번 판에서는 여기서 할 일이 없습니다.",
      "동료 현장 조사는 ‘동료’ 칸에서 합니다."
    ],
    "VEN_CULTURE": [
      "직원 1명을 보내 만난 사람의 말과 그 말이 닿는 범위를 네 칸으로 기록합니다. 아래에서 고릅니다."
    ],
    "VEN_FINANCE": [
      "주식 거래와 상장(회사 주식을 시장에 내놓기)은 이번 판에 없습니다. 현금은 위쪽 막대와 ‘경영 보고’에서 봅니다."
    ]
  },
  "frame": "현지 활동 기록은 네 칸으로 남습니다.",
  "fields": [
    [
      "알게 된 점",
      "누가 무엇을 말했나",
      "findingKo"
    ],
    [
      "범위",
      "몇 명·어디·언제 확인했나",
      "scopeKo"
    ],
    [
      "이 기록이 말하지 않는 것",
      "넓혀 읽으면 안 되는 것",
      "notClaimedKo"
    ],
    [
      "아직 모르는 것",
      "다음에 확인할 것",
      "openQuestionKo"
    ]
  ],
  "limit": "넓혀 읽지 않기",
  "chooseActivity": "① 활동 고르기",
  "activityGroup": "현지 활동 고르기",
  "activityFacts": "(cost, days, contacts) => `${cost} · 기간 ${days}일 · 만나는 사람: ${contacts}`",
  "topic": "(title) => `기록 주제: ${title}`",
  "inQueue": "(employee) => `오늘 할 일에 넣음 — ${employee}`",
  "chooseEmployee": "② 갈 직원 고르기",
  "employeeHint": "(city) => `${city}에 있고 오늘 쉬는 직원만 고를 수 있습니다`",
  "starts": "(day) => `${day}일부터 근무`",
  "preview": "(employee, title) => `미리 보기 — ${employee} · ${title}`",
  "costLabel": "이 활동에 쓰는 것",
  "cost": "(days, cost) => `직원 1명의 ${days === 1 ? \"하루\" : `${days}일`} 업무 · 원화 ${cost}`",
  "busy": "(employee, from, until) => `${employee}: ${from === until ? `오늘(${from}일) 하루` : `${from}~${until}일`} 동안 다른 업무를 맡을 수 없습니다.`",
  "waiting": "(subject, name, left, departure) => `⚠ 기다리는 업무: ${subject ? `${subject} ` : \"\"}${name} ${left}pt${departure === null ? \"\" : ` (${departure}일 출항편 예약됨)`} — 아직 아무에게도 배정하지 않았습니다.`",
  "otherEmployees": "(city, names) => `오늘 쉬는 다른 ${city} 직원: ${names.length ? names.join(\" · \") : \"없음. 이 활동을 하면 오늘 이 업무를 맡을 사람이 없습니다.\"}`",
  "finish": "(day) => `끝나는 날: ${day}일`",
  "campaignWarning": "(days) => `⚠ 캠페인 마지막 날(${days}일)까지 끝나지 않습니다. 기록·경험치는 생기지 않고 활동비는 나갑니다.`",
  "funds": "(before, after, planned) => `활동에 쓸 수 있는 원화: 지금 ${before} → 활동 뒤 ${after}${planned ? \" (오늘 할 일 반영)\" : \"\"}`",
  "runway": "(before, after) => `원화 급여 지급 가능일: 지금 ${before} → 활동하면 ${after}`",
  "runwayEnd": "(days) => `${days}일(캠페인 끝)까지`",
  "runwayUnpaid": "없음",
  "runwayDay": "(day) => `${day}일까지`",
  "wages": "급여는 활동비와 별도로 평소대로 지급합니다.",
  "unpaid": "(day, already) => `⚠ ${already ? \"지금도\" : \"이 활동비를 내면\"} 오늘(${day}일) 급여 일부가 미지급으로 남습니다.`",
  "newRecords": "(xp) => xp ? \"새로 생길 기록과 경험치\" : \"새로 생길 기록\"",
  "companyNew": "(topic) => `회사 보고서(처음 생김) — ${topic}`",
  "companyExists": "회사 보고서는 이미 있어 새로 생기지 않음",
  "experience": "(employee) => `${employee}의 직접 경험 기록`",
  "together": "(pairs) => `함께한 활동: ${pairs.join(\" · \")}`",
  "xp": "(amount) => `첫 완료 경험치 +${amount}`",
  "unchanged": "바뀌지 않는 것",
  "unchangedResult": "바뀌지 않은 것",
  "denied": "(reason) => `⚠ 시작할 수 없음: ${reason}`",
  "noNewRecords": "시작할 수 없으므로 새로 생기는 기록이 없습니다.",
  "queue": "오늘 할 일에 넣기",
  "queued": "현지 활동 예정",
  "queueHint": "넣기만 해서는 시간이 흐르지 않습니다. 활동비는 ‘하루 진행’ 때 나갑니다.",
  "unqueueHint": "빼려면 ‘오늘 할 일’에서 ‘빼기’를 누르세요.",
  "recordDate": "(day, activity, newReport) => `${day}일 ${newReport ? \"기록\" : \"활동\"} · ${activity}`",
  "source": "(names) => `출처 ${names.length}명: ${names.join(\", \")}`",
  "unverified": "다른 출처로 아직 확인하지 않은 기록",
  "reporter": "(employee) => `기록한 직원 ${employee}`",
  "existingReport": "(day, employee) => `회사 보고서는 ${day}일에 이미 있습니다. 네 칸은 그대로입니다. · 이번 활동 직원 ${employee}`",
  "spent": "쓴 것",
  "spentText": "(employee, from, until, cost) => `${employee}의 ${from === until ? `하루 업무(${from}일)` : `${from}~${until}일 업무`} · 원화 ${cost}`",
  "bookHint": "회사 보고서·직원의 직접 경험 기록·함께한 활동은 서로 다른 기록입니다.",
  "reports": "회사 보고서",
  "emptyReports": "회사 보고서가 없습니다. 현지 활동을 마치면 위의 네 칸으로 남습니다.",
  "experiences": "직원의 직접 경험 기록",
  "experienceHint": "그 직원이 직접 듣고 본 기록입니다. 기록 자체는 능력·처리량을 바꾸지 않습니다.",
  "emptyExperiences": "직접 경험 기록이 없습니다.",
  "relations": "함께한 활동",
  "relationHint": "점수가 아니라 누가 누구와 무엇을 함께했는지 적은 기록입니다.",
  "emptyRelations": "함께한 활동이 없습니다.",
  "contacts": "만난 사람",
  "emptyContacts": "만난 사람이 없습니다.",
  "experienceEntry": "(employee, activity, day) => `${employee} — ${activity} (${day}일)`",
  "relationEntry": "(employee, contact, activity, day) => `${employee} — ${contact} · ${activity} (${day}일)`",
  "trust": "거래 신뢰는 계약을 약속대로 지켰는지에서만 나옵니다. 현지 활동은 이것을 바꾸지 않습니다.",
  "resultButton": "결과 보기",
  "toastOne": "(day, topic, employee) => `${day}일 현지 활동 기록: ${topic} — ${employee}`",
  "toastRepeat": "(day, topic, employee, reportDay) => `${day}일 현지 활동: ${topic} — ${employee} (회사 보고서는 ${reportDay}일에 이미 있음)`",
  "toastMany": "(day, topics, newReports) => `${day}일 현지 활동 ${newReports === topics.length ? \"기록 \" : \"\"}${topics.length}건${newReports === topics.length ? \"\" : newReports === 0 ? \"(회사 보고서는 모두 이미 있음)\" : `(새 회사 보고서 ${newReports}건)`}: ${topics.map((t) => `‘${t}’`).join(\", \")}`",
  "toastRejected": "(day, reasons) => `실행하지 못한 명령: ${reasons.join(\" / \")} · ${day}일 현지 활동 기록이 있습니다.`"
};
// bd10189에서 만든 저장 문자열.
const legacySave = "{\"format\":\"scitrade-save\",\"formatVersion\":7,\"engineVersion\":\"0.2.0\",\"rulesVersion\":\"M2a-rules-1\",\"dataVersion\":\"0.5.0\",\"scenarioId\":\"SCENARIO_M2_MULTI_TRADE\",\"state\":{\"meta\":{\"engineVersion\":\"0.2.0\",\"rulesVersion\":\"M2a-rules-1\",\"dataVersion\":\"0.5.0\",\"scenarioId\":\"SCENARIO_M2_MULTI_TRADE\"},\"day\":1,\"phase\":\"AWAITING_INPUT\",\"rng\":{\"seed\":42032026,\"cursors\":{}},\"ledger\":{\"entries\":[{\"id\":\"OPENING-USD\",\"day\":0,\"currency\":\"USD\",\"lines\":[{\"account\":\"CASH\",\"amount\":300000},{\"account\":\"OPENING_EQUITY\",\"amount\":-300000}],\"reason\":\"시작 자금\"},{\"id\":\"OPENING-KRW\",\"day\":0,\"currency\":\"KRW\",\"lines\":[{\"account\":\"CASH\",\"amount\":10000000},{\"account\":\"OPENING_EQUITY\",\"amount\":-10000000}],\"reason\":\"시작 자금\"}],\"postedIds\":{\"OPENING-USD\":true,\"OPENING-KRW\":true}},\"offers\":[{\"id\":\"OFFER_BUY_01\",\"status\":\"OPEN\"},{\"id\":\"OFFER_SELL_01\",\"status\":\"OPEN\"},{\"id\":\"OFFER_BUY_02\",\"status\":\"OPEN\"},{\"id\":\"OFFER_SELL_02\",\"status\":\"OPEN\"},{\"id\":\"OFFER_FWD_01\",\"status\":\"OPEN\"},{\"id\":\"OFFER_FWD_02\",\"status\":\"OPEN\"}],\"contracts\":[],\"cargoLots\":[],\"bookings\":[],\"shipments\":[],\"tasks\":[],\"employees\":[{\"id\":\"EMP01\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"employed\",\"availableFromDay\":1},{\"id\":\"EMP02\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"employed\",\"availableFromDay\":1},{\"id\":\"EMP03\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"candidate\",\"availableFromDay\":1},{\"id\":\"EMP04\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"candidate\",\"availableFromDay\":1},{\"id\":\"EMP05\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"candidate\",\"availableFromDay\":1},{\"id\":\"EMP06\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"candidate\",\"availableFromDay\":1}],\"recruitment\":{\"candidates\":[{\"employeeId\":\"EMP03\",\"stage\":\"UNDISCOVERED\",\"discoveredDay\":null,\"questTaskId\":null,\"interviewReadyDay\":null,\"hiredDay\":null},{\"employeeId\":\"EMP04\",\"stage\":\"UNDISCOVERED\",\"discoveredDay\":null,\"questTaskId\":null,\"interviewReadyDay\":null,\"hiredDay\":null},{\"employeeId\":\"EMP05\",\"stage\":\"UNDISCOVERED\",\"discoveredDay\":null,\"questTaskId\":null,\"interviewReadyDay\":null,\"hiredDay\":null},{\"employeeId\":\"EMP06\",\"stage\":\"UNDISCOVERED\",\"discoveredDay\":null,\"questTaskId\":null,\"interviewReadyDay\":null,\"hiredDay\":null}],\"scoutedVenueIds\":[]},\"culture\":{\"reports\":[],\"experiences\":[],\"relationEvents\":[]},\"operations\":null,\"invoices\":[],\"obligations\":[],\"notices\":[],\"delayDecisions\":[],\"appliedEventIds\":{},\"xpAwards\":{},\"xpAwardAmounts\":{},\"processedCommands\":{},\"closedDays\":[],\"log\":[]}}";
// bd10189에서 만든 저장 문자열.
const opsSave = "{\"format\":\"scitrade-save\",\"formatVersion\":7,\"engineVersion\":\"0.2.0\",\"rulesVersion\":\"M2a-rules-2\",\"dataVersion\":\"0.5.0\",\"scenarioId\":\"SCENARIO_M2_OPERATIONS\",\"state\":{\"meta\":{\"engineVersion\":\"0.2.0\",\"rulesVersion\":\"M2a-rules-2\",\"dataVersion\":\"0.5.0\",\"scenarioId\":\"SCENARIO_M2_OPERATIONS\"},\"day\":1,\"phase\":\"AWAITING_INPUT\",\"rng\":{\"seed\":42032026,\"cursors\":{}},\"ledger\":{\"entries\":[{\"id\":\"OPENING-USD\",\"day\":0,\"currency\":\"USD\",\"lines\":[{\"account\":\"CASH\",\"amount\":300000},{\"account\":\"OPENING_EQUITY\",\"amount\":-300000}],\"reason\":\"시작 자금\"},{\"id\":\"OPENING-KRW\",\"day\":0,\"currency\":\"KRW\",\"lines\":[{\"account\":\"CASH\",\"amount\":10000000},{\"account\":\"OPENING_EQUITY\",\"amount\":-10000000}],\"reason\":\"시작 자금\"}],\"postedIds\":{\"OPENING-USD\":true,\"OPENING-KRW\":true}},\"offers\":[{\"id\":\"OFFER_BUY_01\",\"status\":\"OPEN\"},{\"id\":\"OFFER_SELL_01\",\"status\":\"OPEN\"},{\"id\":\"OFFER_BUY_02\",\"status\":\"OPEN\"},{\"id\":\"OFFER_SELL_02\",\"status\":\"OPEN\"},{\"id\":\"OFFER_FWD_01\",\"status\":\"OPEN\"},{\"id\":\"OFFER_FWD_02\",\"status\":\"OPEN\"}],\"contracts\":[],\"cargoLots\":[],\"bookings\":[],\"shipments\":[],\"tasks\":[],\"employees\":[{\"id\":\"EMP01\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"employed\",\"availableFromDay\":1},{\"id\":\"EMP02\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"employed\",\"availableFromDay\":1},{\"id\":\"EMP03\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"candidate\",\"availableFromDay\":1},{\"id\":\"EMP04\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"candidate\",\"availableFromDay\":1},{\"id\":\"EMP05\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"candidate\",\"availableFromDay\":1},{\"id\":\"EMP06\",\"xp\":0,\"locationCityId\":\"PYEONGTAEK\",\"employmentStatus\":\"candidate\",\"availableFromDay\":1}],\"recruitment\":{\"candidates\":[{\"employeeId\":\"EMP03\",\"stage\":\"UNDISCOVERED\",\"discoveredDay\":null,\"questTaskId\":null,\"interviewReadyDay\":null,\"hiredDay\":null},{\"employeeId\":\"EMP04\",\"stage\":\"UNDISCOVERED\",\"discoveredDay\":null,\"questTaskId\":null,\"interviewReadyDay\":null,\"hiredDay\":null},{\"employeeId\":\"EMP05\",\"stage\":\"UNDISCOVERED\",\"discoveredDay\":null,\"questTaskId\":null,\"interviewReadyDay\":null,\"hiredDay\":null},{\"employeeId\":\"EMP06\",\"stage\":\"UNDISCOVERED\",\"discoveredDay\":null,\"questTaskId\":null,\"interviewReadyDay\":null,\"hiredDay\":null}],\"scoutedVenueIds\":[]},\"culture\":{\"reports\":[],\"experiences\":[],\"relationEvents\":[]},\"operations\":{\"batches\":[{\"k\":0,\"publishDay\":1,\"index\":[{\"goodId\":\"APPAREL\",\"bp\":10000,\"stepPct\":null},{\"goodId\":\"COSMETICS\",\"bp\":10000,\"stepPct\":null}],\"destinations\":null,\"rows\":[{\"cityId\":\"PYEONGTAEK\",\"goodId\":\"APPAREL\",\"side\":\"BUY\",\"basePriceMinor\":1000,\"regionalPct\":0},{\"cityId\":\"PYEONGTAEK\",\"goodId\":\"COSMETICS\",\"side\":\"BUY\",\"basePriceMinor\":4000,\"regionalPct\":0},{\"cityId\":\"HAIPHONG\",\"goodId\":\"APPAREL\",\"side\":\"SELL\",\"basePriceMinor\":1520,\"regionalPct\":0},{\"cityId\":\"HAIPHONG\",\"goodId\":\"COSMETICS\",\"side\":\"SELL\",\"basePriceMinor\":5170,\"regionalPct\":0},{\"cityId\":\"SHANGHAI\",\"goodId\":\"APPAREL\",\"side\":\"SELL\",\"basePriceMinor\":1455,\"regionalPct\":0},{\"cityId\":\"SHANGHAI\",\"goodId\":\"COSMETICS\",\"side\":\"SELL\",\"basePriceMinor\":5300,\"regionalPct\":0}],\"counterpartyPct\":null,\"maxLots\":null,\"templateIds\":[],\"offerIds\":[\"OFFER_BUY_01\",\"OFFER_SELL_01\",\"OFFER_BUY_02\",\"OFFER_SELL_02\",\"OFFER_FWD_01\",\"OFFER_FWD_02\"],\"drawCount\":0}],\"offers\":[],\"expansions\":[],\"handlingLog\":[],\"spaceContracts\":[],\"exchanges\":[],\"defaultEvents\":[],\"outcome\":\"IN_PROGRESS\",\"failure\":null},\"invoices\":[],\"obligations\":[],\"notices\":[],\"delayDecisions\":[],\"appliedEventIds\":{},\"xpAwards\":{},\"xpAwardAmounts\":{},\"processedCommands\":{},\"closedDays\":[],\"log\":[]}}";

const opsSaveV6 = opsSave.replace('"formatVersion":7', '"formatVersion":6');

type Kind = 'ops' | 'culture';
const calls = { ops: 0, culture: 0 };
const failures = { ops: 0, culture: 0 };
const moduleMapMemory = { ops: false, culture: false };
const rememberedFailure = { ops: false, culture: false };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const gates: Partial<Record<Kind, ReturnType<typeof deferred>>> = {};
let situationCalls = 0;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
// 새 진입 단추 조각만 정확히 빼고 기존 전체 HTML 보호값을 대조한다.
const normalizeArtHtml = (html: string) => html.replace(/ creature-(animal|myth_inspired|none)/g, '').replace(/<button[^>]*data-action="open-office"[^>]*>사무실 보기<\/button>/g, '');
const hash = async (html: string) => {
  html = normalizeArtHtml(html);
  expect(html.match(/<option value="SCENARIO_M2_OPS_CREDIT"[^>]*>[^<]*<\/option>/g)).toHaveLength(1);
  html = html.replace(/<option value="SCENARIO_M2_OPS_CREDIT"[^>]*>[^<]*<\/option>/g, '');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html.replace(SITUATION_BUTTON, '').replace(/빌드 [^<]+/, '빌드 dev'))))].map((n) => n.toString(16).padStart(2, '0')).join('');
};
const opsId = 'SCENARIO_M2_OPERATIONS';
const legacyId = 'SCENARIO_M2_MULTI_TRADE';
const warning = '화면 일부를 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요.';
const reloadWarning = '화면 일부를 불러오지 못했습니다. 연결을 확인한 뒤 저장하고 새로 고침해 주세요.';
const loadReloadWarning = '화면 일부를 불러오지 못했습니다. 새로 고침한 뒤 ‘불러오기’를 다시 눌러 주세요. 저장된 상태는 그대로 있습니다.';

beforeEach(() => {
  situationCalls = 0;
  calls.ops = calls.culture = failures.ops = failures.culture = 0;
  moduleMapMemory.ops = moduleMapMemory.culture = rememberedFailure.ops = rememberedFailure.culture = false;
  delete gates.ops; delete gates.culture;
  vi.doMock('./lazy', async (importOriginal) => {
    const original = await importOriginal<typeof import('./lazy')>();
    return { ...original, lazyScreen<T>(loader: () => Promise<T>) {
      return original.lazyScreen(async () => {
        if (loader.toString().includes('office-scene')) return loader();
        if (loader.toString().includes('situation')) { situationCalls++; return loader(); }
        const kind: Kind = loader.toString().includes('ops-screens') ? 'ops' : 'culture';
        calls[kind]++;
        if (rememberedFailure[kind]) throw new Error('시험용 모듈 맵에 남은 실패');
        await gates[kind]?.promise;
        if (failures[kind]-- > 0) {
          rememberedFailure[kind] = moduleMapMemory[kind];
          throw new Error('시험용 불러오기 실패');
        }
        return loader();
      });
    } };
  });
});
afterEach(() => {
  vi.doUnmock('./lazy'); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function freshUi(config?: Parameters<typeof startUi>[0]) {
  const ui = await startUi(config);
  vi.clearAllTimers();
  return ui;
}
const pendingHtml = (html: string) => html.match(/<ol class="pending">[\s\S]*?<\/ol>/)?.[0];
function storage() {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value) });
  return items;
}
function readState(ui: Awaited<ReturnType<typeof startUi>>, items: Map<string, string>) {
  ui.click({ action: 'save' });
  return items.get('scitrade-save');
}

describe('TASK-0059 지연 화면 진입', () => {
  it('TASK-0061 첫 렌더는 상황실 모듈을 불러오지 않는다', async () => {
    const ui = await freshUi();
    expect(ui.app.innerHTML).toContain(SITUATION_BUTTON);
    expect(situationCalls).toBe(0);
  });
  it('첫 렌더·첫 수락 뒤·결산은 screensReady 없이 TASK-0033 sha256 세 개와 같다', async () => {
    gates.ops = deferred(); gates.culture = deferred();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    const ui = await freshUi(), config = loadScenario(legacyId);
    const culture = await import('./culture');
    const state = openDay(createGame(config), config).state;
    expect(culture.culturePanel(state, state, [], config, initialUiState())).toBe('');
    // hash는 빌드 표시를 dev로 맞추므로 TASK-0033 문자열의 BASE 표시는 별도로 보존한다.
    const digest = async (html: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeArtHtml(html).replace(SITUATION_BUTTON, '').replace(/<select data-action="scenario">[\s\S]*?<\/select>/, '').replace(/빌드 [^<]+/, '빌드 BASE'))))].map((n) => n.toString(16).padStart(2, '0')).join('');
    expect(await digest(ui.app.innerHTML)).toBe('2b9b01f74e68b28dbe1173b675f5ea75a674341677e0f67cffcf4a0e91e0dd76');
    expect(await hash(ui.app.innerHTML)).toBe(BASE_HTML.first);
    const pair = tradePairs(config)[0]!;
    await ui.click({ action: 'accept', buy: pair.buyOfferId, sell: pair.sellOfferId });
    expect(await digest(ui.app.innerHTML)).toBe('af80f46e7aa2e31c371a6eaa66a36924f80a127b60d6fe4575c5aadcb5ac8b1e');
    await ui.importText(serializeSave(runToCampaignEnd(createGame(config), config).state));
    expect(await digest(ui.app.innerHTML)).toBe('f06fcf793c53d9cfc4bf63fa174f50b8e37de335c1e6891231f400e6444fe694');
    expect(calls).toEqual({ ops: 0, culture: 0 });
  });
  it('규칙 2 묶음을 기다린 뒤 시나리오·전체 HTML을 바꾼다', async () => {
    gates.ops = deferred();
    const ui = await freshUi(), before = ui.app.innerHTML;
    const change = ui.change({ action: 'scenario' }, opsId);
    await flush();
    expect(calls.ops).toBe(1);
    expect(ui.app.innerHTML).toBe(before);
    expect(ui.doc.title).toContain(loadScenario(legacyId).titleKo);
    gates.ops.resolve(); await change;
    expect(ui.doc.title).toContain(loadScenario(opsId).titleKo);
    expect(await hash(ui.app.innerHTML)).toBe(BASE_HTML.ops);
  });
  it('실패하면 상태·오늘 할 일·select를 보존하고 다음 진입에서 다시 받는다', async () => {
    const ui = await freshUi(), items = storage();
    ui.click({ action: 'accept' });
    const state = readState(ui, items), pending = pendingHtml(ui.app.innerHTML);
    const selector = { ...ui.rendered({ action: 'scenario' }), value: opsId };
    // 실제 사건의 select 객체를 보존해서 되돌림을 검사한다.
    const change = ui.changeTarget;
    failures.ops = 1;
    await change(selector);
    expect(selector.value).toBe(legacyId);
    expect(ui.app.innerHTML).toContain(`flash warn`);
    expect(ui.app.innerHTML).toContain(warning);
    expect(pendingHtml(ui.app.innerHTML)).toBe(pending);
    expect(readState(ui, items)).toBe(state);
    selector.value = opsId;
    await change(selector);
    expect(calls.ops).toBe(2);
    expect(await hash(ui.app.innerHTML)).toBe(BASE_HTML.ops);
  });
  it.each(['load', 'import'] as const)('규칙 2 기준 저장의 %s는 화면을 먼저 받으며 실패한 상태를 보존한다', async (mode) => {
    const ui = await freshUi(), items = storage();
    ui.click({ action: 'accept' });
    const state = readState(ui, items), pending = pendingHtml(ui.app.innerHTML);
    gates.ops = deferred(); failures.ops = 1;
    items.set('scitrade-save', opsSave);
    const load = mode === 'load' ? ui.click({ action: 'load' }) : ui.importText(opsSave);
    await flush();
    expect(ui.doc.title).toContain(loadScenario(legacyId).titleKo);
    expect(pendingHtml(ui.app.innerHTML)).toBe(pending);
    gates.ops.resolve(); await load;
    expect(ui.app.innerHTML).toContain(warning);
    expect(pendingHtml(ui.app.innerHTML)).toBe(pending);
    expect(readState(ui, items)).toBe(state);
    items.set('scitrade-save', opsSave);
    await (mode === 'load' ? ui.click({ action: 'load' }) : ui.importText(opsSave));
    expect(calls.ops).toBe(2);
    expect(readState(ui, items)).toBe(opsSave);
    // 성공 알림을 비운 첫 화면은 기준 정적 import와 같다.
    await ui.change({ action: 'scenario' }, opsId);
    expect(await hash(ui.app.innerHTML)).toBe(BASE_HTML.ops);
  });
  it.each(['load', 'import'] as const)('규칙 1 기준 저장의 %s는 지연 화면 없이 같은 엔진 상태로 열린다', async (mode) => {
    const ui = await freshUi(), items = storage();
    items.set('scitrade-save', legacySave);
    await (mode === 'load' ? ui.click({ action: 'load' }) : ui.importText(legacySave));
    expect(readState(ui, items)).toBe(legacySave);
    expect(calls.ops).toBe(0);
  });
  it.each(['culture-tab', 'culture-result'] as const)('%s는 패널을 기다리고 실패하면 닫힌 채 재시도한다', async (action) => {
    const original = loadScenario(legacyId);
    // 이틀 활동을 미리 시작한 저장으로, 패널을 받지 않고 하루 진행에서 결과 단추를 만든다.
    const config = { ...original, culture: { ...original.culture!, activities: original.culture!.activities.map((a) => ({ ...a, durationDays: 2 })) } };
    const ui = await freshUi(config);
    if (action === 'culture-result') {
      const dayTwo = openDay(commitDay(openDay(createGame(config), config).state, config, []).state, config).state;
      const running = openDay(commitDay(dayTwo, config, [{ id: 'CULTURE-TEST', type: 'START_CULTURE_ACTIVITY', activityId: 'CA01', employeeId: 'EMP01' }]).state, config).state;
      await ui.importText(serializeSave(running));
      await ui.click({ action: 'end-day' });
      expect(calls.culture).toBe(0);
      expect(ui.app.innerHTML).toContain('data-action="culture-result"');
    }
    gates.culture = deferred(); failures.culture = 1;
    const button = ui.rendered({ action });
    const opening = ui.click({ action }); await flush();
    expect(ui.app.innerHTML).not.toContain('id="local"');
    expect(ui.focusIds).not.toContain('local-h');
    gates.culture.resolve(); await opening;
    expect(ui.app.innerHTML).not.toContain('id="local"'); expect(ui.app.innerHTML).toContain(warning);
    vi.advanceTimersByTime(501);
    await ui.clickTarget(button);
    expect(calls.culture).toBe(2);
    expect(ui.app.innerHTML).toContain('aria-expanded="true" aria-controls="local-body"');
    const heading = action === 'culture-result' ? /^culture-result-h-/ : /^local-h$/;
    expect(ui.focusIds.at(-1)).toMatch(heading); expect(ui.scrollIds.at(-1)).toMatch(heading);
  });
  it('열린 문화 패널 HTML은 정적 import 기준과 바이트가 같다', async () => {
    const ui = await freshUi(); await ui.click({ action: 'culture-tab' });
    expect(await hash(ui.app.innerHTML)).toBe(BASE_HTML.panel);
  });
  it('문구를 합치면 기준과 같은 모든 키·값·문구 함수가 남는다', async () => {
    const light = await import('./culture'), panel = await import('./culture-panel');
    expect(Object.keys(light.CULTURE_KO).filter((key) => key in panel.CULTURE_PANEL_KO)).toEqual([]);
    const copy = { ...light.CULTURE_KO, ...panel.CULTURE_PANEL_KO };
    expect(Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, typeof value === 'function' ? value.toString() : value]))).toEqual(BASE_COPY);
  });
  it('시나리오를 기다리는 중 두 번 하루 진행·문화 탭에도 상태가 섞이지 않고 import는 한 번이다', async () => {
    const ui = await freshUi(); gates.ops = deferred();
    const engine = await import('../engine/engine');
    const create = vi.spyOn(engine, 'createGame');
    const before = ui.app.innerHTML;
    const change = ui.change({ action: 'scenario' }, opsId); await flush();
    ui.clickNow({ action: 'end-day' }); ui.clickNow({ action: 'end-day' });
    ui.clickNow({ action: 'culture-tab' }); ui.clickNow({ action: 'culture-tab' });
    expect(ui.app.innerHTML).toBe(before);
    expect(ui.doc.title).toContain(loadScenario(legacyId).titleKo);
    expect(calls).toEqual({ ops: 1, culture: 0 });
    expect(create).not.toHaveBeenCalled();
    gates.ops.resolve(); await change;
    expect(create).toHaveBeenCalledOnce();
    expect(await hash(ui.app.innerHTML)).toBe(BASE_HTML.ops);
  });
  it('문화 탭 두 번은 약속 하나와 열기 결과를 공유한다', async () => {
    const ui = await freshUi(); gates.culture = deferred();
    const first = ui.clickNow({ action: 'culture-tab' }), second = ui.clickNow({ action: 'culture-tab' });
    await flush(); expect(calls.culture).toBe(1);
    gates.culture.resolve(); await Promise.all([first, second]);
    expect(await hash(ui.app.innerHTML)).toBe(BASE_HTML.panel);
    expect(ui.scrollIds.filter((id) => id === 'local-h')).toHaveLength(1);
  });
  it('모듈 맵 기억: 시나리오 고르기는 두 번 뒤 새로 고침을 안내하고 상태·select·오늘 할 일을 보존한다', async () => {
    const ui = await freshUi(), items = storage();
    await ui.click({ action: 'accept' });
    const state = readState(ui, items), pending = pendingHtml(ui.app.innerHTML);
    const selector = { ...ui.rendered({ action: 'scenario' }), value: opsId };
    moduleMapMemory.ops = true; failures.ops = 1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      selector.value = opsId;
      await ui.changeTarget(selector);
      expect(calls.ops).toBe(Math.min(attempt, 2));
      expect(ui.app.innerHTML).toContain(attempt === 1 ? warning : reloadWarning);
      expect(ui.app.innerHTML.includes('data-action="reload"')).toBe(attempt > 1);
      expect(selector.value).toBe(legacyId);
      expect(ui.doc.title).toContain(loadScenario(legacyId).titleKo);
      expect(ui.app.innerHTML).toContain(`<option value="${legacyId}" selected>`);
      expect(pendingHtml(ui.app.innerHTML)).toBe(pending);
      expect(readState(ui, items)).toBe(state);
    }
    // 규칙 2 묶음의 상한은 문화 패널 묶음에 영향을 주지 않는다.
    await ui.click({ action: 'culture-tab' });
    expect(calls.culture).toBe(1);
    expect(ui.app.innerHTML).toContain('id="local"');
  });
  it('모듈 맵 기억: 문화 패널은 두 번 뒤 새로 고침을 안내하고 닫힌 채 상태·오늘 할 일을 보존한다', async () => {
    const ui = await freshUi(), items = storage();
    await ui.click({ action: 'accept' });
    const state = readState(ui, items), pending = pendingHtml(ui.app.innerHTML);
    moduleMapMemory.culture = true; failures.culture = 1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await ui.click({ action: 'culture-tab' });
      expect(calls.culture).toBe(Math.min(attempt, 2));
      expect(ui.app.innerHTML).toContain(attempt === 1 ? warning : reloadWarning);
      expect(ui.app.innerHTML.includes('data-action="reload"')).toBe(attempt > 1);
      expect(ui.app.innerHTML).not.toContain('id="local"');
      expect(ui.focusIds).not.toContain('local-h');
      expect(ui.doc.title).toContain(loadScenario(legacyId).titleKo);
      expect(pendingHtml(ui.app.innerHTML)).toBe(pending);
      expect(readState(ui, items)).toBe(state);
    }
  });
  it.each(['ops', 'culture'] as const)('미리 받기 실패 뒤 %s 첫 진입 실패는 곧바로 새로 고침을 안내한다', async (kind) => {
    moduleMapMemory[kind] = true; failures[kind] = 1;
    // 다른 묶음은 진행 중인 채 두어 미리 받기의 실패만 관찰한다.
    gates[kind === 'ops' ? 'culture' : 'ops'] = deferred();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ui = await startUi(), before = ui.app.innerHTML;
    vi.advanceTimersByTime(1); await flush();
    expect(calls[kind]).toBe(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(warning);
    expect(ui.app.innerHTML).toBe(before);
    const enter = () => kind === 'ops' ? ui.change({ action: 'scenario' }, opsId) : ui.click({ action: 'culture-tab' });
    await enter();
    expect(calls[kind]).toBe(2);
    expect(ui.app.innerHTML).toContain(reloadWarning);
    expect(ui.app.innerHTML).toContain('data-action="reload"');
    await enter();
    expect(calls[kind]).toBe(2);
    expect(ui.app.innerHTML).toContain(reloadWarning);
    expect(ui.app.innerHTML).not.toContain('id="local"');
    expect(ui.doc.title).toContain(loadScenario(legacyId).titleKo);
  });
  it.each(['load', 'import'] as const)('불러오기 문장: %s 상한 실패는 저장 칸을 보존하며 경로에 맞게 안내한다', async (mode) => {
    const ui = await freshUi(), items = storage();
    await ui.click({ action: 'accept' });
    const state = readState(ui, items), pending = pendingHtml(ui.app.innerHTML);
    items.set('scitrade-save', opsSave);
    moduleMapMemory.ops = true; failures.ops = 1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await (mode === 'load' ? ui.click({ action: 'load' }) : ui.importText(opsSave));
      expect(calls.ops).toBe(Math.min(attempt, 2));
      expect(ui.app.innerHTML).toContain(attempt === 1 ? warning : mode === 'load' ? loadReloadWarning : reloadWarning);
      expect(ui.app.innerHTML.includes('data-action="reload"')).toBe(attempt > 1);
      expect(items.get('scitrade-save')).toBe(opsSave);
      expect(ui.doc.title).toContain(loadScenario(legacyId).titleKo);
      expect(pendingHtml(ui.app.innerHTML)).toBe(pending);
      expect(ui.app.innerHTML).not.toContain('id="local"');
    }
    expect(readState(ui, items)).toBe(state);
  });
  it('새로 고침 단추: 저장 안 함 → 취소하면 대기열·알림 띠를 보존하고 이탈 확인도 유지한다', async () => {
    const ui = await freshUi();
    await ui.click({ action: 'accept' });
    moduleMapMemory.culture = true; failures.culture = 1;
    await ui.click({ action: 'culture-tab' }); await ui.click({ action: 'culture-tab' });
    const before = ui.app.innerHTML, pending = pendingHtml(before);
    expect(pending).toContain('<li');
    expect(before).toContain(reloadWarning);
    expect(before).toContain('data-action="reload"');
    const reload = vi.fn(); vi.stubGlobal('location', { reload });
    const confirm = vi.mocked(globalThis.confirm); confirm.mockClear(); confirm.mockReturnValue(false);
    await ui.click({ action: 'reload' });
    expect(confirm).toHaveBeenCalledExactlyOnceWith('새로 고침하면 저장하지 않은 진행과 오늘 할 일이 사라집니다. 새로 고칠까요?');
    expect(reload).not.toHaveBeenCalled();
    expect(ui.app.innerHTML).toBe(before);
    expect(pendingHtml(ui.app.innerHTML)).toBe(pending);
    const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    ui.fireWindow('beforeunload', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe('');
  });
  it('새로 고침 단추: 저장 안 함 → 수락하면 한 번만 새로 고치고 다음 이탈 확인 한 번만 건너뛴다', async () => {
    const ui = await freshUi();
    await ui.click({ action: 'accept' });
    moduleMapMemory.culture = true; failures.culture = 1;
    await ui.click({ action: 'culture-tab' }); await ui.click({ action: 'culture-tab' });
    const reload = vi.fn(); vi.stubGlobal('location', { reload });
    const confirm = vi.mocked(globalThis.confirm); confirm.mockClear(); confirm.mockReturnValue(true);
    await ui.click({ action: 'reload' });
    expect(confirm).toHaveBeenCalledExactlyOnceWith('새로 고침하면 저장하지 않은 진행과 오늘 할 일이 사라집니다. 새로 고칠까요?');
    expect(reload).toHaveBeenCalledOnce();
    const first = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    ui.fireWindow('beforeunload', first);
    expect(first.preventDefault).not.toHaveBeenCalled();
    expect(first.returnValue).toBeUndefined();
    const second = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    ui.fireWindow('beforeunload', second);
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(second.returnValue).toBe('');
  });
  it('새로 고침 단추: 저장함 → 바로 새로 고치며 앱 확인은 묻지 않는다', async () => {
    const ui = await freshUi();
    await ui.click({ action: 'accept' });
    await ui.click({ action: 'end-day' });
    storage();
    await ui.click({ action: 'save' });
    expect(pendingHtml(ui.app.innerHTML)).toBeUndefined();
    moduleMapMemory.culture = true; failures.culture = 1;
    await ui.click({ action: 'culture-tab' }); await ui.click({ action: 'culture-tab' });
    const reload = vi.fn(); vi.stubGlobal('location', { reload });
    const confirm = vi.mocked(globalThis.confirm); confirm.mockClear();
    await ui.click({ action: 'reload' });
    expect(confirm).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('TASK-0074 화면의 옛 형식 거절', () => {
  it.each(['import', 'SAVE_KEY', 'LEGACY_SAVE_KEY'] as const)('%s 거절은 알림만 바꾸고 상태·오늘 할 일·select를 보존한다', async (mode) => {
    const ui = await freshUi(), items = storage();
    await ui.click({ action: 'end-day' });
    await ui.click({ action: 'accept' });
    const before = readState(ui, items), pending = pendingHtml(ui.app.innerHTML);
    const select = (html: string) => html.match(/<select[^>]*data-action="scenario"[\s\S]*?<\/select>/)?.[0];
    const selected = select(ui.app.innerHTML), title = ui.doc.title;
    expect(pending).toBeDefined(); expect(selected).toBeDefined();
    if (mode === 'import') await ui.importText(opsSaveV6);
    else {
      items.clear();
      items.set(mode === 'SAVE_KEY' ? 'scitrade-save' : 'scitrade-m1-save', opsSaveV6);
      await ui.click({ action: 'load' });
    }
    expect(ui.app.innerHTML).toContain('flash warn');
    expect(ui.app.innerHTML).toContain('이전 저장 형식(판본 6)의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.');
    expect(pendingHtml(ui.app.innerHTML)).toBe(pending);
    expect(select(ui.app.innerHTML)).toBe(selected); expect(ui.doc.title).toBe(title);
    expect(readState(ui, items)).toBe(before);
  });
});


it('TASK-0077 첫 화면 정적 닫힘에 경로 11 화면이 없다', async () => {
  const fs = await import('node:fs' as string) as { readFileSync(p: string, e: string): string; existsSync(p: string): boolean };
  const path = await import('node:path' as string) as { resolve(...p: string[]): string; dirname(p: string): string };
  const { parseSync } = await import('rolldown/utils');
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.endsWith('.ts')) return;
    for (const node of parseSync(file, fs.readFileSync(file, 'utf8')).program.body) {
      let specifier: string | undefined;
      if (node.type === 'ImportDeclaration' && node.importKind !== 'type'
        && (!node.specifiers.length || node.specifiers.some((s) => s.type !== 'ImportSpecifier' || s.importKind !== 'type'))) specifier = node.source.value;
      if ((node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && node.exportKind !== 'type'
        && (node.type === 'ExportAllDeclaration' || node.specifiers.some((s) => s.exportKind !== 'type'))) specifier = node.source?.value;
      if (!specifier?.startsWith('.')) continue;
      const stem = path.resolve(path.dirname(file), specifier);
      const target = [stem, `${stem}.ts`, `${stem}/index.ts`].find((p) => fs.existsSync(p));
      if (!target) throw new Error(`정적 의존 파일을 찾지 못했습니다: ${specifier}`);
      visit(target);
    }
  }
  visit(path.resolve('src/ui/main.ts'));
  expect([...seen]).not.toContain(path.resolve('src/ui/path11-screens.ts'));
});


describe('TASK-0079 HTML 정규화', () => {
  it('실제 두 조각을 걷고 기존 세 해시를 유지하며 다른 글자 변경은 검출한다', async () => {
    const ui = await freshUi();
    const html = ui.app.innerHTML;
    expect(html).toMatch(/ creature-animal/);
    expect(html).toMatch(/<button[^>]*data-action="open-office"[^>]*>사무실 보기<\/button>/);
    expect(normalizeArtHtml(html)).not.toContain('creature-animal');
    expect(normalizeArtHtml(html)).not.toContain('open-office');
    expect(normalizeArtHtml(html.replace('경영 보고', '경영 보고 변화'))).toContain('경영 보고 변화');
    expect(await hash(html)).toBe(BASE_HTML.first);
    expect(await hash(html.replace('동료', '동료 변화'))).not.toBe(BASE_HTML.first);
    expect(normalizeArtHtml(' creature-unknown<button data-action="other">사무실 보기</button>')).toBe(' creature-unknown<button data-action="other">사무실 보기</button>');
  });
});

describe('TASK-0079 빌드 청크 보호', () => {
  it('첫 화면은 index·data로 유지하고 출처 기록과 새 화면 CSS는 지연한다', async () => {
    const fs = await import('node:fs' as string) as { readFileSync(p: string, e: string): string; readdirSync(p: string): string[]; mkdtempSync(p: string): string; rmSync(p: string, o: object): void };
    const vite = await import('vite' as string) as { build(o: object): Promise<unknown> };
    const bundle = await import('../../tools/bundle-size.mjs' as string) as { collectDist(p: string): { firstScreen: { file: string; gzip: number }[]; lazy: string[] }; pageRefs(p: string): { kind: string; href: string }[] };
    const dir = fs.mkdtempSync('/tmp/T79-build-');
    try {
      await vite.build({ logLevel: 'silent', define: { __BUILD_ID__: JSON.stringify('dev') }, build: { outDir: dir, emptyOutDir: true } });
      const result = bundle.collectDist(dir), page = fs.readFileSync(`${dir}/index.html`, 'utf8');
      expect(result.firstScreen.map((r) => r.file.replace(/-[^.]+\./, '.')).sort()).toEqual(['assets/data.js', 'assets/index.css', 'assets/index.js']);
      expect(bundle.pageRefs(page).filter((r) => r.kind === 'modulepreload').map((r) => r.href.replace(/-[^.]+\./, '.'))).toEqual(['assets/data.js']);
      const names = fs.readdirSync(`${dir}/assets`);
      for (const pattern of [/^office-scene-.*\.js$/, /^office-scene-.*\.css$/, /^card-najeon-.*\.css$/]) {
        const name = names.find((n) => pattern.test(n)); expect(name).toBeTruthy(); expect(page).not.toContain(name);
      }
      expect(result.lazy.some((f) => /office-scene-.*\.js$/.test(f))).toBe(true);
      for (const file of result.firstScreen) {
        const source = fs.readFileSync(`${dir}/${file.file}`, 'utf8');
        for (const field of ['original_sha256', 'ai_postprocess', 'provenance', '--shell', '.office-stage']) expect(source).not.toContain(field);
      }
      // TASK-0088 견적 머리 문구, 허브 승인
      expect(result.firstScreen.reduce((n, r) => n + r.gzip, 0)).toBeLessThanOrEqual(133600);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
