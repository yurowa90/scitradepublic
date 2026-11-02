"""자료 검사 회귀 시험: 영입 필수 키 누락을 예외 대신 검사 실패로 보고한다."""
import copy
import contextlib
import io
import tempfile
from unittest import mock
import json
import unittest
import unicodedata
from pathlib import Path
import validate_data as validator


class ConservationTest(unittest.TestCase):
    def setUp(self):
        self.tables = {'characters': {item['id']: item for item in
                       validator.read('data/characters.json')['items']}}
        self.record = self.tables['characters']['EMP01']['conservation']
        validator.ERRORS.clear()

    def errors(self):
        validator.ERRORS.clear()
        validator.check_conservation(self.tables)
        return list(validator.ERRORS)

    def test_current_records_pass(self):
        self.assertEqual(self.errors(), [])
        self.assertEqual(validator.check_conservation(self.tables)[0], [])

    def test_secondary_records_are_reported_without_failure(self):
        ids = [f'EMP{i}' for i in (*range(66, 79), *range(83, 86))]
        self.assertEqual(validator.check_conservation(self.tables)[1], ids)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(validator.main(), 0)
        self.assertIn('IUCN 2차 자료 16건(게임 표기 전 사람 확인 필요): ' + ', '.join(ids),
                      output.getvalue().splitlines())

    def test_listed_requires_appendix(self):
        self.record['cites_appendix'] = None
        self.assertTrue(any('EMP01: CITES 확인 상태와 부속서' in error for error in self.errors()))

    def test_not_listed_rejects_appendix(self):
        self.record.update(cites_status='not_listed', cites_appendix='I')
        self.assertTrue(any('EMP01: CITES 확인 상태와 부속서' in error for error in self.errors()))

    def test_listed_rejects_invalid_appendix(self):
        self.record.update(cites_status='listed', cites_appendix='IV')
        self.assertTrue(any('EMP01: CITES 확인 상태와 부속서' in error for error in self.errors()))

    def test_invalid_checked_on_rejected(self):
        for value in ('2026-13-01', '2026/10/11', None, '2026-02-29', '20261011'):
            with self.subTest(value=value):
                self.record['cites_checked_on'] = value
                self.assertTrue(any('EMP01: CITES 확인일' in error for error in self.errors()))

    def test_blank_basis_rejected(self):
        self.record['cites_basis'] = '  '
        self.assertTrue(any('EMP01: CITES 확인 근거' in error for error in self.errors()))

    def test_unchecked_rejected_even_with_date_and_basis(self):
        self.record.update(cites_status='unchecked', cites_appendix=None)
        self.assertIn('EMP01: CITES 확인 안 함(cites_status unchecked)', self.errors())

    def test_unresolved_allowed_with_date_and_basis(self):
        self.record.update(cites_status='unresolved', cites_appendix=None)
        self.assertEqual(self.errors(), [])
        self.assertEqual(validator.check_conservation(self.tables)[0], ['EMP01'])

    def test_unresolved_requires_date_and_basis(self):
        self.record.update(cites_status='unresolved', cites_appendix=None)
        for field, value, message in (
                ('cites_checked_on', None, 'EMP01: CITES 확인일'),
                ('cites_basis', '  ', 'EMP01: CITES 확인 근거')):
            with self.subTest(field=field):
                saved = self.record[field]
                self.record[field] = value
                self.assertTrue(any(message in error for error in self.errors()))
                self.record[field] = saved

    def test_empty_scientific_name_rejected(self):
        self.record['scientific_name'] = ''
        self.assertIn('EMP01: 대표 학명이 비어 있습니다', self.errors())

    def test_pass_output_reports_unresolved_after_second_line(self):
        original_read = Path.read_text

        def read_with_status(path, *args, **kwargs):
            text = original_read(path, *args, **kwargs)
            if path == validator.ROOT / 'data/characters.json':
                document = json.loads(text)
                document['items'] = list(self.tables['characters'].values())
                return json.dumps(document, ensure_ascii=False)
            return text

        for unresolved in (False, True):
            with self.subTest(unresolved=unresolved):
                self.record.update(cites_status='unresolved' if unresolved else 'listed',
                                   cites_appendix=None if unresolved else 'II')
                validator.ERRORS.clear()
                output = io.StringIO()
                with mock.patch.object(Path, 'read_text', read_with_status), contextlib.redirect_stdout(output):
                    self.assertEqual(validator.main(), 0)
                lines = output.getvalue().splitlines()
                self.assertTrue(lines[0].startswith('PASS:'))
                if unresolved:
                    self.assertEqual(lines[2], 'CITES 판정 보류 1건: EMP01')
                else:
                    self.assertNotIn('CITES 판정 보류', output.getvalue())


class MotifCautionsTest(unittest.TestCase):
    def setUp(self):
        self.tables = {'characters': {c['id']: c for c in
                       validator.read('data/characters.json')['items']}}
        validator.ERRORS.clear()

    def test_base(self):
        self.assertEqual(validator.check_motif_cautions(self.tables), [])
        self.assertEqual(validator.ERRORS, [])

    def test_negative_safe(self):
        self.tables['characters']['EMP18']['visual_motif'] += ' 작은 금고'
        self.assertIn(('EMP18', 'visual_motif', '금고'),
                      validator.check_motif_cautions(self.tables))

    def test_negative_hot_spring(self):
        self.tables['characters']['EMP19']['visual_motif'] += ' 온천'
        self.assertIn(('EMP19', 'visual_motif', '온천'),
                      validator.check_motif_cautions(self.tables))

    def chain_caution(self):
        character = self.tables['characters']['EMP65']
        character['myth_reference'] = {'design_cautions_ko': ['사슬을 쓰지 않는다']}
        return character

    def test_negative_chain(self):
        character = self.chain_caution()
        field = 'card_pose_background'
        original = character['art_direction'][field]
        self.assertIn('송곳니·사슬·불길 없음', original)
        character['art_direction'][field] = original.replace('송곳니·사슬·불길 없음', '사슬을 감은')
        self.assertIn(('EMP65', 'art_direction.card_pose_background', '사슬'),
                      validator.check_motif_cautions(self.tables))

    def test_positive_absent_chain(self):
        self.chain_caution()
        self.assertEqual(validator.check_motif_cautions(self.tables), [])

    def test_positive_body_part(self):
        character = self.tables['characters']['EMP34']
        self.assertIn('외뿔', character['visual_motif'])
        self.tables['characters'] = {'EMP34': character}
        self.assertEqual(validator.check_motif_cautions(self.tables), [])

    def test_positive_parentheses(self):
        character = self.tables['characters']['EMP61']
        character['myth_reference'] = {'design_cautions_ko': ['불길을 그리지 않는다']}
        field = 'card_pose_background'
        original = character['art_direction'][field]
        self.assertIn('붉은 원판·빛살 없음', original)
        character['art_direction'][field] = original.replace('붉은 원판·빛살 없음', '(붉은 원판·불길 없음)')
        self.assertEqual(validator.check_motif_cautions(self.tables), [])

    def test_missing_cautions(self):
        character = self.tables['characters']['EMP65']
        for key in ('myth_reference', 'conservation'):
            for value in ({}, None, {'design_cautions_ko': None}):
                with self.subTest(key=key, value=value):
                    character[key] = value
                    self.assertEqual(validator.check_motif_cautions(self.tables), [])
            del character[key]
            self.assertEqual(validator.check_motif_cautions(self.tables), [])

    def test_visual_negation_and_character_scope(self):
        character = self.chain_caution()
        for suffix in ('사슬 없음', '(사슬 없이)  '):
            character['visual_motif'] = '둥근 강아지, ' + suffix + '. 목걸이'
            self.assertEqual(validator.check_motif_cautions(self.tables), [])
        character['myth_reference'] = {}
        character['visual_motif'] = '작은 금고'
        self.assertEqual(validator.check_motif_cautions(self.tables), [])

    def test_invalid_terms(self):
        for term in ('온천', '', '  '):
            with self.subTest(term=term):
                document = validator.read('tools/motif_forbidden_terms.json')
                document['terms'].append({'term': term, 'reason_ko': '시험용'})
                validator.ERRORS.clear()
                with mock.patch.object(validator, 'read', return_value=document):
                    validator.check_motif_cautions(self.tables)
                self.assertTrue(any('생김새 금지어 목록:' in e for e in validator.ERRORS))


class RecruitmentKeysTest(unittest.TestCase):
    def tables(self):
        root = Path(__file__).resolve().parents[1]
        names = ('scenarios', 'market_offers', 'goods', 'routes', 'employees', 'characters', 'venues', 'world')
        tables = {name: {item['id']: item for item in json.loads((root / 'data' / f'{name}.json').read_text())['items']}
                  for name in names}
        return tables

    def test_non_integer_signing_fee_reports_failure(self):
        for value in (None, "5", 5.0):
            with self.subTest(value=value):
                tables = self.tables()
                tables['scenarios']['SCENARIO_M2_MULTI_TRADE']['recruitment']['signing_fee_wage_days'] = value
                validator.ERRORS.clear()
                validator.check_m2a(tables)
                self.assertIn('M2a: signing_fee_wage_days는 정수여야 합니다', validator.ERRORS)

    def test_missing_recruitment_keys_report_failures(self):
        tables = self.tables()
        scenario = tables['scenarios']['SCENARIO_M2_MULTI_TRADE']
        no_block = copy.deepcopy(tables)
        del no_block['scenarios']['SCENARIO_M2_MULTI_TRADE']['recruitment']
        validator.ERRORS.clear()
        validator.check_m2a(no_block)
        self.assertTrue(validator.ERRORS)
        for key in scenario['recruitment']:
            with self.subTest(key=key):
                mutated = copy.deepcopy(tables)
                del mutated['scenarios']['SCENARIO_M2_MULTI_TRADE']['recruitment'][key]
                validator.ERRORS.clear()
                validator.check_m2a(mutated)
                self.assertTrue(validator.ERRORS)
                self.assertTrue(any(key in error for error in validator.ERRORS))


class CultureReportsTest(unittest.TestCase):
    def fixtures(self):
        root = Path(__file__).resolve().parents[1]
        names = ('scenarios', 'culture_activities', 'contacts', 'venues')
        tables = {name: {item['id']: item for item in json.loads((root / 'data' / f'{name}.json').read_text())['items']}
                  for name in names}
        cases = json.loads((root / 'tests/acceptance_cases.json').read_text())['cases']
        return tables, cases

    def errors(self, tables, cases):
        validator.ERRORS.clear()
        config = json.loads((validator.ROOT / 'data/game_config.json').read_text())['config']
        validator.check_culture(tables, cases, config['reporting_currency'], config['home_city_id'])
        return list(validator.ERRORS)

    def test_generalization_finding_rejected(self):
        for word in ('부산 사람', '부산 시민', '평택 사람', '평택 시민', '한국인', '한국 사람', '한국 소비자', '국민', '상인들은'):
            with self.subTest(word=word):
                tables, cases = self.fixtures()
                tables['culture_activities']['CA01']['report_ko']['finding_ko'] = word + ' 모두 그렇다.'
                self.assertTrue(any('일반화 금지어' in e for e in self.errors(tables, cases)))

    def test_generalization_spacing_and_normalization(self):
        for finding in ('부산사람들은 모두 그렇다.', '부산\t사람들은 모두 그렇다.',
                        '부산\n  시민들은 모두 그렇다.', unicodedata.normalize('NFD', '부산사람들은 모두 그렇다.')):
            with self.subTest(finding=finding):
                tables, cases = self.fixtures()
                tables['culture_activities']['CA01']['report_ko']['finding_ko'] = finding
                self.assertTrue(any('일반화 금지어' in e for e in self.errors(tables, cases)))

    def test_korean_doll_is_not_generalization(self):
        tables, cases = self.fixtures()
        tables['culture_activities']['CA01']['report_ko']['finding_ko'] = '한국 인형을 들여왔어요'
        self.assertEqual(self.errors(tables, cases), [])

    def test_key_template_slots(self):
        for field, required, forbidden in (
            ('completion_dedupe_key_template', ('company_id',), ('actor_id', 'contact_id')),
            ('actor_experience_dedupe_key_template', ('actor_id',), ('contact_id',)),
            ('relationship_dedupe_key_template', ('actor_id', 'contact_id'), ()),
        ):
            for slot in required + forbidden:
                with self.subTest(field=field, slot=slot):
                    tables, cases = self.fixtures()
                    activity = tables['culture_activities']['CA01']
                    if slot in required:
                        activity[field] = activity[field].replace('{' + slot + '}', slot)
                    else:
                        activity[field] += ':{' + slot + '}'
                    self.assertIn('CA01: ' + field + ' 필수·금지 키 자리 오류', self.errors(tables, cases))
            # 자리 밖의 글자는 필드가 아니므로 금지하지 않는다.
            tables, cases = self.fixtures()
            tables['culture_activities']['CA01'][field] += ':actor_id:contact_id'
            self.assertEqual(self.errors(tables, cases), [])

    def test_activity_fee_requires_payroll_currency(self):
        tables, cases = self.fixtures()
        tables['culture_activities']['CA01']['money_cost']['currency'] = 'USD'
        self.assertIn('CA01: 현지 활동비는 급여 통화(KRW) 필요', self.errors(tables, cases))

    def test_culture_schema_constraints(self):
        schema = json.loads((validator.ROOT / 'schemas/scenarios.schema.json').read_text())['properties']['items']['items']['properties']['culture']
        for field, value, error in (('data_basis', 'OBSERVED', 'enum'),
                                    ('activity_ids', [], 'minItems'),
                                    ('activity_ids', ['CA01', 'CA01'], 'uniqueItems')):
            with self.subTest(field=field, value=value):
                tables, _ = self.fixtures()
                block = tables['scenarios']['SCENARIO_M2_MULTI_TRADE']['culture']
                block[field] = value
                validator.ERRORS.clear()
                validator.shape(block, schema, 'culture')
                self.assertIn('culture/' + field + ': ' + error, validator.ERRORS)

    def test_any_culture_block_requires_enabled(self):
        for enabled in (False, None):
            with self.subTest(enabled=enabled):
                tables, cases = self.fixtures()
                scenario = tables['scenarios']['SCENARIO_M1_ONE_TRADE']
                scenario['culture'] = copy.deepcopy(tables['scenarios']['SCENARIO_M2_MULTI_TRADE']['culture'])
                scenario['culture_enabled'] = enabled
                self.assertIn(scenario['id'] + ': culture 블록은 culture_enabled 필요', self.errors(tables, cases))

    def test_generalization_denial_allowed(self):
        tables, cases = self.fixtures()
        tables['culture_activities']['CA01']['report_ko']['not_claimed_ko'] = '부산 사람·부산 시민·한국인·한국 사람·한국 소비자·국민·상인들은 모두 그렇다는 뜻이 아니다.'
        self.assertEqual(self.errors(tables, cases), [])

    def test_missing_report_rejected(self):
        tables, cases = self.fixtures()
        del tables['culture_activities']['CA01']['report_ko']
        self.assertEqual(sum('report_ko.' in e for e in self.errors(tables, cases)), 4)
        for key in ('finding_ko', 'scope_ko', 'not_claimed_ko', 'open_question_ko'):
            with self.subTest(key=key):
                tables, cases = self.fixtures()
                tables['culture_activities']['CA01']['report_ko'][key] = '  '
                self.assertTrue(any('report_ko.' + key in e for e in self.errors(tables, cases)))


