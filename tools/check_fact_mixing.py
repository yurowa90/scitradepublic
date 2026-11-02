#!/usr/bin/env python3
"""도시 고유 사실의 주인과 설계·실측 근거를 검사한다."""
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Any
from collections import defaultdict
from decimal import Decimal, InvalidOperation, localcontext
import argparse
import json
import re

RANK_RE = re.compile(r'(?<![0-9.,])(?:(전국|국내)\s?)?([0-9]{1,3})\s?위(?![치험해원반쪽안])')
QTY_RE = re.compile(r'(?<![0-9.,])[0-9][0-9,.]*\s?(?:만|억)?\s?(?:TEU|R/T|운임톤|dwt)')
SHARE_RE = re.compile(r'(?<![0-9.,])[−-]?[0-9]+(?:\.[0-9]+)?\s?[%％]')
SHARE_CONTEXT_RE = re.compile(r'환적|비중|점유|물동량')
CLAIM_RE = re.compile(r'(전국|국내)\s?(최대|최다)')
SENTENCE_SPLIT_RE = re.compile(r'(?<=[.!?。])\s+|\n+')
CODES = set('FACT_OUTSIDE_HUB_TEXT FACT_NAMES_OTHER_HUB FACT_NOT_IN_OWN_ENTRY RANK_WITHOUT_BASIS FACT_SHARED_BETWEEN_HUBS SENTENCE_SHARED_BETWEEN_HUBS DESIGN_WITH_OBSERVED_LEVEL DESIGN_SOURCE_LEVEL DESIGN_AS_OBSERVED UNKNOWN_CITY_ID ALLOWLIST_UNUSED'.split())
MESSAGES = dict(zip([
    'FACT_OUTSIDE_HUB_TEXT', 'FACT_NAMES_OTHER_HUB', 'FACT_NOT_IN_OWN_ENTRY',
    'RANK_WITHOUT_BASIS', 'FACT_SHARED_BETWEEN_HUBS', 'SENTENCE_SHARED_BETWEEN_HUBS',
    'DESIGN_WITH_OBSERVED_LEVEL', 'DESIGN_SOURCE_LEVEL', 'DESIGN_AS_OBSERVED',
    'UNKNOWN_CITY_ID', 'ALLOWLIST_UNUSED'], [
    '거점 항목·그 도시 문장·출처 밖에 도시 고유 사실이 있다',
    '다른 거점(<ID>)의 이름과 사실이 한 문장에 있다',
    '이 도시 문장의 사실이 그 도시 world 항목에 없다',
    '순위가 자기 selection_basis에 없고 전국·국내 범위도 없다',
    '같은 물동량·비율 값이나 같은 선정 근거가 여러 거점에 있다',
    '같은 문장이 여러 거점에 있다',
    'DESIGN 표시와 실측 확인 수준이 한 객체에 함께 있다',
    '설계 출처의 종류와 확인 수준이 맞지 않는다',
    '실측 근거가 설계 출처만 인용한다',
    'city_id가 world 거점이 아니다',
    '허용 목록 항목이 어떤 결과와도 맞지 않는다(지우거나 고친다)']))
