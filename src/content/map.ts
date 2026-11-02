// 지도 표시용 지리 자료 (data/world.json의 geo_position·거점 역할·개방 단계·해협, data/routes.json의 map_waypoints).
// 거리·운송시간 계산에는 쓰지 않는다. 운송시간은 routes.json의 transit_days만 따른다.

import routes from '../../data/routes.json';
import world from '../../data/world.json';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type HubRole =
  | 'CONTAINER_GATEWAY'
  | 'TRANSSHIPMENT_HUB'
  | 'FINANCE_CENTER'
  | 'MARITIME_SERVICES'
  | 'SHIPOWNING_CLUSTER'
  | 'REGIONAL_GATEWAY'
  | 'PRODUCTION_ORIGIN'
  | 'HOME_BASE';

export const HUB_ROLE_KO: Record<HubRole, string> = {
  CONTAINER_GATEWAY: '컨테이너 관문항',
  TRANSSHIPMENT_HUB: '환적 중심',
  FINANCE_CENTER: '국제 금융 중심',
  MARITIME_SERVICES: '해운 금융·보험·중재',
  SHIPOWNING_CLUSTER: '선주·선박 금융',
  REGIONAL_GATEWAY: '지역 관문',
  PRODUCTION_ORIGIN: '생산 거점',
  HOME_BASE: '본사',
};

export interface Availability {
  stage: 'M1' | 'M2' | 'M3' | 'P1';
  chapter: number;
  status: 'PLAYABLE' | 'PLANNED' | 'MAP_PREVIEW';
}

export interface MapCity extends GeoPoint {
  id: string;
  nameKo: string;
  roles: HubRole[];
  /** 화물 항구가 아닌 금융·해운 서비스 도시(런던). 닻 대신 금융 표시를 그린다. */
  cargoPort: boolean;
  availability: Availability;
  basisKo: string[];
  noteKo: string;
}

export interface SeaGate extends GeoPoint {
  id: string;
  nameKo: string;
  gateType: 'strait' | 'canal' | 'cape_route';
  connectsKo: string;
  eventHookKo: string;
}

type CityRaw = {
  id: string;
  name_ko: string;
  location_type: string;
  geo_position?: GeoPoint;
  hub_roles?: HubRole[];
  availability?: Availability;
  selection_basis?: { indicator_ko: string; value_ko: string; period: string }[];
  hub_note_ko?: string;
};
type GateRaw = { id: string; name_ko: string; gate_type: SeaGate['gateType']; geo_position: GeoPoint; connects_ko: string; event_hook_ko: string };
type RouteRaw = { id: string; map_waypoints?: { points: GeoPoint[] }; schedule_basis?: { status: string; checked_on: string; tolerance_days: number } };

export function loadMapCities(): MapCity[] {
  return (world as unknown as { items: CityRaw[] }).items
    .filter((c) => c.geo_position)
    .map((c) => ({
      id: c.id,
      nameKo: c.name_ko,
      lat: c.geo_position!.lat,
      lon: c.geo_position!.lon,
      roles: c.hub_roles ?? [],
      cargoPort: c.location_type !== 'finance_maritime_services_city',
      availability: c.availability ?? { stage: 'P1', chapter: 2, status: 'MAP_PREVIEW' },
      basisKo: (c.selection_basis ?? []).map((b) => `${b.indicator_ko} ${b.value_ko} (${b.period})`),
      noteKo: c.hub_note_ko ?? '',
    }));
}

export function loadSeaGates(): SeaGate[] {
  return ((world as unknown as { sea_gates?: GateRaw[] }).sea_gates ?? []).map((g) => ({
    id: g.id,
    nameKo: g.name_ko,
    gateType: g.gate_type,
    lat: g.geo_position.lat,
    lon: g.geo_position.lon,
    connectsKo: g.connects_ko,
    eventHookKo: g.event_hook_ko,
  }));
}

export function loadRouteWaypoints(routeId: string): GeoPoint[] {
  const route = (routes as { items: RouteRaw[] }).items.find((r) => r.id === routeId);
  return route?.map_waypoints?.points ?? [];
}

/** 노선 운항 근거의 확인 날짜와 오차. 선사·서비스 이름과 메모는 내보내지 않는다. */
export function loadRouteScheduleCheck(routeId: string): { checkedOn: string; toleranceDays: number } | null {
  const basis = (routes as { items: RouteRaw[] }).items.find((r) => r.id === routeId)?.schedule_basis;
  return basis?.status === 'CARRIER_WEEKDAY_SCHEDULE' ? { checkedOn: basis.checked_on, toleranceDays: basis.tolerance_days } : null;
}
