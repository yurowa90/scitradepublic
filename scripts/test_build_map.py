"""논리 격자의 지도 처리: 합성 배열과 실제 생성물의 팔레트 계약을 확인한다."""
import unittest
import os
from pathlib import Path
import numpy as np

from build_map import (ROOT, LOWLAND, FOREST, DRY, MOUNTAIN, SNOW, REGIONS, PIXEL_SIZES,
                       classify_terrain, smooth_classes, isolated_ratio, coastline,
                       carve_gate_passages, geo_pixel, paint_palette, sea_distance, minimum_land_path,
                       remove_small_inland_water, pixel_distances, PASSAGE_MARKERS)
import sys
sys.path.insert(0, str(ROOT))
from tools.art.palette import load_palette, palette_rgb
from PIL import Image
import json


WORLD_LAKES = {
    'Lake Balkhash': (74.5,46.1), 'Lago Titicaca': (-69.4,-15.8),
    'Lago de Nicaragua': (-85.4,11.6), 'Issyk-Kul': (77.4,42.4), 'Qinghai Hu': (100.2,36.9),
    'Tai Hu': (120.15,31.2), 'Lake Superior': (-87.5,47.5), 'Lake Michigan': (-87.0,44.0),
    'Lake Huron': (-82.4,44.8), 'Lake Erie': (-81.2,42.2), 'Lake Ontario': (-77.9,43.7),
}
EAST_ASIA_LAKES = {'Tai Hu': (120.15,31.2), 'Poyang Hu': (116.3,29.1),
                   'Dongting Hu': (112.9,29.3), 'Tonlé Sap': (104.0,12.9)}


