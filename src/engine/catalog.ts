// 시나리오 설정(정적 데이터) 조회 도우미. 게임 상태를 읽거나 바꾸지 않는다.

import { applyBasisPoints } from './money';
import type { GoodDef, OfferDef, RouteDef, ScenarioConfig } from './types';

const pad = (n: number, width = 3) => String(n).padStart(width, '0');

export function goodOf(config: ScenarioConfig, id: string): GoodDef {
  const good = config.goods.find((g) => g.id === id);
  if (!good) throw new Error(`상품 ${id}이(가) 시나리오에 없습니다.`);
  return good;
}

export function offerOf(config: ScenarioConfig, id: string): OfferDef | undefined {
  return config.offers.find((o) => o.id === id);
}

export function routeOf(config: ScenarioConfig, id: string): RouteDef {
  const route = config.routes.find((r) => r.id === id);
  if (!route) throw new Error(`노선 ${id}이(가) 시나리오에 없습니다.`);
  return route;
}

/** 두 항구를 잇는 시나리오 노선. M2a에서는 구간마다 노선이 하나다. */
export function routeBetween(config: ScenarioConfig, fromCityId: string, toCityId: string): RouteDef | undefined {
  return config.routes.find((r) => r.fromCityId === fromCityId && r.toCityId === toCityId);
}

export interface Sailing {
  id: string;
  routeId: string;
  departureDay: number;
  scheduledArrivalDay: number;
}

export function listSailings(
  config: ScenarioConfig,
  routeId: string,
  fromDay = 1,
  toDay = config.campaignDays,
): Sailing[] {
  const r = routeOf(config, routeId);
  const sailings: Sailing[] = [];
  for (let d = r.firstDepartureDay; d <= toDay; d += r.departureIntervalDays) {
    if (d < fromDay) continue;
    sailings.push({
      id: `${r.id}-D${pad(d)}`,
      routeId: r.id,
      departureDay: d,
      scheduledArrivalDay: d + r.transitDays,
    });
  }
  return sailings;
}

export function findSailing(config: ScenarioConfig, sailingId: string): Sailing | undefined {
  for (const r of config.routes) {
    if (!sailingId.startsWith(`${r.id}-D`)) continue;
    const found = listSailings(config, r.id).find((s) => s.id === sailingId);
    if (found) return found;
  }
  return undefined;
}

/** 화물 공간은 정수 단위(g, L)로 비교한다. 원 단위 kg·m³는 상품 정의에서 환산한다. */
export function cargoSpace(config: ScenarioConfig, goodId: string, quantity: number) {
  const good = goodOf(config, goodId);
  return {
    massGrams: Math.round(quantity * good.massKgPerUnit * 1000),
    volumeLiters: Math.round(quantity * good.volumeM3PerUnit * 1000),
  };
}

/** 가상 과세 규칙: 공급자 상품 송장 금액만 과세가격으로 본다. */
export function dutyEstimate(config: ScenarioConfig, purchaseAmountMinor: number): number {
  return applyBasisPoints(purchaseAmountMinor, config.terms.dutyRateBasisPoints);
}

export function cityName(config: ScenarioConfig, id: string | null): string {
  if (!id) return '이동 중';
  return config.cities.find((c) => c.id === id)?.nameKo ?? id;
}

export function unitKo(good: GoodDef): string {
  return ({ piece: '개', case: '상자', kg: 'kg' } as Record<string, string>)[good.quantityUnit] ?? good.quantityUnit;
}
