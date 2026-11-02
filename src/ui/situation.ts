// 상황실은 확정 상태와 저장소 스냅숏을 읽으며 엔진 명령을 만들지 않는다.
import './situation.css';
import snapshot from '../../data/situation_map.json';
import world from '../../data/world.json';
import routes from '../../data/routes.json';
import { loadMapCities, loadRouteWaypoints, type GeoPoint } from '../content/map';
import type { GameState, ScenarioConfig, Shipment } from '../engine/types';
import { chooseMap, mapMarks, renderWorldMap } from './map';
import { mapAsset } from './assets';
import { inBounds, project, type Box } from './projection';

export type LayerId = 'cargo' | 'routes' | 'ports' | 'nightlights' | 'countries';
export type Layers = Record<LayerId, boolean>;
export const defaultLayers = (): Layers => ({ cargo: true, routes: true, ports: true, nightlights: false, countries: true });
export const situationData = snapshot;
export const PORT_RADIUS_KM = 50;
// 공통 엔진 함수에 새 공유 청크가 생기지 않도록 지명·문자 표시는 이 지연 화면에서 읽는다.
const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const cityName = (_config: ScenarioConfig, id: string) => loadMapCities().find((c) => c.id === id)?.nameKo ?? id;
const routeLabel = (config: ScenarioConfig, id: string) => { const r = config.routes.find((r) => r.id === id)!; return `${cityName(config, r.fromCityId)} → ${cityName(config, r.toCityId)}`; };
const EARTH_KM = 6371;
const rad = (x: number) => x * Math.PI / 180;
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const d = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return EARTH_KM * 2 * Math.asin(Math.sqrt(Math.min(1, d)));
}
function bearing(a: GeoPoint, b: GeoPoint) {
  const d = rad(b.lon - a.lon);
  return Math.atan2(Math.sin(d) * Math.cos(rad(b.lat)), Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(d));
}
/** 구면의 선분까지 거리. 연장선이 가까워도 선분 밖이면 끝점까지 잰다. */
export function segmentDistanceKm(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const length = distanceKm(a, b) / EARTH_KM;
  if (!length) return distanceKm(p, a);
  const delta = distanceKm(a, p) / EARTH_KM, angle = bearing(a, p) - bearing(a, b);
  const along = Math.atan2(Math.sin(delta) * Math.cos(angle), Math.cos(delta));
  if (along < 0 || along > length) return Math.min(distanceKm(p, a), distanceKm(p, b));
  return Math.abs(Math.asin(Math.sin(delta) * Math.sin(angle))) * EARTH_KM;
}
export function prominentPort(p: GeoPoint, cities: GeoPoint[] = loadMapCities(), lines: GeoPoint[][] = routes.items.map((r) => loadRouteWaypoints(r.id))): boolean {
  return cities.some((c) => distanceKm(p, c) <= PORT_RADIUS_KM) || lines.some((line) => line.slice(1).some((b, i) => segmentDistanceKm(p, line[i]!, b) <= PORT_RADIUS_KM));
}
const ports = snapshot.ports.map((p) => {
  const hub = world.items.find((c) => c.geo_position && distanceKm(p, c.geo_position) <= 25);
  return { ...p, prominent: prominentPort(p), hub: hub?.name_ko ?? null, country: hub?.country_code ?? '확인 전' };
});
const portName = (p: typeof snapshot.ports[number]) => p.name_ko ?? `${p.name_en} (영문 표기)`;
const cityPoint = (id: string) => loadMapCities().find((c) => c.id === id);
const restrictionFor = (state: GameState, config: ScenarioConfig, cityId: string) => config.portRestrictions.filter((r) => r.cityId === cityId && state.notices.some((n) => n.day <= state.day && n.eventInstanceId === r.eventInstanceId));
export function shipmentArrival(state: GameState, config: ScenarioConfig, sh: Shipment): number {
  if (sh.arrivalDay !== null) return sh.arrivalDay;
  const destination = state.contracts.find((c) => c.id === sh.contractId)?.destinationCityId;
  const known = destination ? restrictionFor(state, config, destination).filter((r) => r.startDay <= Math.max(state.day, sh.scheduledArrivalDay) && r.endDay >= sh.scheduledArrivalDay) : [];
  return Math.max(sh.scheduledArrivalDay + sh.observedWaitDays, ...known.map((r) => r.endDay + 1));
}
export interface BriefingEvent { id: string; title: string; text: string; location: GeoPoint; destination: GeoPoint }
export type PaymentWarning = Pick<ReturnType<typeof import('../engine/operations').paymentDefaultStatus>, 'level' | 'oldest' | 'ageDays' | 'failAtCloseOfDay'>;
export function briefingEvents(state: GameState, config: ScenarioConfig, warning?: PaymentWarning): BriefingEvent[] {
  const events: BriefingEvent[] = [];
  for (const notice of state.notices.filter((n) => n.day <= state.day)) {
    const restriction = config.portRestrictions.find((r) => r.eventInstanceId === notice.eventInstanceId);
    const location = restriction && cityPoint(restriction.cityId);
    if (!location || (restriction && state.day > restriction.endDay)) continue;
    const sh = state.shipments.find((s) => notice.affectedShipmentIds.includes(s.id));
    const destId = state.contracts.find((c) => c.id === sh?.contractId)?.destinationCityId;
    events.push({ id: notice.id, title: notice.titleKo, text: `${notice.bodyKo} ${notice.evidenceKo}`, location, destination: destId && cityPoint(destId) || location });
  }
  for (const sh of state.shipments) {
    const contract = state.contracts.find((c) => c.id === sh.contractId);
    const destination = contract && cityPoint(contract.destinationCityId);
    if (!destination) continue;
    const arrival = shipmentArrival(state, config, sh);
    if (sh.arrivalDay === null && arrival > sh.scheduledArrivalDay) {
      const mark = mapMarks(state, config, 'route').find((m) => m.key === `ship:${state.bookings.find((b) => b.id === sh.bookingId)?.sailingId}`);
      // 선박 표시는 투영 위치이므로, 사건 위치는 현재 대기 항만/출발 도시로 읽는다.
      const location = state.day >= sh.scheduledArrivalDay && restrictionFor(state, config, contract!.destinationCityId).some((r) => r.startDay <= state.day && state.day <= r.endDay) ? destination : cityPoint(contract!.originCityId) ?? destination;
      events.push({ id: `delay:${sh.id}`, title: '운송 지연', text: `${sh.contractId} · ${cityName(config, contract!.destinationCityId)} 도착 예정이 ${sh.scheduledArrivalDay}일에서 ${arrival}일로 늦어졌습니다.${mark ? ` ${mark.lines.join(' ')}` : ''}`, location, destination });
    }
    if (sh.arrivalDay === state.day) events.push({ id: `arrival:${sh.id}`, title: '오늘 도착', text: `${sh.contractId} · ${cityName(config, contract!.destinationCityId)}에 오늘 도착했습니다.`, location: destination, destination });
  }
  if (config.operations && warning) {
    const location = cityPoint(config.routes[0]!.fromCityId);
    if (location && (warning.level === 'WARNING' || warning.level === 'DANGER')) events.push({ id: 'payment', title: `지급 ${warning.level === 'WARNING' ? '경고' : '위험'}`, text: `${warning.oldest?.reasonKo ?? ''} · 미지급 ${warning.ageDays}일째${warning.failAtCloseOfDay === null ? '' : ` · ${warning.failAtCloseOfDay}일 마감까지 지급 필요`}`, location, destination: location });
  }
  return events;
}
/** 두 위치의 최소 영역 양쪽에 15%씩 여백을 더하고 최소 크기로 넓힌 뒤 안쪽으로 옮긴다. */
export function briefingBox(location: { x: number; y: number }, destination: { x: number; y: number }, width: number, height: number): Box {
  const w = Math.min(width, Math.max(560, Math.abs(destination.x - location.x) * 1.3));
  const h = Math.min(height, Math.max(400, Math.abs(destination.y - location.y) * 1.3));
  return { x: Math.max(0, Math.min(width - w, (location.x + destination.x) / 2 - w / 2)), y: Math.max(0, Math.min(height - h, (location.y + destination.y) / 2 - h / 2)), w, h };
}
/** 시나리오 항로와 운항 화물의 경유점을 모두 담고 양쪽에 15% 여백을 둔다. */
export function explorationBox(state: GameState, config: ScenarioConfig): Box {
  const map = chooseMap(config, 'route')!;
  const ids = new Set([...config.routes.map((r) => r.id), ...state.shipments.filter((s) => s.arrivalDay === null).flatMap((s) => state.bookings.filter((b) => b.id === s.bookingId).map((b) => b.routeId))]);
  const points = [...ids].flatMap((id) => loadRouteWaypoints(id)).map((p) => project(p, map.bounds, map.width, map.height));
  if (!points.length) return { x: 0, y: 0, w: map.width, h: map.height };
  const left = Math.min(...points.map((p) => p.x)), right = Math.max(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y)), bottom = Math.max(...points.map((p) => p.y));
  const w = Math.min(map.width, Math.max(1, right - left) * 1.3), h = Math.min(map.height, Math.max(1, bottom - top) * 1.3);
  return { x: Math.max(0, Math.min(map.width - w, (left + right - w) / 2)), y: Math.max(0, Math.min(map.height - h, (top + bottom - h) / 2)), w, h };
}
function briefingText(text: string): string {
  const sentences = text.match(/[\s\S]*?(?:[.!?。](?:\s+|$)|$)/g)?.filter(Boolean) ?? [text];
  if (sentences.length <= 2) return `<p>${esc(text)}</p>`;
  return `<p>${esc(sentences.slice(0, 2).join(''))}</p><details><summary>자세히</summary><p>${esc(sentences.slice(2).join(''))}</p></details>`;
}
export interface SituationView { fullMap: boolean; nearby: string[]; layers: Layers; briefing: boolean; eventIndex: number; visual: boolean; table: boolean; reducedMotion: boolean; selectedPort: string | null; selectedMark: string | null }
export function initialSituationView(reducedMotion = false): SituationView {
  return { fullMap: false, nearby: [], layers: defaultLayers(), briefing: true, eventIndex: 0, visual: true, table: false, reducedMotion, selectedPort: null, selectedMark: null };
}
const allowedLayer = (id: string) => snapshot.layers.find((l) => l.id === id)?.license_tier !== 'banned';
export function layerAnnouncement(id: LayerId, enabled: boolean): string { return `${snapshot.layers.find((l) => l.id === id)!.title_ko} ${enabled ? '켬' : '끔'}`; }
function indicatorValue(indicator: typeof snapshot.countries[number]['indicators'][number]): string {
  if (indicator.value === null) return '—';
  const value = indicator.value;
  if (indicator.id === 'TX.VAL.MRCH.CD.WT') return `${Math.round(value / 100_000_000).toLocaleString('ko-KR')}억 달러`;
  if (indicator.id === 'NY.GDP.PCAP.CD') return `${Math.round(value).toLocaleString('ko-KR')} 달러`;
  if (indicator.id === 'NE.TRD.GNFS.ZS') return `${Math.round(value)}%`;
  if (indicator.id === 'LP.LPI.OVRL.XQ') return `${value.toFixed(1)}점`;
  return `${value} ${esc(indicator.unit_ko)}`;
}
const indicatorYear = (year: number | null) => year === null ? '—' : `${year}년`;
function sourceRegister(): string {
  return `<h3>출처 등록부</h3><table><thead><tr><th>자료</th><th>제공·라이선스</th><th>기준일</th><th>등급</th></tr></thead><tbody>${snapshot.layers.map((l) => `<tr><th>${esc(l.title_ko)}</th><td>${esc(l.provider)} · ${esc(l.license)}<br>${esc(l.license_tier)}<br>${esc(l.credit_ko)}</td><td>${l.retrieved_on ?? '—'}</td><td>${l.verification_status === 'verified' ? '확인' : '확인 전'}</td></tr>`).join('')}</tbody></table><p>실시간 외부 호출 없음. 모든 층은 저장소 안 스냅숏</p>`;
}
export function situationTables(state: GameState, config: ScenarioConfig): string {
  const moving = state.shipments.filter((s) => s.arrivalDay === null);
  return `<section class="situation-tables" aria-label="지도 자료 표"><h3 tabindex="-1" id="situation-table-h">표로 보기</h3>
    <table data-table="cargo"><caption>운항 중 화물</caption><thead><tr><th>계약</th><th>항로</th><th>출발</th><th>도착 예정</th><th>지연 이유</th></tr></thead><tbody>${moving.map((s) => {
      const booking = state.bookings.find((b) => b.id === s.bookingId);
      return `<tr><th>${esc(s.contractId)}</th><td>${booking ? esc(routeLabel(config, booking.routeId)) : '—'}</td><td>${s.departureDay}일</td><td>${shipmentArrival(state, config, s)}일</td><td>${shipmentArrival(state, config, s) > s.scheduledArrivalDay ? '항만 하역 중단 · 공개 공지·관측 대기 기준' : '—'}</td></tr>`;
    }).join('')}</tbody></table>
    <table data-table="ports"><caption>항만</caption><thead><tr><th>이름</th><th>나라</th><th>게임 거점 여부</th><th>표시</th></tr></thead><tbody>${ports.map((p) => `<tr><th>${esc(portName(p))}</th><td>${esc(p.country)}</td><td>${p.hub ? esc(p.hub) : '아니오'}</td><td>${p.prominent ? '또렷' : '옅게'}</td></tr>`).join('')}</tbody></table>
    <table data-table="countries"><caption>국가 지표</caption><thead><tr><th>국가·지표</th><th>값</th><th>기준일</th><th>출처</th></tr></thead><tbody>${snapshot.countries.flatMap((c) => c.indicators.map((i) => `<tr><th>${esc(c.name_ko)} · ${esc(i.label_ko)}</th><td>${indicatorValue(i)}</td><td>${indicatorYear(i.year)}</td><td>World Bank WDI · ${i.value === null ? '값·기준일 확인 전' : '확인'}</td></tr>`)).join('')}</tbody></table>
    <p>야간 불빛은 경제활동이 많은 곳을 밝게 보이는 그림입니다. 밝기는 경제 규모의 직접 측정값이 아닙니다. ${esc(snapshot.layers.find((l) => l.id === 'nightlights')!.credit_ko)}</p></section>`;
}
export function situationHtml(state: GameState, config: ScenarioConfig, view: SituationView, warning?: PaymentWarning): string {
  const layers = Object.fromEntries(Object.entries(view.layers).map(([id, on]) => [id, on && allowedLayer(id)])) as Layers;
  const map = chooseMap(config, 'route')!;
  const proj = (p: GeoPoint) => project(p, map.bounds, map.width, map.height);
  const events = briefingEvents(state, config, warning), event = events[view.eventIndex % Math.max(1, events.length)];
  const vb = view.briefing && event ? briefingBox(proj(event.location), proj(event.destination), map.width, map.height) : view.fullMap ? { x: 0, y: 0, w: map.width, h: map.height } : explorationBox(state, config);
  let svg = renderWorldMap(state, config, 'route', { availableWidth: 946 });
  svg = svg.replace(/<svg\b[^>]*>/, `<svg class="sea-map situation-map${view.briefing && event && !view.reducedMotion ? ' situation-moving' : ''}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="상황실 지도 · ${snapshot.layers.filter((l) => layers[l.id as LayerId]).map((l) => esc(l.title_ko)).join(' · ')}">`);
  svg = svg.replace(/<(g|path) class="(ship |storm |route-line|route-under)([^"]*)"/g, (all: string, _tag: string, cls: string) => `${all} data-situation-layer="${cls.startsWith('route') ? 'routes' : 'cargo'}"${layers[cls.startsWith('route') ? 'routes' : 'cargo'] ? '' : ' hidden'}`);
  if (layers.nightlights) {
    const region = mapAsset('MAP_EAST_ASIA')!, top = proj({ lon: region.bounds.lon_min, lat: region.bounds.lat_max }), bottom = proj({ lon: region.bounds.lon_max, lat: region.bounds.lat_min });
    svg = svg.replace(/(<image class="map-base[^>]+>)/, `$1<image data-situation-layer="nightlights" href="assets/situation/nightlights-ea.png" x="${top.x}" y="${top.y}" width="${bottom.x - top.x}" height="${bottom.y - top.y}" preserveAspectRatio="none"/>`);
  }
  const dotLayer = `<g data-situation-layer="ports"${layers.ports ? '' : ' hidden'}>${ports.filter((p) => inBounds(p, map.bounds)).map((p) => { const q = proj(p); return `<circle class="situation-port" data-port="${p.id}" cx="${q.x}" cy="${q.y}" r="5" opacity="${p.prominent ? 1 : 0.35}"><title>${esc(portName(p))}</title></circle>`; }).join('')}</g>`;
  const badges = `<g data-situation-layer="countries"${layers.countries ? '' : ' hidden'}>${snapshot.countries.map((c, i) => { const q = proj([{ lon: 127.5, lat: 38 }, { lon: 110, lat: 35 }, { lon: 104.5, lat: 17 }][i]!); return `<text class="situation-country" x="${q.x}" y="${q.y}">${esc(c.name_ko)}</text>`; }).join('')}</g>`;
  svg = svg.replace('</svg>', `${dotLayer}${badges}</svg>`);
  const voyages = new Set(mapMarks(state, config, 'route').filter((m) => m.key.startsWith('ship:')).map((m) => m.key)).size;
  const counts: Record<LayerId, string> = { cargo: `운항 ${voyages}척`, routes: `항로 ${config.routes.length}개`, ports: `항만 ${ports.length}곳`, nightlights: '2016', countries: '3개국' };
  const selected = ports.find((p) => p.id === view.selectedPort);
  const mark = mapMarks(state, config, 'route').find((m) => m.key === view.selectedMark);
  return `<header><h2 id="situation-h" tabindex="-1">상황실 지도</h2><div role="group" aria-label="보기 방식"><button data-situation="briefing" aria-pressed="${view.briefing}">브리핑</button><button data-situation="free" aria-pressed="${!view.briefing}">자유 탐색</button></div><button data-situation="all">전체 보기</button><button data-situation="visual" aria-pressed="${view.visual}">상황실 화면 ${view.visual ? '켬' : '끔'}</button><span>${Math.min(state.day, config.campaignDays)}일 / ${config.campaignDays} · 시간 정지</span><button data-situation="table" aria-pressed="${view.table}">표로 보기</button><button data-situation="close">닫기</button></header>
    <div class="situation-body"><div class="situation-left">${view.table ? situationTables(state, config) : `<div class="situation-stage${view.visual ? ' situation-visual' : ''}${view.reducedMotion ? ' situation-reduced' : ''}${layers.nightlights ? ' situation-lights' : ''}">${svg}</div>${layers.nightlights ? `<div class="situation-night-legend"><p>야간 불빛 · 4단계 <span>어두움</span><span>약함</span><span>밝음</span><span>매우 밝음</span></p><p>${esc(snapshot.layers.find((l) => l.id === 'nightlights')!.credit_ko)}</p></div>` : ''}<section class="situation-selection"><h3 id="situation-selection-h" tabindex="-1">${selected ? esc(portName(selected)) : mark ? esc(mark.nameKo) : view.nearby.length ? '이 근처에 여러 곳이 있습니다' : '지도 선택 정보'}</h3>${view.nearby.length ? `<div>${view.nearby.map((id) => { const p = ports.find((p) => p.id === id); const m = mapMarks(state, config, 'route').find((m) => m.key === id); return `<button data-situation="pick" data-id="${esc(id)}">${esc(p ? portName(p) : m?.nameKo ?? id)}</button>`; }).join('')}</div>` : ''}<p>${selected ? `${esc(portName(selected))} · 나라 ${esc(selected.country)} · ${selected.hub ? `게임 거점 ${esc(selected.hub)}` : '게임 거점 아님'} · ${selected.prominent ? '또렷' : '옅게'}` : mark ? esc(`${mark.nameKo} · ${mark.lines.join(' ')}`) : '항만 점·게임 거점·선박을 누르면 이름과 내용을 볼 수 있습니다.'}</p></section>`}</div>
    <aside><div class="situation-controls">${view.briefing ? `<article class="situation-brief"><h3 id="situation-brief-h" tabindex="-1">${event ? `사건 ${view.eventIndex + 1}/${events.length} · ${esc(event.title)}` : '오늘 확인할 사건이 없습니다'}</h3>${event ? `${briefingText(event.text)}<div><button data-situation="prev" ${view.eventIndex === 0 ? 'disabled' : ''}>이전</button><button data-situation="next" ${view.eventIndex === events.length - 1 ? 'disabled' : ''}>다음 사건</button><button data-situation="free">브리핑 끝내기</button></div>` : ''}</article>` : ''}
    <fieldset><legend>레이어</legend>${snapshot.layers.filter((l) => allowedLayer(l.id)).map((l) => `<label class="situation-toggle" for="situation-${l.id}"><input id="situation-${l.id}" type="checkbox" data-layer="${l.id}" ${layers[l.id as LayerId] ? 'checked' : ''}>${esc(l.title_ko)}<small>${counts[l.id as LayerId]}</small></label>`).join('')}</fieldset></div>
    <div class="situation-reference">${layers.countries ? snapshot.countries.map((c) => `<article class="situation-country-card"><h3>${esc(c.name_ko)}</h3><dl>${c.indicators.map((i) => `<dt>${esc(i.label_ko)}</dt><dd>${indicatorValue(i)} · ${indicatorYear(i.year)}</dd>`).join('')}</dl>${c.indicators.some((i) => i.value === null) ? '<p>값·기준일 확인 전</p>' : ''}</article>`).join('') : ''}${sourceRegister()}</div></aside></div>`;
}

/** 전체 화면을 붙이고 배경은 inert로 막는다. 종료 때 원래 진행 단추·초점을 복구한다. */
export function openSituation(state: GameState, config: ScenarioConfig, opener: HTMLElement, onClose: () => void, warning?: PaymentWarning): void {
  const view = initialSituationView(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const root = document.createElement('section');
  root.className = 'situation'; root.setAttribute('tabindex', '-1'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'situation-h');
  const background = document.querySelector<HTMLElement>('#app')!;
  const previousInert = background.inert;
  const progress = background.querySelector<HTMLButtonElement>('[data-action="end-day"]')!;
  const previousDisabled = progress.disabled;
  background.inert = true; progress.disabled = true;
  // 바깥 틀과 낭독 영역은 그대로 두고 화면 내용만 바꾼다.
  const content = document.createElement('div'); content.className = 'situation-content';
  const live = document.createElement('div'); live.className = 'visually-hidden'; live.id = 'situation-live';
  live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
  root.appendChild(content); root.appendChild(live);
  const announce = (text: string) => { live.textContent = live.textContent === text ? text + '\u00a0' : text; };
  const redraw = (selector?: string, activated?: HTMLElement) => {
    const active = document.activeElement as HTMLElement | null, inside = !!active && root.contains(active);
    const button = inside ? active?.closest<HTMLElement>('[data-situation], [data-action]') : null;
    const same = activated?.dataset ?? button?.dataset;
    const restoreFocus = !!selector || inside || !!activated;
    content.innerHTML = situationHtml(state, config, view, warning);
    const restored = same ? Array.from(content.querySelectorAll<HTMLElement>('[data-situation], [data-action]')).find((b) => !b.hasAttribute('disabled') && b.dataset.situation === same.situation && b.dataset.action === same.action && b.dataset.id === same.id) : null;
    if (restoreFocus) (selector ? root.querySelector<HTMLElement>(selector) : restored)?.focus({ preventScroll: true });
    if (restoreFocus && !root.contains(document.activeElement)) (root.querySelector<HTMLElement>(view.selectedPort || view.selectedMark || view.nearby.length ? '#situation-selection-h' : '#situation-h') ?? root.querySelector<HTMLElement>('#situation-h'))?.focus({ preventScroll: true });
  };
  let lastBriefing = '';
  const announceBriefing = () => {
    const events = briefingEvents(state, config, warning), event = events[view.eventIndex];
    const text = view.briefing ? event ? `${event.title} · ${event.text}` : '오늘 확인할 사건이 없습니다' : '';
    if (text && text !== lastBriefing) announce(text);
    lastBriefing = text;
  };
  const close = () => { root.remove(); background.inert = previousInert; progress.disabled = previousDisabled; onClose(); opener.focus({ preventScroll: true }); };
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ev.repeat && !ev.isComposing && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); close(); }
    if (ev.key === 'Tab') {
      const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input, summary'));
      const first = focusable[0], last = focusable.at(-1);
      const start = document.activeElement === root || document.activeElement === root.querySelector('#situation-h');
      if (ev.shiftKey && (document.activeElement === first || start)) { ev.preventDefault(); last?.focus(); }
      else if (!ev.shiftKey && (document.activeElement === last || start)) { ev.preventDefault(); first?.focus(); }
    }
  });
  root.addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement, id = input.dataset.layer as LayerId;
    if (!id || !allowedLayer(id)) return;
    view.layers[id] = input.checked;
    redraw(`#situation-${id}`);
    announce(layerAnnouncement(id, input.checked));
  });
  root.addEventListener('click', (ev) => {
    const target = ev.target as Element, button = target.closest<HTMLButtonElement>('[data-situation]');
    if (button?.disabled) return;
    const action = button?.dataset.situation;
    if (action === 'close') return close();
    if (action === 'visual') view.visual = !view.visual;
    if (action === 'table') view.table = !view.table;
    if (action === 'briefing') { view.briefing = true; view.table = false; view.eventIndex = 0; view.layers.nightlights = false; }
    if (action === 'free') view.briefing = false;
    if (action === 'all') { view.fullMap = true; view.briefing = false; view.table = false; }
    if (action === 'next') view.eventIndex = Math.min(briefingEvents(state, config, warning).length - 1, view.eventIndex + 1);
    if (action === 'prev') view.eventIndex = Math.max(0, view.eventIndex - 1);
    if (action === 'pick') {
      const id = button!.dataset.id!;
      view.selectedPort = ports.some((p) => p.id === id) ? id : null;
      view.selectedMark = view.selectedPort ? null : id; view.nearby = [];
    }
    const stage = target.closest('.situation-stage');
    if (!action && stage) {
      const points = Array.from(stage.querySelectorAll<SVGElement>('[data-port], [data-mark-dot]')).filter((dot) => !dot.closest('[hidden]')).map((dot) => {
        const r = dot.getBoundingClientRect();
        return { key: dot.dataset.port ?? dot.closest<SVGElement>('[data-mark]')!.dataset.mark!, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      // nearestMarks와 같은 22 CSS px 판정. 초기 청크에 새 export를 만들지 않는다.
      const near = points.map((p) => ({ ...p, distance: Math.hypot(p.x - ev.clientX, p.y - ev.clientY) }))
        .filter((p) => p.distance <= 22).sort((a, b) => a.distance - b.distance).map((p) => p.key);
      if (!near.length) return;
      view.nearby = near.length > 1 ? near : [];
      view.selectedPort = near.length === 1 && ports.some((p) => p.id === near[0]) ? near[0]! : null;
      view.selectedMark = near.length === 1 && !view.selectedPort ? near[0]! : null;
    }
    if (!action && !stage) return;
    redraw(!action || action === 'pick' ? '#situation-selection-h' : undefined, button ?? undefined);
    announceBriefing();
  });
  redraw(); document.body.appendChild(root); root.querySelector<HTMLElement>('#situation-h')!.focus({ preventScroll: true }); announceBriefing();
}