ALLOWLIST = [
    {'code': 'RANK_WITHOUT_BASIS', 'file': 'world.json', 'record': 'PYEONGTAEK', 'field': 'hub_note_ko', 'token': '8위', 'sentence_contains': '서울(GFCI 39 8위)', 'reason': '서울의 국제 금융센터 지수 순위다. 서울은 지도 거점이 아니며 본사 금융 설명에만 쓴다.'},
    {'code': 'RANK_WITHOUT_BASIS', 'file': 'world.json', 'record': 'SHANGHAI', 'field': 'hub_note_ko', 'token': '3위', 'sentence_contains': '3위 닝보·저우산항', 'reason': '인접 닝보·저우산항의 세계 컨테이너항 순위다. 상하이 권역으로 묶는 이유를 설명한다.'},
    {'code': 'RANK_WITHOUT_BASIS', 'file': 'world.json', 'record': 'SINGAPORE', 'field': 'hub_note_ko', 'token': '10위', 'sentence_contains': '10위 포트클랑(말레이시아)', 'reason': '인접 포트클랑의 세계 컨테이너항 순위다. 싱가포르 권역 설명이다.'},
    {'code': 'RANK_WITHOUT_BASIS', 'file': 'world.json', 'record': 'HONG_KONG', 'field': 'hub_note_ko', 'token': '6위', 'sentence_contains': '6위 광저우가 가까워', 'reason': '인접 광저우의 세계 컨테이너항 순위다. 홍콩 권역으로 묶는 이유를 설명한다.'},
    {'code': 'RANK_WITHOUT_BASIS', 'file': 'world.json', 'record': 'MUMBAI', 'field': 'hub_note_ko', 'token': '1위', 'sentence_contains': '총화물량 1위는 구자라트의 문드라항', 'reason': '문드라항의 인도 총화물량 순위다. 컨테이너와 총화물 기준이 다르다는 설명이다.'},
    {'code': 'RANK_WITHOUT_BASIS', 'file': 'world.json', 'record': 'ROTTERDAM', 'field': 'hub_note_ko', 'token': '3위', 'sentence_contains': '3위 함부르크는 로테르담 권역', 'reason': '인접 함부르크의 순위다. 로테르담 권역으로 묶는 이유를 설명한다.'},
    {'code': 'FACT_NAMES_OTHER_HUB', 'file': 'world.json', 'record': 'PANAMA', 'field': 'selection_basis.value_ko', 'token': '1위', 'sentence_contains': '산투스에 1위를 내주기 전까지', 'other': 'SANTOS', 'reason': '콜론항이 라틴아메리카 1위를 산투스에 내준 순위 변화 설명이다. 산투스의 값을 파나마의 사실로 쓰지 않는다.'},
    {'code': 'FACT_NOT_IN_OWN_ENTRY', 'file': 'culture_activities.json', 'record': 'CA02', 'field': 'report_ko.open_question_ko', 'token': '1위', 'sentence_contains': '1위 항만과는 얼마나 차이 나는지', 'reason': '본사 항만의 사실이 아니라 ‘1위 항만과의 차이’를 묻는 열린 질문이다. 값을 주장하지 않는다.'},
]

@dataclass(frozen=True)
class Token:
    kind: str
    text: str
    scope: str | None = None
    number: int | None = None

@dataclass(frozen=True)
class TextUnit:
    file: str
    record: str | None
    field: str
    owner: str | None
    owner_kind: str | None
    sentence: str

@dataclass
class Finding:
    code: str
    file: str
    record: str | None
    field: str
    token: str
    sentence: str
    message: str
    other: str = ''

    def key(self):
        return (self.code, self.file, self.record, self.field, self.token, self.other)

class AllowlistError(ValueError):
    pass

def normalized(text):
    return ' '.join(text.split())

def canonical(token: Token) -> str:
    if token.kind not in {'QTY', 'SHARE'}:
        return token.text
    text = re.sub(r'[\s,]', '', token.text.replace('％', '%').replace('−', '-'))
    match = re.fullmatch(r'(-?[0-9.]+)(만|억)?(TEU|R/T|운임톤|dwt|%)', text)
    if not match:
        return text
    number, scale, unit = match.groups()
    try:
        with localcontext() as context:
            context.prec = max(28, len(number) + 8)
            value = Decimal(number) * {None: 1, '만': 10000, '억': 100000000}[scale]
    except InvalidOperation:
        return text
    value_text = format(value, 'f')
    if '.' in value_text:
        value_text = value_text.rstrip('0').rstrip('.')
    return value_text + unit

def names_hub(sentence, names, gate_names) -> bool:
    gate_spans = [m.span() for name in gate_names for m in re.finditer(re.escape(name), sentence)]
    suffixes = tuple(sorted('으로 에서 까지 부터 보다 처럼 과의 와의 에는 에도 이나 은 는 이 가 을 를 의 에 와 과 도 로 만 나 항 시 권 발 행'.split(), key=len, reverse=True))
    for name in names:
        if name.isascii():
            if re.search(r'\b' + re.escape(name) + r'\b', sentence):
                return True
            continue
        for match in re.finditer(re.escape(name), sentence):
            if any(start <= match.start() and match.end() <= end for start, end in gate_spans):
                continue
            tail = sentence[match.end():]
            if tail and '가' <= tail[0] <= '힣' and not tail.startswith(suffixes):
                continue
            return True
    return False

