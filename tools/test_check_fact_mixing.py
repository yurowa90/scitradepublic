"""자료에서 항목을 고르는 사실 섞임 회귀 시험."""
import copy
import contextlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import check_fact_mixing as checker

ROOT = Path(__file__).resolve().parents[1]

class FactMixingTest(unittest.TestCase):
    def setUp(self):
        self.docs = copy.deepcopy(checker.load_documents(ROOT))
        hubs = self.docs['world.json']['items']
        home_id = self.docs['game_config.json']['config']['home_city_id']
        self.home = next(h for h in hubs if h['id'] == home_id)
        numbers = {t.number for _, text in checker.leaves(self.home) for s in checker.split_sentences(text)
                   for t in checker.fact_tokens(s) if t.kind == 'RANK'}
        self.other, self.other_sb = next((h, sb) for h in hubs if h['id'] != home_id
                                       for sb in h.get('selection_basis', [])
                                       if any(t.kind == 'RANK' and t.number not in numbers for t in checker.fact_tokens(sb['value_ko'])))
        self.design = next(s for s in self.docs['sources.json']['items'] if s['kind'] == 'project_design')

    def codes(self, allowlist=None):
        return {f.code for f in checker.check_documents(self.docs, allowlist)}

    def test_01_baseline(self):
        """원본은 허용 목록 여덟 건을 모두 사용한다."""
        self.assertEqual(checker.check_documents(self.docs), [])
        raw = checker.check_documents(self.docs, [])
        self.assertEqual({f.key() for f in raw}, {tuple(e[k] for k in ('code', 'file', 'record', 'field', 'token')) + (e.get('other', ''),) for e in checker.ALLOWLIST})
        self.assertEqual(len(raw), 8)

    def test_02_reasons(self):
        """모든 허용 사유가 비어 있지 않다."""
        self.assertTrue(all(isinstance(e['reason'], str) and e['reason'].strip() for e in checker.ALLOWLIST))

    def add_other_rank(self):
        self.home['hub_note_ko'] += f" {self.other_sb['indicator_ko']} {self.other_sb['value_ko']}다."

    def test_03_rank(self):
        """자기 선정 근거에 없는 순위를 잡는다."""
        self.add_other_rank()
        self.assertIn('RANK_WITHOUT_BASIS', self.codes())

    def test_04_other_sentence(self):
        """다른 거점 이름·수치·문장 복사를 잡는다."""
        aliases = checker.hub_aliases(self.docs['world.json'])
        hub, sentence = next((h, s) for h in self.docs['world.json']['items'] if h['id'] != self.home['id']
                             for s in checker.split_sentences(h.get('hub_note_ko', ''))
                             if checker.fact_tokens(s) and len(''.join(s.split())) >= 15
                             and any(a in s for a in aliases[h['id']]))
        self.home['hub_note_ko'] += ' ' + sentence
        expected = {'FACT_NAMES_OTHER_HUB', 'SENTENCE_SHARED_BETWEEN_HUBS'}
        if any(t.kind in {'QTY', 'SHARE'} for t in checker.fact_tokens(sentence)):
            expected.add('FACT_SHARED_BETWEEN_HUBS')
        self.assertTrue(expected <= self.codes())

    def test_05_city_text(self):
        """문화 문장은 자기 도시의 사실만 쓴다."""
        item = next(i for i in self.docs['culture_activities.json']['items'] if i['city_id'] == self.home['id'])
        item['report_ko']['finding_ko'] += f" 처리 순위는 {self.other_sb['value_ko']}다."
        self.assertIn('FACT_NOT_IN_OWN_ENTRY', self.codes())

    def test_06_outside(self):
        """동료 이야기의 도시 수치를 잡는다."""
        item = next(i for i in self.docs['characters.json']['items'] if 'story_clue' in i.get('recruitment', {}))
        sentence = next(s for _, text in checker.leaves(self.home) for s in checker.split_sentences(text) if checker.fact_tokens(s))
        item['recruitment']['story_clue'] += ' ' + sentence
        self.assertIn('FACT_OUTSIDE_HUB_TEXT', self.codes())

    def test_07_basis(self):
        """선정 근거 전체 복사를 잡는다."""
        self.home['selection_basis'].append(copy.deepcopy(self.other_sb))
        self.assertIn('FACT_SHARED_BETWEEN_HUBS', self.codes())

    def test_08_shared_sentence(self):
        """수치 없는 동일 문장도 잡는다."""
        hubs = [h for h in self.docs['world.json']['items'] if h['id'] != self.home['id']][:2]
        for h in hubs:
            h['hub_note_ko'] += ' 이 문장은 두 거점에 똑같이 들어간 시험 문장이다.'
        self.assertIn('SENTENCE_SHARED_BETWEEN_HUBS', self.codes())

    def test_09_design_level(self):
        """기간 설계와 실측 수준이 섞이면 실패한다."""
        self.docs['culture_activities.json']['items'][0]['check_level'] = 'web_search_summary'
        self.assertIn('DESIGN_WITH_OBSERVED_LEVEL', self.codes())

    def test_10_source_levels(self):
        """설계 여부와 출처 확인 수준이 양방향으로 맞아야 한다."""
        for design in (True, False):
            with self.subTest(design=design):
                docs = copy.deepcopy(self.docs)
                item = next(s for s in docs['sources.json']['items'] if (s['kind'] == 'project_design') == design)
                item['verification_status'] = 'CONTENT_READ' if design else 'LOCAL_DESIGN'
                self.assertIn('DESIGN_SOURCE_LEVEL', {f.code for f in checker.check_documents(docs)})

    def test_11_design_basis(self):
        """선정 근거는 설계 출처만 인용할 수 없다."""
        self.other_sb['source_id'] = self.design['id']
        self.assertIn('DESIGN_AS_OBSERVED', self.codes())

    def test_12_design_schedule(self):
        """요일표는 설계 출처만 인용할 수 없다."""
        item = next(i for i in self.docs['routes.json']['items'] if 'schedule_basis' in i)
        item['schedule_basis']['source_refs'] = [self.design['id']]
        self.assertIn('DESIGN_AS_OBSERVED', self.codes())

    def test_13_unused(self):
        """낡은 허용 항목을 잡는다."""
        entries = checker.ALLOWLIST + [{'code': 'RANK_WITHOUT_BASIS', 'file': 'world.json', 'record': self.home['id'], 'field': 'hub_note_ko', 'token': '999위', 'sentence_contains': '존재하지 않는 순위 문장', 'reason': '시험'}]
        self.assertIn('ALLOWLIST_UNUSED', self.codes(entries))

    def test_14_bad_allowlist(self):
        """빈 사유·키 누락·중복·모르는 코드는 설정 오류다."""
        entry = copy.deepcopy(checker.ALLOWLIST[0])
        missing = dict(entry); del missing['file']
        cases = [[dict(entry, reason='')], [dict(entry, reason='  ')], [missing], [entry, entry], [dict(entry, code='BAD_CODE')]]
        missing_sentence = dict(entry); del missing_sentence['sentence_contains']
        cases += [[missing_sentence], [dict(entry, sentence_contains='일곱자이하')],
                  [dict(entry, sentence_contains=None)], [dict(entry, code='FACT_NAMES_OTHER_HUB')]]
        for entries in cases:
            with self.subTest(entries=entries), self.assertRaises(checker.AllowlistError):
                checker.check_documents(self.docs, entries)

    def test_15_unknown_city(self):
        """없는 도시 참조는 한 건의 소유권 오류다."""
        self.docs['venues.json']['items'][0]['city_id'] = 'NO_SUCH_CITY'
        self.assertIn('UNKNOWN_CITY_ID', self.codes())

    def synthetic(self, note='', gate=''):
        return {'world.json': {'items': [{'id': 'HUB_A', 'name_ko': '가람항', 'hub_note_ko': note, 'selection_basis': []}, {'id': 'HUB_B', 'name_ko': '나루항', 'selection_basis': []}], 'sea_gates': [{'id': 'GATE_X', 'note_ko': gate}]}, 'sources.json': {'items': []}}

    def test_16_tokens(self):
        """순위·물량·비율의 문맥을 구별한다."""
        tokens = checker.fact_tokens('처리량은 전국 6위(약 12.3만 TEU)다')
        self.assertEqual([(t.kind, t.text) for t in tokens], [('RANK', '전국 6위'), ('QTY', '12.3만 TEU')])
        for text in ['3위치', '위험', '단위', '범위', '20피트', '시너지 10%까지']:
            self.assertEqual(checker.fact_tokens(text), [])
        self.assertEqual(checker.fact_tokens('약 41%가 환적 화물이다')[0].kind, 'SHARE')
        self.assertEqual(checker.fact_tokens('국내 최대 항만')[0].kind, 'CLAIM')

    def test_17_sentences(self):
        """소수점은 남기고 문장·줄바꿈을 나눈다."""
        self.assertEqual(checker.split_sentences(' 첫 문장. 둘째 12.3만.\n셋째! 넷째。 끝 '), ['첫 문장.', '둘째 12.3만.', '셋째!', '넷째。', '끝'])

    def test_18_gate(self):
        """관문은 자기 사실을 갖되 다른 거점 사실은 구별한다."""
        self.assertEqual(checker.check_documents(self.synthetic(gate='처리량 13만 TEU다.'), []), [])
        self.assertIn('FACT_NAMES_OTHER_HUB', {f.code for f in checker.check_documents(self.synthetic(gate='가람항 처리량 13만 TEU다.'), [])})

    def test_19_scope(self):
        """전국 범위 순위는 무근거 순위 검사에서 제외한다."""
        self.assertEqual(checker.check_documents(self.synthetic(note='전국 3위'), []), [])
        self.assertIn('RANK_WITHOUT_BASIS', {f.code for f in checker.check_documents(self.synthetic(note='3위'), [])})

    def test_20_cli(self):
        """임시 자료의 명령줄 성공·실패·JSON 출력을 확인한다."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shutil.copytree(ROOT / 'data', root / 'data')
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(checker.main(['--root', tmp]), 0)
            self.add_other_rank()
            (root / 'data/world.json').write_text(json.dumps(self.docs['world.json'], ensure_ascii=False))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(checker.main(['--root', tmp]), 1)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(checker.main(['--root', tmp, '--json']), 1)
            self.assertIsInstance(json.loads(out.getvalue()), list)

    def test_21_shared_variants(self):
        """표기가 다른 같은 비율·물량은 거점 공유로 잡는다."""
        for first, second in [('비중은 57 %다.', '환적 비중은 57％다.'),
                              ('물량은 5506만TEU다.', '처리량은 55,060,000 TEU다.')]:
            with self.subTest(first=first):
                docs = self.synthetic(note=first)
                docs['world.json']['items'][1]['hub_note_ko'] = second
                findings = checker.check_documents(docs, [])
                shared = [f for f in findings if f.code == 'FACT_SHARED_BETWEEN_HUBS']
                self.assertEqual(len(shared), 1)
                self.assertEqual(shared[0].token, checker.fact_tokens(first)[0].text)

    def test_22_canonical(self):
        """소수 정밀도와 단위를 지키며 표기를 통일한다."""
        def value(text, kind='QTY'):
            return checker.canonical(checker.Token(kind, text))
        self.assertEqual({value(t, 'SHARE') for t in ['57 %', '57％', '57%']}, {'57%'})
        self.assertEqual(value('5506만TEU'), value('55,060,000 TEU'))
        self.assertEqual(value('5.5만 TEU'), value('55,000TEU'))
        self.assertNotEqual(value('57%'), value('57.1%'))
        self.assertEqual(value('1.25억 R/T'), '125000000R/T')
        self.assertEqual(value('−0.50％', 'SHARE'), '-0.5%')
        self.assertEqual(value('1..2 TEU'), '1..2TEU')
        self.assertEqual(value('국내 1위', 'RANK'), '국내 1위')
        docs = self.synthetic(note='처리량 5.5만 TEU, 비중 57％다.')
        docs['venues.json'] = {'items': [{'id': 'V', 'city_id': 'HUB_A',
                                         'note_ko': '처리량 55,000TEU, 비중 57 %다.'}]}
        self.assertEqual(checker.check_documents(docs, []), [])

    def test_23_yuan(self):
        """위안 가격과 띄어 쓴 순위를 구별한다."""
        self.assertEqual(checker.fact_tokens('택시 기본요금은 14위안이다.'), [])
        self.assertEqual(checker.fact_tokens('1위 안에 든다.'), [checker.Token('RANK', '1위', None, 1)])

    def test_24_alias_boundary(self):
        """낱말 안 별칭과 관문 이름을 거점으로 읽지 않는다."""
        self.assertFalse(checker.names_hub('부산물', {'부산'}, []))
        for text in ['부산항', '부산은', '부산발', '부산물과 부산은']:
            self.assertTrue(checker.names_hub(text, {'부산'}, []))
        self.assertFalse(checker.names_hub('파나마 운하를 거쳐', {'파나마'}, ['파나마 운하']))
        self.assertTrue(checker.names_hub('파나마는', {'파나마'}, ['파나마 운하']))
        self.assertTrue(checker.names_hub('파나마 운하와 파나마는', {'파나마'}, ['파나마 운하']))
        self.assertFalse(checker.names_hub('HUB_AB', {'HUB_A'}, []))
        self.assertTrue(checker.names_hub('HUB_A 항만', {'HUB_A'}, []))

    def test_25_allowlist_sentence(self):
        """허용된 순위와 같은 새 문장도 따로 검사한다."""
        hub = next(h for h in self.docs['world.json']['items'] if h['id'] == 'HONG_KONG')
        sentence = '홍콩은 세계 6위 금융 도시다.'
        hub['hub_note_ko'] += ' ' + sentence
        findings = checker.check_documents(self.docs)
        self.assertEqual([(f.code, f.sentence) for f in findings], [('RANK_WITHOUT_BASIS', sentence)])

    def test_26_allowlist_other(self):
        """상대 거점이 다르면 허용 항목을 쓰지 않는다."""
        entries = copy.deepcopy(checker.ALLOWLIST)
        entry = next(e for e in entries if e['record'] == 'PANAMA')
        entry['other'] = 'BUSAN'
        findings = checker.check_documents(self.docs, entries)
        self.assertEqual({f.code for f in findings}, {'ALLOWLIST_UNUSED', 'FACT_NAMES_OTHER_HUB'})
        fact = next(f for f in findings if f.code == 'FACT_NAMES_OTHER_HUB')
        self.assertEqual(fact.other, 'SANTOS')
        self.assertEqual(fact.key()[-1], 'SANTOS')

if __name__ == '__main__':
    unittest.main()
