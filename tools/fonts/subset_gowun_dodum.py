#!/usr/bin/env python3
"""Gowun Dodum 원본 TTF를 public/fonts/fonts.css의 unicode-range마다 WOFF2 부분 집합으로 나눈다.

결과는 OFL의 수정본(Modified Version)이다. Gowun Dodum은 예약 글꼴 이름이 없어 이름을 그대로 둔다.
출처·해시·옵션의 근거는 docs/art/FONT_LICENSES.md에 있다.

준비(저장소 밖 가상 환경): python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools==4.60.1 brotli==1.1.0
실행: /tmp/ft/bin/python tools/fonts/subset_gowun_dodum.py --source <GowunDodum-Regular.ttf> [--check]
--check는 파일을 쓰지 않고 다시 만든 결과가 저장소 파일과 바이트 단위로 같은지만 본다.
"""
from pathlib import Path
import argparse
import hashlib
import io
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
CSS = ROOT / 'public/fonts/fonts.css'
OUT = ROOT / 'public/fonts/gowun-dodum'
# yangheeryu/Gowun-Dodum 6d9ef10 fonts/ttf/GowunDodum-Regular.ttf = google/fonts ofl/gowundodum (Version 2.000)
SOURCE_SHA256 = 'a6e457933227483a11758fd0947bc74422a106d46f0bf057fdaa5af94a30067d'
FACE = re.compile(r"@font-face\{font-family:'Gowun Dodum';[^}]*?src:url\(gowun-dodum/(GowunDodum-Regular-\d+\.woff2)\) format\('woff2'\);unicode-range:([^}]+)\}")


def codepoints(text: str) -> list[int]:
    result = []
    for part in text.split(','):
        part = part.strip().upper().removeprefix('U+')
        low, _, high = part.partition('-')
        result.extend(range(int(low, 16), int(high or low, 16) + 1))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    from fontTools import subset
    from fontTools.ttLib import TTFont

    data = args.source.read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        print('원본 TTF의 SHA-256이 기록과 다릅니다', file=sys.stderr)
        return 2
    faces = FACE.findall(CSS.read_text(encoding='utf-8'))
    if not faces:
        print('fonts.css에서 Gowun Dodum 규칙을 찾지 못했습니다', file=sys.stderr)
        return 2
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']      # OpenType 기능을 모두 남긴다
    options.name_IDs = ['*']             # 저작권·라이선스(이름 13·14)를 포함한 이름 기록을 모두 남긴다
    options.name_languages = ['*']
    options.name_legacy = True
    options.notdef_outline = True
    differences = 0
    for filename, ranges in faces:
        font = TTFont(io.BytesIO(data), recalcTimestamp=False)  # 원본 수정 시각을 유지해 같은 입력이면 같은 바이트가 나온다
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=codepoints(ranges))
        subsetter.subset(font)
        buffer = io.BytesIO()
        font.flavor = 'woff2'
        font.save(buffer)
        target = OUT / filename
        if args.check:
            if not target.is_file() or target.read_bytes() != buffer.getvalue():
                print(f'다름: {target.relative_to(ROOT)}')
                differences += 1
        else:
            target.write_bytes(buffer.getvalue())
    print(f"{len(faces)}개 {'확인' if args.check else '작성'}, 다름 {differences}개")
    return 1 if differences else 0


if __name__ == '__main__':
    sys.exit(main())