class HomeAndScheduleTest(unittest.TestCase):
    def fixtures(self):
        names = ('world', 'routes', 'sources')
        return {name: {item['id']: item for item in validator.read('data/' + name + '.json')['items']}
                for name in names}

    def test_home_and_weekday_schedules_pass(self):
        tables = self.fixtures()
        validator.ERRORS.clear()
        validator.check_home_city(validator.read('data/game_config.json')['config'], tables['world'])
        validator.check_route_schedules(tables['routes'], set(tables['sources']))
        self.assertEqual(validator.ERRORS, [])

    def test_home_allows_shared_rank_words(self):
        # 상하이에도 '4위'가 있지만 평택 자기 순위(4위·5위)는 막지 않는다.
        tables = self.fixtures()
        validator.ERRORS.clear()
        validator.check_home_city({'home_city_id': 'PYEONGTAEK'}, tables['world'])
        self.assertEqual(validator.ERRORS, [])
        self.assertIn('4위', tables['world']['PYEONGTAEK']['hub_note_ko'])

    def test_home_id_must_exist(self):
        validator.ERRORS.clear()
        validator.check_home_city({'home_city_id': 'UNKNOWN'}, self.fixtures()['world'])
        self.assertIn('본사: home_city_id가 world에 있어야 합니다', validator.ERRORS)

    def test_home_rejects_other_hub_facts(self):
        for word in ('7위', '환적 화물', 'TRANSSHIPMENT', '57%'):
            with self.subTest(word=word):
                tables = self.fixtures()
                tables['world']['PYEONGTAEK']['hub_note_ko'] += word
                validator.ERRORS.clear()
                validator.check_home_city({'home_city_id': 'PYEONGTAEK'}, tables['world'])
                self.assertIn('본사: 다른 거점 고유 문구 ' + word, validator.ERRORS)

    def test_home_role_exempts_world_indicator(self):
        tables = self.fixtures()
        tables['scenarios'] = {}
        # 다른 지표 역할을 함께 가지더라도 본사는 교육·지역 기준으로 고를 수 있다.
        tables['world']['PYEONGTAEK']['hub_roles'].append('REGIONAL_GATEWAY')
        validator.ERRORS.clear()
        validator.check_world_hubs({'world': validator.read('data/world.json')}, tables, set(tables['sources']))
        self.assertEqual(validator.ERRORS, [])

    def test_schedule_day_mismatch_rejected(self):
        for rid, days in (('ROUTE01', 6), ('ROUTE02', 5)):
            with self.subTest(route=rid):
                tables = self.fixtures()
                tables['routes'][rid]['transit_days'] = days
                validator.ERRORS.clear()
                validator.check_route_schedules(tables['routes'], set(tables['sources']))
                self.assertIn(rid + ': 운송일수와 요일 차이 불일치', validator.ERRORS)

    def test_schedule_unknown_source_rejected(self):
        tables = self.fixtures()
        tables['routes']['ROUTE01']['schedule_basis']['source_refs'] = ['UNKNOWN']
        validator.ERRORS.clear()
        validator.check_route_schedules(tables['routes'], set(tables['sources']))
        self.assertIn('ROUTE01: 요일표 출처 없음 UNKNOWN', validator.ERRORS)

    def test_schedule_invalid_weekday_rejected(self):
        tables = self.fixtures()
        tables['routes']['ROUTE01']['schedule_basis']['departure_weekday'] = 'UNKNOWN'
        validator.ERRORS.clear()
        validator.check_route_schedules(tables['routes'], set(tables['sources']))
        self.assertIn('ROUTE01: 출항·접안 요일 필요', validator.ERRORS)

    def test_city_home_mapping_reads_config(self):
        helper = CultureReportsTest()
        tables, cases = helper.fixtures()
        # 본사 대응 검사는 특정 도시 ID를 하드코딩하지 않는다.
        for case in cases:
            if case['id'] in ('P0-CITY-01', 'P0-CITY-02', 'P0-CITY-03', 'P0-CITY-04'):
                case['engine_fixture_mapping']['CITY_HOME'] = 'SHANGHAI'
        validator.ERRORS.clear()
        validator.check_culture(tables, cases, 'KRW', 'SHANGHAI')
        self.assertEqual(validator.ERRORS, [])


def data_documents():
    return copy.deepcopy({f.stem: json.loads(f.read_text(encoding='utf-8'))
                          for f in (validator.ROOT / 'data').glob('*.json')})