def split_sentences(text: str) -> list[str]:
    return [part.strip() for part in SENTENCE_SPLIT_RE.split(text) if part.strip()]

def fact_tokens(sentence: str) -> list[Token]:
    tokens = []
    for match in RANK_RE.finditer(sentence):
        scope, number = match.groups()
        text = f'{int(number)}위'
        tokens.append(Token('RANK', f'{scope} {text}' if scope else text, scope, int(number)))
    for kind, regex in [('QTY', QTY_RE), ('SHARE', SHARE_RE), ('CLAIM', CLAIM_RE)]:
        if kind == 'SHARE' and not SHARE_CONTEXT_RE.search(sentence):
            continue
        tokens.extend(Token(kind, normalized(m.group())) for m in regex.finditer(sentence))
    return tokens

def load_documents(root: Path) -> dict[str, Any]:
    docs = {p.name: json.loads(p.read_text(encoding='utf-8')) for p in sorted((root / 'data').glob('*.json'))}
    for name in ('world.json', 'sources.json'):
        if name not in docs:
            raise FileNotFoundError(f'필수 자료 파일이 없습니다: {name}')
    return docs

def hub_aliases(world: dict) -> dict[str, set[str]]:
    return {h['id']: {h['id']} | {p.strip() for p in re.split(r'[·()]', h['name_ko']) if len(p.strip()) >= 2}
            for h in world['items']}

def leaves(obj, path=''):
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for key, value in obj.items():
            yield from leaves(value, f'{path}.{key}' if path else key)
    elif isinstance(obj, list):
        for value in obj:
            yield from leaves(value, path)

def finding(code, file, record, field, token='', sentence='', other=None):
    message = MESSAGES[code]
    if other is not None:
        message = message.replace('<ID>', other)
    return Finding(code, file, record, field, token, sentence, message, other or '')

CITY_FILES = {'venues.json', 'contacts.json', 'culture_activities.json'}

def collect_units(docs: dict) -> tuple[list[TextUnit], list[Finding]]:
    hubs = set(hub_aliases(docs['world.json']))
    units, findings = [], []
    def walk(obj, file, path='', record=None, owner=None, kind=None):
        if isinstance(obj, dict):
            if record is None:
                record = obj.get('id')
            for key, value in obj.items():
                walk(value, file, f'{path}.{key}' if path else key, record, owner, kind)
        elif isinstance(obj, list):
            for value in obj:
                walk(value, file, path, record, owner, kind)
        elif isinstance(obj, str):
            units.extend(TextUnit(file, record, path, owner, kind, s) for s in split_sentences(obj))
    for file, obj in sorted(docs.items()):
        if file == 'sources.json':
            continue
        if file == 'world.json' or file in CITY_FILES:
            for key, value in obj.items():
                if key == 'items' or (file == 'world.json' and key == 'sea_gates'):
                    for item in value:
                        if file == 'world.json':
                            owner, kind = item['id'], 'gate' if key == 'sea_gates' else 'hub'
                        else:
                            owner, kind = item.get('city_id'), 'hub'
                            if owner not in hubs:
                                findings.append(finding('UNKNOWN_CITY_ID', file, item.get('id'), 'city_id', str(owner)))
                                owner, kind = None, None
                        walk(item, file, record=item.get('id'), owner=owner, kind=kind)
                else:
                    walk(value, file, key)
        else:
            for key, value in obj.items():
                if key == 'items' and isinstance(value, list):
                    for item in value:
                        walk(item, file, record=item.get('id') if isinstance(item, dict) else None)
                else:
                    walk(value, file, key)
    return units, findings

