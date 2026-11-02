import { describe, expect, it } from 'vitest';
import world from '../../data/world.json';
import routes from '../../data/routes.json';
import { loadScenario } from '../content/scenario';
import { loadMapCities, HUB_ROLE_KO } from '../content/map';

describe('TASK-0015 본사와 노선', () => {
  it('본사는 평택이고 기존 환적 거점은 1장 지도에 남는다', () => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    expect(config.homeCityId).toBe('PYEONGTAEK');
    const home = world.items.find(c => c.id === config.homeCityId)!;
    expect(home.hub_roles).toEqual(['HOME_BASE']);
    expect(home.availability).toMatchObject({ stage: 'M1', chapter: 1, status: 'PLAYABLE' });
    expect(JSON.stringify(home)).not.toMatch(/7위|환적 화물|TRANSSHIPMENT/);
    expect(HUB_ROLE_KO.HOME_BASE).toBe('본사');
    const transshipment = loadMapCities().find(c => c.id === 'BUSAN')!;
    expect(transshipment.availability).toMatchObject({ stage: 'M3', chapter: 1, status: 'PLANNED' });
    expect(transshipment.id).not.toBe(config.homeCityId);
    expect(transshipment.roles).toContain('TRANSSHIPMENT_HUB');
  });

  it.each([
    ['ROUTE01', 'HAIPHONG', 5, '일요일', '금요일', []],
    ['ROUTE02', 'SHANGHAI', 4, '수요일', '일요일', ['인천']],
  ] as const)('%s의 양 끝·운송일수·요일표가 일치한다', (id, destination, days, departure, arrival, calls) => {
    const route = routes.items.find(r => r.id === id)!;
    expect(route).toMatchObject({ from_city_id: 'PYEONGTAEK', to_city_id: destination, transit_days: days,
      first_departure_day: 2, departure_interval_days: 7, carrier_id: 'CARRIER_DEMO' });
    expect(route.schedule_basis).toMatchObject({ departure_weekday: departure, arrival_weekday: arrival, port_calls: calls,
      source_refs: ['SINOKOR-ROT-2026'], tolerance_days: 1, checked_on: '2026-10-09' });
    const weekdays = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];
    expect((weekdays.indexOf(route.schedule_basis!.arrival_weekday) - weekdays.indexOf(route.schedule_basis!.departure_weekday) + 7) % 7)
      .toBe(route.transit_days);
    expect(route.map_waypoints!.points[0]).toEqual({ lat: 37, lon: 126.8 });
    expect(route.map_waypoints!.points.at(-1)).toEqual(expect.objectContaining(
      destination === 'HAIPHONG' ? { lat: 20.9, lon: 106.7 } : { lat: 31.2, lon: 121.5 }));
  });

  it('항만 제한은 첫 노선 도착항에 있고 공지는 하이퐁항으로 시작한다', () => {
    const config = loadScenario('SCENARIO_M1_DELAY_ACCEPTED');
    expect(config.portRestrictions[0]).toMatchObject({ cityId: config.routes[0]!.toCityId,
      eventInstanceId: 'EVI_M1_EV02_HAIPHONG', announceDay: 5, startDay: 7, endDay: 8,
      forecastKo: '하이퐁항 7~8일 기상 악화로 하역 중단 예보' });
  });

  it('자동차 부품 200상자와 가구는 무게 한도 안에서 부피 한도만 넘는다', () => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const offer = config.offers.find(o => o.id === 'OFFER_FWD_02')!;
    expect(offer).toMatchObject({ goodId: 'AUTO_PARTS', quantity: 200, counterpartyId: 'SHIPPER_DEMO_AUTOPARTS' });
    const parts = config.goods.find(g => g.id === offer.goodId)!;
    expect(parts).toMatchObject({ quantityUnit: 'case', massKgPerUnit: 12, volumeM3PerUnit: 0.04 });
    expect(offer.quantity * parts.massKgPerUnit + 120 * 20).toBe(4800);
    expect(offer.quantity * parts.volumeM3PerUnit + 120 * 0.2).toBe(32);
  });
});