class AcceptanceLinkTest(unittest.TestCase):
    def setUp(self):
        self.core = copy.deepcopy(validator.read('tests/acceptance_cases.json'))
        self.character = copy.deepcopy(validator.read('tests/character_acceptance_cases.json'))
        self.cases = self.core['cases'] + self.character['items']
        self.linked = next(c for c in self.cases if isinstance(c.get('engine_test_ref'), str))
        validator.ERRORS.clear()

    def summary(self):
        validator.ERRORS.clear()
        validator.check_acceptance_summary(self.core, self.character)
        return validator.ERRORS

    def fake_titles(self, text, names):
        case = copy.deepcopy(self.linked)
        for key in ('ui_test_ref', 'ui_test_names', 'unexecuted_assertions'):
            case.pop(key, None)
        case.update(engine_test_ref='src/engine/fake.test.ts', engine_test_names=names)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            file = root / case['engine_test_ref']
            file.parent.mkdir(parents=True)
            file.write_text(text, encoding='utf-8')
            validator.ERRORS.clear()
            validator.check_test_refs([case], root)
        return list(validator.ERRORS)

    def fake_root_errors(self, files, check):
        """임시 root에 시험 파일을 쓰고 check(root)의 오류를 돌려준다."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for path, text in files.items():
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(text, encoding='utf-8')
            validator.ERRORS.clear()
            check(root)
        return list(validator.ERRORS)

    def unknown_ids(self, count):
        ids = {c['id'] for c in self.cases}
        return [cid for cid in (f'P0-UNKNOWN-{i:02d}' for i in range(100)) if cid not in ids][:count]

    def test_current_links_pass(self):
        validator.check_test_refs(self.core['cases'])
        validator.check_test_refs(self.character['items'])
        validator.check_acceptance_summary(self.core, self.character)
        self.assertEqual(validator.ERRORS, [])

    def test_missing_test_file_rejected(self):
        self.linked['engine_test_ref'] = 'src/engine/no-such.test.ts'
        validator.check_test_refs(self.cases)
        self.assertIn(self.linked['id'] + ': engine_test_ref 파일 없음 src/engine/no-such.test.ts', validator.ERRORS)

    def test_missing_test_name_rejected(self):
        original = copy.deepcopy(self.linked)
        self.linked['engine_test_names'][0] += ' 없음'
        validator.check_test_refs(self.cases)
        self.assertIn(self.linked['id'] + ': engine 시험 이름 없음 ' + self.linked['engine_test_names'][0], validator.ERRORS)
        # 제목은 정확히 같아야 한다. 앞부분만 같은 이름은 없는 이름이다.
        cid, name = original['id'], original['engine_test_names'][0]
        for short in (name[:-1], cid):
            with self.subTest(name=short):
                case = copy.deepcopy(original)
                case['engine_test_names'][0] = short
                validator.ERRORS.clear()
                validator.check_test_refs([case])
                self.assertIn(f'{cid}: engine 시험 이름 없음 {short}', validator.ERRORS)

    def test_todo_skip_comment_and_prefixed_calls_are_not_titles(self):
        cid = self.linked['id']
        names = [cid + ' ' + name for name in ('할 일', '건너뜀', '엑스', '주석', '묶음 주석', '반복', '여러 줄 주석', '정상')]
        text = '\n'.join((f"it.todo('{names[0]}')", f"describe.skip('{names[1]}', () => {{}})",
                          f"xit('{names[2]}', () => {{}})", f"// it('{names[3]}', () => {{}})",
                          f"/* describe('{names[4]}', () => {{}}) */", f"it.each([1])('{names[5]}', () => {{}})",
                          f"/*\n  describe('{names[6]}', () => {{}})\n*/",
                          f"describe('{names[7]}', () => {{}})"))
        errors = self.fake_titles(text, names)
        for name in names[:-1]:
            with self.subTest(name=name):
                self.assertIn(f'{cid}: engine 시험 이름 없음 {name}', errors)
        self.assertNotIn(f'{cid}: engine 시험 이름 없음 {names[-1]}', errors)

    def test_comment_markers_in_comment_or_string_keep_titles(self):
        # 줄 주석 속 /* 나 문자열 속 /* 는 묶음 주석의 시작이 아니다. 뒤의 제목이 지워지면 안 된다.
        path = 'src/engine/fake.test.ts'
        for first, unknown in zip(('// TODO /*', "const g = 'src/*.ts';"), self.unknown_ids(2)):
            text = '\n'.join((first, f"describe('{unknown} 제목', () => {{}})", '/* 끝 */'))
            with self.subTest(first=first):
                errors = self.fake_root_errors({path: text}, lambda root: validator.check_test_title_links(self.cases, root))
                self.assertIn(f'{path}: 시험 제목의 사례 ID가 인수 명세에 없음 {unknown}', errors)

    def test_ui_link_checked(self):
        source = copy.deepcopy(next(c for c in self.cases if 'ui_test_ref' in c))
        cid = source['id']
        with self.subTest(change='없는 파일'):
            case = copy.deepcopy(source)
            case['ui_test_ref'] = 'src/ui/no-such.test.ts'
            validator.ERRORS.clear()
            validator.check_test_refs([case])
            self.assertIn(f'{cid}: ui_test_ref 파일 없음 src/ui/no-such.test.ts', validator.ERRORS)
        with self.subTest(change='없는 이름'):
            case = copy.deepcopy(source)
            case['ui_test_names'][0] += ' 없음'
            validator.ERRORS.clear()
            validator.check_test_refs([case])
            self.assertIn(f"{cid}: ui 시험 이름 없음 {case['ui_test_names'][0]}", validator.ERRORS)
        with self.subTest(change='사례 ID 없는 이름'):
            case = copy.deepcopy(source)
            for key in ('engine_test_names', 'unexecuted_assertions'):
                case.pop(key, None)
            case.update(engine_test_ref=None, unlinked_reason_ko='x', ui_test_ref='src/ui/fake.test.ts', ui_test_names=['정상 제목'])
            errors = self.fake_root_errors({'src/ui/fake.test.ts': "describe('정상 제목', () => {})"},
                                           lambda root: validator.check_test_refs([case], root))
            self.assertIn(f'{cid}: ui_test_names에 사례 ID가 든 이름 필요', errors)

    def test_title_without_case_id_rejected(self):
        errors = self.fake_titles("describe('정상 제목', () => {})", ['정상 제목'])
        self.assertIn(self.linked['id'] + ': engine_test_names에 사례 ID가 든 이름 필요', errors)

    def test_template_title_rejected(self):
        name = self.linked['id'] + ' ${timing}'
        errors = self.fake_titles('it(`' + name + '`, () => {})', [name])
        self.assertIn(self.linked['id'] + ': engine 시험 이름은 고정 문자열이어야 함 ' + name, errors)

    def test_unlinked_case_requires_reason(self):
        case = next(c for c in self.cases if c['engine_test_ref'] is None)
        del case['unlinked_reason_ko']
        validator.check_test_refs(self.cases)
        self.assertIn(case['id'] + ': 연결 없는 사례는 unlinked_reason_ko 필요', validator.ERRORS)
        case['engine_test_names'] = [case['id'] + ' 남은 이름']
        validator.ERRORS.clear()
        validator.check_test_refs(self.cases)
        self.assertIn(case['id'] + ': 연결 없는 사례에 engine_test_names가 남음', validator.ERRORS)
        del case['engine_test_ref']
        validator.ERRORS.clear()
        validator.check_test_refs(self.cases)
        self.assertIn(case['id'] + ': engine_test_ref 키 필요', validator.ERRORS)

    def test_todo_link_checked(self):
        case = next(c for c in self.cases if any('todo_test_name' in a for a in c.get('unexecuted_assertions', [])))
        source = copy.deepcopy(case)
        assertion = next(a for a in case['unexecuted_assertions'] if 'todo_test_name' in a)
        assertion['todo_test_name'] += ' 없음'
        validator.check_test_refs(self.cases)
        self.assertIn(case['id'] + ': 미실행 단언의 할 일 시험 없음 ' + assertion['todo_test_name'], validator.ERRORS)
        # 주석 속 it.todo는 할 일 시험이 아니다.
        cid = source['id']
        todo = next(a['todo_test_name'] for a in source['unexecuted_assertions'] if 'todo_test_name' in a)
        path = 'src/engine/fake.test.ts'
        titles = '\n'.join(f"it('{name}', () => {{}})" for name in source['engine_test_names'])
        for comment in (f"// it.todo('{todo}')", f"/* it.todo('{todo}') */"):
            with self.subTest(comment=comment):
                linked = copy.deepcopy(source)
                for key in ('ui_test_ref', 'ui_test_names'):
                    linked.pop(key, None)
                linked['engine_test_ref'] = path
                errors = self.fake_root_errors({path: titles + '\n' + comment},
                                               lambda root: validator.check_test_refs([linked], root))
                self.assertIn(f'{cid}: 미실행 단언의 할 일 시험 없음 {todo}', errors)
        # 연결 없는 사례의 할 일 시험은 찾을 파일이 없다.
        with self.subTest(change='연결 없음'):
            unlinked = copy.deepcopy(next(c for c in self.cases if 'engine_test_ref' in c and c['engine_test_ref'] is None))
            name = unlinked['id'] + ' 없는 할 일'
            unlinked['unexecuted_assertions'] = [{'assertion': 'x', 'status': '미실행 단언', 'reason_ko': 'x', 'todo_test_name': name}]
            validator.ERRORS.clear()
            validator.check_test_refs([unlinked])
            self.assertIn(f"{unlinked['id']}: 미실행 단언의 할 일 시험 없음 {name}", validator.ERRORS)

    def test_summary_and_status_must_match(self):
        # 한 번에 한 칸만 바꾸고, 그 칸의 문구 하나만 나오는지 본다.
        index, item = next((i, c) for i, c in enumerate(self.character['items']) if isinstance(c.get('engine_test_ref'), str))
        add_one = lambda value: value + 1
        changes = (
            ('core', ('review_summary', 'engine_linked_case_count'), add_one, 'review_summary engine_linked_case_count matches cases'),
            ('core', ('review_summary', 'ui_linked_case_count'), add_one, 'review_summary ui_linked_case_count matches cases'),
            ('character', ('summary', 'case_count'), add_one, 'character summary case_count matches items'),
            ('character', ('summary', 'engine_linked_case_count'), add_one, 'character summary engine_linked_case_count matches items'),
            ('character', ('summary', 'ui_linked_case_count'), add_one, 'character summary ui_linked_case_count matches items'),
            ('core', ('status',), lambda _: 'DESIGN_ONLY_NOT_EXECUTED_AGAINST_ENGINE', 'acceptance status matches linked cases'),
            ('character', ('status',), lambda _: 'SPECIFICATION_NOT_EXECUTED', 'character status matches linked items'),
            ('character', ('items', index, 'status'), lambda _: 'SPECIFICATION_NOT_EXECUTED',
             item['id'] + ': status와 engine_test_ref 연결 불일치'),
        )
        for doc, keys, change, message in changes:
            with self.subTest(message=message):
                docs = {'core': copy.deepcopy(self.core), 'character': copy.deepcopy(self.character)}
                target = docs[doc]
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = change(target[keys[-1]])
                validator.ERRORS.clear()
                validator.check_acceptance_summary(docs['core'], docs['character'])
                self.assertEqual(validator.ERRORS, [message])

    def test_pass_claim_rejected(self):
        self.core['review_summary']['engine_test_pass_claim'] = True
        self.assertIn('acceptance file makes no engine pass claim', self.summary())

    def test_human_review_records(self):
        record = dict(case_id=self.cases[0]['id'], reviewed_on='2026-10-10', reviewer_ko='교사', result='일치', note_ko='')
        self.core['human_review_records'] = [record]
        self.assertEqual(self.summary(), [])
        for key, value, message in (
            ('case_id', 'NO-SUCH-CASE', '없는 사례 NO-SUCH-CASE'), ('result', '통과', 'result 오류'),
            ('reviewed_on', '10/10', 'reviewed_on 오류'), ('extra', True, '알 수 없는 키 extra'),
            ('reviewer_ko', '', 'reviewer_ko 오류'), ('note_ko', None, 'note_ko 오류'),
            # 달력에 없는 날과 전각 숫자도 날짜 오류다.
            ('reviewed_on', '2026-02-30', 'reviewed_on 오류'), ('reviewed_on', '２０２６-10-10', 'reviewed_on 오류'),
        ):
            with self.subTest(key=key, value=value):
                self.core['human_review_records'] = [{**record, key: value}]
                self.assertIn('사람 검토 기록 0: ' + message, self.summary())
        del self.core['human_review_records']
        self.assertIn('human_review_records 목록 필요', self.summary())

    def test_reverse_title_link(self):
        validator.check_test_title_links(self.cases)
        self.assertEqual(validator.ERRORS, [])
        unknown = next(f'P0-UNKNOWN-{i:02d}' for i in range(100) if f'P0-UNKNOWN-{i:02d}' not in {c['id'] for c in self.cases})
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = 'src/engine/fake.test.ts'
            file = root / path
            file.parent.mkdir(parents=True)
            file.write_text(f"describe('{unknown} 없음', () => {{}})\nit('{self.linked['id']}은 연결 없음', () => {{}})", encoding='utf-8')
            validator.ERRORS.clear()
            validator.check_test_title_links(self.cases, root)
            self.assertIn(f'{path}: 시험 제목의 사례 ID가 인수 명세에 없음 {unknown}', validator.ERRORS)
            self.assertIn(f"{path}: 시험 제목의 {self.linked['id']}가 그 사례의 시험 연결에 없음", validator.ERRORS)
        # 화면 시험 폴더와 큰따옴표·백틱 제목도 훑는다.
        unknowns = self.unknown_ids(3)
        files = {'src/ui/fake.test.ts': f"it('{unknowns[0]} 화면', () => {{}})",
                 'src/engine/fake.test.ts': f'it("{unknowns[1]} 큰따옴표", () => {{}})\nit(`{unknowns[2]} 백틱`, () => {{}})'}
        errors = self.fake_root_errors(files, lambda root: validator.check_test_title_links(self.cases, root))
        for path, unknown in zip(('src/ui/fake.test.ts', 'src/engine/fake.test.ts', 'src/engine/fake.test.ts'), unknowns):
            with self.subTest(unknown=unknown):
                self.assertIn(f'{path}: 시험 제목의 사례 ID가 인수 명세에 없음 {unknown}', errors)

    def test_path_names_and_ui_pair_validation(self):
        for path in ('/src/engine/fake.test.ts', 'src/../fake.test.ts', 'other/fake.test.ts', 'src/fake.ts', 1):
            with self.subTest(path=path):
                case = copy.deepcopy(self.linked)
                case['engine_test_ref'] = path
                validator.ERRORS.clear()
                validator.check_test_refs([case])
                self.assertIn(f"{case['id']}: engine_test_ref 경로 형식 오류 {path}", validator.ERRORS)
        for names in (None, [], '제목', [1]):
            with self.subTest(names=names):
                case = copy.deepcopy(self.linked)
                case['engine_test_names'] = names
                validator.ERRORS.clear()
                validator.check_test_refs([case])
                self.assertIn(case['id'] + ': engine_test_names 필요', validator.ERRORS)
        case = copy.deepcopy(next(c for c in self.cases if 'ui_test_ref' in c))
        for key in ('ui_test_ref', 'ui_test_names'):
            incomplete = copy.deepcopy(case)
            del incomplete[key]
            validator.ERRORS.clear()
            validator.check_test_refs([incomplete])
            self.assertIn(case['id'] + ': ui_test_ref와 ui_test_names는 함께 필요', validator.ERRORS)


class OrganizationNamesTest(unittest.TestCase):
    FIELDS = ('setup', 'expected')

    def setUp(self):
        self.cases = copy.deepcopy(validator.read('tests/character_acceptance_cases.json')['items'])
        self.organization = copy.deepcopy(validator.read('data/organization.json'))
        validator.ERRORS.clear()

    def fixtures(self, field):
        """사본을 새로 읽고, field에 permanent_team이 있는 첫 사례를 고른다."""
        cases = copy.deepcopy(validator.read('tests/character_acceptance_cases.json')['items'])
        organization = copy.deepcopy(validator.read('data/organization.json'))
        case = next(c for c in cases if isinstance(c.get(field), dict) and 'permanent_team' in c[field])
        validator.ERRORS.clear()
        return cases, organization, case

    def test_current_names_pass(self):
        validator.check_organization_names(self.cases, self.organization)
        self.assertEqual(validator.ERRORS, [])

    def test_unknown_team_rejected(self):
        for field in self.FIELDS:
            with self.subTest(field=field):
                cases, organization, case = self.fixtures(field)
                case[field]['permanent_team'] = '물류팀'
                validator.check_organization_names(cases, organization)
                self.assertIn(case['id'] + ': organization.json에 없는 팀 이름 물류팀', validator.ERRORS)

    def test_unknown_department_rejected(self):
        for field in self.FIELDS:
            with self.subTest(field=field):
                cases, organization, case = self.fixtures(field)
                case[field]['department'] = '없는 부서'
                validator.check_organization_names(cases, organization)
                self.assertIn(case['id'] + ': organization.json에 없는 부서 이름 없는 부서', validator.ERRORS)

    def test_team_department_mismatch_rejected(self):
        for field in self.FIELDS:
            with self.subTest(field=field):
                cases, organization, case = self.fixtures(field)
                obj = case[field]
                obj['department'] = next(d['name_ko'] for d in organization['departments'] if d['name_ko'] != obj.get('department'))
                validator.check_organization_names(cases, organization)
                self.assertIn(f"{case['id']}: 팀과 부서 불일치 {obj['permanent_team']}/{obj['department']}", validator.ERRORS)


class GeneralizationPrecisionTest(unittest.TestCase):
    def fixtures(self):
        tables, cases = copy.deepcopy(CultureReportsTest().fixtures())
        block = next(s['culture'] for s in tables['scenarios'].values() if 'culture' in s)
        aid = block['activity_ids'][0]
        return tables, cases, aid

    def finding_errors(self, finding):
        tables, cases, aid = self.fixtures()
        tables['culture_activities'][aid]['report_ko']['finding_ko'] = finding
        return aid, CultureReportsTest().errors(tables, cases)

    def test_zero_width_inside_banned_word_rejected(self):
        for finding, word in (('부산\u200b사람들은 모두 그렇다.', '부산 사람'),
                              ('한\u200d국인은 모두 그렇다.', '한국인'), ('국\u2060민은 모두 그렇다.', '국민'),
                              ('상인\ufeff들은 모두 그렇다.', '상인들은'), ('부산\u00ad시민들은 모두 그렇다.', '부산 시민')):
            with self.subTest(finding=finding):
                aid, errors = self.finding_errors(finding)
                self.assertIn(aid + ': finding_ko 일반화 금지어 ' + word, errors)

    def test_public_proper_nouns_allowed(self):
        for finding in ('부산시민공원에서 상자를 봤어요.', '한국소비자원 자료를 읽었어요.', '국민연금 안내문을 봤어요.'):
            with self.subTest(finding=finding):
                _, errors = self.finding_errors(finding)
                self.assertEqual(errors, [])

    def test_proper_noun_does_not_hide_banned_word(self):
        aid, errors = self.finding_errors('부산시민공원에서 만난 부산 사람은 모두 그렇다.')
        self.assertIn(aid + ': finding_ko 일반화 금지어 부산 사람', errors)

    def test_inherited_culture_block_requires_enabled(self):
        tables, cases, _ = self.fixtures()
        child = next(s for s in tables['scenarios'].values() if s.get('base_scenario_id'))
        parent = tables['scenarios'][child['base_scenario_id']]
        parent['culture'] = copy.deepcopy(next(s['culture'] for s in tables['scenarios'].values() if 'culture' in s))
        parent['culture_enabled'] = True
        child['culture_enabled'] = False
        errors = CultureReportsTest().errors(tables, cases)
        self.assertIn(child['id'] + ': culture 블록은 culture_enabled 필요', errors)
        self.assertNotIn(parent['id'] + ': culture 블록은 culture_enabled 필요', errors)
        child['culture_enabled'] = True
        self.assertNotIn(child['id'] + ': culture 블록은 culture_enabled 필요', CultureReportsTest().errors(tables, cases))


class SourceUsageTest(unittest.TestCase):
    def setUp(self):
        self.documents = data_documents()
        self.sources = self.documents['sources']['items']
        validator.ERRORS.clear()

    def test_current_sources_pass(self):
        validator.check_sources(self.documents)
        self.assertEqual(validator.ERRORS, [])

    def test_usage_kinds(self):
        usage = validator.source_usage(self.documents)
        self.assertEqual({sid for sid, kinds in usage.items() if not kinds},
                         {s['id'] for s in self.sources if 'unreferenced_reason_ko' in s})
        self.assertIn({'design'}, usage.values())
        # 공개판에는 references/가 없다. 그 폴더가 있을 때만 '레퍼런스 문서만 쓰는 출처'를 확인한다.
        if (validator.ROOT / 'references').is_dir():
            values = {v for file in (validator.ROOT / 'references').glob('*.json')
                      for v in validator.string_values(json.loads(file.read_text(encoding='utf-8')))}
            self.assertGreater(sum(kinds == {'references'} and sid not in values for sid, kinds in usage.items()), 0)
        self.assertGreater(sum('data' in kinds for kinds in usage.values()), 0)

    def test_unused_source_needs_reason(self):
        source = next(s for s in self.sources if 'unreferenced_reason_ko' in s)
        del source['unreferenced_reason_ko']
        validator.check_sources(self.documents)
        self.assertIn(source['id'] + ': 쓰이지 않는 출처는 unreferenced_reason_ko 필요', validator.ERRORS)

    def test_used_source_with_stale_reason_rejected(self):
        usage = validator.source_usage(self.documents)
        source = next(s for s in self.sources if 'data' in usage[s['id']])
        source['unreferenced_reason_ko'] = '낡은 표시'
        validator.check_sources(self.documents)
        self.assertIn(source['id'] + ': 쓰이는 출처에 unreferenced_reason_ko가 남음', validator.ERRORS)

    def test_unknown_superseded_by_rejected(self):
        source = next(s for s in self.sources if 'superseded_by' in s)
        source['superseded_by'] = ['NO-SUCH-SOURCE']
        validator.check_sources(self.documents)
        self.assertIn(source['id'] + ': superseded_by에 없는 출처 NO-SUCH-SOURCE', validator.ERRORS)

    def test_unused_superseded_target_rejected(self):
        source = next(s for s in self.sources if 'superseded_by' in s)
        target = next(s['id'] for s in self.sources if s['id'] != source['id'] and 'unreferenced_reason_ko' in s)
        source['superseded_by'] = [target]
        validator.check_sources(self.documents)
        self.assertIn(source['id'] + ': superseded_by의 출처도 쓰이지 않음 ' + target, validator.ERRORS)

    def test_missing_local_path_rejected(self):
        source = next(s for s in self.sources if isinstance(s.get('local_path'), str))
        source['local_path'] = 'docs/NO_SUCH_FILE.md'
        validator.check_sources(self.documents)
        self.assertIn(source['id'] + ': local_path 파일 없음 docs/NO_SUCH_FILE.md', validator.ERRORS)

    def test_local_path_outside_root_rejected(self):
        # 있는 파일이라도 절대 경로나 '..'로 가리키면 저장소 기준 경로가 아니다.
        for path in (str((validator.ROOT / 'README.md').resolve()), f'../{validator.ROOT.name}/README.md'):
            with self.subTest(path=path):
                documents = data_documents()
                source = next(s for s in documents['sources']['items'] if isinstance(s.get('local_path'), str))
                source['local_path'] = path
                validator.ERRORS.clear()
                validator.check_sources(documents)
                self.assertIn(f"{source['id']}: local_path 파일 없음 {path}", validator.ERRORS)


class CurriculumStageTest(unittest.TestCase):
    def setUp(self):
        self.documents = data_documents()
        self.doc = self.documents['curriculum_links']
        self.curriculum = {c['id']: c for c in self.doc['links']}
        self.file, self.obj = next((f, o) for f, d in self.documents.items() if f != 'curriculum_links'
                                   for o in validator.walk(d) if o.get('stage') == 'P0' and o.get('curriculum_refs'))
        validator.ERRORS.clear()

    def test_current_pending_pairs_match(self):
        found = validator.check_curriculum_stages(self.documents, self.curriculum)
        self.assertEqual(validator.ERRORS, [])
        self.assertEqual(found, validator.PENDING_P0_CURRICULUM_LINKS)

    def test_new_p0_link_without_p0_label_rejected(self):
        ref = next(cid for cid, c in self.curriculum.items() if not any(p.startswith('P0') for p in c['priority'])
                   and cid not in self.obj['curriculum_refs'])
        self.obj['curriculum_refs'].append(ref)
        validator.check_curriculum_stages(self.documents, self.curriculum)
        self.assertIn(f"{self.file}/{self.obj['id']}: P0 항목이 P0 표지 없는 교과 연결을 가리킴 {ref}", validator.ERRORS)

    def test_stale_pending_pair_rejected(self):
        # 실제 미해결 목록은 비어 있다. P0 표지 없는 연결 하나를 합성 미해결 쌍으로 넘긴다.
        ref = next(cid for cid, c in self.curriculum.items() if not any(p.startswith('P0') for p in c['priority'])
                   and cid not in self.obj['curriculum_refs'])
        pair = (self.file, self.obj['id'], ref)
        self.obj['curriculum_refs'].append(ref)
        found = validator.check_curriculum_stages(self.documents, self.curriculum, pending=frozenset({pair}))
        self.assertEqual((validator.ERRORS, found), ([], {pair}))
        self.obj['curriculum_refs'].remove(ref)
        validator.check_curriculum_stages(self.documents, self.curriculum, pending=frozenset({pair}))
        self.assertIn(f'교과 연결 미해결 목록이 낡음 {self.file}/{self.obj["id"]} {ref}', validator.ERRORS)

    def test_p0_report_label_counts_as_p0(self):
        ref = next(cid for cid, c in self.curriculum.items() if c['priority'] and all(p.startswith('P0 ') for p in c['priority'])
                   and cid not in self.obj['curriculum_refs'])
        self.obj['curriculum_refs'].append(ref)
        validator.check_curriculum_stages(self.documents, self.curriculum)
        self.assertNotIn(f"{self.file}/{self.obj['id']}: P0 항목이 P0 표지 없는 교과 연결을 가리킴 {ref}", validator.ERRORS)
        self.assertEqual(validator.ERRORS, [])

    def test_counts_read_from_data(self):
        validator.check_curriculum_counts(self.doc, self.curriculum)
        self.assertEqual(validator.ERRORS, [])
        self.doc['counts']['total'] += 1
        group = next(iter(self.doc['counts']['by_group']))
        selection = next(iter(self.doc['counts']['by_selection']))
        self.doc['counts']['by_group'][group] += 1
        self.doc['counts']['by_selection'][selection] += 1
        validator.ERRORS.clear()
        validator.check_curriculum_counts(self.doc, self.curriculum)
        for message in ('curriculum: counts.total 불일치', f'curriculum: counts.by_group.{group} 불일치',
                        f'curriculum: counts.by_selection.{selection} 불일치'):
            self.assertIn(message, validator.ERRORS)
        item = next(iter(self.curriculum.values()))
        item['group'] = next(g for g in self.doc['counts']['by_group'] if g != item['group'])
        validator.ERRORS.clear()
        validator.check_curriculum_counts(self.doc, self.curriculum)
        self.assertIn(item['id'] + ': 연결 ID 머리와 group 불일치', validator.ERRORS)

    def test_unknown_link_is_left_to_reference_check(self):
        self.obj['curriculum_refs'].append('NO-SUCH-LINK')
        validator.check_curriculum_stages(self.documents, self.curriculum)
        self.assertEqual(validator.ERRORS, [])


class ExtensionCurriculumTest(unittest.TestCase):
    def setUp(self):
        self.documents = data_documents()
        self.curriculum = {c['id']: c for c in self.documents['curriculum_links']['links']}
        self.file, self.obj = next((f, o) for f, d in self.documents.items() if f != 'curriculum_links'
                                   for o in validator.walk(d) if o.get('extension_curriculum_refs'))
        self.ref = self.obj['extension_curriculum_refs'][0]
        self.where = f"{self.file}/{self.obj['id']}"
        validator.ERRORS.clear()

    def run_check(self):
        validator.ERRORS.clear()
        validator.check_extension_curriculum_refs(self.documents, self.curriculum)
        return validator.ERRORS

    def test_current_extensions_pass(self):
        self.assertEqual(self.run_check(), [])

    def test_unknown_extension_rejected(self):
        self.obj['extension_curriculum_refs'] = ['NO-SUCH-LINK']
        self.assertIn(self.where + ': 없는 확장 교과 연결 NO-SUCH-LINK', self.run_check())

    def test_p0_label_belongs_in_curriculum_refs(self):
        ref = next(cid for cid, c in self.curriculum.items() if any(p.startswith('P0') for p in c['priority']))
        self.obj['extension_curriculum_refs'] = [ref]
        self.assertIn(f'{self.where}: P0 표지 연결은 curriculum_refs에 둔다 {ref}', self.run_check())

    def test_same_link_in_both_fields_rejected(self):
        self.obj['curriculum_refs'].append(self.ref)
        self.assertIn(f'{self.where}: 같은 연결이 curriculum_refs와 extension_curriculum_refs에 함께 있음 {self.ref}',
                      self.run_check())

    def test_extension_needs_p1_item(self):
        for doc in self.documents.values():
            for obj in validator.walk(doc):
                if obj.get('stage') not in (None, 'P0') and self.ref in obj.get('curriculum_refs', []):
                    obj['curriculum_refs'].remove(self.ref)
        # P0 항목이 그 연결을 가리켜도 근거가 되지 않는다.
        p0 = next(o for d in self.documents.values() for o in validator.walk(d)
                  if o.get('stage') == 'P0' and o is not self.obj and isinstance(o.get('curriculum_refs'), list))
        p0['curriculum_refs'].append(self.ref)
        self.assertIn(f'{self.where}: 확장 교과 연결을 다루는 P1 이상 항목이 없음 {self.ref}', self.run_check())

    def test_bad_shape_rejected(self):
        self.obj['extension_curriculum_refs'] = self.ref
        self.assertIn(self.where + ': extension_curriculum_refs 형식 오류', self.run_check())


class AchievementStandardsTest(unittest.TestCase):
    def setUp(self):
        self.documents = data_documents()
        self.doc = self.documents['curriculum_links']
        self.curriculum = {c['id']: c for c in self.doc['links']}
        self.source_ids = {s['id'] for s in self.documents['sources']['items']}
        self.link = next(iter(self.curriculum.values()))
        self.item = self.link['achievement_standards'][0]
        validator.ERRORS.clear()

    def run_check(self):
        validator.ERRORS.clear()
        validator.check_achievement_standards(self.doc, self.curriculum, self.source_ids)
        return validator.ERRORS

    def test_current_standards_pass(self):
        self.assertEqual(self.run_check(), [])

    def test_code_format(self):
        cid = self.link['id']
        for code in ('10통사1-01-01', '[10통사1-1-01]', '[09통사1-01-01]', '[12Econ02-01]'):
            with self.subTest(code=code):
                self.item['code'] = code
                self.assertIn(f'{cid}: 성취기준 코드 형식 오류 {code}', self.run_check())

    def test_grade_matches_selection(self):
        cid = self.link['id']
        code = self.item['code']
        self.link['selection'] = next(s for s in ('common', 'general') if (s == 'common') != (code[1:3] == '10'))
        self.assertIn(f'{cid}: 성취기준 학년 머리와 selection 불일치 {code}', self.run_check())

    def test_basis_and_text_required(self):
        cid, code = self.link['id'], self.item['code']
        cases = [('basis', '추정', f'{cid}: 성취기준 근거 종류 오류 {code}'),
                 ('sentence_ko', '  ', f'{cid}: 성취기준 sentence_ko 필요 {code}'),
                 ('keyword_ko', '', f'{cid}: 성취기준 keyword_ko 필요 {code}')]
        for field, value, message in cases:
            with self.subTest(field=field):
                saved = self.item[field]
                self.item[field] = value
                self.assertIn(message, self.run_check())
                self.item[field] = saved

    def test_same_code_same_sentence(self):
        other = next(c for c in self.curriculum.values() if c is not self.link)
        copy_item = dict(self.item, sentence_ko=self.item['sentence_ko'] + ' 다른 문장')
        other['achievement_standards'].append(copy_item)
        self.assertIn(f"{other['id']}: 같은 성취기준 코드의 문장이 다름 {self.item['code']}", self.run_check())

    def test_duplicate_code_and_empty_list(self):
        cid = self.link['id']
        self.link['achievement_standards'].append(dict(self.item))
        self.assertIn(cid + ': 성취기준 코드 중복', self.run_check())
        self.link['achievement_standards'] = []
        self.assertIn(cid + ': achievement_standards 필요', self.run_check())

    def test_source_required(self):
        self.link['achievement_standards_source_id'] = 'NO-SUCH-SOURCE'
        self.assertIn(self.link['id'] + ': 성취기준 출처 없음', self.run_check())

    def test_flag_off_skips(self):
        self.doc['scope']['achievement_standard_codes_included'] = False
        self.link['achievement_standards'] = []
        self.assertEqual(self.run_check(), [])



class AcceptanceFixtureNumbersTest(unittest.TestCase):
    def test_m1_case_matches_scenario_fixture(self):
        cases = copy.deepcopy(validator.read('tests/acceptance_cases.json')['cases'])
        scenarios = {s['id']: s for s in data_documents()['scenarios']['items']}
        validator.ERRORS.clear()
        validator.check_acceptance_fixture_numbers(cases, scenarios)
        self.assertEqual(validator.ERRORS, [])
        case = next(c for c in cases if 'expected_trade_only_usd' in scenarios.get(c.get('scenario_id'), {}))
        key = next(k for k, v in case['expected_numeric'].items() if type(v) is int)
        case['expected_numeric'][key] += 1
        validator.ERRORS.clear()
        validator.check_acceptance_fixture_numbers(cases, scenarios)
        self.assertIn(case['id'] + ': expected_numeric와 시나리오 expected_trade_only_usd 불일치', validator.ERRORS)
        # 시나리오 값을 읽는다고 적은 사례는 있는 시나리오와 그 값이 필요하다.
        source = next(c for c in validator.read('tests/acceptance_cases.json')['cases']
                      if 'expected_trade_only_usd' in scenarios.get(c.get('scenario_id'), {})
                      and 'expected_trade_only_usd' in c.get('engine_mapping_note_ko', ''))
        cid = source['id']
        missing = next(f'SCENARIO_UNKNOWN_{i:02d}' for i in range(100) if f'SCENARIO_UNKNOWN_{i:02d}' not in scenarios)
        other = next(sid for sid in scenarios if 'expected_trade_only_usd' not in validator.resolve_scenario(scenarios, sid))
        for change, message in ((missing, f'{cid}: 없는 시나리오 {missing}'),
                                (None, f'{cid}: 연결 시나리오에 expected_trade_only_usd 없음'),
                                (other, f'{cid}: 연결 시나리오에 expected_trade_only_usd 없음')):
            with self.subTest(scenario_id=change):
                case = copy.deepcopy(source)
                if change is None:
                    del case['scenario_id']
                else:
                    case['scenario_id'] = change
                validator.ERRORS.clear()
                validator.check_acceptance_fixture_numbers([case], copy.deepcopy(scenarios))
                self.assertIn(message, validator.ERRORS)


class CityLinkTest(unittest.TestCase):
    def test_city_case_must_stay_linked(self):
        helper = CultureReportsTest()
        _, cases = helper.fixtures()
        city_ids = [c['id'] for c in cases if c['id'].startswith('P0-CITY-')]
        self.assertTrue(city_ids)
        for cid in city_ids:
            with self.subTest(case=cid):
                tables, cases = helper.fixtures()
                case = next(c for c in cases if c['id'] == cid)
                case.pop('engine_test_names', None)
                case.update(engine_test_ref=None, unlinked_reason_ko='이유')
                self.assertIn(cid + ': 문화 엔진 시험 연결 필요', helper.errors(tables, cases))


class MainWiringTest(unittest.TestCase):
    def test_main_calls_new_checks(self):
        names = ('check_test_refs', 'check_acceptance_summary', 'check_organization_names', 'check_sources',
                 'check_extension_curriculum_refs', 'check_achievement_standards',
                 'check_curriculum_stages', 'check_curriculum_counts', 'check_acceptance_fixture_numbers', 'check_test_title_links')
        with contextlib.ExitStack() as stack:
            mocks = {name: stack.enter_context(mock.patch.object(validator, name, wraps=getattr(validator, name))) for name in names}
            with contextlib.redirect_stdout(io.StringIO()):
                validator.ERRORS.clear()
                validator.main()
            for name, wrapped in mocks.items():
                with self.subTest(name=name):
                    self.assertGreaterEqual(wrapped.call_count, 2 if name == 'check_test_refs' else 1)
        # 실제 자료 목록을 넘겼는지 사례 ID로 확인한다.
        core = [c['id'] for c in validator.read('tests/acceptance_cases.json')['cases']]
        character = [c['id'] for c in validator.read('tests/character_acceptance_cases.json')['items']]
        ids = lambda items: [item['id'] for item in items]
        calls = lambda name: mocks[name].call_args_list
        with self.subTest(name='check_test_refs 인자'):
            self.assertEqual(sorted(ids(call.args[0]) for call in calls('check_test_refs')), sorted([core, character]))
        for name, expected in (('check_acceptance_fixture_numbers', core), ('check_organization_names', character)):
            with self.subTest(name=name + ' 인자'):
                for call in calls(name):
                    self.assertEqual(ids(call.args[0]), expected)
        with self.subTest(name='check_test_title_links 인자'):
            for call in calls('check_test_title_links'):
                self.assertEqual(set(ids(call.args[0])), set(core) | set(character))
        with self.subTest(name='check_acceptance_summary 인자'):
            for call in calls('check_acceptance_summary'):
                self.assertEqual(ids(call.args[0]['cases']), core)
                self.assertEqual(ids(call.args[1]['items']), character)


class DataDrivenMainTest(unittest.TestCase):
    """디스크 자료 대신 메모리 사본을 읽어 main의 연결까지 검사한다."""
    def setUp(self):
        self.documents = data_documents()

    def run_main(self):
        original_read = Path.read_text

        def read_copy(path, *args, **kwargs):
            if path.parent == validator.ROOT / 'data' and path.stem in self.documents:
                return json.dumps(self.documents[path.stem], ensure_ascii=False)
            return original_read(path, *args, **kwargs)

        validator.ERRORS.clear()
        with mock.patch.object(Path, 'read_text', read_copy), contextlib.redirect_stdout(io.StringIO()):
            result = validator.main()
        return result, list(validator.ERRORS)

    def test_motif_cautions_main_failure(self):
        character = next(c for c in self.documents['characters']['items'] if c['id'] == 'EMP18')
        character['visual_motif'] += ' 작은 금고'
        result, errors = self.run_main()
        self.assertEqual(result, 1)
        self.assertIn('EMP18: 생김새·주의 문장 충돌 visual_motif 금고', errors)

    def test_character_release_and_stat_budget(self):
        for mutation, message in (
            ('phase', 'EMP61: release_phase 허용값은 P0·P1·P2'),
            ('candidate', 'scenarios.candidate_employee_ids: P2 캐릭터 참조 금지 EMP61'),
            ('stats', 'EMP62: base stat budget'),
        ):
            with self.subTest(mutation=mutation):
                self.documents = data_documents()
                characters = {c['id']: c for c in self.documents['characters']['items']}
                if mutation == 'phase':
                    characters['EMP61']['release_phase'] = 'P3'
                elif mutation == 'candidate':
                    scenario = next(obj for obj in validator.walk(self.documents['scenarios'])
                                    if 'candidate_employee_ids' in obj)
                    scenario['candidate_employee_ids'].append('EMP61')
                else:
                    characters['EMP62']['stats']['negotiation'] += 5
                result, errors = self.run_main()
                self.assertNotEqual(result, 0)
                self.assertIn(message, errors)

    def test_domestic_and_secondary_conservation(self):
        cases = (
            ('EMP66', {'cites_status': 'not_applicable', 'cites_appendix': None}, '가축 해당 없음'),
            ('EMP79', {'iucn_status': 'LC'}, '가축 해당 없음'),
            ('EMP79', {'cites_status': 'listed', 'cites_appendix': 'I'}, '가축 해당 없음'),
            ('EMP79', {'cites_appendix': 'I'}, 'CITES 확인 상태와 부속서'),
            ('EMP66', {'check_level': 'IUCN 2차 자료'}, '사람 확인 필요 표시'),
        )
        for cid, changes, message in cases:
            with self.subTest(cid=cid, changes=changes):
                self.documents = data_documents()
                character = next(c for c in self.documents['characters']['items'] if c['id'] == cid)
                character['conservation'].update(changes)
                result, errors = self.run_main()
                self.assertEqual(result, 1)
                self.assertTrue(any(cid in error and message in error for error in errors))

    def test_regional_bonus_tokens(self):
        for field, value, rejected in (
            ('trigger_tag', 'BUSAN_PORT_BRIEF', True),
            ('trigger_tag', 'KR_BUYER_PREP', True),
            ('trigger_tag', 'TRANSIT_ROUTE_BRIEF', False),
            ('trigger_tag', 'CUTOFF_TRACKING', False),
            ('target_score', 'busan_port_score', True),
            ('target_score', 'kr_buyer_score', True),
            ('compatibility', 'ROUTE01', True),
            ('compatibility', 'HONG_KONG', True),
        ):
            with self.subTest(field=field, value=value):
                self.documents = data_documents()
                # 양성 태그는 원래 소유한 동료를 써서 유일성 검사도 통과한다.
                cid = 'EMP71' if value == 'CUTOFF_TRACKING' else 'EMP75'
                character = next(c for c in self.documents['characters']['items'] if c['id'] == cid)
                if field == 'compatibility':
                    character['compatibility']['note'] = value
                else:
                    character['signature_trait']['candidate_effect'][field] = value
                result, errors = self.run_main()
                self.assertEqual(result, 1 if rejected else 0)
                self.assertEqual(any('지역 보너스 금지' in error for error in errors), rejected)

    def verified_good(self):
        good = self.documents['goods']['items'][0]
        good.update(hs_mapping_status='VERIFIED', hs_code='3304.99', hs_edition='HS2022')
        return good

    def test_recovery_carry_failure_output(self):
        profile = next(p for p in self.documents['market_rules']['risk_profiles'] if p['id'] == 'RISK_PROFILE_V2')
        profile['collections']['recovery_bp'] = 0
        original_read = Path.read_text

        def read_copy(path, *args, **kwargs):
            if path == validator.ROOT / 'data' / 'market_rules.json':
                return json.dumps(self.documents['market_rules'], ensure_ascii=False)
            return original_read(path, *args, **kwargs)
        output = io.StringIO()
        validator.ERRORS.clear()
        with mock.patch.object(Path, 'read_text', read_copy), contextlib.redirect_stdout(output):
            result = validator.main()
        self.assertEqual(result, 1)
        self.assertIn('FAIL risk_profiles: RISK_PROFILE_V2: recovery_bp: 확정일까지의 최대 누적 이자 이상이어야 함', output.getvalue().splitlines())

    def test_verified_hs(self):
        self.verified_good()
        self.assertEqual(self.run_main(), (0, []))

    def test_invalid_hs(self):
        for field, value, message in (
                ('hs_code', None, '확인한 HS 코드 형식 오류'),
                ('hs_code', '330499', '확인한 HS 코드 형식 오류'),
                ('hs_edition', None, '확인한 HS 판본 형식 오류'),
                ('hs_edition', 'HS1996', '확인한 HS 판본 형식 오류'),
                ('hs_mapping_status', 'NOT_VERIFIED', '미확인 HS 코드와 판본은 null이어야 함'),
                ('hs_mapping_status', 'MAYBE', 'HS 확인 상태 오류'),
                ('source_refs', ['UNKNOWN'], '확인한 HS 출처가 없거나 잘못됨'),
                ('source_refs', [], '확인한 HS 출처가 없거나 잘못됨')):
            with self.subTest(field=field, value=value):
                self.documents = data_documents()
                good = self.verified_good()
                good[field] = value
                result, errors = self.run_main()
                self.assertNotEqual(result, 0)
                self.assertIn(f"{good['id']}: {message}", errors)

    def test_unverified_edition(self):
        good = self.documents['goods']['items'][0]
        good['hs_edition'] = 'HS2022'
        self.assertIn(f"{good['id']}: 미확인 HS 코드와 판본은 null이어야 함", self.run_main()[1])

    def vocational(self):
        doc = self.documents['curriculum_links']
        link = copy.deepcopy(doc['links'][0])
        link.update(id='VOC01', group='vocational', selection='major_general')
        link['achievement_standards'] = [dict(link['achievement_standards'][0], code='[무일 02-03-02]')]
        doc['links'].append(link)
        doc['counts']['total'] += 1
        doc['counts']['by_group']['vocational'] = 1
        doc['counts']['by_selection']['major_general'] = 1
        return link

    def test_vocational(self):
        link = self.vocational()
        self.assertEqual(self.run_main(), (0, []))
        link['selection'] = 'major_practice'
        counts = self.documents['curriculum_links']['counts']['by_selection']
        del counts['major_general']
        counts['major_practice'] = 1
        self.assertEqual(self.run_main(), (0, []))

    def test_group_code_format(self):
        for group, code in (('social', '[무일 02-03-02]'), ('vocational', '[12경제04-03]')):
            with self.subTest(group=group):
                self.documents = data_documents()
                link = self.vocational() if group == 'vocational' else self.documents['curriculum_links']['links'][0]
                link['achievement_standards'][0]['code'] = code
                self.assertIn(f"{link['id']}: 성취기준 코드 형식 오류 {code}", self.run_main()[1])

    def test_vocational_counts(self):
        self.vocational()
        self.documents['curriculum_links']['counts']['by_group']['vocational'] = 2
        self.assertIn('curriculum: counts.by_group.vocational 불일치', self.run_main()[1])

    def test_vocational_prefix(self):
        link = self.vocational()
        link['id'] = 'BAD01'
        self.assertIn('BAD01: 연결 ID 머리와 group 불일치', self.run_main()[1])

    def test_vocational_selection(self):
        link = self.vocational()
        link['selection'] = 'career'
        self.assertIn('VOC01: selection과 group 불일치', self.run_main()[1])

    def test_general_selection(self):
        link = self.documents['curriculum_links']['links'][0]
        link['selection'] = 'major_general'
        self.assertIn(f"{link['id']}: selection과 group 불일치", self.run_main()[1])

    def test_vocational_stage(self):
        link = self.vocational()
        link['priority'] = ['P1']
        file, obj = next((f, o) for f, d in self.documents.items() if f != 'curriculum_links'
                         for o in validator.walk(d) if o.get('stage') == 'P0' and o.get('curriculum_refs'))
        obj['curriculum_refs'].append(link['id'])
        self.assertIn(f"{file}/{obj['id']}: P0 항목이 P0 표지 없는 교과 연결을 가리킴 VOC01", self.run_main()[1])


class MarketRulesTest(unittest.TestCase):
    def test_risk_setup_rejections(self):
        for field, value, message in (
                ('level', 'R3', 'risk_setup.level은 R4여야 함'),
                ('profile_id', 'MISSING', 'risk_setup.profile_id는 외상 칸이 모두 있는 위험 프로필이어야 함'),
                ('base_scenario_id', 'SCENARIO_M2_OPERATIONS', 'risk_setup.base_scenario_id는 실험 시나리오여야 함')):
            with self.subTest(field=field):
                d, t = self.fixtures()
                row = t['scenarios']['SCENARIO_M2_OPS_CREDIT']
                (row if field == 'base_scenario_id' else row['risk_setup'])[field] = value
                self.assertIn(row['id'] + ': ' + message, self.errors(d, t))

    def test_sale_margin_k_range(self):
        message = 'risk_profiles: RISK_PROFILE_V2: sale_margin_k: -2~3 정수여야 함'
        for value in (4, 2.5, '1', -3, True):
            with self.subTest(value=value):
                d, t = self.fixtures()
                p = next(p for p in d['market_rules']['risk_profiles'] if p['id'] == 'RISK_PROFILE_V2')
                p['sale_margin_k'] = value
                # MANIFEST와 스키마를 거치지 않고 범위 검사의 고유 실패를 확인한다.
                self.assertEqual(self.errors(d, t), [message])

    def test_sale_margin_k_optional(self):
        for value in (None, -2, 0, 1, 3):
            with self.subTest(value=value):
                d, t = self.fixtures()
                p = next(p for p in d['market_rules']['risk_profiles'] if p['id'] == 'RISK_PROFILE_V2')
                if value is None:
                    p.pop('sale_margin_k', None)
                else:
                    p['sale_margin_k'] = value
                self.assertEqual(self.errors(d, t), [])

    def fixtures(self):
        documents = {p.stem: json.loads(p.read_text()) for p in (validator.ROOT / 'data').glob('*.json')}
        tables = {name: {i['id']: i for i in doc['items']} for name, doc in documents.items() if 'items' in doc}
        return documents, tables

    def errors(self, documents, tables):
        validator.ERRORS.clear()
        validator.check_market_rules(documents, tables)
        return list(validator.ERRORS)

    def test_credit_profile_rejections(self):
        cases = [
            ('함께', lambda p: p.pop('credit_terms'), '외상 칸은 모두 함께'),
            ('대손 누락', lambda p: p['collections']['grades'][0].pop('p_default_bp'), '외상 칸은 모두 함께'),
            ('조건', lambda p: p['credit_terms'][0].update(days=1), 'credit_terms: 조건 값 오류'),
            ('등급', lambda p: [r.update(grade='B') for r in p['collections']['by_counterparty']], '품목마다 등급 둘 이상'),
            ('비대칭', lambda p: p['collections']['grades'][2].update(p_default_bp=0), '비대칭 제약'),
            ('A 비용 초과', lambda p: p['collections']['grades'][0].update(p_default_bp=1000), '비대칭 제약: D15'),
            ('B 비용 초과', lambda p: p['collections']['grades'][1].update(p_default_bp=1000), '비대칭 제약: D15'),
            # 회수율 6000bp이면 D15 C 비용 0.02616 < 가산 0.03으로 뒤집힌다.
            ('C 회수율', lambda p: p['collections'].update(recovery_bp=6000), '비대칭 제약: D15'),
            ('비BASE 기간', lambda p: p['credit_terms'][1].update(days=0), 'credit_terms: 조건 값 오류'),
            ('비BASE 계수', lambda p: p['credit_terms'][1].update(factor_pct=99), 'credit_terms: 조건 값 오류'),
            ('비BASE 가산 하한', lambda p: p['credit_terms'][1].update(premium_bp=-1), 'credit_terms: 조건 값 오류'),
            ('비BASE 가산 상한', lambda p: p['credit_terms'][1].update(premium_bp=10001), 'credit_terms: 조건 값 오류'),
            ('판매 거래처 누락', lambda p: p['collections']['by_counterparty'].pop(), '외상 등급: 판매 거래처 누락'),
            ('D30 가산 1000', lambda p: p['credit_terms'][2].update(premium_bp=1000), '한도 단위: 손잡이 최대 1로트 판매액 401060 미만'),
            ('한도 단위', lambda p: p.update(credit_limit_unit_minor=390000), '한도 단위'),
            ('한도 일치', lambda p: p['credit_limits'][1].update(limit_minor=800001), 'limit_minor ='),
            ('배수', lambda p: p['credit_limits'][0].update(lots=1), 'lots는 양의 정수'),
            ('이자', lambda p: p['collections'].update(carry_bp_per_day=101), 'carry_bp_per_day'),
            ('회수', lambda p: p['collections'].update(recovery_bp=10001), 'recovery_bp'),
            ('대손 범위', lambda p: p['collections']['grades'][0].update(p_default_bp=-1), 'p_default_bp: 정수 범위'),
            ('조건 중복', lambda p: p['credit_terms'][1].update(id='BASE'), 'BASE·D15·D30 각 한 행'),
            ('한도 중복', lambda p: p['credit_limits'][1].update(grade='A'), 'A·B·C 각 한 행'),
        ]
        for name, mutate, message in cases:
            with self.subTest(name=name):
                d, t = self.fixtures()
                p = next(p for p in d['market_rules']['risk_profiles'] if p['id'] == 'RISK_PROFILE_V2')
                mutate(p)
                self.assertTrue(any(message in e for e in self.errors(d, t)))
        d, t = self.fixtures()
        d['market_rules']['risk_profiles'][0]['collections']['grades'][0]['p_default_bp'] = 200
        self.assertTrue(any('외상 칸은 모두 함께' in e for e in self.errors(d, t)))

    def test_recovery_covers_confirmation_carry(self):
        d, t = self.fixtures()
        p = next(p for p in d['market_rules']['risk_profiles'] if p['id'] == 'RISK_PROFILE_V2')
        message = 'risk_profiles: RISK_PROFILE_V2: recovery_bp: 확정일까지의 최대 누적 이자 이상이어야 함'
        self.assertNotIn(message, self.errors(d, t))
        p['collections']['recovery_bp'] = 0
        self.assertIn(message, self.errors(d, t))
        # 등호는 허용한다. 해시 검사는 거치지 않고 신용 자료의 고유 실패만 본다.
        p['collections']['recovery_bp'] = p['collections']['carry_bp_per_day'] * p['collections']['late_max_days']
        self.assertNotIn(message, self.errors(d, t))

    def test_credit_profile_requires_each_collection_grade(self):
        d, t = self.fixtures()
        p = next(p for p in d['market_rules']['risk_profiles'] if p['id'] == 'RISK_PROFILE_V2')
        for row in p['collections']['by_counterparty']:
            if row['grade'] == 'B':
                row['grade'] = 'A'
        p['collections']['grades'] = [g for g in p['collections']['grades'] if g['grade'] != 'B']
        self.assertTrue(any('collections.grades: A·B·C 각 한 행 필요' in e for e in self.errors(d, t)))

    def test_credit_limit_boundary_cos_laver(self):
        # 최댓값은 (다) M2A5_PYEONGTAEK_COS_LAVER의 상하이 김 1로트에서 나온다.
        message = 'risk_profiles: RISK_PROFILE_V2: 한도 단위: 손잡이 최대 1로트 판매액 393768 미만'
        for unit in (393767, 393768):
            with self.subTest(unit=unit):
                d, t = self.fixtures()
                p = next(p for p in d['market_rules']['risk_profiles'] if p['id'] == 'RISK_PROFILE_V2')
                p['credit_limit_unit_minor'] = unit
                for row in p['credit_limits']:
                    row['limit_minor'] = unit * row['lots']
                self.assertEqual(self.errors(d, t), [message] if unit == 393767 else [])

    def test_current_data(self):
        self.assertEqual(self.errors(*self.fixtures()), [])

    def experiment_errors(self, documents, tables):
        self.errors(documents, tables)
        validator.check_experiments(documents, tables)
        return list(validator.ERRORS)

    def experiment_fixtures(self):
        d, t = self.fixtures()
        scenarios = [t['scenarios'][sid] for sid in validator.EXPERIMENT_SCENARIO_IDS]
        rules = {r['id']: r for r in d['market_rules']['rule_sets']}
        new = [rules[rid] for rid in validator.EXPERIMENT_RULE_SET_IDS]
        base = validator.resolve_scenario(t['scenarios'], scenarios[0]['base_scenario_id'])
        old = rules[base['operations']['market_rules_ref'].split('#')[1]]
        focus = next(t['market_offers'][oid]['good_id'] for oid in scenarios[0]['offer_ids']
                     if t['market_offers'][oid]['kind'] == 'supplier')
        return d, t, scenarios, new, old, focus

    def test_experiment_inheritance(self):
        d, t, scenarios, _, _, _ = self.experiment_fixtures()
        scenarios[0]['operations']['facility']['storage_m3'] += 1
        self.assertTrue(any('실험 상속 동일성' in e for e in self.experiment_errors(d, t)))

    def test_experiment_sellers_separate(self):
        d, t, _, rules, old, focus = self.experiment_fixtures()
        extra = next(g for g in rules[1]['trade']['goods'] if g['good_id'] != focus)
        extra['sell_counterparties'][-1]['counterparty_id'] = old['trade']['goods'][0]['sell_counterparties'][-1]['counterparty_id']
        self.assertTrue(any('실험 판매 거래처가 옛 거래처와 겹침' in e for e in self.experiment_errors(d, t)))

    def test_experiment_common_copy(self):
        d, t, _, rules, _, _ = self.experiment_fixtures()
        rules[1]['regional_pct'][0] += 1
        self.assertTrue(any('실험 복사 동일성: 공통 규칙' in e for e in self.experiment_errors(d, t)))

    def test_experiment_cosmetics_copy(self):
        for field in ('base_lot', 'rows'):
            with self.subTest(field=field):
                d, t, _, rules, _, focus = self.experiment_fixtures()
                if field == 'rows':
                    next(r for r in rules[0]['rows'] if r['good_id'] == focus)['base_price']['amount'] += 1
                else:
                    next(g for g in rules[0]['trade']['goods'] if g['good_id'] == focus)[field] += 1
                self.assertTrue(any('실험 복사 동일성: 화장품' in e for e in self.experiment_errors(d, t)))

    def test_experiment_static_offer_copy(self):
        d, t, scenarios, _, _, _ = self.experiment_fixtures()
        sell = next(t['market_offers'][oid] for oid in scenarios[0]['offer_ids']
                    if t['market_offers'][oid]['kind'] == 'customer')
        sell['unit_price']['amount'] += 1
        self.assertTrue(any('실험 복사 동일성: 정적 판매 견적' in e for e in self.experiment_errors(d, t)))

    def test_experiment_missing_row_uses_existing_check(self):
        d, t, _, rules, _, _ = self.experiment_fixtures()
        rules[1]['rows'].pop()
        self.assertTrue(any('시세표 행 집합이 거래 품목·도시와 다름' in e for e in self.experiment_errors(d, t)))

    def test_experiment_legacy_data_still_passes(self):
        d, t, scenarios, rules, old, focus = self.experiment_fixtures()
        base = validator.resolve_scenario(t['scenarios'], scenarios[0]['base_scenario_id'])
        old_parties = {p['counterparty_id'] for g in old['trade']['goods'] for p in g['sell_counterparties']}
        old_parties.update(g['buy_counterparty_id'] for g in old['trade']['goods'])
        new_parties = {p['counterparty_id'] for r in rules for g in r['trade']['goods'] for p in g['sell_counterparties']}
        new_parties.update(g['buy_counterparty_id'] for r in rules for g in r['trade']['goods'])
        added_parties = new_parties - old_parties
        added_goods = {g['good_id'] for g in rules[1]['trade']['goods']} - {g['good_id'] for g in old['trade']['goods']}
        for sid in (*validator.EXPERIMENT_SCENARIO_IDS, 'SCENARIO_M2_OPS_CREDIT'):
            del t['scenarios'][sid]
        for oid in set(scenarios[0]['offer_ids']) - set(base['offer_ids']):
            del t['market_offers'][oid]
        for gid in added_goods:
            del t['goods'][gid]
        m = d['market_rules']
        m['rule_sets'] = [r for r in m['rule_sets'] if r['id'] not in validator.EXPERIMENT_RULE_SET_IDS]
        m['counterparties'] = [p for p in m['counterparties'] if p['id'] not in added_parties]
        for p in m['risk_profiles']:
            p['tariff']['base'] = [r for r in p['tariff']['base'] if r['good_id'] not in added_goods]
            p['claims']['by_good'] = [r for r in p['claims']['by_good'] if r['good_id'] not in added_goods]
            p['collections']['by_counterparty'] = [r for r in p['collections']['by_counterparty'] if r['counterparty_id'] not in added_parties]
        self.assertEqual(self.experiment_errors(d, t), [])

    def test_risk_counterexamples(self):
        cases = [
            ('probability', 'collections: 등급 확률 합은 10000이어야 함'),
            ('weight', 'claims: 손상 가중치 합은 10000이어야 함'),
            ('range', 'surcharge: 최소·최대 범위 오류'),
            ('good', 'claims: 품목 자료에 없는 품목'),
            ('tariff_good', 'tariff: 품목 자료에 없는 품목'),
            ('party', 'collections: 시장 자료에 없는 거래처'),
            ('fx', 'fx: 시작 환율이 fx_krw_per_usd와 다름'),
            ('missing_party', 'collections: 운영 판매 거래처 누락'),
            ('missing_good', 'claims: 운영 품목 누락'),
            ('missing_tariff', 'tariff: 운영 판매국·품목 누락'),
            ('step', 'tariff.step_bp: 최소·최대 범위 오류'),
            ('days', 'collections.late_days: 최소·최대 범위 오류'),
            ('bp', 'fx.step_bp: 정수 범위 오류'),
        ]
        for change, message in cases:
            with self.subTest(change=change):
                d, t = self.fixtures()
                p = d['market_rules']['risk_profiles'][0]
                if change == 'probability': p['collections']['grades'][0]['p_on_time_bp'] += 1
                elif change == 'weight': p['claims']['minor']['weight_bp'] += 1
                elif change == 'range': p['surcharge']['min_bp'] = p['surcharge']['max_bp'] + 1
                elif change == 'good': p['claims']['by_good'][0]['good_id'] = 'UNKNOWN'
                elif change == 'tariff_good': p['tariff']['base'][0]['good_id'] = 'UNKNOWN'
                elif change == 'party': p['collections']['by_counterparty'][0]['counterparty_id'] = 'UNKNOWN'
                elif change == 'fx': p['fx']['start_krw_per_usd'] += 1
                elif change == 'missing_party': p['collections']['by_counterparty'] = []
                elif change == 'missing_good': p['claims']['by_good'] = []
                elif change == 'missing_tariff': p['tariff']['base'] = []
                elif change == 'step': p['tariff']['step_bp'][0] = -10001
                elif change == 'days': p['collections']['late_min_days'] = -1
                elif change == 'bp': p['fx']['step_bp'] = 10001
                self.assertIn(f"risk_profiles: {p['id']}: {message}", self.errors(d, t))

    def test_risk_all_profiles(self):
        d, t = self.fixtures()
        p = copy.deepcopy(d['market_rules']['risk_profiles'][0])
        p['id'] += '_SECOND'
        p['collections']['by_counterparty'] = []
        d['market_rules']['risk_profiles'].append(p)
        self.assertIn(f"risk_profiles: {p['id']}: collections: 운영 판매 거래처 누락", self.errors(d, t))

    def test_risk_inherited_rule_and_rules3(self):
        for rules_version in (None, 'M2a-rules-3'):
            with self.subTest(rules_version=rules_version):
                d, t = self.fixtures()
                parent = validator.resolve_scenario(t['scenarios'], 'SCENARIO_M2_OPERATIONS')
                rule_id = parent['operations']['market_rules_ref'].split('#')[1]
                rule = copy.deepcopy(next(r for r in d['market_rules']['rule_sets'] if r['id'] == rule_id))
                rule['id'] = 'VARIANT_X'
                covered = {r['counterparty_id'] for r in d['market_rules']['risk_profiles'][0]['collections']['by_counterparty']}
                seller = next(r['id'] for r in d['market_rules']['counterparties'] if r['id'] not in covered)
                self.assertNotIn(seller, covered)
                rule['trade']['goods'][-1]['sell_counterparties'][-1]['counterparty_id'] = seller
                d['market_rules']['rule_sets'].append(rule)
                child = {'base_scenario_id': 'SCENARIO_M2_OPERATIONS',
                         'operations': {'market_rules_ref': 'market_rules.json#VARIANT_X'}}
                if rules_version:
                    child['engine_rules'] = {'rules_version': rules_version}
                t['scenarios']['SCENARIO_VARIANT_X'] = child
                profile = d['market_rules']['risk_profiles'][0]
                self.assertIn(f"risk_profiles: {profile['id']}: collections: 운영 판매 거래처 누락", self.errors(d, t))

    def test_risk_missing_single_rows(self):
        for missing, message in (
            ('party', 'collections: 운영 판매 거래처 누락'),
            ('good', 'claims: 운영 품목 누락'),
            ('tariff', 'tariff: 운영 판매국·품목 누락'),
        ):
            with self.subTest(missing=missing):
                d, t = self.fixtures()
                parent = validator.resolve_scenario(t['scenarios'], 'SCENARIO_M2_OPERATIONS')
                rule_id = parent['operations']['market_rules_ref'].split('#')[1]
                rule = next(r for r in d['market_rules']['rule_sets'] if r['id'] == rule_id)
                profile = d['market_rules']['risk_profiles'][0]
                good = rule['trade']['goods'][-1]
                if missing == 'party':
                    rows, key = profile['collections']['by_counterparty'], 'counterparty_id'
                    value = good['sell_counterparties'][-1][key]
                    row = next(r for r in rows if r[key] == value)
                elif missing == 'good':
                    rows = profile['claims']['by_good']
                    row = next(r for r in rows if r['good_id'] == good['good_id'])
                else:
                    rows = profile['tariff']['base']
                    country = t['world'][rule['trade']['sell_city_ids'][1]]['country_code']
                    row = next(r for r in rows if r['country_code'] == country and r['good_id'] == good['good_id'])
                before = len(rows)
                rows.remove(row)
                self.assertEqual(len(rows), before - 1)
                self.assertGreater(len(rows), 0)
                self.assertIn(f"risk_profiles: {profile['id']}: {message}", self.errors(d, t))

    def test_risk_additional_ranges_and_grade(self):
        for change, message in (
            ('start', 'fx: 시작 환율 범위 오류'),
            ('fx_range', 'fx: 최소·최대 범위 오류'),
            ('grade', 'collections: 정의되지 않은 등급'),
            ('lag', 'tariff.lag_days: 최소·최대 범위 오류'),
            ('tariff_range', 'tariff: 최소·최대 범위 오류'),
            ('major_range', 'claims.major: 최소·최대 범위 오류'),
        ):
            with self.subTest(change=change):
                d, t = self.fixtures()
                p = d['market_rules']['risk_profiles'][0]
                if change == 'start': p['fx']['min_krw_per_usd'] = p['fx']['start_krw_per_usd'] + 1
                elif change == 'fx_range': p['fx']['min_krw_per_usd'] = p['fx']['max_krw_per_usd'] + 1
                elif change == 'grade': p['collections']['by_counterparty'][0]['grade'] = 'UNKNOWN'
                elif change == 'lag': p['tariff']['lag_days'] = [3, 0]
                elif change == 'tariff_range': p['tariff']['min_bp'] = p['tariff']['max_bp'] + 1
                elif change == 'major_range': p['claims']['major']['min_bp'] = p['claims']['major']['max_bp'] + 1
                self.assertIn(f"risk_profiles: {p['id']}: {message}", self.errors(d, t))

    def test_risk_duplicate_profile_id(self):
        d, t = self.fixtures()
        d['market_rules']['risk_profiles'].append(copy.deepcopy(d['market_rules']['risk_profiles'][0]))
        self.assertIn('risk_profiles: 프로필 ID 중복', self.errors(d, t))

    def test_risk_duplicate_rows(self):
        for group, field in (('tariff', 'base'), ('claims', 'by_good'),
                             ('collections', 'by_counterparty'), ('collections', 'grades')):
            with self.subTest(group=group, field=field):
                d, t = self.fixtures()
                p = d['market_rules']['risk_profiles'][0]
                rows = p[group][field]
                rows.append(copy.deepcopy(rows[-1]))
                self.assertIn(f"risk_profiles: {p['id']}: {group}.{field}: 중복 행", self.errors(d, t))

    def test_goods_counts(self):
        for count in (1, 3):
            with self.subTest(count=count):
                d, t = self.fixtures()
                rule = d['market_rules']['rule_sets'][0]
                goods = rule['trade']['goods']
                if count == 1:
                    removed = goods.pop()['good_id']
                    rule['rows'] = [r for r in rule['rows'] if r['good_id'] != removed]
                else:
                    good = copy.deepcopy(goods[0])
                    good['good_id'] = next(g for g in t['goods'] if g not in {x['good_id'] for x in goods})
                    good['id_tag'] = 'THIRD'
                    goods.append(good)
                    for profile in d['market_rules']['risk_profiles']:
                        claim = copy.deepcopy(profile['claims']['by_good'][0])
                        claim['good_id'] = good['good_id']
                        profile['claims']['by_good'].append(claim)
                        for country in {t['world'][city]['country_code'] for city in rule['trade']['sell_city_ids']}:
                            tariff = copy.deepcopy(profile['tariff']['base'][0])
                            tariff.update(country_code=country, good_id=good['good_id'])
                            profile['tariff']['base'].append(tariff)
                    for row in list(rule['rows']):
                        if row['good_id'] == goods[0]['good_id']:
                            rule['rows'].append(dict(copy.deepcopy(row), good_id=good['good_id']))
                rule['index']['goods'] = [g['good_id'] for g in goods]
                self.assertEqual(len(rule['rows']), count * 3)
                self.assertEqual(self.errors(d, t), [])

    def test_rows(self):
        for change in ('missing', 'duplicate', 'outside'):
            with self.subTest(change=change):
                d, t = self.fixtures()
                rule = d['market_rules']['rule_sets'][0]
                rows = rule['rows']
                row = next(r for r in rows if r['side'] == 'SELL')
                if change == 'missing':
                    rows.remove(row)
                elif change == 'duplicate':
                    rows.append(copy.deepcopy(row))
                else:
                    row['city_id'] = rule['trade']['buy_city_id']
                message = '시세표 행이 중복됨' if change == 'duplicate' else '시세표 행 집합이 거래 품목·도시와 다름'
                self.assertIn(f"market_rules: {rule['id']}: {message}", self.errors(d, t))

    def test_trade_coverage(self):
        for field in ('index', 'parties', 'payment'):
            for change in ('missing', 'duplicate', 'outside'):
                with self.subTest(field=field, change=change):
                    d, t = self.fixtures()
                    rule = d['market_rules']['rule_sets'][0]
                    good = rule['trade']['goods'][0]
                    values, message = {
                        'index': (rule['index']['goods'], '지수 품목이 거래 품목과 다르거나 중복됨'),
                        'parties': (good['sell_counterparties'], f"품목 {good['good_id']}의 판매 거래처는 판매지마다 정확히 하나여야 함"),
                        'payment': (rule['trade']['payment_offset_days'], '결제일은 판매지마다 정확히 하나여야 함'),
                    }[field]
                    if change == 'missing':
                        values.pop()
                    elif change == 'duplicate':
                        values.append(copy.deepcopy(values[0]))
                    elif field == 'index':
                        values[0] = 'UNKNOWN'
                    else:
                        values[0]['city_id'] = rule['trade']['buy_city_id']
                    self.assertIn(f"market_rules: {rule['id']}: {message}", self.errors(d, t))

    def test_trade_prerequisites(self):
        for change in ('unknown_good', 'duplicate_good', 'duplicate_tag', 'empty_cities', 'duplicate_city', 'unknown_city', 'buy_city', 'lots'):
            with self.subTest(change=change):
                d, t = self.fixtures()
                trade = d['market_rules']['rule_sets'][0]['trade']
                if change == 'unknown_good':
                    trade['goods'][0]['good_id'] = 'UNKNOWN'
                elif change == 'duplicate_good':
                    trade['goods'].append(copy.deepcopy(trade['goods'][0]))
                elif change == 'duplicate_tag':
                    trade['goods'][1]['id_tag'] = trade['goods'][0]['id_tag']
                elif change == 'empty_cities':
                    trade['sell_city_ids'] = []
                elif change == 'duplicate_city':
                    trade['sell_city_ids'].append(trade['sell_city_ids'][0])
                elif change == 'unknown_city':
                    trade['sell_city_ids'][0] = 'UNKNOWN'
                elif change == 'buy_city':
                    trade['buy_city_id'] = 'UNKNOWN'
                else:
                    trade['max_lots_choices'] = []
                self.assertTrue(self.errors(d, t))

    def test_deadline(self):
        d, t = self.fixtures()
        item = d['market_rules']['rule_sets'][0]['forwarding']['templates'][0]
        item['deadline_offset_days'] = 0
        self.assertIn(f"{item['id']}: 납기가 운송일보다 짧음", self.errors(d, t))

    def test_payment(self):
        d, t = self.fixtures()
        item = d['market_rules']['rule_sets'][0]['forwarding']['templates'][0]
        item['payment_offset_days'] = item['deadline_offset_days'] - 1
        self.assertIn(f"{item['id']}: 결제일이 납기보다 이름", self.errors(d, t))

    def test_draw_count(self):
        d, t = self.fixtures()
        forward = d['market_rules']['rule_sets'][0]['forwarding']
        for draw in forward['draws']:
            draw['count'] = len(forward['templates']) + 1
            self.assertIn(f"market_rules: {draw['service_class']} 뽑기 수가 틀 수보다 많음", self.errors(d, t))

    def test_counterparty(self):
        for source in ('template', 'trade', 'initial'):
            d, t = self.fixtures()
            rule = d['market_rules']['rule_sets'][0]
            if source == 'template':
                item = rule['forwarding']['templates'][0]
                pid, ident = item['counterparty_id'], item['id']
            elif source == 'trade':
                item = rule['trade']['goods'][0]
                pid, ident = item['buy_counterparty_id'], item['good_id']
            else:
                item = next(iter(t['market_offers'].values()))
                pid, ident = item['counterparty_id'], item['id']
            d['market_rules']['counterparties'] = [p for p in d['market_rules']['counterparties'] if p['id'] != pid]
            self.assertIn(f'{ident}: 거래처 이름 없음 {pid}', self.errors(d, t))

    def test_counterparty_name(self):
        for name in ('', '   '):
            with self.subTest(name=name):
                d, t = self.fixtures()
                party = d['market_rules']['counterparties'][0]
                party['name_ko'] = name
                self.assertIn(f"{party['id']}: 거래처 이름이 비어 있음", self.errors(d, t))

    def test_duplicate_counterparty_id(self):
        d, t = self.fixtures()
        parties = d['market_rules']['counterparties']
        duplicate = copy.deepcopy(parties[0])
        duplicate['name_ko'] = '다른 거래처 이름'
        parties.append(duplicate)
        self.assertEqual(self.errors(d, t).count(f"market_rules: 거래처 ID 중복 {duplicate['id']}"), 1)

    def test_prep(self):
        for grade, value in [('HANDLING', None), ('HANDLING', 1), ('HANDLING', 2.5), ('STANDARD', 2)]:
            d, t = self.fixtures()
            item = next(x for x in d['market_rules']['rule_sets'][0]['forwarding']['templates'] if x['service_class'] == grade)
            item['prep_work_units'] = value
            self.assertIn(f"{item['id']}: 준비량 칸 오류", self.errors(d, t))

    def test_grace_pointer(self):
        for pointer in (False, True):
            d, t = self.fixtures()
            param = next(p for p in d['parameters']['items'] if 'json_pointer' in p and '/payment_default/' in p['json_pointer'])
            if pointer:
                param['json_pointer'] += '/missing'
            else:
                param['value'] += 1
            self.assertIn(f"{param['id']}: 시나리오 값과 다름", self.errors(d, t))

    def test_rule_version(self):
        d, t = self.fixtures()
        s = next(s for s in t['scenarios'].values() if 'operations' in s)
        s['engine_rules'] = copy.deepcopy(t['scenarios'][s['base_scenario_id']]['engine_rules'])
        self.assertIn(f"{s['id']}: operations는 M2a-rules-2 필요", self.errors(d, t))

    def test_late_cap(self):
        for cap in (None, 0, 10001, 1.5, True):
            d, t = self.fixtures()
            s = next(s for s in t['scenarios'].values() if 'operations' in s)
            late = s['contract_terms']['late_delivery']
            if cap is None:
                del late['cap_basis_points']
            else:
                late['cap_basis_points'] = cap
            self.assertIn(f"{s['id']}: 지연 감액 상한 칸 오류", self.errors(d, t))
        d, t = self.fixtures()
        s = next(s for s in t['scenarios'].values() if s.get('contract_terms', {}).get('late_delivery', {}).get('basis') == 'flat_once_regardless_of_late_days')
        s['contract_terms']['late_delivery']['cap_basis_points'] = 10000
        self.assertIn(f"{s['id']}: 지연 감액 상한 칸 오류", self.errors(d, t))


class SituationMapTest(unittest.TestCase):
    def setUp(self):
        self.document = validator.read('data/situation_map.json')
        self.bounds = next(a['bounds'] for a in validator.read('src/assets/manifest.json')['assets']
                           if a['id'] == 'MAP_EAST_ASIA')
        validator.ERRORS.clear()

    def errors(self):
        validator.ERRORS.clear()
        validator.shape(self.document, validator.read('schemas/situation_map.schema.json'), 'situation_map')
        validator.validate_situation_map(self.document, self.bounds)
        return list(validator.ERRORS)

    def test_layers_pass_and_duplicates_fail(self):
        self.assertEqual(self.errors(), [])
        self.document['layers'][1]['id'] = 'cargo'
        self.assertTrue(self.errors())

    def test_layer_count_pass_and_missing_fail(self):
        self.assertEqual(self.errors(), [])
        self.document['layers'].pop()
        self.assertTrue(self.errors())

    def test_license_pass_and_unknown_fail(self):
        self.assertEqual(self.errors(), [])
        self.document['layers'][0]['license_tier'] = 'unknown'
        self.assertTrue(self.errors())

    def test_status_pass_and_unknown_fail(self):
        self.assertEqual(self.errors(), [])
        self.document['layers'][0]['verification_status'] = 'unknown'
        self.assertTrue(self.errors())

    def test_allowed_pass_and_banned_fail(self):
        self.assertEqual(self.errors(), [])
        self.document['layers'][0]['license_tier'] = 'banned'
        self.assertTrue(self.errors())

    def test_verified_date_pass_and_invalid_fail(self):
        self.assertEqual(self.errors(), [])
        for date in (None, '2026-02-30', '20261014'):
            with self.subTest(date=date):
                self.document['layers'][0]['retrieved_on'] = date
                self.assertTrue(self.errors())

    def test_port_bounds_pass_and_outside_fail(self):
        for key, bound in [('lon', 'lon_min'), ('lat', 'lat_min')]:
            saved = self.document['ports'][0][key]
            self.document['ports'][0][key] = self.bounds[bound]
            self.assertEqual(self.errors(), [])
            self.document['ports'][0][key] -= .001
            self.assertTrue(self.errors())
            self.document['ports'][0][key] = saved

    def test_unique_ports_pass_and_duplicate_fail(self):
        self.assertEqual(self.errors(), [])
        self.document['ports'][1]['id'] = self.document['ports'][0]['id']
        self.assertTrue(self.errors())

    def test_value_needs_verified_layer(self):
        indicator = self.document['countries'][0]['indicators'][0]
        indicator.update(value=1, year=2025)
        self.document['layers'][4].update(verification_status='verified', retrieved_on='2026-10-14')
        self.assertEqual(self.errors(), [])
        self.document['layers'][4]['verification_status'] = 'pending'
        self.assertTrue(self.errors())

    def test_value_needs_integer_year(self):
        indicator = self.document['countries'][0]['indicators'][0]
        indicator.update(value=1, year=2025)
        self.document['layers'][4].update(verification_status='verified', retrieved_on='2026-10-14')
        self.assertEqual(self.errors(), [])
        for year in (None, 2025.5, True):
            indicator['year'] = year
            self.assertTrue(self.errors())

    def test_null_values_pass_without_year_and_verification(self):
        self.document['layers'][4].update(verification_status='pending', retrieved_on=None)
        for country in self.document['countries']:
            for indicator in country['indicators']:
                indicator.update(value=None, year=None)
        self.assertEqual(self.errors(), [])
        self.document['countries'][0]['indicators'][0]['value'] = 0
        self.assertTrue(self.errors())

    def test_verified_country_values_pass(self):
        self.document['layers'][4].update(verification_status='verified', retrieved_on='2026-10-14')
        for country in self.document['countries']:
            for indicator in country['indicators']:
                indicator.update(value=1, year=2025)
        self.assertEqual(self.errors(), [])

    def test_verified_country_null_value_fails(self):
        self.document['layers'][4].update(verification_status='verified', retrieved_on='2026-10-14')
        self.document['countries'][0]['indicators'][0]['value'] = None
        self.assertIn('situation_map: 확인된 국가 지표는 값 필요', self.errors())

    def test_required_field_pass_and_missing_fail(self):
        self.assertEqual(self.errors(), [])
        del self.document['layers'][0]['credit_ko']
        self.assertTrue(self.errors())


class AssetIndexTest(unittest.TestCase):
    def test_generated_index_matches_and_has_no_editorial_fields(self):
        import subprocess
        from art.build_asset_index import ROOT, build_index
        result = subprocess.run(['python3', str(ROOT / 'tools/art/build_asset_index.py'), '--check'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        index = json.loads((ROOT / 'src/assets/asset-index.json').read_text())
        for key in ('provenance', 'ai_postprocess', 'human_edits', 'original_sha256'):
            self.assertNotIn(key, json.dumps(index))
        manifest = json.loads((ROOT / 'src/assets/manifest.json').read_text())
        self.assertEqual(index, build_index(manifest))

    def test_only_approved_assets_and_runtime_fields_are_projected(self):
        from art.build_asset_index import build_index
        manifest = validator.read('src/assets/manifest.json')
        manifest['assets'] = [dict(manifest['assets'][0], status='candidate'),
                              dict(manifest['assets'][0], id='TEST', review='빼는 칸')]
        index = build_index(manifest)
        self.assertEqual([a['id'] for a in index['assets']], ['TEST'])
        self.assertNotIn('review', index['assets'][0])
        self.assertEqual(index['assets'][0]['attribution'], manifest['assets'][1]['provenance']['attribution'])


if __name__ == '__main__':
    unittest.main()