class BuildMapTests(unittest.TestCase):
    def test_gate_paths_are_minimum_land_and_enforce_limit(self):
        from unittest.mock import patch
        from build_map import PASSAGES, component_labels
        bounds = {'lon_min':30,'lon_max':36,'lat_min':26,'lat_max':34}
        land = np.zeros((80,60),dtype=bool); land[30:35,:] = True
        with patch('build_map.PASSAGES', {'SUEZ_CANAL': PASSAGES['SUEZ_CANAL']}):
            carved, opened, _ = carve_gate_passages(land, [{'id':'SUEZ_CANAL','geo_position':{'lon':32,'lat':30.5}}], bounds)
            self.assertEqual(opened[0]['changed_cells'],5)
            self.assertEqual(opened[0]['source_land_cells'],5)
            self.assertEqual(np.count_nonzero(land & ~carved),5)
            self.assertEqual(len(set(component_labels(carved)[~carved])),1)
            land[35:38] = True
            with self.assertRaisesRegex(ValueError,'상한'):
                carve_gate_passages(land,[{'id':'SUEZ_CANAL','geo_position':{'lon':32,'lat':29.5}}],bounds)

    def test_connected_water_does_not_carve_or_request_path(self):
        from unittest.mock import patch
        from build_map import PASSAGES
        bounds = {'lon_min':30,'lon_max':36,'lat_min':26,'lat_max':34}
        land = np.zeros((80,60),dtype=bool);land[30:35,10:50] = True
        with patch('build_map.PASSAGES', {'SUEZ_CANAL': PASSAGES['SUEZ_CANAL']}), patch('build_map.minimum_land_path') as path:
            carved,opened,_ = carve_gate_passages(land,[{'id':'SUEZ_CANAL','geo_position':{'lon':32,'lat':29.5}}],bounds)
            np.testing.assert_array_equal(carved,land)
            path.assert_not_called()
            self.assertTrue(opened[0]['already_connected'])
            self.assertEqual(opened[0]['source_land_cells'],0)

    def test_suez_local_window_does_not_accept_ocean_detour(self):
        from unittest.mock import patch
        from build_map import PASSAGES, passage_connections, sea_connections
        bounds = {'lon_min':20,'lon_max':50,'lat_min':0,'lat_max':40}
        land = np.zeros((80,60),dtype=bool);land[20:24,20:32] = True
        with patch('build_map.PASSAGES', {'SUEZ_CANAL': PASSAGES['SUEZ_CANAL']}):
            self.assertTrue(all(c['connected'] for c in sea_connections(land,bounds)))
            self.assertFalse(passage_connections(land,bounds)[0]['connected'])
            carved,opened,_ = carve_gate_passages(land,[{'id':'SUEZ_CANAL','geo_position':{'lon':32,'lat':29.5}}],bounds)
            self.assertEqual(opened[0]['changed_cells'],4)
            self.assertTrue(passage_connections(carved,bounds)[0]['connected'])
            bad = land.copy();bad[16,24] = True
            with self.assertRaisesRegex(ValueError,'기준점은 물'):
                carve_gate_passages(bad,[],bounds)

    def test_path_cost_prefers_land_count_then_source_fraction_then_length(self):
        # 더 먼 1칸 통로가 가까운 2칸 통로보다 먼저다.
        land=np.zeros((7,9),dtype=bool);land[:,4:6]=True;land[0,5]=False
        path=minimum_land_path(land,(1,3),(7,3))
        self.assertEqual(sum(land[y,x] for x,y in path),1)
        # 같은 육지 칸 수라면 길이보다 원본 물 비율을 먼저 비교한다.
        land[:,5]=False
        fractions=land.astype(float);fractions[0,4]=.51;fractions[3,4]=.9
        path=minimum_land_path(land,(1,3),(7,3),fractions)
        self.assertIn((4,0),path);self.assertNotIn((4,3),path)

    def test_gate_distance_failure_rejects_carving(self):
        from unittest.mock import patch
        from build_map import PASSAGES
        bounds={'lon_min':30,'lon_max':36,'lat_min':26,'lat_max':34}
        land=np.zeros((80,60),dtype=bool);land[30:35,:]=True
        with patch('build_map.PASSAGES',{'SUEZ_CANAL':PASSAGES['SUEZ_CANAL']}):
            with self.assertRaisesRegex(ValueError,'관문 거리'):
                carve_gate_passages(land,[{'id':'SUEZ_CANAL','geo_position':{'lon':35,'lat':33}}],bounds)

    def test_gate_distance_boundary_is_one_pixel(self):
        # 합성 지도에서 통로는 x=20(경도 32.0~32.1°) 열에 난다. 표시가 0.5픽셀이면 통과, 1.5픽셀이면 실패한다.
        from unittest.mock import patch
        from build_map import PASSAGES
        bounds={'lon_min':30,'lon_max':36,'lat_min':26,'lat_max':34}
        land=np.zeros((80,60),dtype=bool);land[30:35,:]=True
        gate=lambda lon:[{'id':'SUEZ_CANAL','geo_position':{'lon':lon,'lat':30.75}}]
        with patch('build_map.PASSAGES',{'SUEZ_CANAL':PASSAGES['SUEZ_CANAL']}):
            _,opened,_=carve_gate_passages(land,gate(31.95),bounds)
            self.assertEqual({x for x,_ in opened[0]['changed_pixels']},{20})
            self.assertAlmostEqual(opened[0]['gate_distance_px'],.5,places=6)
            with self.assertRaisesRegex(ValueError,'관문 거리 1.500'):
                carve_gate_passages(land,gate(31.85),bounds)

    def test_manifest_hash_matches_committed_map_png(self):
        # 원본 없이도 돈다: 매니페스트의 출력 해시·크기가 저장소의 지도 PNG와 같아야 한다.
        import hashlib
        manifest = json.loads((ROOT / 'src/assets/manifest.json').read_text(encoding='utf-8'))
        maps = [a for a in manifest['assets'] if a.get('kind') == 'map']
        self.assertEqual({a['path'] for a in maps}, {'assets/maps/east-asia.png', 'assets/maps/world.png'})
        for asset in maps:
            png = ROOT / 'public' / asset['path']
            self.assertEqual(hashlib.sha256(png.read_bytes()).hexdigest(), asset['provenance']['output_sha256'], asset['id'])
            with Image.open(png) as image:
                self.assertEqual(image.size, (asset['pixel_grid']['logical_width'], asset['pixel_grid']['logical_height']))

    def test_terrain_color_sets_are_disjoint(self):
        from build_map import TERRAIN_RAMPS
        groups=[set(TERRAIN_RAMPS[k]) for k in (MOUNTAIN,SNOW,DRY)]
        groups.append({f'{r}-{i}' for r in ('sea','teal') for i in range(1,5)} | {'ink-1','ink-2','ink-3'})
        for i,left in enumerate(groups):
            for right in groups[i+1:]: self.assertTrue(left.isdisjoint(right),(left,right))
        self.assertEqual(set(TERRAIN_RAMPS[SNOW]),{'light-3','light-4'})

    def test_mode_remove_isolated_pixels(self):
        land = np.ones((5, 5), dtype=bool)
        classes = np.full((5, 5), LOWLAND, dtype=np.int16)
        classes[2, 2] = FOREST
        self.assertGreater(isolated_ratio(classes, land), 0)
        result = smooth_classes(classes, land)
        self.assertEqual(result[2, 2], LOWLAND)
        self.assertEqual(isolated_ratio(result, land), 0)
        land[0] = False
        classes[0] = -1
        self.assertTrue(np.all(smooth_classes(classes, land)[0] == -1))

    def test_coastline_is_one_land_pixel_thick(self):
        land = np.zeros((7, 7), dtype=bool)
        land[1:6, 1:6] = True
        coast = coastline(land)
        self.assertEqual(np.count_nonzero(coast), 16)
        self.assertFalse(coast[3, 3])
        self.assertTrue(np.all(~coast | land))
        self.assertFalse(coastline(np.ones((5, 5), dtype=bool)).any())

    def test_terrain_thresholds_and_mountain_precedence(self):
        rgb = np.array([[[0.25, 0.26, 0.25], [0.12, 0.25, 0.12], [0.7, 0.45, 0.25],
                         [0.9, 0.9, 0.9], [0.9, 0.9, 0.9], [0.1, 0.2, 0.4]]])
        height = np.array([[0.1, 0.1, 0.1, 0.5, 0.1, 0]])
        land = height > 0
        np.testing.assert_array_equal(classify_terrain(rgb, height, land), [[LOWLAND, FOREST, DRY, SNOW, SNOW, -1]])

    def test_distance_and_palette_painting(self):
        land = np.zeros((9, 9), dtype=bool)
        land[3:6, 3:6] = True
        distance = sea_distance(land, 3)
        self.assertEqual(distance[3, 2], 1)
        self.assertAlmostEqual(distance[2, 2], np.sqrt(2))
        painted=paint_palette(np.zeros((9,9),dtype=int),land,np.zeros((9,9),dtype=int),distance,(1.5,3),load_palette())
        np.testing.assert_array_equal(painted[2,2],palette_rgb(load_palette())[6])
        classes = np.arange(81).reshape(9, 9) % 5
        shade = np.arange(81).reshape(9, 9) % 3
        palette = load_palette()
        painted = paint_palette(classes, land, shade, distance, (1, 3), palette)
        allowed = {tuple(c) for c in palette_rgb(palette)}
        used = {tuple(c) for c in painted.reshape(-1, 3)}
        self.assertTrue(used <= allowed)
        self.assertLessEqual(len(used), 20)
        np.testing.assert_array_equal(painted[0, 0], palette_rgb(palette)[4])

    def test_pyeongtaek_routes_stay_at_sea_except_port_approaches(self):
        routes = json.loads((ROOT / 'data/routes.json').read_text())['items'][:2]
        sea = {tuple(c) for c in palette_rgb(load_palette())[4:7]}
        for region in REGIONS:
            with Image.open(ROOT / f'public/assets/maps/{region}.png') as image:
                pixels = image.convert('RGB')
                bounds = REGIONS[region]['bounds']
                for route in routes:
                    points = route['map_waypoints']['points']
                    for index, (a, b) in enumerate(zip(points, points[1:])):
                        # 대략 항만 좌표로 접근하는 맨 앞·맨 뒤 구간만 육지 칸을 허용한다.
                        if index in (0, len(points) - 2):
                            continue
                        start, end = geo_pixel(a, bounds, image.size), geo_pixel(b, bounds, image.size)
                        self.assertIsNotNone(start)
                        self.assertIsNotNone(end)
                        steps = max(abs(end[0] - start[0]), abs(end[1] - start[1]), 1) * 4
                        for step in range(steps + 1):
                            position = {key: a[key] + (b[key] - a[key]) * step / steps for key in ('lat', 'lon')}
                            pixel = geo_pixel(position, bounds, image.size)
                            self.assertIsNotNone(pixel)
                            self.assertIn(pixels.getpixel(pixel), sea, (region, route['id'], index, position))

    def test_generated_maps_and_gate_centers(self):
        world = json.loads((ROOT / 'data/world.json').read_text(encoding='utf-8'))
        palette = load_palette()
        allowed = {tuple(c) for c in palette_rgb(palette)}
        sea = {tuple(c) for c in palette_rgb(palette)[4:7]}
        for region, size in PIXEL_SIZES.items():
            with self.subTest(region=region):
                with Image.open(ROOT / f'public/assets/maps/{region}.png') as image:
                    self.assertEqual(image.size, size)
                    pixels = np.asarray(image.convert('RGB'))
                used = {tuple(c) for c in pixels.reshape(-1, 3)}
                self.assertTrue(used <= allowed)
                self.assertLessEqual(len(used), 20)
                for gate in world['sea_gates']:
                    point = geo_pixel(gate['geo_position'], REGIONS[region]['bounds'], size)
                    if point:
                        x, y = point
                        yy,xx=np.nonzero(np.any(np.all(pixels[:,:,None,:] == np.array(list(sea)),axis=3),axis=2))
                        bounds=REGIONS[region]['bounds'];position=gate['geo_position']
                        lon=(position['lon']-bounds['lon_min'])%360+bounds['lon_min']
                        cx=(lon-bounds['lon_min'])/(bounds['lon_max']-bounds['lon_min'])*size[0]
                        cy=(bounds['lat_max']-position['lat'])/(bounds['lat_max']-bounds['lat_min'])*size[1]
                        distance=np.hypot(np.maximum(np.maximum(xx-cx,cx-xx-1),0),
                                          np.maximum(np.maximum(yy-cy,cy-yy-1),0))
                        self.assertLessEqual(distance.min(),1,gate['id'])


    def test_exact_palette_sea_coast_terrain_and_shade(self):
        palette = load_palette()
        lookup = {c['id']:tuple(bytes.fromhex(c['hex'][1:])) for c in palette['colors']}
        land = np.ones((7,20),dtype=bool); land[:,:4] = False
        classes = np.tile(np.repeat(np.arange(5),4),(7,1))
        shade = np.tile(np.arange(20)%3,(7,1))
        distance = np.tile([8,3,2,1]+[0]*16,(7,1))
        out = paint_palette(classes,land,shade,distance,(1,3),palette)
        for x,color in enumerate(['sea-1','sea-2','sea-2','sea-3','teal-4']):
            self.assertEqual(tuple(out[3,x]),lookup[color])
        from build_map import TERRAIN_RAMPS
        for x in range(5,20):
            self.assertEqual(tuple(out[3,x]),lookup[TERRAIN_RAMPS[classes[3,x]][shade[3,x]]])
        self.assertNotIn('teal-4',{color for ramp in TERRAIN_RAMPS.values() for color in ramp})
        self.assertTrue(set(TERRAIN_RAMPS[MOUNTAIN]).isdisjoint(TERRAIN_RAMPS[SNOW] + TERRAIN_RAMPS[DRY]))

    def test_vector_area_holes_longitude_wrap_and_thin_islands(self):
        import tempfile
        from pathlib import Path
        from build_map import rasterize_land
        with tempfile.TemporaryDirectory() as directory:
            land = Path(directory)/'land.json'; lakes = Path(directory)/'lakes.json'
            def polygon(rings): return {'type':'Feature','geometry':{'type':'Polygon','coordinates':rings}}
            def rectangle(x0,y0,x1,y1):return [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]
            land.write_text(json.dumps({'features':[polygon([rectangle(-175,0,-171,4),rectangle(-174,1,-173,2)])]}),encoding='utf-8')
            lakes.write_text(json.dumps({'features':[polygon([rectangle(-172,2,-171,3)])]}),encoding='utf-8')
            bounds={'lon_min':180,'lon_max':190,'lat_min':0,'lat_max':5}
            mask=rasterize_land(land,lakes,bounds,(10,5),7)
            self.assertTrue(mask[2,5]);self.assertFalse(mask[3,6]);self.assertFalse(mask[2,8])
            self.assertFalse(mask[2,4])

    def test_height_alignment_and_bilinear_enlargement(self):
        from build_map import resize_equirect
        source=Image.fromarray(np.array([[0,255],[64,128]],dtype=np.uint8))
        bounds={'lon_min':-90,'lon_max':90,'lat_min':-45,'lat_max':45}
        actual=resize_equirect(source,bounds,(9,9),Image.Resampling.BILINEAR)
        expected=source.resize((9,9),Image.Resampling.BILINEAR,box=(.5,.5,1.5,1.5))
        self.assertEqual(actual.tobytes(),expected.tobytes())
        self.assertNotEqual(actual.tobytes(),source.resize((9,9),Image.Resampling.BOX,box=(.5,.5,1.5,1.5)).tobytes())
        # 생성기가 확대에도 BILINEAR를 요청하는지 실제 호출을 가로챈다.
        from unittest.mock import patch
        from build_map import build_pixel, source_hashes
        args=self.source_args('east-asia')
        self.require_sources(args)
        calls=[]
        def resized(image,bounds,size,resample):
            calls.append((image.mode,resample))
            return resize_equirect(image,bounds,size,resample)
        import tempfile,contextlib,io
        with tempfile.TemporaryDirectory() as directory, patch('build_map.resize_equirect',side_effect=resized), contextlib.redirect_stdout(io.StringIO()):
            build_pixel(args,source_hashes(args),Path(directory))
        self.assertIn(('L',Image.Resampling.BILINEAR),calls)
        self.assertNotIn(('L',Image.Resampling.BOX),calls)

    def source_args(self,region):
        from types import SimpleNamespace
        return SimpleNamespace(source_dir=Path(os.environ.get('SCITRADE_MAP_SOURCES', ROOT.parent/'map')),region=region,style='pixel')

    def require_sources(self,args):
        resolution='10m' if args.region=='east-asia' else '50m'
        required=['bluemarble.jpg','topology.png',f'ne/ne_{resolution}_land.geojson',f'ne/ne_{resolution}_lakes.geojson']
        missing=[name for name in required if not (args.source_dir/name).exists()]
        if missing:
            reason=f'재생성 원본 없음 ({args.source_dir}): '+', '.join(missing)
            print(reason, file=sys.stderr)
            self.skipTest(reason)

    def test_regeneration_byte_identity_geography_and_connections(self):
        from build_map import build_pixel,source_hashes,CHECK_POINTS
        import tempfile,contextlib,io
        from pathlib import Path
        for region in PIXEL_SIZES:
            args=self.source_args(region)
            self.require_sources(args)
            with self.subTest(region=region),tempfile.TemporaryDirectory() as directory,contextlib.redirect_stdout(io.StringIO()):
                meta=build_pixel(args,source_hashes(args),Path(directory))
                self.assertEqual((Path(directory)/f'{region}.png').read_bytes(),(ROOT/f'public/assets/maps/{region}.png').read_bytes())
                self.assertTrue(all(c['passed'] for c in meta['city_coast_checks']),meta['city_coast_checks'])
                self.assertTrue(all(c['passed'] for c in meta['gate_water_checks']),meta['gate_water_checks'])
                self.assertTrue(all(c['connected'] for c in meta['sea_connections']),meta['sea_connections'])
                self.assertEqual(meta['gate_warnings'],[])
                self.assertLessEqual(meta['color_isolated_ratio_8'],0.003)
                self.assertTrue(all(c['passed'] for c in meta['point_checks']),meta['point_checks'])
                self.assertTrue(all(c['connected'] for c in meta['passage_connections']),meta['passage_connections'])
                for passage in meta['gates_opened']:
                    if passage['id'] in ('MALACCA_STRAIT','KOREA_STRAIT','CAPE_OF_GOOD_HOPE'):
                        self.assertTrue(passage['already_connected'],passage)
                        self.assertEqual(passage['source_land_cells'],0)
                    self.assertLessEqual(passage['changed_cells'],6)
                self.assertEqual(meta['ocean_cells_before_cleanup'],meta['ocean_cells_after_cleanup'])
                checks = {l['name']: l for l in meta['lake_checks']}
                expected = EAST_ASIA_LAKES if region == 'east-asia' else WORLD_LAKES
                sea = {tuple(c) for c in palette_rgb(load_palette())[4:7]}
                pixels = np.asarray(Image.open(Path(directory)/f'{region}.png'))
                for name,(lon,lat) in expected.items():
                    self.assertGreaterEqual(checks[name]['after_cells'],1,name)
                    self.assertGreaterEqual(checks[name]['after_cells'],checks[name]['before_cells']/2,name)
                    x,y = geo_pixel({'lon':lon,'lat':lat},REGIONS[region]['bounds'],PIXEL_SIZES[region])
                    nearby = pixels[max(0,y-2):y+3,max(0,x-2):x+3]
                    self.assertTrue(any(tuple(c) in sea for c in nearby.reshape(-1,3)),name)
                markers = {**PASSAGE_MARKERS, **{g['id']: g['geo_position'] for g in json.loads((ROOT/'data/world.json').read_text())['sea_gates']}}
                for passage in meta['gates_opened']:
                    if passage['changed_cells']:
                        self.assertLessEqual(min(pixel_distances(passage['changed_pixels'],markers[passage['id']],REGIONS[region]['bounds'],PIXEL_SIZES[region])),1,passage)
                        self.assertLessEqual(passage['gate_distance_px'],1)
                meta2=build_pixel(args,source_hashes(args),Path(directory))
                self.assertEqual(meta['output_sha256'],meta2['output_sha256'])

    def test_generation_fails_when_connection_check_fails(self):
        from unittest.mock import patch
        from build_map import build_pixel, source_hashes, carve_gate_passages as carve
        import tempfile,contextlib,io
        args=self.source_args('world');self.require_sources(args)
        def disconnected(*a):
            land, opened, _ = carve(*a)
            return land, opened, [{'id':'SUEZ_CANAL','connected':False}]
        with tempfile.TemporaryDirectory() as directory, patch('build_map.carve_gate_passages',side_effect=disconnected), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError,'바다 연결 실패'):
                build_pixel(args,source_hashes(args),Path(directory))
            self.assertFalse((Path(directory)/'world.png').exists())

    def test_exact_center_samples_and_polygon_holes_do_not_erase_other_islands(self):
        import tempfile
        from build_map import rasterize_land
        def rect(x0,y0,x1,y1):return [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]
        def feature(rings):return {'geometry':{'type':'Polygon','coordinates':rings}}
        with tempfile.TemporaryDirectory() as directory:
            land=Path(directory)/'land.json'; lakes=Path(directory)/'lakes.json'
            lakes.write_text(json.dumps({'features':[]}))
            bounds={'lon_min':0,'lon_max':1,'lat_min':0,'lat_max':1}
            land.write_text(json.dumps({'features':[feature([rect(0,0,.45,1)])]}))
            fraction=rasterize_land(land,lakes,bounds,(1,1),return_fraction=True)
            self.assertAlmostEqual(fraction[0,0],3/7)
            self.assertFalse(rasterize_land(land,lakes,bounds,(1,1))[0,0])
            island=feature([rect(.3,.3,.7,.7)])
            mainland=feature([rect(0,0,1,1),rect(.2,.2,.8,.8)])
            land.write_text(json.dumps({'features':[island,mainland]}))
            self.assertTrue(rasterize_land(land,lakes,bounds,(10,10))[5,5])
            land.write_text(json.dumps({'features':[mainland,island]}))
            self.assertTrue(rasterize_land(land,lakes,bounds,(10,10))[5,5])
            with self.assertRaisesRegex(ValueError,'홀수'):
                rasterize_land(land,lakes,bounds,(1,1),6)

    def test_small_inland_water_and_color_isolation(self):
        from build_map import remove_small_inland_water, color_isolated_ratio
        land=np.ones((8,8),dtype=bool)
        land[0:4,1]=False; land[3,2]=False; land[3,4]=False; land[5:7,5:7]=False
        lakes=[{'name':None,'area_cells':.8,'indices':[3*8+2,3*8+4]}, {'name':None,'area_cells':2,'indices':[5*8+5,5*8+6,6*8+5,6*8+6]}]
        clean=remove_small_inland_water(land,lakes)
        self.assertTrue(clean[3,4]);self.assertFalse(clean[3,2]);self.assertFalse(clean[5,5])
        # 원본이 1.5칸이면 화면에 한 칸만 잡혀도 남긴다.
        self.assertFalse(remove_small_inland_water(land,[{'name':None,'area_cells':1.5,'indices':[3*8+4]}])[3,4])
        out=np.zeros((5,5,3),dtype=np.uint8);out[2,2]=255;out[1,1]=255
        four=((-1,0),(1,0),(0,-1),(0,1))
        eight=[(dy,dx) for dy in (-1,0,1) for dx in (-1,0,1) if dy or dx]
        self.assertEqual(color_isolated_ratio(out,four),2/25)
        self.assertEqual(color_isolated_ratio(out,eight),0)


if __name__ == '__main__':
    unittest.main()
