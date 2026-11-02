#!/usr/bin/env python3
"""Validate bundled data, arithmetic references and acceptance-test links. It does not run the game engine or its tests.

Standard-library validator for the JSON Schema keywords used by this bundle:
type, required, properties, items, enum, minimum, maximum, minItems, uniqueItems, additionalProperties.
The schema files can also be used with a complete Draft 2020-12 validator.
"""
from pathlib import Path
from decimal import Decimal, ROUND_HALF_EVEN
import datetime
import hashlib
import json
import sys
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
ERRORS = []
CHECKS = 0

# src/content/scenario.ts의 같은 이름 상수와 같은 값.
EXPERIMENT_SCENARIO_IDS = ('SCENARIO_M2_OPS_COSMETICS', 'SCENARIO_M2_OPS_COS_LAVER')
EXPERIMENT_RULE_SET_IDS = ('M2A5_PYEONGTAEK_COS', 'M2A5_PYEONGTAEK_COS_LAVER')


def check(condition, message):
    global CHECKS
    CHECKS += 1
    if not condition:
        ERRORS.append(message)


def check_conservation(tables):
    """보전 기록을 검사하고 CITES 판정 보류·IUCN 2차 자료 ID를 돌려준다."""
    unresolved, secondary = [], []
    for character in tables['characters'].values():
        if 'conservation' not in character:
            continue
        cid = character['id']
        record = character['conservation']
        check(isinstance(record, dict), f'{cid}: 보전 기록은 객체여야 합니다')
        if not isinstance(record, dict):
            continue
        name = record.get('scientific_name')
        check(isinstance(name, str) and bool(name.strip()), f'{cid}: 대표 학명이 비어 있습니다')
        status, appendix = record.get('cites_status'), record.get('cites_appendix')
        check((status == 'listed' and appendix in ('I', 'II', 'III'))
              or (status in ('not_listed', 'unresolved', 'unchecked', 'not_applicable') and appendix is None),
              f'{cid}: CITES 확인 상태와 부속서 값이 맞지 않습니다')
        domestic = record.get('iucn_status') == 'NOT_APPLICABLE_DOMESTIC'
        familiar = character.get('encounter', {}).get('category') == 'familiar_animal'
        check(domestic == (status == 'not_applicable') == familiar,
              f'{cid}: 가축 해당 없음 값은 친숙한 동물에서 IUCN·CITES에 함께 써야 합니다')
        if record.get('iucn_source') == 'secondary':
            secondary.append(cid)
            level = record.get('check_level')
            check(isinstance(level, str) and '사람 확인 필요' in level,
                  f'{cid}: IUCN 2차 자료는 사람 확인 필요 표시가 있어야 합니다')
        if status in ('listed', 'not_listed', 'unresolved'):
            checked_on = record.get('cites_checked_on')
            valid_date = isinstance(checked_on, str) and bool(re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', checked_on))
            if valid_date:
                try:
                    datetime.date.fromisoformat(checked_on)
                except ValueError:
                    valid_date = False
            check(valid_date, f'{cid}: CITES 확인일은 유효한 YYYY-MM-DD 날짜여야 합니다')
            basis = record.get('cites_basis')
            check(isinstance(basis, str) and bool(basis.strip()), f'{cid}: CITES 확인 근거가 비어 있습니다')
        if status == 'unchecked':
            check(False, f'{cid}: CITES 확인 안 함(cites_status unchecked)')
        if status == 'unresolved':
            unresolved.append(cid)
    return unresolved, secondary


def check_character_regions(tables):
    """특성과 호환 값에 지역 식별자를 끼워 넣은 보너스 조건을 막는다."""
    forbidden = {city['id'].upper() for city in tables['world'].values()}
    forbidden.update(city['country_code'].upper() for city in tables['world'].values())
    forbidden.update(route_id.upper() for route_id in tables['routes'])

    def strings(value):
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for nested in value.values():
                yield from strings(nested)
        elif isinstance(value, list):
            for nested in value:
                yield from strings(nested)

    for character in tables['characters'].values():
        effect = character['signature_trait']['candidate_effect']
        values = [effect['trigger_tag'], effect['target_score'],
                  *strings(character['compatibility'])]
        for value in values:
            upper = value.upper()
            matches = ({upper} | set(upper.split('_'))) & forbidden
            check(not matches, character['id'] + ': 지역 보너스 금지: ' + ', '.join(sorted(matches)))


def check_motif_cautions(tables):
    """같은 동료의 주의 문장과 생김새 문구에 겹치는 금지어를 찾는다."""
    rows = read('tools/motif_forbidden_terms.json')['terms']
    terms = []
    for row in rows:
        term = row.get('term')
        valid = isinstance(term, str) and bool(term.strip())
        check(valid, '생김새 금지어 목록: term은 빈 문자열이 아닌 글자여야 합니다')
        if not valid:
            continue
        check(term not in terms, f'생김새 금지어 목록: term 중복 {term}')
        if term not in terms:
            terms.append(term)

    conflicts = []
    for character in tables['characters'].values():
        cautions = ' '.join(
            caution
            for key in ('myth_reference', 'conservation')
            for caution in ((character.get(key) or {}).get('design_cautions_ko') or []))
        fields = {
            'visual_motif': character.get('visual_motif') or '',
            'art_direction.card_pose_background':
                (character.get('art_direction') or {}).get('card_pose_background') or '',
        }
        for field, value in fields.items():
            fragments = [re.sub(r'[)\s]+$', '', fragment)
                         for fragment in re.split(r'[,.]', value)]
            positive = ' '.join(fragment for fragment in fragments
                                if not fragment.endswith(('없음', '없이')))
            for term in terms:
                if term in cautions and term in positive:
                    conflicts.append((character['id'], field, term))
    return conflicts


def validate_growth(rules, characters):
    """성장 자료와 엔진이 고정한 의미를 대조한다. 누락도 검사 실패로 보고한다."""
    level_min, level_max = rules.get('level_min'), rules.get('level_max')
    bounds_ok = (type(level_min) is int and type(level_max) is int
                 and 1 <= level_min <= level_max)
    check(bounds_ok, 'positive ordered level_min and level_max')
    thresholds = rules.get('xp_thresholds')
    thresholds_ok = isinstance(thresholds, list) and all(
        isinstance(t, dict) and type(t.get('level')) is int
        and type(t.get('cumulative_xp')) is int for t in thresholds)
    check(thresholds_ok, 'XP thresholds contain integer level and cumulative_xp')
    if thresholds_ok and bounds_ok:
        check(level_max == len(thresholds), 'level_max equals XP threshold count')
        check([t['level'] for t in thresholds] == list(range(level_min, level_max + 1)),
              'complete level_min-level_max thresholds')
        for t in thresholds:
            check(t['cumulative_xp'] == 50*(t['level']-1)*t['level'], 'XP threshold arithmetic')
        for cid, character in characters.items():
            xp = character.get('xp_total')
            check(type(xp) is int and xp >= 0, cid + ': nonnegative integer XP')
            if type(xp) is int:
                level = max([level_min] + [min(level_max, t['level']) for t in thresholds
                                           if xp >= t['cumulative_xp']])
                check(character.get('level') == level, cid + ': level matches XP')
    training = rules.get('ordinary_training')
    check(isinstance(training, dict), 'ordinary training definition exists')
    training = training if isinstance(training, dict) else {}
    fee = training.get('fee')
    fee = fee if isinstance(fee, dict) else {}
    for name, value in [('task_completion_xp', rules.get('task_completion_xp')),
                        ('duration_days', training.get('duration_days')),
                        ('fee.amount', fee.get('amount')),
                        ('xp_on_completion', training.get('xp_on_completion'))]:
        check(type(value) is int and value > 0, name + ': positive integer')
    check(fee.get('currency') == 'KRW', 'ordinary training fee uses KRW')
    check(training.get('occupies_employee_reservation') is True,
          'ordinary training occupies employee reservation')
    check(training.get('salary_included_in_fee') is False,
          'ordinary training fee excludes salary')


def resolve_scenario(scenarios, sid):
    """시나리오의 부모를 먼저 풀고 자식 값으로 덮는다."""
    scenario = scenarios[sid]
    base = resolve_scenario(scenarios, scenario['base_scenario_id']) if scenario.get('base_scenario_id') else {}
    return {**base, **scenario}


def validate_cancellation(scenarios, routes):
    """상속한 계약 조건을 포함해 모든 시나리오 노선의 고정 취소비를 검사한다."""
    for sid in scenarios:
        scenario = resolve_scenario(scenarios, sid)
        cancel = scenario.get('contract_terms', {}).get('pre_departure_cancellation')
        if cancel is None:
            continue
        fee = cancel['cancellation_fee']
        route_ids = scenario.get('route_ids', [scenario['route_id']] if 'route_id' in scenario else [])
        for rid in route_ids:
            freight = routes[rid]['booking_fee']
            check(fee['currency'] == freight['currency'], f'{sid}/{rid}: cancellation fee currency matches booking fee')
            check(fee['amount'] <= freight['amount'], f'{sid}/{rid}: cancellation fee <= booking fee')


def read(relative):
    return json.loads((ROOT / relative).read_text(encoding='utf-8'))


def shape(value, schema, path):
    types = schema.get('type', [])
    if isinstance(types, str):
        types = [types]
    predicates = {
        'object': lambda x: isinstance(x, dict),
        'array': lambda x: isinstance(x, list),
        'string': lambda x: isinstance(x, str),
        'boolean': lambda x: isinstance(x, bool),
        'integer': lambda x: isinstance(x, int) and not isinstance(x, bool),
        'number': lambda x: isinstance(x, (int, float)) and not isinstance(x, bool),
        'null': lambda x: x is None,
    }
    correct = not types or any(predicates[t](value) for t in types)
    check(correct, f'{path}: type {types}')
    if not correct:
        return
    if 'enum' in schema:
        check(value in schema['enum'], f'{path}: enum')
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 'minimum' in schema:
            check(value >= schema['minimum'], f'{path}: minimum')
        if 'maximum' in schema:
            check(value <= schema['maximum'], f'{path}: maximum')
    if isinstance(value, dict):
        for key in schema.get('required', []):
            check(key in value, f'{path}: missing {key}')
        for key, item in value.items():
            if key in schema.get('properties', {}):
                shape(item, schema['properties'][key], f'{path}/{key}')
            elif schema.get('additionalProperties') is False:
                check(False, f'{path}: unexpected {key}')
    if isinstance(value, list):
        if 'minItems' in schema:
            check(len(value) >= schema['minItems'], f'{path}: minItems')
        if schema.get('uniqueItems'):
            check(all(item not in value[:i] for i, item in enumerate(value)), f'{path}: uniqueItems')
    if isinstance(value, list) and 'items' in schema:
        for index, item in enumerate(value):
            shape(item, schema['items'], f'{path}/{index}')


def walk(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def index(items, label):
    ids = [item['id'] for item in items]
    check(len(ids) == len(set(ids)), f'{label}: duplicate IDs')
    return {item['id']: item for item in items}


def sailing_day(route, sailing_id):
    prefix = route['id'] + '-D'
    check(sailing_id.startswith(prefix), sailing_id + ': sailing belongs to route ' + route['id'])
    day = int(sailing_id[len(prefix):])
    check(day >= route['first_departure_day']
          and (day - route['first_departure_day']) % route['departure_interval_days'] == 0,
          sailing_id + ': sailing exists in the schedule')
    return day


def check_culture(tables, cases, payroll_currency, home_city_id):
    """활동의 장소·인물·비용·출처 범위와 엔진 인수 명세 연결을 확인한다."""
    scenario = tables['scenarios']['SCENARIO_M2_MULTI_TRADE']
    block = scenario.get('culture')
    check(scenario.get('culture_enabled') is True and isinstance(block, dict), 'M2 문화 활동 블록·활성화 필요')
    ids = block.get('activity_ids', []) if isinstance(block, dict) else []
    check(ids == ['CA01', 'CA02', 'CA03'], 'M2 문화 활동은 CA01~03 순서')
    for sid in tables['scenarios']:
        item = resolve_scenario(tables['scenarios'], sid)
        if 'culture' in item:
            check(item.get('culture_enabled') is True, item['id'] + ': culture 블록은 culture_enabled 필요')
    known = {'company_id', 'actor_id', 'contact_id', 'activity_id', 'city_id', 'content_revision'}
    for activity in tables['culture_activities'].values():
        aid = activity['id']
        venue = tables['venues'].get(activity.get('venue_id'), {})
        check(activity.get('city_id') == venue.get('city_id'), aid + ': 활동·장소 도시 불일치')
        check(aid in venue.get('activity_ids', []), aid + ': 장소 역방향 활동 연결 누락')
        for cid in activity.get('contact_ids', []):
            check(aid in tables['contacts'].get(cid, {}).get('activity_ids', []), aid + ': 인물 역방향 활동 연결 누락')
        check(activity.get('money_cost', {}).get('currency') == payroll_currency, aid + ': 현지 활동비는 급여 통화(KRW) 필요')
        for field, required, forbidden in (
            ('completion_dedupe_key_template', {'company_id'}, {'actor_id', 'contact_id'}),
            ('actor_experience_dedupe_key_template', {'actor_id'}, {'contact_id'}),
            ('relationship_dedupe_key_template', {'actor_id', 'contact_id'}, set()),
        ):
            template = activity.get(field, '')
            slots = re.findall(r'\{([^{}]*)\}', template)
            check(required <= set(slots) and not (forbidden & set(slots)), aid + ': ' + field + ' 필수·금지 키 자리 오류')
            residue = re.sub(r'\{[^{}]*\}', '', template)
            check(bool(slots) and set(slots) <= known and not re.search(r'[{}]', residue), aid + ': 알 수 없는 키 자리')
    for aid in ids:
        activity = tables['culture_activities'].get(aid)
        check(activity is not None, str(aid) + ': 활동 없음')
        if activity is None:
            continue
        check(activity.get('stage') == 'P0', aid + ': P0 활동 필요')
        check(activity.get('city_id') in scenario.get('city_ids', []), aid + ': 시나리오 도시 필요')
        cost = activity.get('money_cost', {})
        check(cost.get('currency') in scenario.get('starting_cash', {}), aid + ': 시작 자금 통화 필요')
        check(type(cost.get('amount')) is int and cost['amount'] > 0, aid + ': 활동 비용 양의 정수 필요')
        report = activity.get('report_ko')
        report = report if isinstance(report, dict) else {}
        for field in ('finding_ko', 'scope_ko', 'not_claimed_ko', 'open_question_ko'):
            check(isinstance(report.get(field), str) and bool(report[field].strip()), aid + ': report_ko.' + field + ' 필요')
        finding = report.get('finding_ko', '')
        if isinstance(finding, str):
            finding = ''.join(c for c in finding if unicodedata.category(c) != 'Cf')
            finding = unicodedata.normalize('NFC', finding)
            for noun in GENERALIZATION_PROPER_NOUNS:
                finding = finding.replace(noun, ' ')
            for word in ('부산 사람', '부산 시민', '평택 사람', '평택 시민', '한국인', '한국 사람', '한국 소비자', '국민', '상인들은'):
                check(re.search(r'\s*'.join(map(re.escape, word.split(' '))), finding) is None, aid + ': finding_ko 일반화 금지어 ' + word)
    case_map = {c['id']: c for c in cases}
    mapping = {'ACT_A': 'CA01', 'CONTACT_A': 'NPC_MARKET', 'CONTACT_B': 'NPC_GUIDE',
               'EMPLOYEE_A': 'EMP01', 'EMPLOYEE_B': 'EMP02', 'CITY_HOME': home_city_id, 'CITY_REMOTE': 'SHANGHAI'}
    for cid in ('P0-CITY-01', 'P0-CITY-02', 'P0-CITY-03', 'P0-CITY-04'):
        case = case_map.get(cid, {})
        check(case.get('scenario_id') == 'SCENARIO_M2_MULTI_TRADE', cid + ': M2 시나리오 연결 필요')
        check(isinstance(case.get('engine_test_ref'), str), cid + ': 문화 엔진 시험 연결 필요')
        check(case.get('engine_fixture_mapping') == mapping, cid + ': 구체 활동·인물·직원·도시 대응 필요')
        note = case.get('engine_mapping_note_ko', '')
        check('20,000원·1일' in note and '두 실행의 원화 현금 차이 20,000원' in note and '시험 전용 합성 활동' in note,
              cid + ': 원화 차이·합성 활동 설명 필요')
    check(any(item.get('status') == '미실행 단언' and '퇴사' in item.get('assertion', '')
              for item in case_map.get('P0-CITY-03', {}).get('unexecuted_assertions', [])), 'P0-CITY-03: 퇴사 미실행 표시 필요')


def check_m2a(tables):
    """Reference arithmetic for SCENARIO_M2_MULTI_TRADE (DESIGN). The engine tests replay the same paths."""
    scenario = tables['scenarios']['SCENARIO_M2_MULTI_TRADE']
    offers, goods, routes = tables['market_offers'], tables['goods'], tables['routes']
    terms = scenario['contract_terms']
    rate = scenario['tax_rule']['rate']
    late_cut = terms['late_delivery']['price_reduction']['amount']
    opening = scenario['starting_cash']['USD']
    check(scenario['engine_rules']['funds_check'] == 'committed_outlays'
          and scenario['engine_rules']['forwarding_enabled'] is True, 'M2a rule set explicit')
    check(set(scenario['offer_ids']) <= set(offers), 'M2a offers exist')
    check_recruitment(tables)

    def route_between(origin, destination):
        found = [r for r in routes.values() if r['id'] in scenario['route_ids']
                 and r['from_city_id'] == origin and r['to_city_id'] == destination]
        check(len(found) == 1, f'M2a: one scenario route {origin}->{destination}')
        return found[0]

    def space(offer):
        good = goods[offer['good_id']]
        return offer['quantity'] * good['mass_kg_per_unit'], round(offer['quantity'] * good['volume_m3_per_unit'], 6)

    def trade_numbers(buy_id, sell_id):
        buy, sell = offers[buy_id], offers[sell_id]
        check(buy['kind'] == 'supplier' and sell['kind'] == 'customer' and buy['good_id'] == sell['good_id']
              and buy['quantity'] == sell['quantity'], f'M2a trade pair {buy_id}+{sell_id}')
        route = route_between(buy['city_id'], sell['city_id'])
        purchase = buy['quantity'] * buy['unit_price']['amount']
        sale = sell['quantity'] * sell['unit_price']['amount']
        duty = round(purchase * rate)
        return route, purchase, sale, route['booking_fee']['amount'], duty

    for path in scenario['expected_paths_usd']:
        pid = path['id']
        cash, reserved = opening, 0
        goods_revenue = cogs = fwd_revenue = fwd_cost = 0
        load = {}
        for buy_id, sell_id in path['trades']:
            route, purchase, sale, freight, duty = trade_numbers(buy_id, sell_id)
            sailing = path['sailing_by_offer'][buy_id]
            day = sailing_day(route, sailing)
            arrival = day + route['transit_days'] + scenario['customs_days']
            net = sale - (late_cut if arrival > offers[sell_id]['delivery_deadline_day'] else 0)
            cash -= purchase + freight
            reserved += duty
            goods_revenue += net
            cogs += purchase + freight + duty
            kg, m3 = space(offers[buy_id])
            load.setdefault(sailing, [route, 0, 0])
            load[sailing][1] += kg
            load[sailing][2] += m3
        for oid in path['forwarding_offer_ids']:
            offer = offers[oid]
            route = route_between(offer['city_id'], offer['destination_city_id'])
            sailing = path['sailing_by_offer'][oid]
            day = sailing_day(route, sailing)
            arrival = day + route['transit_days'] + scenario['customs_days']
            fee = offer['service_fee']['amount']
            net = fee - (late_cut if arrival > offer['delivery_deadline_day'] else 0)
            cash -= route['booking_fee']['amount']
            fwd_revenue += net
            fwd_cost += route['booking_fee']['amount']
            kg, m3 = space(offer)
            load.setdefault(sailing, [route, 0, 0])
            load[sailing][1] += kg
            load[sailing][2] += m3
        check(cash == path['cash_after_day1'], pid + ': cash after day-1 purchases and bookings')
        check(reserved == path['reserved_after_day1'], pid + ': duty still reserved after day 1')
        check(cash - reserved == path['available_after_day1'], pid + ': available cash after day 1')
        check(cash - reserved >= 0, pid + ': path is affordable')
        for sailing, (route, kg, m3) in load.items():
            check(kg <= route['capacity_kg'] and m3 <= route['capacity_m3'], pid + ': ' + sailing + ' within capacity')
        contribution = goods_revenue - cogs + fwd_revenue - fwd_cost
        check([goods_revenue, cogs, fwd_revenue, fwd_cost] ==
              [path['goods_revenue'], path['cost_of_goods_sold'], path['forwarding_revenue'], path['forwarding_cost']],
              pid + ': revenue and cost lines')
        check(contribution == path['contribution'] and opening + contribution == path['cash_final'],
              pid + ': contribution and final cash')
        last_due = max(offers[s]['payment_due_day'] for _, s in path['trades'])
        last_due = max([last_due] + [offers[o]['payment_due_day'] for o in path['forwarding_offer_ids']])
        check(path['final_day'] == last_due, pid + ': final day is the last payment day')

    rejections = {r['id']: r for r in scenario['expected_rejections']}
    r = rejections['REJECT_SECOND_DIRECT_TRADE']
    _, p1, _, f1, d1 = trade_numbers(*r['first_trade'])
    _, p2, _, f2, d2 = trade_numbers(*r['second_trade'])
    check(opening - p1 == r['cash_after_first'] and f1 + d1 == r['reserved_after_first']
          and opening - p1 - f1 - d1 == r['available_after_first'] and p2 + f2 + d2 == r['needed_for_second'],
          'M2a funds reservation arithmetic')
    check(r['cash_after_first'] >= p2 > r['available_after_first'],
          'M2a: second purchase is payable from cash but not from available funds')
    r = rejections['REJECT_FORWARDING_SAME_SAILING']
    route = next(x for x in routes.values() if r['sailing_id'].startswith(x['id'] + '-D'))
    sailing_day(route, r['sailing_id'])
    v1, v2 = (space(offers[o])[1] for o in ('OFFER_FWD_01', 'OFFER_FWD_02'))
    k1, k2 = (space(offers[o])[0] for o in ('OFFER_FWD_01', 'OFFER_FWD_02'))
    check([v1, v2, route['capacity_m3']] == [r['volume_m3_first'], r['volume_m3_second'], r['capacity_m3']],
          'M2a space fixture volumes')
    check(v1 <= route['capacity_m3'] and v2 <= route['capacity_m3'] < v1 + v2 and k1 + k2 <= route['capacity_kg'],
          'M2a: each cargo fits alone, both together exceed volume only')

    cases = {c['id']: c for c in read('tests/acceptance_cases.json')['cases']}
    rej = rejections['REJECT_SECOND_DIRECT_TRADE']
    e1 = cases['P0-M2A-01']['expected_numeric']
    check([e1['opening_cash'], e1['cash_after_first'], e1['reserved_after_first'], e1['available_after_first'], e1['needed_for_second']]
          == [opening, rej['cash_after_first'], rej['reserved_after_first'], rej['available_after_first'], rej['needed_for_second']],
          'P0-M2A-01 matches scenario fixture')
    path = next(p for p in scenario['expected_paths_usd'] if p['id'] == 'PATH_COSMETICS_AND_FORWARDING')
    e2 = cases['P0-M2A-02']['expected_numeric']
    check([e2['cash_after_day1'], e2['reserved_after_day1'], e2['goods_revenue'], e2['cost_of_goods_sold'],
           e2['forwarding_revenue'], e2['forwarding_cost'], e2['contribution'], e2['cash_final_day17']]
          == [path['cash_after_day1'], path['reserved_after_day1'], path['goods_revenue'], path['cost_of_goods_sold'],
              path['forwarding_revenue'], path['forwarding_cost'], path['contribution'], path['cash_final']],
          'P0-M2A-02 matches scenario fixture')
    e3 = cases['P0-M2A-03']['expected_numeric']
    space_rej = rejections['REJECT_FORWARDING_SAME_SAILING']
    check([e3['capacity_m3'], e3['volume_m3_first'], e3['volume_m3_second']]
          == [space_rej['capacity_m3'], space_rej['volume_m3_first'], space_rej['volume_m3_second']]
          and e3['cash_after_day1'] == opening - routes['ROUTE01']['booking_fee']['amount']
          and e3['reserved_after_day1'] == routes['ROUTE01']['booking_fee']['amount'],
          'P0-M2A-03 matches scenario fixture')
    e4 = cases['P0-M2A-04']['expected_numeric']
    wage = tables['employees']['EMP04']['salary_per_day']['amount']
    signing_days = (scenario.get('recruitment') or {}).get('signing_fee_wage_days')
    valid_signing_days = type(signing_days) is int
    check(valid_signing_days, 'M2a: signing_fee_wage_days는 정수여야 합니다')
    check(valid_signing_days and e4['signing_fee'] == wage * signing_days
          and e4['daily_wage'] == wage
          and e4['employed_after_discovery'] == len(scenario['employee_ids'])
          and e4['available_from_day'] == e4['hired_day'] + 1,
          'P0-M2A-04: 계약금·기존 인원·근무 시작일 검산')
    for rid in scenario['route_ids']:
        points = routes[rid]['map_waypoints']['points']
        for end, city_id in ((points[0], routes[rid]['from_city_id']), (points[-1], routes[rid]['to_city_id'])):
            geo = tables['world'][city_id]['geo_position']
            check(abs(end['lat'] - geo['lat']) <= 0.2 and abs(end['lon'] - geo['lon']) <= 0.2,
                  rid + ' map waypoints start and end at their ports')


def check_recruitment(tables):
    """영입 블록이 있는 시나리오의 후보·조사 장소·작업량을 검증한다."""
    for scenario in tables['scenarios'].values():
        recruitment = scenario.get('recruitment')
        if recruitment is None:
            continue
        label = scenario['id'] + ': 영입 '
        for key in ('data_basis', 'status', 'decision_ref', 'candidate_employee_ids',
                    'scout_sites', 'scout_work_units', 'quest_work_units', 'signing_fee_wage_days'):
            check(key in recruitment, label + key + ' 필수 키')
        candidates = recruitment.get('candidate_employee_ids', [])
        sites = recruitment.get('scout_sites', [])
        for site in sites:
            for key in ('venue_id', 'city_id', 'candidate_employee_ids'):
                check(key in site, label + '장소 ' + key + ' 필수 키')
        check(bool(candidates) and len(candidates) == len(set(candidates)), label + '후보 목록 중복 없음')
        check(len({s.get('venue_id') for s in sites}) == len(sites), label + '장소 중복 없음')
        for key in ('scout_work_units', 'quest_work_units', 'signing_fee_wage_days'):
            value = recruitment.get(key)
            check(type(value) is int and value > 0, label + key + ' 양의 정수')
        for cid in candidates:
            employee = tables['employees'].get(cid)
            check(employee is not None, label + cid + ' 직원 정의 존재')
            if employee is None:
                continue
            character = tables['characters'].get(employee['character_id'])
            check(employee['employment_status'] == 'candidate', label + cid + ' 후보 상태')
            check(character is not None and character['recruitment']['start_employed'] is False,
                  label + cid + ' 처음에는 미고용')
            check(cid not in scenario.get('employee_ids', []), label + cid + ' 시작 직원과 분리')
            check(sum(s.get('candidate_employee_ids', []).count(cid) for s in sites) == 1,
                  label + cid + ' 조사 장소 정확히 하나')
        for site in sites:
            venue = tables['venues'].get(site.get('venue_id'))
            check(venue is not None, label + str(site.get('venue_id')) + ' 장소 존재')
            check(venue is not None and venue['city_id'] == site.get('city_id'), label + '장소 도시 일치')
            check(bool(site.get('candidate_employee_ids', [])), label + '장소에 후보 존재')
            for cid in site.get('candidate_employee_ids', []):
                check(cid in candidates, label + cid + ' 시나리오 후보에 포함')
                employee = tables['employees'].get(cid)
                character = tables['characters'].get(employee['character_id']) if employee else None
                check(character is not None and site.get('city_id') == character['encounter']['city_id'],
                      label + cid + ' 만남 도시 일치')


def check_home_city(config, world):
    """본사의 존재와 다른 거점 사실이 섞이지 않았는지 확인한다."""
    home_id = config.get('home_city_id')
    check(home_id in world, '본사: home_city_id가 world에 있어야 합니다')
    if home_id not in world:
        return
    home = world[home_id]
    check('HOME_BASE' in home.get('hub_roles', []), '본사: HOME_BASE 역할 필요')
    # 다른 거점 설명문의 비율 수치(예: 부산 환적 57%)도 본사 항목에 옮겨 오지 않는다.
    # 순위(N위)는 거점마다 겹치므로(평택 4위·상하이 4위) 비율만 거점 자료에서 읽는다.
    other_shares = {share for cid, city in world.items() if cid != home_id
                    for share in re.findall(r'\d+(?:\.\d+)?%', city.get('hub_note_ko', ''))}
    text = json.dumps(home, ensure_ascii=False)
    for word in ('7위', '환적 화물', 'TRANSSHIPMENT', *sorted(other_shares)):
        check(word not in text, '본사: 다른 거점 고유 문구 ' + word)


def check_route_schedules(routes, source_ids):
    """요일표의 달력 날짜 차이와 출처 연결을 검증한다. 허용 오차로 일수를 보정하지 않는다."""
    weekdays = {day: i for i, day in enumerate(('월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'))}
    for rid, route in routes.items():
        if 'schedule_basis' not in route:
            continue
        basis = route['schedule_basis']
        if not isinstance(basis, dict):
            check(False, rid + ': schedule_basis 객체 필요')
            continue
        departure, arrival = basis.get('departure_weekday'), basis.get('arrival_weekday')
        valid = isinstance(departure, str) and isinstance(arrival, str) and departure in weekdays and arrival in weekdays
        check(valid, rid + ': 출항·접안 요일 필요')
        if valid:
            check(route.get('transit_days') == (weekdays[arrival] - weekdays[departure]) % 7,
                  rid + ': 운송일수와 요일 차이 불일치')
        refs = basis.get('source_refs')
        check(isinstance(refs, list) and bool(refs), rid + ': 요일표 출처 필요')
        if isinstance(refs, list):
            for ref in refs:
                check(isinstance(ref, str) and ref in source_ids, rid + ': 요일표 출처 없음 ' + str(ref))


def check_world_hubs(documents, tables, source_ids):
    """World hubs (user decision 2026-10-05): real logistics and trade-finance centres, opened by chapter."""
    world = tables['world']
    stage_order = {'M1': 1, 'M2': 2, 'M3': 3, 'P1': 4}
    selection_roles = {'CONTAINER_GATEWAY', 'TRANSSHIPMENT_HUB', 'FINANCE_CENTER', 'MARITIME_SERVICES',
                       'SHIPOWNING_CLUSTER', 'REGIONAL_GATEWAY'}
    for city in world.values():
        cid = city['id']
        check(bool(city.get('hub_roles')), cid + ': hub roles')
        check('availability' in city and 'geo_position' in city, cid + ': availability and map position')
        for item in city.get('selection_basis', []):
            check(item['source_id'] in source_ids, cid + ': selection basis source ' + item['source_id'])
        if set(city.get('hub_roles', [])) & selection_roles and not ({'PRODUCTION_ORIGIN', 'HOME_BASE'} & set(city.get('hub_roles', []))):
            check(len(city.get('selection_basis', [])) >= 1, cid + ': hub chosen by a cited indicator')
        if city.get('availability', {}).get('status') == 'MAP_PREVIEW':
            check(city['venue_ids'] == [] and city['availability']['stage'] == 'P1',
                  cid + ': preview hubs have no playable content yet')
    for scenario in tables['scenarios'].values():
        stage = stage_order.get(scenario['stage'])
        for city_id in scenario.get('city_ids', []):
            avail = world[city_id]['availability']
            check(stage is None or stage_order[avail['stage']] <= stage,
                  f"{scenario['id']}: {city_id} opens no later than the scenario stage")
            check(avail['status'] != 'MAP_PREVIEW', f"{scenario['id']}: {city_id} is playable or planned")
    gates = documents['world'].get('sea_gates', [])
    index(gates, 'sea gates')
    check(len(gates) == 6, 'sea gates: expected 6')
    for gate in gates:
        check(gate['geo_position']['use'] == 'map_display_only', gate['id'] + ': display-only gate position')
    check(sum(c['availability']['chapter'] == 1 for c in world.values()) == 7, 'chapter 1 keeps the 7 East Asian hubs')


TEST_CALL = r'(?<![\w.$])(?:describe|it|test)\(\s*'
TODO_CALL = r'(?<![\w.$])(?:it|test)\.todo\(\s*'
GENERALIZATION_PROPER_NOUNS = ('부산시민공원', '한국소비자원', '국민연금')
# 미해결 쌍 목록. TASK-0021 표 C의 7쌍은 W2-0b(2026-10-09)에서 정리해 비었다.
# 3쌍은 extension_curriculum_refs로 옮기고 4쌍은 뺐다. 새 쌍은 원문을 대조한 뒤에만 더한다.
PENDING_P0_CURRICULUM_LINKS = frozenset()
ACHIEVEMENT_CODE = re.compile(r'^\[(10|12)[가-힣]+(?:[12]-[0-9]{2}|[0-9]{2})-[0-9]{2}\]$')
VOCATIONAL_ACHIEVEMENT_CODE = re.compile(r'^\[[가-힣]{2} [0-9]{2}-[0-9]{2}-[0-9]{2}\]$')
ACHIEVEMENT_BASIS = ('직접', '해설', '영역')


_TOKENS = re.compile(r"""('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|//[^\n]*|/\*.*?\*/""", re.S)


def strip_comments(text):
    """문자열은 그대로 두고, // 줄 주석과 /* */ 묶음 주석을 나타난 순서대로 지운다. 정규식 리터럴은 구분하지 않는다."""
    return _TOKENS.sub(lambda m: m.group(1) if m.group(1) is not None else ' ', text)


def has_title(text, name, call=TEST_CALL):
    text = strip_comments(text)
    return any(re.search(call + re.escape(q + name + q), text) for q in ("'", '"', '`'))


def check_test_refs(cases, root=ROOT):
    """연결한 파일과 고정 제목의 존재만 확인하며 시험을 실행하지 않는다."""
    for case in cases:
        cid = case['id']
        check('engine_test_ref' in case, f'{cid}: engine_test_ref 키 필요')
        if case.get('engine_test_ref') is None:
            reason = case.get('unlinked_reason_ko')
            check(isinstance(reason, str) and bool(reason.strip()), f'{cid}: 연결 없는 사례는 unlinked_reason_ko 필요')
            check(not case.get('engine_test_names'), f'{cid}: 연결 없는 사례에 engine_test_names가 남음')
        check(('ui_test_ref' in case) == ('ui_test_names' in case), f'{cid}: ui_test_ref와 ui_test_names는 함께 필요')
        texts = {}
        for kind in ('engine', 'ui'):
            path = case.get(f'{kind}_test_ref')
            if path is None and kind == 'engine':
                continue
            if kind == 'ui' and 'ui_test_ref' not in case:
                continue
            valid_path = (isinstance(path, str) and path.startswith('src/') and path.endswith('.test.ts')
                          and '..' not in path and not Path(path).is_absolute())
            check(valid_path, f'{cid}: {kind}_test_ref 경로 형식 오류 {path}')
            if valid_path:
                file = root / path
                check(file.is_file(), f'{cid}: {kind}_test_ref 파일 없음 {path}')
                if file.is_file():
                    texts[kind] = file.read_text(encoding='utf-8')
            names = case.get(f'{kind}_test_names')
            valid_names = isinstance(names, list) and bool(names) and all(isinstance(n, str) for n in names)
            check(valid_names, f'{cid}: {kind}_test_names 필요')
            if valid_names:
                for name in names:
                    check('${' not in name, f'{cid}: {kind} 시험 이름은 고정 문자열이어야 함 {name}')
                    check(has_title(texts.get(kind, ''), name), f'{cid}: {kind} 시험 이름 없음 {name}')
                check(any(cid in name for name in names), f'{cid}: {kind}_test_names에 사례 ID가 든 이름 필요')
        for assertion in case.get('unexecuted_assertions', []):
            if 'todo_test_name' in assertion:
                name = assertion['todo_test_name']
                check(isinstance(name, str) and has_title(texts.get('engine', ''), name, TODO_CALL),
                      f'{cid}: 미실행 단언의 할 일 시험 없음 {name}')


def linked_count(cases, kind):
    return sum(isinstance(c.get(f'{kind}_test_ref'), str) for c in cases)


def valid_date(value):
    """ASCII 숫자 YYYY-MM-DD이고 달력에 있는 날짜인지 본다."""
    if not isinstance(value, str) or re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value) is None:
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def check_acceptance_summary(acceptance, character_doc):
    cases, items = acceptance['cases'], character_doc['items']
    summary = acceptance.get('review_summary', {})
    for kind in ('engine', 'ui'):
        check(summary.get(f'{kind}_linked_case_count') == linked_count(cases, kind),
              f'review_summary {kind}_linked_case_count matches cases')
        check(character_doc.get('summary', {}).get(f'{kind}_linked_case_count') == linked_count(items, kind),
              f'character summary {kind}_linked_case_count matches items')
    check(character_doc.get('summary', {}).get('case_count') == len(items), 'character summary case_count matches items')
    for doc, records, message in ((acceptance, cases, 'acceptance status matches linked cases'),
                                  (character_doc, items, 'character status matches linked items')):
        if 0 < linked_count(records, 'engine') < len(records):
            check(doc.get('status') == 'PARTIALLY_LINKED_TO_ENGINE_TESTS', message)
    check(summary.get('engine_test_pass_claim') is False, 'acceptance file makes no engine pass claim')
    for case in items:
        linked = isinstance(case.get('engine_test_ref'), str)
        expected = 'EXECUTABLE_ENGINE_TEST_LINKED' if linked else 'SPECIFICATION_NOT_EXECUTED'
        check(case.get('status') == expected, case['id'] + ': status와 engine_test_ref 연결 불일치')
    records = acceptance.get('human_review_records')
    check(isinstance(records, list), 'human_review_records 목록 필요')
    if not isinstance(records, list):
        return
    ids = {c['id'] for c in cases}
    fields = {'case_id', 'reviewed_on', 'reviewer_ko', 'result', 'note_ko'}
    for i, record in enumerate(records):
        record = record if isinstance(record, dict) else {}
        for key in sorted(set(record) - fields):
            check(False, f'사람 검토 기록 {i}: 알 수 없는 키 {key}')
        cid = record.get('case_id')
        check(isinstance(cid, str) and cid in ids, f'사람 검토 기록 {i}: 없는 사례 {cid}')
        predicates = {
            'reviewed_on': valid_date,
            'reviewer_ko': lambda v: isinstance(v, str) and bool(v.strip()),
            'result': lambda v: v in ('일치', '불일치'),
            'note_ko': lambda v: isinstance(v, str),
        }
        for field, predicate in predicates.items():
            check(predicate(record.get(field)), f'사람 검토 기록 {i}: {field} 오류')


def check_organization_names(character_cases, organization_doc):
    departments = {d['id']: d['name_ko'] for d in organization_doc['departments']}
    teams = {t['name_ko']: t for t in organization_doc['items']}
    for case in character_cases:
        cid = case['id']
        for field in ('setup', 'expected'):
            obj = case.get(field)
            if not isinstance(obj, dict):
                continue
            dept, team = obj.get('department'), obj.get('permanent_team')
            if 'department' in obj:
                check(dept in departments.values(), f'{cid}: organization.json에 없는 부서 이름 {dept}')
            if 'permanent_team' in obj:
                check(isinstance(team, str) and team in teams, f'{cid}: organization.json에 없는 팀 이름 {team}')
            if 'department' in obj and isinstance(team, str) and team in teams:
                check(departments.get(teams[team]['department_id']) == dept, f'{cid}: 팀과 부서 불일치 {team}/{dept}')


def string_values(value):
    """객체의 키를 제외한 모든 문자열 값을 걷는다."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from string_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from string_values(item)


def source_usage(documents, root=ROOT):
    sources = documents['sources']['items']
    usage = {s['id']: set() for s in sources}
    data_values = {v for name, doc in documents.items() if name != 'sources' for v in string_values(doc)}
    reference_values = {v for file in (root / 'references').glob('*.json')
                        for v in string_values(json.loads(file.read_text(encoding='utf-8')))}
    design_file = root / 'docs/DESIGN_v0.4.md'
    design = design_file.read_text(encoding='utf-8') if design_file.is_file() else ''
    for source in sources:
        sid = source['id']
        if sid in data_values:
            usage[sid].add('data')
        if sid in reference_values or source.get('url') in reference_values:
            usage[sid].add('references')
        if re.search(r'\[' + re.escape(sid) + r'(?:\]|,)', design):
            usage[sid].add('design')
    return usage


def check_sources(documents, root=ROOT):
    usage = source_usage(documents, root)
    for source in documents['sources']['items']:
        sid = source['id']
        path = source.get('local_path')
        if isinstance(path, str):
            # 저장소 기준 상대 경로만 받는다. 절대 경로와 '..'는 root 밖을 가리킬 수 있다.
            inside = not Path(path).is_absolute() and '..' not in Path(path).parts
            check(inside and (root / path).is_file(), f'{sid}: local_path 파일 없음 {path}')
        if not usage[sid]:
            reason = source.get('unreferenced_reason_ko')
            check(isinstance(reason, str) and bool(reason.strip()), f'{sid}: 쓰이지 않는 출처는 unreferenced_reason_ko 필요')
        else:
            check('unreferenced_reason_ko' not in source, f'{sid}: 쓰이는 출처에 unreferenced_reason_ko가 남음')
        for target in source.get('superseded_by', []):
            check(target in usage, f'{sid}: superseded_by에 없는 출처 {target}')
            if target in usage:
                check(bool(usage[target]), f'{sid}: superseded_by의 출처도 쓰이지 않음 {target}')


def check_curriculum_stages(documents, curriculum, pending=PENDING_P0_CURRICULUM_LINKS):
    found = set()
    for file, doc in documents.items():
        if file == 'curriculum_links':
            continue
        for obj in walk(doc):
            if obj.get('stage') != 'P0':
                continue
            for ref in obj.get('curriculum_refs', []):
                if ref not in curriculum:
                    continue
                if not any(label.startswith('P0') for label in curriculum[ref].get('priority', [])):
                    oid = obj.get('id')
                    pair = (file, oid, ref)
                    check(pair in pending, f'{file}/{oid}: P0 항목이 P0 표지 없는 교과 연결을 가리킴 {ref}')
                    if pair in pending:
                        found.add(pair)
    for file, oid, ref in sorted(pending - found):
        check(False, f'교과 연결 미해결 목록이 낡음 {file}/{oid} {ref}')
    return found


def check_extension_curriculum_refs(documents, curriculum):
    """P1 확장 연결: P0 표지가 없고, 같은 연결을 다루는 P1 이상 항목이 있어야 한다."""
    covered = set()
    for file, doc in documents.items():
        if file == 'curriculum_links':
            continue
        for obj in walk(doc):
            if obj.get('stage') not in (None, 'P0'):
                covered.update(obj.get('curriculum_refs', []))
    for file, doc in documents.items():
        if file == 'curriculum_links':
            continue
        for obj in walk(doc):
            refs = obj.get('extension_curriculum_refs')
            if refs is None:
                continue
            oid = obj.get('id')
            if not (isinstance(refs, list) and refs and all(isinstance(r, str) for r in refs)):
                check(False, f'{file}/{oid}: extension_curriculum_refs 형식 오류')
                continue
            for ref in refs:
                if ref not in curriculum:
                    check(False, f'{file}/{oid}: 없는 확장 교과 연결 {ref}')
                    continue
                check(not any(label.startswith('P0') for label in curriculum[ref].get('priority', [])),
                      f'{file}/{oid}: P0 표지 연결은 curriculum_refs에 둔다 {ref}')
                check(ref not in obj.get('curriculum_refs', []),
                      f'{file}/{oid}: 같은 연결이 curriculum_refs와 extension_curriculum_refs에 함께 있음 {ref}')
                check(ref in covered, f'{file}/{oid}: 확장 교과 연결을 다루는 P1 이상 항목이 없음 {ref}')


def check_achievement_standards(curriculum_doc, curriculum, source_ids):
    """성취기준 코드·문장 칸의 형식. 원문 대조는 하지 않는다(원문은 저장소에 없다)."""
    if curriculum_doc.get('scope', {}).get('achievement_standard_codes_included') is not True:
        return
    sentences = {}
    for cid, link in curriculum.items():
        standards = link.get('achievement_standards')
        if not (isinstance(standards, list) and standards):
            check(False, f'{cid}: achievement_standards 필요')
            continue
        check(link.get('achievement_standards_source_id') in source_ids, f'{cid}: 성취기준 출처 없음')
        grade = '10' if link.get('selection') == 'common' else '12'
        pattern = VOCATIONAL_ACHIEVEMENT_CODE if link.get('group') == 'vocational' else ACHIEVEMENT_CODE
        codes = []
        for item in standards:
            code = item.get('code') if isinstance(item, dict) else None
            item = item if isinstance(item, dict) else {}
            check(isinstance(code, str) and pattern.fullmatch(code) is not None, f'{cid}: 성취기준 코드 형식 오류 {code}')
            if link.get('group') != 'vocational' and isinstance(code, str) and pattern.fullmatch(code):
                check(code[1:3] == grade, f'{cid}: 성취기준 학년 머리와 selection 불일치 {code}')
            check(item.get('basis') in ACHIEVEMENT_BASIS, f'{cid}: 성취기준 근거 종류 오류 {code}')
            for field in ('sentence_ko', 'keyword_ko'):
                check(isinstance(item.get(field), str) and bool(item[field].strip()), f'{cid}: 성취기준 {field} 필요 {code}')
            codes.append(code)
            sentence = item.get('sentence_ko')
            if isinstance(code, str) and isinstance(sentence, str):
                check(sentences.setdefault(code, sentence) == sentence, f'{cid}: 같은 성취기준 코드의 문장이 다름 {code}')
        check(len(codes) == len(set(codes)), f'{cid}: 성취기준 코드 중복')


def check_curriculum_counts(curriculum_doc, curriculum):
    counts = curriculum_doc.get('counts', {})
    check(counts.get('total') == len(curriculum), 'curriculum: counts.total 불일치')
    for field in ('group', 'selection'):
        actual = {}
        for item in curriculum.values():
            value = item[field]
            actual[value] = actual.get(value, 0) + 1
        expected = counts.get('by_' + field, {})
        for value in sorted(set(actual) | set(expected)):
            check(expected.get(value) == actual.get(value, 0), f'curriculum: counts.by_{field}.{value} 불일치')
    prefixes = {'social': 'SOC', 'ethics': 'ETH', 'science': 'SCI', 'vocational': 'VOC'}
    for cid, item in curriculum.items():
        selections = ('major_general', 'major_practice') if item.get('group') == 'vocational' else ('common', 'general', 'career')
        check(item.get('selection') in selections, f'{cid}: selection과 group 불일치')
        prefix = prefixes.get(item.get('group'))
        check(prefix is not None and cid.startswith(prefix), f'{cid}: 연결 ID 머리와 group 불일치')


def check_acceptance_fixture_numbers(cases, scenarios):
    for case in cases:
        cid, sid = case['id'], case.get('scenario_id')
        if sid is not None:
            check(sid in scenarios, f'{cid}: 없는 시나리오 {sid}')
        scenario = resolve_scenario(scenarios, sid) if sid in scenarios else {}
        # 시나리오 값을 읽는다고 적은 사례는 그 값이 있어야 한다.
        note = case.get('engine_mapping_note_ko')
        if isinstance(note, str) and 'expected_trade_only_usd' in note:
            check('expected_trade_only_usd' in scenario, f'{cid}: 연결 시나리오에 expected_trade_only_usd 없음')
        if 'expected_trade_only_usd' in scenario:
            check(case.get('expected_numeric') == scenario['expected_trade_only_usd'],
                  cid + ': expected_numeric와 시나리오 expected_trade_only_usd 불일치')


def check_test_title_links(cases, root=ROOT):
    case_map = {c['id']: c for c in cases}
    titles = TEST_CALL + r'''(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\]*)`)'''
    case_id = r'(?<![A-Za-z0-9-])(?:P[0-2]-[A-Z0-9]+-\d{2}|CHAR-ACC-\d{2})(?!\d)'
    for file in sorted((root / 'src').rglob('*.test.ts')):
        path = file.relative_to(root).as_posix()
        for match in re.finditer(titles, strip_comments(file.read_text(encoding='utf-8'))):
            title = next(g for g in match.groups() if g is not None)
            for cid in re.findall(case_id, title):
                check(cid in case_map, f'{path}: 시험 제목의 사례 ID가 인수 명세에 없음 {cid}')
                if cid in case_map:
                    case = case_map[cid]
                    check(path in (case.get('engine_test_ref'), case.get('ui_test_ref')),
                          f'{path}: 시험 제목의 {cid}가 그 사례의 시험 연결에 없음')


def check_experiments(documents, tables):
    """실험의 상속·복사 조건과 옛 판매 거래처 분리를 잠근다."""
    def without(record, *keys):
        return {k: v for k, v in record.items() if k not in keys}

    for sid in EXPERIMENT_SCENARIO_IDS:
        scenario = tables['scenarios'].get(sid)
        if scenario is None:
            continue
        base = resolve_scenario(tables['scenarios'], scenario['base_scenario_id'])
        check(without(scenario['operations'], 'market_rules_ref') == without(base['operations'], 'market_rules_ref'),
              f'{sid}: 실험 상속 동일성: operations가 base와 다름')

    rules = {r['id']: r for r in documents['market_rules']['rule_sets']}
    base = rules['M2A5_PYEONGTAEK']
    def sellers(rule):
        return {p['counterparty_id'] for g in rule['trade']['goods'] for p in g['sell_counterparties']}

    def common_rule(rule):
        return {**without(rule, 'id', 'index', 'trade', 'rows'),
                'index': without(rule['index'], 'goods'), 'trade': without(rule['trade'], 'goods')}

    def cosmetics(rule):
        good = next((g for g in rule['trade']['goods'] if g['good_id'] == 'COSMETICS'), None)
        if good is None:
            return None
        return {**without(good, 'sell_counterparties'),
                'sell_counterparties': [without(p, 'counterparty_id') for p in good['sell_counterparties']]}

    for rid in EXPERIMENT_RULE_SET_IDS:
        rule = rules.get(rid)
        if rule is None:
            continue
        check(sellers(rule).isdisjoint(sellers(base)), f'{rid}: 실험 판매 거래처가 옛 거래처와 겹침')
        check(common_rule(rule) == common_rule(base), f'{rid}: 실험 복사 동일성: 공통 규칙이 다름')
        check(cosmetics(rule) == cosmetics(base), f'{rid}: 실험 복사 동일성: 화장품 거래 조건이 다름')
        check([r for r in rule['rows'] if r['good_id'] == 'COSMETICS']
              == [r for r in base['rows'] if r['good_id'] == 'COSMETICS'],
              f'{rid}: 실험 복사 동일성: 화장품 시세 행이 다름')

    offers = tables['market_offers']
    if 'OFFER_SELL_02_NEW' in offers:
        check(without(offers['OFFER_SELL_02_NEW'], 'id', 'counterparty_id')
              == without(offers['OFFER_SELL_02'], 'id', 'counterparty_id'),
              'OFFER_SELL_02_NEW: 실험 복사 동일성: 정적 판매 견적이 다름')


def credit_limit_sales(rule, premium_bp=800):
    """DESIGN-v2 2.1: 단계마다 정수 halfUp으로 손잡이 상한의 1로트 판매액을 낸다."""
    from fractions import Fraction
    def half_up(n, d=1):
        v = Fraction(n, d)
        return (2 * v.numerator + v.denominator) // (2 * v.denominator)
    # 판정표 v2 5.2 판매 마진 k=+3, 가산은 손잡이 상한과 실제 조건 중 큰 값.
    margin_k = 3
    buys = {r['good_id']: Fraction(str(r['base_price']['amount'])) * 100
            for r in rule['rows'] if r['side'] == 'BUY'}
    lots = {g['good_id']: g['base_lot'] for g in rule['trade']['goods']}
    values = []
    for row in rule['rows']:
        if row['side'] != 'SELL':
            continue
        if row['good_id'] not in buys or row['good_id'] not in lots:
            check(False, f"{rule['id']}: 한도 단위 계산에 매입가·기본 로트가 필요함")
            continue
        base = Fraction(str(row['base_price']['amount'])) * 100 + buys[row['good_id']] * Fraction(5 * margin_k, 100)
        price = half_up(base * rule['index']['max_bp'] * (100 + rule['regional_pct'][1]), 1000000)
        unit = half_up(price * (100 + rule['counterparty_pct'][1]), 100)
        amount = half_up(unit * lots[row['good_id']] * (10000 + premium_bp), 10000)
        values.append((row['good_id'], row['city_id'], amount))
    return values


def check_credit_profile(p, rules):
    """선택 외상 칸은 한 묶음으로 검사한다. 기존 프로필은 바꾸지 않는다."""
    from fractions import Fraction
    prefix = f"risk_profiles: {p['id']}: "
    if p['id'] == 'RISK_PROFILE_V2' and 'sale_margin_k' in p:
        check(type(p['sale_margin_k']) is int and -2 <= p['sale_margin_k'] <= 3,
              prefix + 'sale_margin_k: -2~3 정수여야 함')
    col = p['collections']
    present = [k in p for k in ('credit_terms', 'credit_limit_unit_minor', 'credit_limits')]
    present += [k in col for k in ('carry_bp_per_day', 'recovery_bp')]
    defaults = ['p_default_bp' in g for g in col['grades']]
    check((all(present) and all(defaults)) or (not any(present) and not any(defaults)),
          prefix + '외상 칸은 모두 함께 있어야 함')
    if any(present) or any(defaults):
        check(len(col['grades']) == 3 and {g['grade'] for g in col['grades']} == {'A', 'B', 'C'},
              prefix + 'collections.grades: A·B·C 각 한 행 필요')
    if not all(present) or not all(defaults):
        return
    def integer(v, low, high):
        return type(v) is int and low <= v <= high
    for g in col['grades']:
        check(integer(g['p_default_bp'], 0, 10000), prefix + 'p_default_bp: 정수 범위 오류')
    check(integer(col['carry_bp_per_day'], 0, 100), prefix + 'carry_bp_per_day: 정수 범위 오류')
    check(integer(col['recovery_bp'], 0, 10000), prefix + 'recovery_bp: 정수 범위 오류')
    if all(type(col[k]) is int for k in ('recovery_bp', 'carry_bp_per_day', 'late_max_days')):
        check(col['recovery_bp'] >= col['carry_bp_per_day'] * col['late_max_days'],
              prefix + 'recovery_bp: 확정일까지의 최대 누적 이자 이상이어야 함')
    terms = p['credit_terms']
    check(len(terms) == 3 and {t['id'] for t in terms} == {'BASE', 'D15', 'D30'},
          prefix + 'credit_terms: BASE·D15·D30 각 한 행 필요')
    valid_terms = True
    for t in terms:
        valid = (all(type(t[k]) is int for k in ('days', 'factor_pct', 'premium_bp'))
                 and ((t['days'], t['factor_pct'], t['premium_bp']) == (0, 100, 0) if t['id'] == 'BASE'
                      else t['days'] > 0 and t['factor_pct'] >= 100 and 0 <= t['premium_bp'] <= 10000))
        check(valid, prefix + 'credit_terms: 조건 값 오류')
        valid_terms = valid_terms and valid
    by_party = {r['counterparty_id']: r['grade'] for r in col['by_counterparty']}
    for rule in rules:
        for good in rule['trade']['goods']:
            parties = [r['counterparty_id'] for r in good['sell_counterparties']]
            check(all(party in by_party for party in parties), prefix + '외상 등급: 판매 거래처 누락')
            check(len({by_party[party] for party in parties if party in by_party}) >= 2,
                  prefix + f"외상 등급: {rule['id']}·{good['good_id']} 품목마다 등급 둘 이상 필요")
    grades = {g['grade']: g['p_default_bp'] for g in col['grades']}
    if valid_terms and all(integer(v, 0, 10000) for v in grades.values()) and integer(col['recovery_bp'], 0, 10000):
        for t in terms:
            if t['id'] == 'BASE':
                continue
            rho, pi, f = Fraction(col['recovery_bp'], 10000), Fraction(t['premium_bp'], 10000), Fraction(t['factor_pct'], 100)
            costs = {g: (1 - rho) * Fraction(grades.get(g, 0), 10000) * (f * (1 + pi) - 1) for g in ('A', 'B', 'C')}
            check(costs['A'] < pi and costs['B'] < pi and pi < costs['C'],
                  prefix + f"비대칭 제약: {t['id']} A·B 유리/C 불리 조건 위반")
    unit = p['credit_limit_unit_minor']
    premium_bp = max([800] + [t['premium_bp'] for t in terms
                              if t['id'] != 'BASE' and type(t['premium_bp']) is int])
    maximum = max((v for rule in rules for _, _, v in credit_limit_sales(rule, premium_bp)), default=0)
    check(integer(unit, maximum, float('inf')), prefix + f'한도 단위: 손잡이 최대 1로트 판매액 {maximum} 미만')
    limits = p['credit_limits']
    check(len(limits) == 3 and {r['grade'] for r in limits} == {'A', 'B', 'C'},
          prefix + 'credit_limits: A·B·C 각 한 행 필요')
    by_grade = {r['grade']: r['lots'] for r in limits}
    check(all(integer(r['lots'], 1, float('inf')) for r in limits)
          and by_grade.get('A', 0) >= by_grade.get('B', 0) >= by_grade.get('C', 0),
          prefix + 'credit_limits: lots는 양의 정수·A ≥ B ≥ C 필요')
    for r in limits:
        check(type(r['limit_minor']) is int and r['limit_minor'] == unit * r['lots'],
              prefix + 'credit_limits: limit_minor = credit_limit_unit_minor × lots 불일치')


def check_market_rules(documents, tables):
    """반복 시장과 운영 시나리오의 참조·경제 조건을 검사한다."""
    market = documents['market_rules']
    for sid in tables['scenarios']:
        scenario = resolve_scenario(tables['scenarios'], sid)
        setup = scenario.get('risk_setup')
        if setup is None:
            continue
        check(setup.get('level') == 'R4', f'{sid}: risk_setup.level은 R4여야 함')
        profile = next((p for p in market['risk_profiles'] if p['id'] == setup.get('profile_id')), None)
        check(profile is not None and all(k in profile for k in ('credit_terms', 'credit_limit_unit_minor', 'credit_limits'))
              and all(k in profile.get('collections', {}) for k in ('carry_bp_per_day', 'recovery_bp'))
              and {g['grade'] for g in profile.get('collections', {}).get('grades', []) if 'p_default_bp' in g} == {'A', 'B', 'C'},
              f'{sid}: risk_setup.profile_id는 외상 칸이 모두 있는 위험 프로필이어야 함')
        check(scenario.get('base_scenario_id') in EXPERIMENT_SCENARIO_IDS,
              f'{sid}: risk_setup.base_scenario_id는 실험 시나리오여야 함')
    names = {p['id'] for p in market['counterparties']}
    party_counts = {}
    for party in market['counterparties']:
        pid = party['id']
        name = party.get('name_ko')
        check(isinstance(name, str) and bool(name.strip()), f'{pid}: 거래처 이름이 비어 있음')
        party_counts[pid] = party_counts.get(pid, 0) + 1
    for pid, count in party_counts.items():
        check(count == 1, f'market_rules: 거래처 ID 중복 {pid}')
    for rule in market['rule_sets']:
        rows = rule['rows']
        rid = rule['id']
        trade = rule['trade']
        goods = [g['good_id'] for g in trade['goods']]
        cities = trade['sell_city_ids']
        check(bool(cities) and len(cities) == len(set(cities)) and all(c in tables['world'] for c in cities),
              f'market_rules: {rid}: 판매지는 비어 있지 않은 고유 도시 목록이어야 함')
        check(trade['buy_city_id'] in tables['world'], f'market_rules: {rid}: 매입 도시가 없음')
        check(bool(trade['max_lots_choices']), f'market_rules: {rid}: 물량 선택지가 비어 있음')
        for gid in goods:
            check(gid in tables['goods'] and goods.count(gid) == 1,
                  f'market_rules: {rid}: 품목 {gid}가 없거나 중복됨')
        tags = [g['id_tag'] for g in trade['goods']]
        check(len(tags) == len(set(tags)), f'market_rules: {rid}: 품목 견적 태그가 중복됨')
        expected_rows = {(trade['buy_city_id'], gid, 'BUY') for gid in goods}
        expected_rows.update((city, gid, 'SELL') for gid in goods for city in cities)
        actual_rows = [(r['city_id'], r['good_id'], r['side']) for r in rows]
        check(set(actual_rows) == expected_rows, f'market_rules: {rid}: 시세표 행 집합이 거래 품목·도시와 다름')
        check(len(actual_rows) == len(set(actual_rows)), f'market_rules: {rid}: 시세표 행이 중복됨')
        index_goods = rule['index']['goods']
        check(set(index_goods) == set(goods) and len(index_goods) == len(set(index_goods)),
              f'market_rules: {rid}: 지수 품목이 거래 품목과 다르거나 중복됨')
        for good in trade['goods']:
            party_cities = [p['city_id'] for p in good['sell_counterparties']]
            check(set(party_cities) == set(cities) and len(party_cities) == len(set(party_cities)),
                  f"market_rules: {rid}: 품목 {good['good_id']}의 판매 거래처는 판매지마다 정확히 하나여야 함")
        payment_cities = [p['city_id'] for p in trade['payment_offset_days']]
        check(set(payment_cities) == set(cities) and len(payment_cities) == len(set(payment_cities)),
              f'market_rules: {rid}: 결제일은 판매지마다 정확히 하나여야 함')
        templates = rule['forwarding']['templates']
        for t in templates:
            tid = t['id']
            route = next((r for r in tables['routes'].values()
                          if r['from_city_id'] == rule['trade']['buy_city_id']
                          and r['to_city_id'] == t['destination_city_id']), None)
            check(route is not None and t['deadline_offset_days'] >= route['transit_days'] + 1,
                  f'{tid}: 납기가 운송일보다 짧음')
            check(t['payment_offset_days'] >= t['deadline_offset_days'], f'{tid}: 결제일이 납기보다 이름')
            party = t['counterparty_id']
            check(party in names, f'{tid}: 거래처 이름 없음 {party}')
            prep = t.get('prep_work_units')
            check((type(prep) is int and prep >= 2) if t['service_class'] == 'HANDLING' else prep is None,
                  f'{tid}: 준비량 칸 오류')
        for d in rule['forwarding']['draws']:
            grade = d['service_class']
            check(d['count'] <= sum(t['service_class'] == grade for t in templates),
                  f'market_rules: {grade} 뽑기 수가 틀 수보다 많음')
        for g in rule['trade']['goods']:
            for party in [g['buy_counterparty_id']] + [p['counterparty_id'] for p in g['sell_counterparties']]:
                check(party in names, f"{g['good_id']}: 거래처 이름 없음 {party}")
    for offer in tables['market_offers'].values():
        party = offer['counterparty_id']
        check(party in names, f"{offer['id']}: 거래처 이름 없음 {party}")
    for sid in tables['scenarios']:
        scenario = resolve_scenario(tables['scenarios'], sid)
        if 'operations' in scenario:
            check(scenario.get('engine_rules', {}).get('rules_version') == 'M2a-rules-2',
                  f'{sid}: operations는 M2a-rules-2 필요')
        late = scenario.get('contract_terms', {}).get('late_delivery')
        if late:
            cap = late.get('cap_basis_points')
            check((type(cap) is int and 1 <= cap <= 10000) if late['basis'] == 'per_late_day_capped'
                  else 'cap_basis_points' not in late, f'{sid}: 지연 감액 상한 칸 오류')
    # 모든 프로필은 현재 운영 시나리오가 상속해 쓰는 rule_set 전체를 덮어야 한다.
    active_rules = set()
    for sid in tables['scenarios']:
        scenario = resolve_scenario(tables['scenarios'], sid)
        if scenario.get('engine_rules', {}).get('rules_version') in ('M2a-rules-2', 'M2a-rules-3'):
            ref = scenario.get('operations', {}).get('market_rules_ref', '')
            if '#' in ref:
                active_rules.add(ref.split('#', 1)[1])
    profiles = market.get('risk_profiles', [])
    check(bool(profiles), 'risk_profiles: 프로필이 필요함')
    profile_ids = [p['id'] for p in profiles]
    check(len(profile_ids) == len(set(profile_ids)), 'risk_profiles: 프로필 ID 중복')
    for p in profiles:
        check_credit_profile(p, [r for r in market['rule_sets'] if r['id'] in active_rules])
        prefix = f"risk_profiles: {p['id']}: "
        def integer(value, low, high, field):
            check(type(value) is int and low <= value <= high, prefix + field + ': 정수 범위 오류')
        def pair(values, low, high, field):
            valid = (len(values) == 2 and all(type(v) is int and low <= v <= high for v in values)
                     and values[0] <= values[1])
            check(valid, prefix + field + ': 최소·최대 범위 오류')
        def bp(group, fields, path):
            for field in fields:
                integer(group[field], 0, 10000, path + '.' + field)
        fx, tariff, surcharge, claims, collections = (p[k] for k in ('fx', 'tariff', 'surcharge', 'claims', 'collections'))
        for rows, keys, label in (
            (tariff['base'], ('country_code', 'good_id'), 'tariff.base'),
            (claims['by_good'], ('good_id',), 'claims.by_good'),
            (collections['by_counterparty'], ('counterparty_id',), 'collections.by_counterparty'),
            (collections['grades'], ('grade',), 'collections.grades'),
        ):
            row_keys = [tuple(row[key] for key in keys) for row in rows]
            check(len(row_keys) == len(set(row_keys)), prefix + label + ': 중복 행')
        bp(fx, ['step_bp'], 'fx')
        pair([fx['min_krw_per_usd'], fx['max_krw_per_usd']], 1, float('inf'), 'fx')
        check(type(fx['start_krw_per_usd']) is int and fx['min_krw_per_usd'] <= fx['start_krw_per_usd'] <= fx['max_krw_per_usd'],
              prefix + 'fx: 시작 환율 범위 오류')
        check(fx['start_krw_per_usd'] == documents['game_config']['config']['fx_krw_per_usd'],
              prefix + 'fx: 시작 환율이 fx_krw_per_usd와 다름')
        integer(tariff['max_changes'], 0, float('inf'), 'tariff.max_changes')
        pair(tariff['lag_days'], 0, float('inf'), 'tariff.lag_days')
        pair(tariff['step_bp'], -10000, 10000, 'tariff.step_bp')
        pair([tariff['min_bp'], tariff['max_bp']], 0, 10000, 'tariff')
        bp(surcharge, ['p_zero_bp', 'min_bp', 'max_bp'], 'surcharge')
        pair([surcharge['min_bp'], surcharge['max_bp']], 0, 10000, 'surcharge')
        for tier in ('minor', 'major'):
            bp(claims[tier], ['weight_bp', 'min_bp', 'max_bp'], 'claims.' + tier)
            pair([claims[tier]['min_bp'], claims[tier]['max_bp']], 0, 10000, 'claims.' + tier)
        check(claims['minor']['weight_bp'] + claims['major']['weight_bp'] == 10000,
              prefix + 'claims: 손상 가중치 합은 10000이어야 함')
        for row in tariff['base']:
            bp(row, ['rate_bp'], 'tariff.base')
            check(row['good_id'] in tables['goods'], prefix + 'tariff: 품목 자료에 없는 품목')
        for row in claims['by_good']:
            bp(row, ['p_claim_bp'], 'claims.by_good')
            check(row['good_id'] in tables['goods'], prefix + 'claims: 품목 자료에 없는 품목')
        grades = {row['grade'] for row in collections['grades']}
        for row in collections['grades']:
            fields = ['p_on_time_bp', 'p_late_bp', 'p_partial_bp']
            bp(row, fields, 'collections.grades')
            check(sum(row[f] for f in fields) == 10000, prefix + 'collections: 등급 확률 합은 10000이어야 함')
        for row in collections['by_counterparty']:
            check(row['counterparty_id'] in names, prefix + 'collections: 시장 자료에 없는 거래처')
            check(row['grade'] in grades, prefix + 'collections: 정의되지 않은 등급')
        bp(collections, ['partial_bp'], 'collections')
        pair([collections['late_min_days'], collections['late_max_days']], 0, float('inf'), 'collections.late_days')
        parties = {row['counterparty_id'] for row in collections['by_counterparty']}
        claim_goods = {row['good_id'] for row in claims['by_good']}
        tariff_keys = {(row['country_code'], row['good_id']) for row in tariff['base']}
        for rule in market['rule_sets']:
            if rule['id'] not in active_rules:
                continue
            for good in rule['trade']['goods']:
                check(good['good_id'] in claim_goods, prefix + 'claims: 운영 품목 누락')
                for party in good['sell_counterparties']:
                    check(party['counterparty_id'] in parties, prefix + 'collections: 운영 판매 거래처 누락')
                for city in rule['trade']['sell_city_ids']:
                    country = tables['world'].get(city, {}).get('country_code')
                    check((country, good['good_id']) in tariff_keys, prefix + 'tariff: 운영 판매국·품목 누락')

    param = next(p for p in documents['parameters']['items'] if p['id'] == 'PAR_PAYMENT_GRACE_DAYS')
    try:
        file, pointer = param['json_pointer'].split('#')
        value = documents[file.removesuffix('.json')]
        for part in pointer.lstrip('/').split('/'):
            value = value[int(part)] if isinstance(value, list) else value[part]
    except (KeyError, IndexError, ValueError, TypeError):
        value = None
    check(type(param['value']) is int and param['value'] == value,
          'PAR_PAYMENT_GRACE_DAYS: 시나리오 값과 다름')


def validate_situation_map(document, bounds):
    """상황실 한 문서의 출처 확인·반입 등급·지도 좌표를 함께 검사한다."""
    layers = document.get('layers', [])
    ids = [layer.get('id') for layer in layers]
    check(len(ids) == 5 and set(ids) == {'cargo', 'routes', 'ports', 'nightlights', 'countries'},
          'situation_map: 겹치지 않는 다섯 층')
    by_id = {layer.get('id'): layer for layer in layers}
    for layer in layers:
        check(layer.get('license_tier') in ('bundle_raw', 'derived_only', 'banned'),
              'situation_map: 반입 등급')
        check(layer.get('verification_status') in ('pending', 'verified'),
              'situation_map: 확인 상태')
        check(layer.get('license_tier') != 'banned', 'situation_map: 금지 층은 화면에 쓸 수 없음')
        date = layer.get('retrieved_on')
        check((date is None and layer.get('verification_status') != 'verified') or valid_date(date),
              'situation_map: 확인된 층의 수집일은 날짜')
    ports = document.get('ports', [])
    port_ids = [port.get('id') for port in ports]
    check(len(port_ids) == len(set(port_ids)), 'situation_map: 항만 ID 중복')
    for port in ports:
        lon, lat = port.get('lon'), port.get('lat')
        check(type(lon) in (int, float) and type(lat) in (int, float)
              and bounds['lon_min'] <= lon <= bounds['lon_max']
              and bounds['lat_min'] <= lat <= bounds['lat_max'], 'situation_map: 항만 지도 경계')
    countries = document.get('countries', [])
    check(len(countries) == 3 and {c.get('id') for c in countries} == {'KOR', 'CHN', 'VNM'},
          'situation_map: 세 국가')
    for country in countries:
        indicators = country.get('indicators', [])
        check(len(indicators) == 4 and len({i.get('id') for i in indicators}) == 4,
              'situation_map: 국가 지표 네 개')
        for indicator in indicators:
            layer = by_id.get(indicator.get('source_layer'), {})
            check(layer.get('verification_status') != 'verified' or indicator.get('value') is not None,
                  'situation_map: 확인된 국가 지표는 값 필요')
            check(indicator.get('value') is None or
                  (type(indicator.get('year')) is int and layer.get('verification_status') == 'verified'),
                  'situation_map: 값은 정수 기준 연도와 확인된 층 필요')


def check_character_release(documents):
    """출시 전 동료가 실제 고용·영입·설정에 연결되지 않도록 검사한다."""
    characters = documents['characters']['items']
    for character in characters:
        check(character['release_phase'] in {'P0', 'P1', 'P2'},
              character['id'] + ': release_phase 허용값은 P0·P1·P2')
    unreleased = {c['id'] for c in characters if c['release_phase'] == 'P2'}

    def check_refs(value, path):
        if isinstance(value, dict):
            for key, child in value.items():
                check_refs(key, path)
                check_refs(child, path + '.' + key)
        elif isinstance(value, list):
            for child in value:
                check_refs(child, path)
        elif isinstance(value, str):
            check(value not in unreleased, f'{path}: P2 캐릭터 참조 금지 {value}')

    for employee in documents['employees']['items']:
        for key in ('id', 'character_id'):
            check_refs(employee.get(key), 'employees.' + key)
    for obj in walk(documents['scenarios']):
        for key in ('candidate_employee_ids', 'candidate_character_ids'):
            if key in obj:
                check_refs(obj[key], 'scenarios.' + key)
    for name in ('team_synergies', 'game_config'):
        check_refs(documents[name], name)


def main():
    documents = {}
    for file in sorted((ROOT / 'data').glob('*.json')):
        data = json.loads(file.read_text(encoding='utf-8'))
        documents[file.stem] = data
        schema = read('schemas/' + file.stem + '.schema.json')
        shape(data, schema, file.name)
    tables = {name: index(doc['items'], name)
              for name, doc in documents.items() if 'items' in doc}
    map_asset = next(a for a in read('src/assets/manifest.json')['assets'] if a['id'] == 'MAP_EAST_ASIA')
    validate_situation_map(documents['situation_map'], map_asset['bounds'])
    curriculum = index(documents['curriculum_links']['links'], 'curriculum')
    source_ids = set(tables['sources'])
    expected_counts = {'world': 21, 'goods': 9, 'routes': 6, 'employees': 6,
                       'market_offers': 7, 'scenarios': 11, 'securities': 4,
                       'events': 6, 'culture_activities': 6, 'venues': 5, 'contacts': 2,
                       'observed_fx_sample': 10, 'characters': 85, 'organization': 7,
                       'job_templates': 6, 'team_synergies': 3, 'ui_screens': 15}
    for name, count in expected_counts.items():
        check(len(tables[name]) == count, f'{name}: expected {count}')
    check(documents['curriculum_links']['counts']['total'] > 0, 'curriculum: counts.total은 양수여야 함')
    for group in ('social', 'ethics', 'science'):
        check(any(item['group'] == group for item in curriculum.values()),
              f'curriculum {group}: 연결이 하나 이상 필요')
    check_curriculum_counts(documents['curriculum_links'], curriculum)
    pending_found = check_curriculum_stages(documents, curriculum)
    check_extension_curriculum_refs(documents, curriculum)
    check_achievement_standards(documents['curriculum_links'], curriculum, source_ids)
    check_sources(documents)
    for item in curriculum.values():
        check(item['pdf_page'] == item['printed_page'] + 6, item['id'] + ': page offset')
        check(item['source_id'] in source_ids, item['id'] + ': unknown source')
    curriculum_doc = documents['curriculum_links']
    check(hashlib.sha256((ROOT/curriculum_doc['source_document']).read_bytes()).hexdigest()
          == curriculum_doc['source_document_sha256'], 'curriculum: source document hash')

    single_refs = {'city_id':'world', 'home_city_id':'world', 'location_city_id':'world',
                   'from_city_id':'world', 'to_city_id':'world', 'venue_id':'venues',
                   'destination_city_id':'world',
                   'good_id':'goods', 'route_id':'routes'}
    plural_refs = {'city_ids':'world', 'venue_ids':'venues', 'venue_template_ids':'venues',
                   'contact_ids':'contacts', 'activity_ids':'culture_activities',
                   'event_ids':'events', 'employee_ids':'employees',
                   'offer_ids':'market_offers', 'security_ids':'securities'}
    for name, doc in documents.items():
        for obj in walk(doc):
            for ref in obj.get('source_refs', []):
                check(ref in source_ids, f'{name}: source {ref}')
            for ref in obj.get('curriculum_refs', []):
                check(ref in curriculum, f'{name}: curriculum {ref}')
            for key, table in single_refs.items():
                if key in obj and isinstance(obj[key], str) and '{' not in obj[key]:
                    check(obj[key] in tables[table], f'{name}: {key}={obj[key]}')
            for key, table in plural_refs.items():
                refs = obj.get(key, [])
                # Explanatory merge rules may use the same field name as prose.
                if not isinstance(refs, list):
                    continue
                for ref in refs:
                    if isinstance(ref, str) and '{' not in ref:
                        check(ref in tables[table], f'{name}: {key}={ref}')

    for city in tables['world'].values():
        for venue_id in city['venue_ids']:
            check(tables['venues'][venue_id]['city_id'] == city['id'],
                  city['id'] + ': venue location mismatch')
        if 'map_position' in city:
            for coordinate in city['map_position']['x'], city['map_position']['y']:
                check(0 <= coordinate <= 1, city['id'] + ': concept map coordinate')
    for good in tables['goods'].values():
        check(good['mass_kg_per_unit'] > 0 and good['volume_m3_per_unit'] > 0,
              good['id'] + ': physical fixture dimensions')
        status = good['hs_mapping_status']
        check(status in ('NOT_VERIFIED', 'VERIFIED'), good['id'] + ': HS 확인 상태 오류')
        if status == 'NOT_VERIFIED':
            check(good['hs_code'] is None and good['hs_edition'] is None,
                  good['id'] + ': 미확인 HS 코드와 판본은 null이어야 함')
        elif status == 'VERIFIED':
            check(isinstance(good['hs_code'], str) and re.fullmatch(r'[0-9]{4}\.[0-9]{2}', good['hs_code']) is not None,
                  good['id'] + ': 확인한 HS 코드 형식 오류')
            check(isinstance(good['hs_edition'], str) and re.fullmatch(r'HS20[0-9]{2}', good['hs_edition']) is not None,
                  good['id'] + ': 확인한 HS 판본 형식 오류')
            check(bool(good['source_refs']) and all(ref in source_ids for ref in good['source_refs']),
                  good['id'] + ': 확인한 HS 출처가 없거나 잘못됨')
    for route in tables['routes'].values():
        check(route['transit_days'] > 0 and route['departure_interval_days'] > 0,
              route['id'] + ': time')
        check(route['capacity_kg'] > 0 and route['capacity_m3'] > 0,
              route['id'] + ': capacity')
    check_character_release(documents)
    check_character_regions(tables)
    for cid, field, term in check_motif_cautions(tables):
        check(False, f'{cid}: 생김새·주의 문장 충돌 {field} {term}')
    # Characters: real animals or mythic beasts only; mythic ones carry an interpretation note.
    for character in tables['characters'].values():
        check(character['creature_kind'] in {'animal', 'myth_inspired'},
              character['id'] + ': no invented composite creatures')
        if character['creature_kind'] == 'myth_inspired':
            check(bool(character.get('myth_interpretation_note')), character['id'] + ': myth interpretation note')
    # Country collection: encounter region is where you first meet a companion, not a nationality.
    countries = {city['country_code'] for city in tables['world'].values()}
    names_seen, tags_seen = set(), set()
    for character in tables['characters'].values():
        cid = character['id']
        enc = character['encounter']
        if enc['country_code'] is not None:
            check(enc['country_code'] in countries, cid + ': encounter country is a port country')
            check(tables['world'][enc['city_id']]['country_code'] == enc['country_code'], cid + ': encounter city in country')
        else:
            check(enc['category'] == 'global_myth', cid + ': only global myth motifs have no encounter country')
        check(character['regional_background']['nationality'] is None, cid + ': no nationality')
        if enc['category'] in {'representative_animal', 'rare_animal'} or (character['creature_kind'] == 'animal' and enc['category'] != 'starter'):
            check('conservation' in character, cid + ': real animal conservation record')
        if enc['category'] == 'rare_animal':
            check(character['recruitment']['mode'] == 'QUEST_GUARANTEED' and not character['recruitment']['random_draw_required'],
                  cid + ': rare animals join through partnership stories, not draws')
        check(character['name_ko'] not in names_seen, cid + ': unique display name')
        names_seen.add(character['name_ko'])
        tag = character['signature_trait']['candidate_effect']['trigger_tag']
        check(tag not in tags_seen, cid + ': unique trait trigger tag')
        tags_seen.add(tag)
    for employee in tables['employees'].values():
        check(employee['name_ko'] == tables['characters'][employee['id']]['name_ko'],
              employee['id'] + ': employee and character names match')
    # Map display geometry (not used for distance or transit time).
    for city in tables['world'].values():
        geo = city.get('geo_position')
        check(geo is not None and geo['use'] == 'map_display_only', city['id'] + ': map geo position')
    check_world_hubs(documents, tables, source_ids)
    route01 = tables['routes']['ROUTE01']
    points = route01['map_waypoints']['points']
    for end, city_id in ((points[0], route01['from_city_id']), (points[-1], route01['to_city_id'])):
        geo = tables['world'][city_id]['geo_position']
        check(abs(end['lat'] - geo['lat']) <= 0.2 and abs(end['lon'] - geo['lon']) <= 0.2,
              'ROUTE01 map waypoints start and end at their ports')
    config = documents['game_config']['config']
    check_home_city(config, tables['world'])
    check_route_schedules(tables['routes'], source_ids)
    check(config['securities_enabled'] is False and config['ipo_enabled'] is False,
          'P0 must not enable future finance automatically')
    check(tables['scenarios']['SCENARIO_CITY_CULTURE']['culture_enabled'] is True,
          'M2 culture scenario must explicitly enable activities')
    check(len([a for a in tables['culture_activities'].values() if a['stage']=='P0']) == 3,
          'expected 3 P0 cultural activities')
    hooks = {item['id'] for item in documents['content_hooks']['unlocks']}
    commands = {item['id'] for item in documents['content_hooks']['commands']}
    for event in tables['events'].values():
        for choice in event['choices']:
            check(choice['command_template']['type'] in commands, event['id'] + ': command hook')
            check(choice['command_template']['execution_status'] == 'DECLARATIVE_ONLY',
                  event['id'] + ': unimplemented command status')
    for activity in tables['culture_activities'].values():
        check(activity['duration_days'] >= 1, activity['id'] + ': real activity consumes time')
        check(activity['money_cost']['amount'] >= 0, activity['id'] + ': cost')
        check(activity['eligibility']['actor_must_be_in_city'], activity['id'] + ': location required')
        for effect in activity['effects']:
            check(effect['type'] in {'UNLOCK_KNOWLEDGE','UNLOCK_CONTACT_FOLLOWUP'},
                  activity['id'] + ': unexpected blanket buff')
            for unlock in effect.get('unlocks', []):
                check(unlock in hooks, activity['id'] + ': undeclared unlock')

    scenario = tables['scenarios']['SCENARIO_M1_ONE_TRADE']
    purchase = 100 * 10
    cost = purchase + 200 + purchase * .05
    expected = scenario['expected_direct_trade_result']
    check(expected['contribution_before_payroll_usd'] == 100*14-cost == 150, 'M1 arithmetic')
    check(scenario['arrival_day'] == scenario['departure_day'] + tables['routes']['ROUTE01']['transit_days'],
          'M1 time arithmetic')
    check(scenario['arrival_day'] <= scenario['delivery_deadline_day'] < scenario['cash_payment_due_day'],
          'M1 delivery and payment are separate')
    check(100*.5 <= tables['routes']['ROUTE01']['capacity_kg'] and
          100*.003 <= tables['routes']['ROUTE01']['capacity_m3'], 'M1 freight capacity')

    # Offers: goods trades carry a unit price; forwarding carries a service fee for customer-owned cargo.
    for offer in tables['market_offers'].values():
        oid = offer['id']
        check(offer['quantity_unit'] == tables['goods'][offer['good_id']]['quantity_unit'], oid + ': quantity unit matches good')
        if offer['kind'] in {'supplier', 'customer'}:
            check('unit_price' in offer and 'service_fee' not in offer, oid + ': goods offer has unit price only')
        else:
            check(offer['kind'] == 'forwarding' and 'unit_price' not in offer and 'service_fee' in offer
                  and offer.get('cargo_owner') == 'customer', oid + ': forwarding offer prices a service for customer cargo')
            check(offer['destination_city_id'] != offer['city_id'], oid + ': forwarding moves cargo between ports')
        if offer['kind'] in {'customer', 'forwarding'}:
            check(offer['valid_until_day'] < offer['delivery_deadline_day'] < offer['payment_due_day'],
                  oid + ': acceptance, delivery and payment are separate days')
    # M1 scenarios keep the M1 rule set; the M2a scenario opts into committed-outlay funds checks.
    for sid in ('SCENARIO_M1_ONE_TRADE',):
        check(tables['scenarios'][sid]['engine_rules'] == {**tables['scenarios'][sid]['engine_rules'],
              'rules_version': 'M1-rules-1', 'funds_check': 'immediate_cash', 'forwarding_enabled': False},
              sid + ': M1 rule set unchanged')
    unresolved_conservation, secondary_conservation = check_conservation(tables)
    check_m2a(tables)
    validate_cancellation(tables['scenarios'], tables['routes'])
    check_market_rules(documents, tables)
    check_experiments(documents, tables)

    acceptance = read('tests/acceptance_cases.json')
    cases = acceptance['cases']
    check_culture(tables, cases, config['reporting_currency'], config.get('home_city_id'))
    summary = acceptance['review_summary']
    check(summary['case_count'] == len(cases), 'review_summary case_count matches cases')
    counts = {phase: sum(c['phase'] == phase for c in cases) for phase in ('P0', 'P1', 'P2')}
    check(summary['phase_case_counts'] == counts, 'review_summary phase counts match cases')
    index(cases, 'acceptance cases')
    check_test_refs(cases)
    check_acceptance_fixture_numbers(cases, tables['scenarios'])
    # Reference arithmetic only. Engine behaviour is checked by the linked tests (npx vitest run).
    check(10000-1000-200+150 == tables['scenarios']['SCENARIO_M1_CANCEL_PREDEPARTURE']['expected_trade_only_usd']['cash_after'], 'cancel reference arithmetic')
    check(10000-1250+1350 == tables['scenarios']['SCENARIO_M1_DELAY_ACCEPTED']['expected_trade_only_usd']['cash_after_collection'], 'late delivery arithmetic')
    # M1 contract terms used by the engine (DESIGN, reviewed 2026-10-04).
    terms = scenario['contract_terms']
    cancel_terms = terms['pre_departure_cancellation']
    check(cancel_terms['freight_refund']['amount'] + cancel_terms['cancellation_fee']['amount']
          == tables['routes']['ROUTE01']['booking_fee']['amount'], 'M1 cancellation splits prepaid freight exactly')
    check(cancel_terms['cancellation_fee']['amount']
          == tables['scenarios']['SCENARIO_M1_CANCEL_PREDEPARTURE']['expected_trade_only_usd']['cancellation_expense'],
          'M1 cancellation fee matches cancel fixture')
    delay = tables['scenarios']['SCENARIO_M1_DELAY_ACCEPTED']
    check(100*14 - terms['late_delivery']['price_reduction']['amount'] == delay['expected_trade_only_usd']['net_revenue'],
          'M1 late reduction matches delay fixture')
    check(terms['prep_work_units'] <= tables['employees']['EMP01']['work_units_per_day']
          * (scenario['departure_day'] - scenario['booking_day']), 'M1 prep finishes before departure')
    restriction = delay['port_restriction']
    check(restriction['event_template_id'] in tables['events'], 'M1 delay restriction template')
    check(restriction['city_id'] == tables['routes']['ROUTE01']['to_city_id'], 'M1 delay restriction at destination')
    check(restriction['announce_day'] < restriction['restriction_start_day'] == scenario['arrival_day'],
          'M1 delay restriction announced before scheduled arrival')
    check(restriction['restriction_end_day'] - restriction['restriction_start_day'] + 1
          == delay['arrival_day'] - scenario['arrival_day'], 'M1 delay restriction adds the fixture delay once')
    check(100-60-5-3-4 == 28 and 90-60-5-3-4 == 18 and 28+90 == 118, 'trade reference arithmetic')
    check(100-10*3-1 == 69 and 10*4-10*3 == 10, 'stock reference arithmetic')
    check(250000*2000 == 500000000 and 1000000/1250000 == .8, 'IPO reference arithmetic')

    fx = documents['observed_fx_sample']
    check(fx['auto_load_as_operating_data'] is False, 'observed FX sample must not replace fixture')
    dates = [r['date'] for r in fx['items']]
    check(dates == sorted(set(dates)), 'observed FX: sorted unique dates')
    for row in fx['items']:
        cross = (Decimal(row['krw_per_eur']) / Decimal(row['usd_per_eur'])).quantize(
            Decimal('0.000000000001'), rounding=ROUND_HALF_EVEN)
        check(cross == Decimal(row['krw_per_usd_derived']), row['id'] + ': cross-rate arithmetic')

    rules = documents['character_rules']
    characters = tables['characters']
    attributes = {item['id'] for item in rules['attributes']}
    departments = {item['id'] for item in documents['organization']['departments']}
    check(len(attributes) == 6 and len(departments) == 3, 'attributes and departments')
    check(sum(c['release_phase'] == 'P0' for c in characters.values()) == 6, 'P0 character count')
    check(sum(c['attribute'] == 'water' and c['release_phase'] == 'P0'
              for c in characters.values()) >= 2, 'P0 attribute synergy must be attainable')
    for character in characters.values():
        cid = character['id']
        check(set(character['stats']) == set(rules['stats']), cid + ': six named stats')
        check(all(character['growth_focus'][key] in character['stats']
                  for key in ('primary_stat', 'secondary_stat')), cid + ': growth focus names existing stats')
        check(sum(character['stats'].values()) == 300, cid + ': base stat budget')
        check(all(0 <= value <= 100 for value in character['stats'].values()), cid + ': stat range')
        check(character['attribute'] in attributes, cid + ': known attribute')
        check(character['rarity_power_multiplier'] == 1, cid + ': no rarity power multiplier')
        check(character['regional_background']['country_locked'] is False, cid + ': learned region')
        check(character['assignment_policy']['deck_slot_reserves_employee'] is False,
              cid + ': draft lineup is not a reservation')
        check(character['signature_trait']['candidate_effect']['active_in_P0'] is False,
              cid + ': deferred signature trait')
    for employee in tables['employees'].values():
        check(employee['character_id'] in characters, employee['id'] + ': character link')
        check(employee['home_team_id'] in tables['organization'], employee['id'] + ': home team')
        check(employee['name_ko'] == characters[employee['character_id']]['name_ko'],
              employee['id'] + ': display identity')
    for team in tables['organization'].values():
        check(team['department_id'] in departments, team['id'] + ': department')
    for job in tables['job_templates'].values():
        check(job['home_team_id'] in tables['organization'], job['id'] + ': home team')
        check(job['affinity_attribute'] in attributes, job['id'] + ': affinity')
        check(sum(Decimal(str(v)) for v in job['stat_weights'].values()) == 1,
              job['id'] + ': stat weights sum to one')
    validate_growth(rules, characters)
    check(tables['scenarios']['SCENARIO_M2_MULTI_TRADE'].get('growth') == {'enabled': True},
          'M2 multi trade enables growth without copying numeric rules')
    check(all('growth' not in s for sid, s in tables['scenarios'].items() if sid.startswith('SCENARIO_M1_')),
          'M1 growth remains disabled')
    steps = rules['enhancement_steps']
    check(sum(s['fee_krw'] for s in steps) == 700000, 'enhancement total fee')
    check(sum(s['duration_days'] for s in steps) == 10, 'enhancement total duration')
    check(sum(s['primary_stat_gain'] for s in steps) == 15, 'enhancement total gain')
    check(all(s['xp_awarded'] == 0 for s in steps), 'no ordinary XP during enhancement')
    check(min(100, 90+15) == 100, 'final stat cap reference arithmetic')
    check(min(250, 3*100*(.9+.002*50)*1.1) == 250, 'team throughput and facility cap')
    check((Decimal('.9')+Decimal('.002')*100)*Decimal('1.1') == Decimal('1.21'),
          'max individual multiplier reference arithmetic')
    check(config['character_system_enabled'] is False and config['productivity_mode'] == 'LEGACY_FIXED',
          'M1 legacy fixture remains isolated')
    crew_scenario = tables['scenarios']['SCENARIO_CREW_M2']
    check(crew_scenario['character_system_enabled'] is True and
          crew_scenario['productivity_mode'] == 'CHARACTER_WEIGHTED', 'M2 character mode explicit')
    character_doc = read('tests/character_acceptance_cases.json')
    character_cases = character_doc['items']
    index(character_cases, 'character acceptance cases')
    check_test_refs(character_cases)
    check_acceptance_summary(acceptance, character_doc)
    check_organization_names(character_cases, documents['organization'])
    check_test_title_links(cases + character_cases)

    for file in sorted((ROOT/'references').glob('*.json')):
        obj=json.loads(file.read_text(encoding='utf-8'))
        if 'observations' in obj:
            check(len(obj['observations']) == 12, file.name + ': expected 12 observations')
            index(obj['observations'],file.name)
    manifest=read('MANIFEST.json')
    for item in manifest['files']:
        file=ROOT/item['path']
        check(file.is_file(), 'missing manifest file '+item['path'])
        if file.is_file():
            check(hashlib.sha256(file.read_bytes()).hexdigest()==item['sha256'],
                  'hash mismatch '+item['path'])
    if ERRORS:
        print('\n'.join('FAIL '+message for message in ERRORS))
        print(f'{len(ERRORS)} errors; {CHECKS} checks')
        return 1
    print(f'PASS: {len(documents)} data documents; {CHECKS} structural/reference/arithmetic checks')
    n_core, n_char = len(cases), len(character_cases)
    core_engine, char_engine = linked_count(cases, 'engine'), linked_count(character_cases, 'engine')
    core_ui, char_ui = linked_count(cases, 'ui'), linked_count(character_cases, 'ui')
    print(f'{n_core + n_char} acceptance specifications included ({n_core} core + {n_char} character); '
          f'linked by file and test name: {core_engine} core and {char_engine} character to engine tests, '
          f'{core_ui + char_ui} to screen tests. This validator checks that those files and names exist; it does not run them (npx vitest run).')
    if unresolved_conservation:
        print(f'CITES 판정 보류 {len(unresolved_conservation)}건: ' + ', '.join(unresolved_conservation))
    if secondary_conservation:
        print(f'IUCN 2차 자료 {len(secondary_conservation)}건(게임 표기 전 사람 확인 필요): ' + ', '.join(secondary_conservation))
    print(f'Unlinked specifications: {n_core - core_engine} core, {n_char - char_engine} character. '
          f'Curriculum: {len(pending_found)} P0 item links without a P0 label remain on the pending list (not approved exceptions).')
    print('Game fixtures are DESIGN; ECB sample is OBSERVED_AND_DERIVED and import-only.')
    print('Economic calibration and playtesting are pending.')
    return 0


if __name__=='__main__':
    sys.exit(main())