def validate_allowlist(allowlist: list[dict]) -> None:
    seen = set()
    for entry in allowlist:
        if not isinstance(entry, dict) or not {'code', 'file', 'record', 'field', 'token', 'reason', 'sentence_contains'} <= entry.keys():
            raise AllowlistError('허용 목록에 필수 키가 없습니다')
        if not isinstance(entry['reason'], str) or not entry['reason'].strip():
            raise AllowlistError('허용 목록 사유가 비었습니다')
        if entry['code'] not in CODES:
            raise AllowlistError('허용 목록의 결과 코드가 올바르지 않습니다')
        if not isinstance(entry['sentence_contains'], str) or len(entry['sentence_contains']) < 8:
            raise AllowlistError('허용 문장 조각은 8자 이상이어야 합니다')
        if entry['code'] == 'FACT_NAMES_OTHER_HUB' and not (isinstance(entry.get('other'), str) and entry['other'].strip()):
            raise AllowlistError('허용 목록에 상대 거점이 없습니다')
        key = tuple(entry[k] for k in ('code', 'file', 'record', 'field', 'token')) + (entry.get('other', ''), entry['sentence_contains'])
        if key in seen:
            raise AllowlistError('허용 목록 키가 중복됩니다')
        seen.add(key)

def observed(obj):
    status, level = obj.get('verification_status'), obj.get('check_level')
    return (isinstance(status, str) and not status.startswith('LOCAL_DESIGN') and status != 'NOT_VERIFIED') or (
        isinstance(level, str) and bool(level.strip()) and level != 'author_knowledge' and not level.startswith('작성자 지식'))

def designed(obj):
    return any(isinstance(v, str) and (
        ((k in {'data_basis', 'basis'} or k.endswith('_basis')) and (v == 'DESIGN' or v.startswith('DESIGN_')))
        or (k.endswith('status') and v.startswith('DESIGN_'))) for k, v in obj.items())

