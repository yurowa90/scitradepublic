"""PNG 원본 청크를 읽어 Pillow 변환 전에 비트 깊이와 색 공간을 확인한다."""
import io
import struct
import zlib
from PIL import Image, ImageCms


# 색 해석을 바꾸는 청크. 여럿이면 검사와 화면이 다른 청크를 볼 수 있어 거절한다.
COLOR_CHUNKS = (b'gAMA', b'cHRM', b'cICP', b'iCCP', b'sRGB')
# HDR 메타데이터. PNG 3판 최종 이름(mDCV·cLLI)과 초안 이름(mDCv·cLLi)을 모두 거절한다.
HDR_CHUNKS = (b'mDCV', b'cLLI', b'mDCv', b'cLLi')


def png_depth_errors(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return []
    if len(data) < 29 or data[24] > 8:
        return ['비트 깊이: 8비트 이하 PNG만 허용합니다.']
    return []


def png_errors(path):
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return []
    errors = png_depth_errors(data)
    offset = 8
    chunks = {}
    counts = {}
    while offset + 12 <= len(data):
        length = struct.unpack('>I', data[offset:offset+4])[0]
        kind = data[offset+4:offset+8]
        # 브라우저(Chromium)는 같은 청크가 여럿이면 첫 번째를 쓴다. 검사도 첫 번째를 본다.
        chunks.setdefault(kind, data[offset+8:offset+8+length])
        counts[kind] = counts.get(kind, 0) + 1
        offset += length + 12
    duplicated = [kind.decode('ascii', 'replace') for kind in COLOR_CHUNKS if counts.get(kind, 0) > 1]
    if duplicated:
        errors.append(f'색 청크 중복: {", ".join(duplicated)} 청크는 하나만 허용합니다.')
    if b'acTL' in chunks:
        errors.append('애니메이션: 움직이는 PNG(APNG)는 허용하지 않습니다.')
    if b'gAMA' in chunks and (len(chunks[b'gAMA']) != 4 or
                              abs(struct.unpack('>I', chunks[b'gAMA'])[0] / 100000 - .45455) > .000011):
        errors.append('감마: sRGB 감마(0.45455)만 허용합니다.')
    if b'cHRM' in chunks and chunks[b'cHRM'] != struct.pack('>8I', 31270,32900,64000,33000,30000,60000,15000,6000):
        errors.append('색 좌표: sRGB/D65가 아닌 cHRM은 허용하지 않습니다.')
    if b'cICP' in chunks and chunks[b'cICP'] != bytes((1,13,0,1)):
        errors.append('색 공간: sRGB가 아닌 cICP는 허용하지 않습니다.')
    if any(kind in chunks for kind in HDR_CHUNKS):
        errors.append('색 공간: HDR 색 청크는 허용하지 않습니다.')
    if b'iCCP' in chunks:
        # 프로필 이름만 믿지 않고 표본 색이 sRGB와 같은지 변환으로 확인한다.
        try:
            # IDAT 뒤 청크도 Pillow의 지연 로딩 여부와 무관하게 검사한다.
            _, encoded = chunks[b'iCCP'].split(b'\0', 1)
            if encoded[0] != 0:
                raise ValueError('알 수 없는 프로필 압축')
            profile = ImageCms.ImageCmsProfile(io.BytesIO(zlib.decompress(encoded[1:])))
            samples = Image.new('RGB', (256, 1))
            samples.putdata([(i, (i*67) % 256, (i*131) % 256) for i in range(256)])
            converted = ImageCms.profileToProfile(samples, profile, ImageCms.createProfile('sRGB'), outputMode='RGB')
            sample_data = samples.get_flattened_data() if hasattr(samples, 'get_flattened_data') else samples.getdata()
            converted_data = converted.get_flattened_data() if hasattr(converted, 'get_flattened_data') else converted.getdata()
            if any(abs(a-b) > 1 for left, right in zip(sample_data, converted_data) for a,b in zip(left,right)):
                raise ValueError('sRGB와 다른 프로필')
        except (OSError, ValueError, KeyError, IndexError, zlib.error, ImageCms.PyCMSError):
            errors.append('색 프로필: sRGB가 아닌 iCCP는 허용하지 않습니다.')
    return errors
