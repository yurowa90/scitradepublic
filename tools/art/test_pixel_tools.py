"""합성 그림으로 변환·검사의 계약과 실패 종료를 확인한다."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageFilter

try:
    from .palette import ROOT, export_palette, load_palette, nearest_color, nearest_indices, palette_rgb, rgb_to_lab
    from .png_format import png_errors
    from .pixelize import despeckle_pixels, pixelize
    from .check_pixel_asset import check_asset, slot_spec
except ImportError:
    from palette import ROOT, export_palette, load_palette, nearest_color, nearest_indices, palette_rgb, rgb_to_lab
    from png_format import png_errors
    from pixelize import despeckle_pixels, pixelize
    from check_pixel_asset import check_asset, slot_spec


class PixelToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.palette = load_palette()
        self.colors = palette_rgb(self.palette)

    def command(self, script, *args):
        return subprocess.run([sys.executable, str(ROOT / 'tools/art' / script), *map(str, args)],
                              capture_output=True, text=True)

    def test_blurred_noisy_draft_round_trip_and_determinism(self):
        source = np.zeros((32, 32, 4), dtype=np.uint8)
        source[3:29, 3:29, :3] = self.colors[14]
        source[3:29, 3:29, 3] = 255
        source[8:24, 8:24, :3] = self.colors[18]
        enlarged = Image.fromarray(source).resize((256, 256), Image.Resampling.NEAREST).filter(ImageFilter.GaussianBlur(2))
        noisy = np.array(enlarged).astype(np.int16)
        noisy[..., :3] += np.random.default_rng(7).integers(-5, 6, noisy[..., :3].shape)
        enlarged = Image.fromarray(np.clip(noisy, 0, 255).astype(np.uint8))
        input_path, output_path = self.directory / 'draft.png', self.directory / 'pixel.png'
        enlarged.save(input_path)
        self.assertTrue(np.any((noisy[..., 3] > 0) & (noisy[..., 3] < 255)))
        hashes = []
        for _ in range(2):
            result = self.command('pixelize.py', input_path, output_path, '--size', '32x32', '--max-colors', 15, '--despeckle')
            self.assertEqual(result.returncode, 0, result.stderr)
            meta = json.loads(result.stdout)
            self.assertEqual((meta['width'], meta['height']), (32, 32))
            self.assertLessEqual(meta['colors_used'], 15)
            hashes.append(hashlib.sha256(output_path.read_bytes()).hexdigest())
            check = self.command('check_pixel_asset.py', output_path, '--size', '32x32', '--max-colors', 15)
            self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        self.assertEqual(hashes[0], hashes[1])
        with Image.open(output_path) as recovered:
            actual = np.asarray(recovered)
        self.assertEqual(np.mean(np.all(actual == source, axis=2)), 1.0)

    def test_checker_rejects_each_error_and_exit_code(self):
        base = np.zeros((8, 8, 4), dtype=np.uint8)
        base[..., :3], base[..., 3] = self.colors[0], 255
        cases = [('알파', (0, 0, 3), 127, []), ('팔레트', (0, 0, 0), 1, []),
                 ('크기', None, None, ['--size', '9x9']), ('색 수', None, None, ['--max-colors', '1'])]
        for name, index, value, options in cases:
            with self.subTest(name=name):
                pixels = base.copy()
                if index:
                    pixels[index] = value
                if name == '색 수':
                    pixels[0, 0, :3] = self.colors[1]
                path = self.directory / f'{name}.png'
                Image.fromarray(pixels).save(path)
                size_args = [] if name == '크기' else ['--size', '8x8']
                result = self.command('check_pixel_asset.py', path, *size_args, *options)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(name + ':', result.stdout)
                self.assertEqual(len(result.stdout.splitlines()), 1)

    def test_format_and_frame_grid(self):
        path = self.directory / 'test.bmp'
        Image.new('RGB', (7, 8), tuple(self.colors[0])).save(path)
        errors = check_asset(path, (7, 8), frame=(4, 4))
        self.assertTrue(any(e.startswith('형식:') for e in errors))
        self.assertTrue(any(e.startswith('칸 격자:') for e in errors))

    def test_accent_colors(self):
        # 강조색은 허용 색에 들어가지만 줄기 검사(32색·8줄기)는 그대로다(DECISIONS 화면 미술 방향 13항).
        self.assertEqual(len(self.palette['colors']), 32)
        self.assertIn((0xcf, 0x3b, 0x2e), {tuple(int(v) for v in c) for c in self.colors})
        bad = json.loads(json.dumps(self.palette)); bad['accents'].append({'id': 'x', 'hex': bad['colors'][0]['hex']})
        path = self.directory / 'bad_accent.json'; path.write_text(json.dumps(bad), encoding='utf-8')
        with self.assertRaises(ValueError):
            load_palette(path)

    def test_slot_specs(self):
        for slot, spec in {'background': ((640,360),None,32), 'icon': ((16,16),None,15),
                           'map-icon': ((16,16),None,15), 'ship': ((24,16),None,15),
                           'frame': ((24,24),None,32)}.items():
            self.assertEqual(slot_spec(slot), spec)
        self.assertEqual(slot_spec('work'), ((192, 192), (48, 48), 15))
        self.assertEqual(slot_spec('portrait'), ((48, 48), None, 15))
        self.assertEqual(slot_spec('card'), ((96, 128), None, 32))
        self.assertEqual(slot_spec('map-east-asia'), ((546, 615), None, 20))
        self.assertEqual(slot_spec('map-world'), ((720, 244), None, 20))

    def test_palette_rejects_duplicate_and_reversed_lightness(self):
        for mode in ('duplicate', 'reverse', 'step', 'ramp', 'count', 'id'):
            with self.subTest(mode=mode):
                palette = copy.deepcopy(self.palette)
                if mode == 'duplicate':
                    palette['colors'][1]['hex'] = palette['colors'][4]['hex']
                elif mode == 'reverse':
                    a, b = palette['colors'][:2]
                    a['hex'], b['hex'] = b['hex'], a['hex']
                elif mode == 'step':
                    palette['colors'][1]['step'] = 1
                elif mode == 'ramp':
                    palette['ramps'][0]['id'] = 'unknown'
                elif mode == 'count':
                    palette['colors'].pop()
                else:
                    palette['colors'][1]['id'] = palette['colors'][0]['id']
                path = self.directory / 'palette.json'
                path.write_text(json.dumps(palette))
                messages = {'duplicate': 'hex가 중복', 'reverse': '밝기 역전', 'step': '1~4단계',
                            'ramp': '8줄기', 'count': '32색', 'id': 'ID가 중복'}
                with self.assertRaisesRegex(ValueError, messages[mode]):
                    load_palette(path)

    def test_gpl_export_and_lab(self):
        export_palette(self.palette, self.directory)
        lines = (self.directory / 'scitrade-32.gpl').read_text().splitlines()
        self.assertEqual(lines[:3], ['GIMP Palette', 'Name: scitrade-32', 'Columns: 4'])
        self.assertEqual(len([l for l in lines if l.strip() and l.strip()[0].isdigit()]), 32 + len(self.palette.get('accents', [])))
        self.assertEqual(len((self.directory / 'scitrade-32.hex').read_text().splitlines()), 32 + len(self.palette.get('accents', [])))
        self.assertAlmostEqual(rgb_to_lab([255, 255, 255])[0], 100, places=4)
        self.assertEqual(nearest_color(self.colors[12], self.palette)['id'], 'green-1')

    def test_modal_color_alpha_tie_and_arbitrary_size(self):
        # 평균색이 아닌 3표를 받은 원래 색을 유지한다.
        rgba = np.array([[list(self.colors[4]) + [255], list(self.colors[4]) + [255]],
                         [list(self.colors[4]) + [255], list(self.colors[19]) + [255]]], dtype=np.uint8)
        out = np.asarray(pixelize(Image.fromarray(rgba), (1, 1), self.palette))
        np.testing.assert_array_equal(out[0, 0], list(self.colors[4]) + [255])
        rgba[0, :, 3] = 0
        self.assertEqual(np.asarray(pixelize(Image.fromarray(rgba), (1, 1), self.palette))[0, 0, 3], 255)
        rgba[1, 0, 3] = 0
        self.assertEqual(np.asarray(pixelize(Image.fromarray(rgba), (1, 1), self.palette))[0, 0, 3], 0)
        enlarged = pixelize(Image.fromarray(rgba), (7, 9), self.palette)
        self.assertEqual(enlarged.size, (7, 9))
        self.assertTrue(set(np.unique(np.asarray(enlarged)[..., 3])) <= {0, 255})

    def test_despeckle_snapshot_and_transparency(self):
        grid = np.full((5, 5), 4, dtype=np.int16)
        grid[2, 2] = 8
        grid[0, 0] = -1
        result = despeckle_pixels(grid)
        self.assertEqual(result[2, 2], 4)
        self.assertEqual(grid[2, 2], 8)
        self.assertEqual(result[0, 0], -1)
        grid[2, 1] = 8
        self.assertEqual(despeckle_pixels(grid)[2, 2], 8)


    def test_lab_choice_differs_from_rgb_distance(self):
        sample = np.array([60, 46, 205])
        choices = np.array([[34, 87, 138], [124, 90, 158]])
        # RGB 거리는 첫 색, CIELAB은 두 번째 색을 고른다.
        self.assertEqual(((choices-sample)**2).sum(axis=1).argmin(), 0)
        self.assertEqual(int(nearest_indices(sample, choices)), 1)

    def test_lightness_seven_boundary(self):
        from unittest.mock import patch
        base = np.tile([0., 7., 14., 21.], 8)
        path = self.directory / 'palette.json'
        path.write_text(json.dumps(self.palette), encoding='utf-8')
        lab = np.zeros((32,3)); lab[:,0] = base
        module = load_palette.__module__
        with patch(module + '.rgb_to_lab', return_value=lab):
            self.assertEqual(load_palette(path), self.palette)
        lab[1,0] = 6.99999
        with patch(module + '.rgb_to_lab', return_value=lab):
            with self.assertRaisesRegex(ValueError, '최소 7'):
                load_palette(path)

    def test_max_colors_remaps_to_nearest_retained_lab_color(self):
        rgba = np.zeros((3,3,4), dtype=np.uint8)
        rgba[...,3] = 255; rgba[...,:3] = self.colors[0]
        rgba[0,:2,:3] = self.colors[1]; rgba[2,2,:3] = self.colors[12]
        out = np.asarray(pixelize(Image.fromarray(rgba), (3,3), self.palette, max_colors=2))
        expected = self.colors[[0,1]][int(nearest_indices(self.colors[12], self.colors[[0,1]]))]
        rgb_choice = ((self.colors[[0,1]].astype(int)-self.colors[12])**2).sum(axis=1).argmin()
        self.assertFalse(np.array_equal(expected,self.colors[[0,1]][rgb_choice]))
        np.testing.assert_array_equal(out[2,2,:3], expected)
        self.assertEqual(len(np.unique(out[...,:3].reshape(-1,3),axis=0)), 2)
        source_path, output_path = self.directory/'three-colors.png', self.directory/'two-colors.png'
        Image.fromarray(rgba).save(source_path)
        command = self.command('pixelize.py', source_path, output_path, '--size', '3x3', '--max-colors', '2')
        self.assertEqual(command.returncode, 0, command.stderr)
        with Image.open(output_path) as image:
            np.testing.assert_array_equal(np.asarray(image), out)

    def test_despeckle_is_connected_to_pixelize_and_preserves_diagonals(self):
        grid = np.full((7,7), 4, dtype=np.int16)
        np.fill_diagonal(grid, 8)
        np.testing.assert_array_equal(despeckle_pixels(grid), grid)
        grid = np.full((5,5), 4, dtype=np.int16); grid[2,2] = 8
        rgba = np.full((5,5,4), 255, dtype=np.uint8); rgba[...,:3] = self.colors[grid]
        raw = pixelize(Image.fromarray(rgba), (5,5), self.palette)
        clean = pixelize(Image.fromarray(rgba), (5,5), self.palette, despeckle=True)
        np.testing.assert_array_equal(np.asarray(raw)[2,2,:3], self.colors[8])
        np.testing.assert_array_equal(np.asarray(clean)[2,2,:3], self.colors[4])
        source_path, output_path = self.directory/'speckle.png', self.directory/'clean.png'
        Image.fromarray(rgba).save(source_path)
        command = self.command('pixelize.py', source_path, output_path, '--size', '5x5', '--despeckle')
        self.assertEqual(command.returncode, 0, command.stderr)
        with Image.open(output_path) as image:
            np.testing.assert_array_equal(np.asarray(image), np.asarray(clean))
        # 4표로는 바꾸지 않는다.
        grid = np.array([[4,4,4],[4,8,12],[12,12,12]],dtype=np.int16)
        self.assertEqual(despeckle_pixels(grid)[1,1],8)
        grid[2,0] = 4  # 정확히 5표부터 바꾼다.
        self.assertEqual(despeckle_pixels(grid)[1,1],4)

    def test_alpha_threshold_inclusive_boundary(self):
        rgba = np.zeros((1,3,4),dtype=np.uint8); rgba[...,:3] = self.colors[4]
        rgba[...,3] = [127,128,129]
        out = pixelize(Image.fromarray(rgba),(3,1),self.palette,alpha_threshold=128)
        np.testing.assert_array_equal(np.asarray(out)[...,3],[[0,255,255]])
        source_path, output_path = self.directory/'alpha.png', self.directory/'alpha-out.png'
        Image.fromarray(rgba).save(source_path)
        command = self.command('pixelize.py', source_path, output_path, '--size', '3x1', '--alpha-threshold', '129')
        self.assertEqual(command.returncode, 0, command.stderr)
        with Image.open(output_path) as image:
            np.testing.assert_array_equal(np.asarray(image)[...,3], [[0,0,255]])

    def test_color_count_fifteen_and_sixteen(self):
        for count in (15,16):
            path = self.directory / f'{count}.png'
            Image.fromarray(self.colors[:count].reshape(1,count,3)).save(path)
            errors = check_asset(path,(count,1),max_colors=15)
            self.assertEqual(bool(errors),count==16)
            if errors: self.assertTrue(errors[0].startswith('색 수:'))

    def test_png_depth_animation_gamma_and_profile(self):
        import struct
        from PIL.PngImagePlugin import PngInfo
        path = self.directory / 'special.png'
        Image.fromarray(np.full((4,4),40000,dtype=np.uint16)).save(path)
        self.assertTrue(any(e.startswith('비트 깊이:') for e in check_asset(path,(4,4))))
        result = self.command('pixelize.py',path,self.directory/'out.png','--size','4x4')
        self.assertEqual(result.returncode,1); self.assertIn('비트 깊이:',result.stderr)
        frames = [Image.new('RGB',(4,4),tuple(c)) for c in self.colors[:2]]
        frames[0].save(path,save_all=True,append_images=frames[1:],duration=100,loop=0)
        self.assertEqual(check_asset(path,(4,4)),['애니메이션: 움직이는 PNG(APNG)는 허용하지 않습니다.'])
        for gamma, valid in ((45455,True),(45454,True),(45456,True),(45457,False),(100000,False)):
            info = PngInfo(); info.add(b'gAMA',struct.pack('>I',gamma))
            frames[0].save(path,pnginfo=info)
            self.assertEqual(bool(check_asset(path,(4,4))),not valid)
        from PIL import ImageCms
        srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        # 이름과 RGB 색 공간은 유지하고 실제 전달 곡선의 감마만 바꾼다.
        altered = bytearray(srgb)
        count = struct.unpack('>I',altered[128:132])[0]
        for i in range(count):
            tag,offset,length = struct.unpack('>4sII',altered[132+i*12:144+i*12])
            if tag in (b'rTRC',b'gTRC',b'bTRC'):
                self.assertEqual(altered[offset:offset+4],b'para')
                altered[offset+12:offset+16] = struct.pack('>i',round(1.6*65536))
        for profile, valid in ((srgb,True),(bytes(altered),False)):
            frames[0].save(path,icc_profile=profile)
            errors = check_asset(path,(4,4))
            self.assertEqual(bool(errors),not valid)
            if errors: self.assertTrue(errors[0].startswith('색 프로필:'))
        # 원본 청크 순서가 IDAT 뒤여도 ICC 검사에서 예외가 나지 않는다.
        data=path.read_bytes();offset=8;chunks=[]
        while offset < len(data):
            length=struct.unpack('>I',data[offset:offset+4])[0]
            chunks.append(data[offset:offset+length+12]);offset+=length+12
        iccp=next(c for c in chunks if c[4:8]==b'iCCP')
        reordered=[c for c in chunks if c[4:8] not in (b'iCCP',b'IEND')]+[iccp,chunks[-1]]
        path.write_bytes(data[:8]+b''.join(reordered))
        self.assertTrue(any(e.startswith('색 프로필:') for e in check_asset(path,(4,4))))

    def test_four_bit_palette_png_is_valid(self):
        path=self.directory/'four-bit.png'
        image=Image.new('P',(4,4))
        image.putpalette(self.colors[:16].reshape(-1).tolist())
        image.putdata(list(range(16)))
        image.save(path,bits=4)
        self.assertEqual(path.read_bytes()[24],4)
        self.assertEqual(png_errors(path),[])
        self.assertEqual(check_asset(path,(4,4)),[])
        with Image.open(path) as source:
            self.assertEqual(pixelize(source,(4,4),self.palette).size,(4,4))

    def test_color_coordinate_and_signal_chunks(self):
        import struct
        from PIL.PngImagePlugin import PngInfo
        path=self.directory/'color.png'
        for kind,valid,invalid in [
            (b'cHRM',struct.pack('>8I',31270,32900,64000,33000,30000,60000,15000,6000),struct.pack('>8I',34570,35850,64000,33000,30000,60000,15000,6000)),
            (b'cICP',bytes((1,13,0,1)),bytes((9,16,0,1))),
            # 한 필드만 다른 경우도 거절한다: 원색만, 전달 특성만, 원색 좌표만.
            (b'cICP',bytes((1,13,0,1)),bytes((9,13,0,1))),
            (b'cICP',bytes((1,13,0,1)),bytes((1,16,0,1))),
            (b'cHRM',struct.pack('>8I',31270,32900,64000,33000,30000,60000,15000,6000),struct.pack('>8I',31270,32900,68000,32000,26500,69000,15000,6000)),
        ]:
            for data,accepted in [(valid,True),(invalid,False)]:
                info=PngInfo();info.add(kind,data)
                Image.new('RGB',(1,1),tuple(self.colors[0])).save(path,pnginfo=info)
                self.assertEqual(bool(png_errors(path)),not accepted)
                self.assertEqual(bool(check_asset(path,(1,1))),not accepted)
        for kind in (b'mDCv',b'cLLi',b'mDCV',b'cLLI'):
            Image.new('RGB',(1,1),tuple(self.colors[0])).save(path)
            import zlib
            payload=b'\0'*24
            chunk=struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload))
            data=path.read_bytes();path.write_bytes(data[:-12]+chunk+data[-12:])
            self.assertTrue(any('HDR' in e for e in png_errors(path)))

    def test_duplicate_color_chunks_are_rejected(self):
        # Chromium은 첫 번째 청크를 쓴다. 잘못된 청크 뒤에 올바른 청크를 붙여 검사를 피할 수 없어야 한다.
        import struct,zlib
        def chunk(kind,data):
            return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
        srgb_chrm=struct.pack('>8I',31270,32900,64000,33000,30000,60000,15000,6000)
        cases={
            'gAMA':[chunk(b'gAMA',struct.pack('>I',100000)),chunk(b'gAMA',struct.pack('>I',45455))],
            'cICP':[chunk(b'cICP',bytes((9,16,0,1))),chunk(b'cICP',bytes((1,13,0,1)))],
            'cHRM':[chunk(b'cHRM',srgb_chrm),chunk(b'cHRM',srgb_chrm)],
        }
        path=self.directory/'duplicate.png'
        for name,extra in cases.items():
            Image.new('RGB',(1,1),tuple(self.colors[0])).save(path)
            data=path.read_bytes()
            path.write_bytes(data[:33]+b''.join(extra)+data[33:])
            errors=png_errors(path)
            self.assertTrue(any('색 청크 중복' in e and name in e for e in errors),(name,errors))
            self.assertTrue(check_asset(path,(1,1)))
        # 첫 번째 청크가 잘못되었으면 그것을 근거로도 거절한다.
        Image.new('RGB',(1,1),tuple(self.colors[0])).save(path)
        data=path.read_bytes()
        path.write_bytes(data[:33]+cases['gAMA'][0]+data[33:])
        self.assertTrue(any('감마' in e for e in png_errors(path)))

    def test_srgb_profile_after_idat_and_old_pillow_fallback(self):
        import struct
        from PIL import ImageCms
        from unittest.mock import patch
        path=self.directory/'late-srgb.png'
        srgb=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        Image.new('RGB',(2,2),tuple(self.colors[4])).save(path,icc_profile=srgb)
        data=path.read_bytes();offset=8;chunks=[]
        while offset<len(data):
            length=struct.unpack('>I',data[offset:offset+4])[0]
            chunks.append(data[offset:offset+length+12]);offset+=length+12
        iccp=next(c for c in chunks if c[4:8]==b'iCCP')
        path.write_bytes(data[:8]+b''.join([c for c in chunks if c[4:8] not in (b'iCCP',b'IEND')]+[iccp,chunks[-1]]))
        self.assertEqual(png_errors(path),[])
        self.assertEqual(check_asset(path,(2,2)),[])
        original_hasattr=hasattr
        original_getdata=Image.Image.getdata
        with patch(png_errors.__module__+'.hasattr',side_effect=lambda obj,name: False if name=='get_flattened_data' else original_hasattr(obj,name),create=True), patch.object(Image.Image,'getdata',autospec=True,side_effect=original_getdata) as fallback:
            self.assertEqual(png_errors(path),[])
            self.assertEqual(fallback.call_count,2)

    def test_low_bit_palette_and_grayscale_formats(self):
        import struct,zlib,io
        def chunk(kind,data):
            return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
        for depth in (1,2):
            path=self.directory/f'palette-{depth}.png'
            image=Image.new('P',(4,4));image.putpalette(self.colors[:2**depth].reshape(-1).tolist())
            image.save(path,bits=depth)
            self.assertEqual(path.read_bytes()[24],depth)
            self.assertEqual(png_errors(path),[])
            self.assertEqual(check_asset(path,(4,4)),[])
            with Image.open(path) as source:self.assertEqual(pixelize(source,(4,4),self.palette).size,(4,4))
        for depth in (1,2,4):
            header=struct.pack('>IIBBBBB',1,1,depth,0,0,0,0)
            raw=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',header)+chunk(b'IDAT',zlib.compress(b'\0\0'))+chunk(b'IEND',b'')
            path=self.directory/f'gray-{depth}.png';path.write_bytes(raw)
            self.assertEqual(png_errors(path),[])
            with Image.open(io.BytesIO(raw)) as source:self.assertEqual(pixelize(source,(1,1),self.palette).size,(1,1))

    def test_pixelize_function_rejects_sixteen_bit_rgb_png(self):
        import struct,zlib,io
        def chunk(kind,data):
            return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
        header=struct.pack('>IIBBBBB',1,1,16,2,0,0,0)
        raw=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',header)+chunk(b'IDAT',zlib.compress(b'\0'+struct.pack('>HHH',40000,20000,10000)))+chunk(b'IEND',b'')
        with Image.open(io.BytesIO(raw)) as source:
            self.assertEqual(source.mode,'RGB')
            with self.assertRaisesRegex(ValueError,'비트 깊이:'):
                pixelize(source,(1,1),self.palette)
        from unittest.mock import patch
        path=self.directory/'sixteen.png';path.write_bytes(raw)
        with Image.open(path) as source:
            source.filename=str(self.directory/'gone.png')
            with patch('builtins.open',side_effect=AssertionError('디스크 재읽기')):
                with self.assertRaisesRegex(ValueError,'비트 깊이:'):
                    pixelize(source,(1,1),self.palette)
        with Image.open(io.BytesIO(raw)) as source:
            source.load()
            # 디코더 정보가 사라진 RGB는 경로 함수에 검사를 맡긴다.
            with patch('builtins.open',side_effect=AssertionError('디스크 재읽기')):
                self.assertEqual(pixelize(source,(1,1),self.palette).size,(1,1))


if __name__ == '__main__':
    unittest.main()