def check_documents(docs: dict, allowlist: list[dict] | None = None) -> list[Finding]:
    allowlist = ALLOWLIST if allowlist is None else allowlist
    validate_allowlist(allowlist)
    world, sources = docs['world.json'], {s['id']: s for s in docs['sources.json']['items']}
    aliases = hub_aliases(world)
    gate_names = [g['name_ko'] for g in world.get('sea_gates', []) if g.get('name_ko')]
    units, findings = collect_units(docs)
    own, basis_numbers = {}, {}
    shared_tokens, shared_basis, shared_sentences = defaultdict(list), defaultdict(list), defaultdict(list)
    shared_text = {}
    for hub in world['items']:
        hid = hub['id']
        tokens = [t for _, text in leaves(hub) for s in split_sentences(text) for t in fact_tokens(s)]
        own[hid] = {canonical(t) for t in tokens} | {f'{t.number}위' for t in tokens if t.kind == 'RANK'}
        basis_numbers[hid] = {t.number for sb in hub.get('selection_basis', []) for t in fact_tokens(sb.get('value_ko', '')) if t.kind == 'RANK'}
        for t in tokens:
            if t.kind in {'QTY', 'SHARE'}:
                shared_tokens[canonical(t)].append(('world.json', hid))
                shared_text.setdefault(canonical(t), t.text)
        for sb in hub.get('selection_basis', []):
            key = tuple(sb.get(k, '') for k in ('source_id', 'indicator_ko', 'value_ko'))
            shared_basis[key].append(('world.json', hid))
    sentence_fields = {
        'world.json': {'hub_note_ko'},
        'contacts.json': {'information_scope_ko', 'individual_request_ko'},
        'culture_activities.json': {'observations_ko', 'report_ko.finding_ko', 'report_ko.scope_ko', 'report_ko.not_claimed_ko', 'report_ko.open_question_ko'}}
    for u in units:
        tokens = fact_tokens(u.sentence)
        for t in tokens:
            if u.owner is None:
                findings.append(finding('FACT_OUTSIDE_HUB_TEXT', u.file, u.record, u.field, t.text, u.sentence))
            else:
                for hid, names in aliases.items():
                    if hid == u.owner:
                        continue
                    if names_hub(u.sentence, names, gate_names):
                        findings.append(finding('FACT_NAMES_OTHER_HUB', u.file, u.record, u.field, t.text, u.sentence, hid))
                if u.file in CITY_FILES and canonical(t) not in own[u.owner]:
                    findings.append(finding('FACT_NOT_IN_OWN_ENTRY', u.file, u.record, u.field, t.text, u.sentence))
                if (u.file == 'world.json' and u.owner_kind == 'hub' and u.field == 'hub_note_ko'
                        and t.kind == 'RANK' and t.scope is None and t.number not in basis_numbers[u.owner]):
                    findings.append(finding('RANK_WITHOUT_BASIS', u.file, u.record, u.field, t.text, u.sentence))
        if (u.owner_kind == 'hub' and u.field in sentence_fields.get(u.file, set())
                and len(re.sub(r'\s', '', u.sentence)) >= 15 and re.search(r'[가-힣]', u.sentence)):
            shared_sentences[normalized(u.sentence)].append((u.file, u.owner))
    for mapping, code in [(shared_tokens, 'FACT_SHARED_BETWEEN_HUBS'), (shared_basis, 'FACT_SHARED_BETWEEN_HUBS'), (shared_sentences, 'SENTENCE_SHARED_BETWEEN_HUBS')]:
        for token, entries in mapping.items():
            hubs = {h for _, h in entries}
            if len(hubs) >= 2:
                text = ' / '.join(token) if isinstance(token, tuple) else token
                if mapping is shared_tokens:
                    text = shared_text[token]
                findings.append(finding(code, ','.join(sorted({f for f, _ in entries})), ','.join(sorted(hubs)), '', text, text))
    def objects(obj, file, path='', record=None):
        if isinstance(obj, dict):
            record = obj.get('id', record)
            if designed(obj) and observed(obj):
                findings.append(finding('DESIGN_WITH_OBSERVED_LEVEL', file, record, path))
            if observed(obj) or ('source_id' in obj and 'value_ko' in obj) or path.split('.')[-1] == 'schedule_basis':
                refs = ([obj['source_id']] if isinstance(obj.get('source_id'), str) else []) + obj.get('source_refs', [])
                known = [sources[r] for r in refs if r in sources]
                if known and all(s.get('kind') == 'project_design' for s in known):
                    findings.append(finding('DESIGN_AS_OBSERVED', file, record, path))
            for key, value in obj.items():
                objects(value, file, f'{path}.{key}' if path else key, record)
        elif isinstance(obj, list):
            for value in obj:
                objects(value, file, path, record)
    for file, obj in sorted(docs.items()):
        if file != 'sources.json':
            objects(obj, file)
    for sid, source in sources.items():
        value = source.get('verification_status', '')
        if (source.get('kind') == 'project_design') != value.startswith('LOCAL_DESIGN'):
            findings.append(finding('DESIGN_SOURCE_LEVEL', 'sources.json', sid, 'verification_status', value))
    unique = {}
    for f in findings:
        unique.setdefault(f.key() + (normalized(f.sentence),), f)
    for entry in allowlist:
        key = tuple(entry[k] for k in ('code', 'file', 'record', 'field', 'token'))
        key += (entry.get('other', ''),)
        matches = [k for k, f in unique.items() if f.key() == key and entry['sentence_contains'] in f.sentence]
        if matches:
            for k in matches:
                del unique[k]
        else:
            f = finding('ALLOWLIST_UNUSED', entry['file'], entry['record'], entry['field'], entry['token'])
            unique[f.key() + (entry['sentence_contains'],)] = f
    return sorted(unique.values(), key=lambda f: (f.code, f.file, str(f.record), f.field, f.token))

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    try:
        docs = load_documents(args.root)
        findings = check_documents(docs)
    except (AllowlistError, OSError, ValueError) as error:
        print(f'검사 설정·자료 오류: {error}')
        return 2
    if args.json:
        print(json.dumps([asdict(f) for f in findings], ensure_ascii=False, indent=2))
    elif findings:
        for f in findings:
            other = f'(상대 {f.other})' if f.code == 'FACT_NAMES_OTHER_HUB' else ''
            print(f'FAIL {f.code} {f.file} {f.record} {f.field} 「{f.token}」{other} — {f.message} | {f.sentence[:80]}')
        print(f'{len(findings)}건 실패')
    else:
        units, _ = collect_units(docs)
        count = sum(len(fact_tokens(u.sentence)) for u in units)
        print(f'PASS: 사실 섞임 검사 — 자료 {len(docs)}개, 문장 {len(units)}개, 사실 표지 {count}개, 허용 목록 {len(ALLOWLIST)}건 모두 사용')
    return 1 if findings else 0

if __name__ == '__main__':
    raise SystemExit(main())
