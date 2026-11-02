// 태평양 중심 세계지도의 좌표 변환과 이름표 배치. 지도 자료(data/world.json)의 거점·해협이 모두 지도 안에 들어오는지도 확인한다.

import { describe, expect, it } from 'vitest';
import { loadMapCities, loadSeaGates } from '../content/map';
import manifest from '../assets/manifest.json';
import { inBounds, placeLabel, project, splitAtSeam, wrapLon } from './projection';

const world = (manifest as { assets: { id: string; width: number; height: number; bounds: { lon_min: number; lon_max: number; lat_min: number; lat_max: number } }[] }).assets.find((a) => a.id === 'MAP_WORLD')!;
const B = world.bounds;

describe('태평양 중심 세계지도 좌표', () => {
  it('서경 도시는 지도 오른쪽(동쪽 끝 너머)으로 감싼다', () => {
    expect(wrapLon(-74, B)).toBe(286);
    expect(wrapLon(-5.5, B)).toBe(-5.5);
    const ny = project({ lat: 40.7, lon: -74 }, B, world.width, world.height);
    const london = project({ lat: 51.5, lon: -0.1 }, B, world.width, world.height);
    const busan = project({ lat: 35.1, lon: 129 }, B, world.width, world.height);
    expect(london.x).toBeLessThan(busan.x);
    expect(busan.x).toBeLessThan(ny.x);
  });

  it('세계 거점 21곳과 해협 6곳이 모두 세계지도 안에 있다', () => {
    const cities = loadMapCities();
    expect(cities).toHaveLength(21);
    expect(cities.filter((c) => !inBounds(c, B))).toEqual([]);
    expect(loadSeaGates().filter((g) => !inBounds(g, B))).toEqual([]);
    // 1장 거점은 본사를 더해 7곳이다.
    expect(cities.filter((c) => c.availability.chapter === 1).map((c) => c.id).sort()).toEqual(
      ['BUSAN', 'HAIPHONG', 'JAKARTA', 'PYEONGTAEK', 'SHANGHAI', 'SINGAPORE', 'YOKOHAMA'],
    );
  });

  it('지도 이음매를 넘는 항로선은 둘로 나눈다', () => {
    const pts = [{ x: 3500 }, { x: 3590 }, { x: 20 }, { x: 90 }];
    expect(splitAtSeam(pts, 3600)).toEqual([[{ x: 3500 }, { x: 3590 }], [{ x: 20 }, { x: 90 }]]);
  });

  it('이름표는 이미 놓인 이름표와 겹치지 않는 다음 후보 자리를 쓰고, 자리가 없으면 생략한다', () => {
    const view = { x: 0, y: 0, w: 100, h: 100 };
    const placed = [{ x: 50, y: 10, w: 30, h: 10 }];
    const right = { x: 55, y: 12, w: 30, h: 10 };
    const left = { x: 10, y: 12, w: 30, h: 10 };
    expect(placeLabel([right, left], placed, view)).toEqual(left);
    expect(placeLabel([right, { x: 90, y: 0, w: 30, h: 10 }], placed, view)).toBeNull();
  });
});
