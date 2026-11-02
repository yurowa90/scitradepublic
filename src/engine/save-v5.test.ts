import { describe, expect, it } from 'vitest';
import { loadScenario, M1_SCENARIO_IDS, SCENARIO_IDS } from '../content/scenario';
import rules from '../../data/character_rules.json';
import legacyFixture from './fixtures/save-v4-m2.json';
import currentFixture from './fixtures/save-v5-m2.json';

// 현행 자료 판본에서 저장 형식 4의 필드 모양만 재현한다.
const { culture: _culture, ...v4State } = currentFixture.state;
const fixture = { ...currentFixture, formatVersion: 4, state: v4State };
import { createGame } from './engine';
import { awardTaskCompletion } from './growth';
import { deserializeSave, SaveError, serializeSave, SAVE_FORMAT_VERSION } from './save';
import { checkSaveShape } from './save-shape';
import { runDays } from './testkit';
import type { CultureState, ScenarioConfig } from './types';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const emptyCulture: CultureState = { reports: [], experiences: [], relationEvents: [] };
const records: CultureState = {
  reports: [{ key: 'REPORT', activityId: 'CA01', topicId: 'KT_PYEONGTAEK_PACKAGING', cityId: 'PYEONGTAEK',
    sourceContactIds: ['NPC_MARKET'], reporterEmployeeId: 'EMP01', taskId: 'CULTURE-TEST', day: 1,
    contentRevision: '1', status: 'UNVERIFIED' }],
  experiences: [{ key: 'EXPERIENCE', employeeId: 'EMP01', activityId: 'CA01', topicId: 'KT_PYEONGTAEK_PACKAGING',
    cityId: 'PYEONGTAEK', countryCode: 'KR', contentRevision: '1', completedTaskId: 'CULTURE-TEST', verifiedDay: 1 }],
  relationEvents: [{ key: 'RELATION', employeeId: 'EMP01', contactId: 'NPC_MARKET', activityId: 'CA01',
    cityId: 'PYEONGTAEK', contentRevision: '1', taskId: 'CULTURE-TEST', day: 1, kind: 'SHARED_ACTIVITY' }],
};
const load = (file: unknown) => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion });
const freshFile = () => JSON.parse(serializeSave(createGame(config)));
function reject(file: unknown, path: string, cfg?: ScenarioConfig) {
  const read = () => cfg ? deserializeSave(JSON.stringify(file), { dataVersion: cfg.dataVersion, config: cfg }) : load(file);
  expect(read).toThrow(SaveError);
  expect(read).toThrow(path);
}

describe('평택 자료 판본의 저장과 이전 자료 거절', () => {
  it('0.4.1 실제 저장은 형식 4·5 모두 한국어 이유로 거절한다', () => {
    for (const formatVersion of [4, 5]) {
      reject({ ...legacyFixture, formatVersion }, '이전 판(부산 본사)의 저장입니다. 이번 판에서는 열 수 없습니다.');
    }
  });

  it('0.4.x 저장은 호출자가 옛 판본을 기대해도 거절한다', () => {
    for (const dataVersion of ['0.4.0', '0.4.1', '0.4.9']) {
      expect(() => deserializeSave(JSON.stringify({ ...legacyFixture, dataVersion }), { dataVersion }))
        .toThrow('이전 판(부산 본사)의 저장입니다. 이번 판에서는 열 수 없습니다.');
    }
  });

  it('판본 5은 새 문구로 거절한다', () => {
    expect(() => load(currentFixture)).toThrow(`이전 저장 형식(판본 ${5})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });
  it('판본 4은 새 문구로 거절한다', () => {
    expect(() => load(fixture)).toThrow(`이전 저장 형식(판본 ${4})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it('판본 4은 새 문구로 거절한다', () => {
    expect(() => load(fixture)).toThrow(`이전 저장 형식(판본 ${4})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it('판본 3은 새 문구로 거절한다', () => {
    expect(() => load({ ...fixture, formatVersion: 3 })).toThrow(`이전 저장 형식(판본 ${3})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it('판본 4은 새 문구로 거절한다', () => {
    expect(() => load({ ...fixture, state: { ...fixture.state, culture: records } })).toThrow(`이전 저장 형식(판본 ${4})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });
});

describe('판본 5와 이전 판본 읽기', () => {
  it('실제 설정은 M1에서 비활성이고 M2에서 활성이다', () => {
    for (const id of M1_SCENARIO_IDS) expect(loadScenario(id).culture).toBeNull();
    expect(loadScenario('SCENARIO_M2_MULTI_TRADE').culture).not.toBeNull();
  });

  it.each(SCENARIO_IDS)('%s의 culture 비활성 설정·초깃값은 비어 있고 판본 5로 왕복한다', id => {
    // M2 활성화 뒤에도 선행 작업의 비활성 저장 계약은 별도 설정으로 검증한다.
    const cfg = { ...loadScenario(id), culture: null };
    const s = createGame(cfg);
    expect(s.culture).toEqual(emptyCulture);
    const text = serializeSave(s);
    expect(JSON.parse(text).formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(deserializeSave(text, { dataVersion: cfg.dataVersion, config: cfg })).toEqual(s);
  });

  it('판본 4은 새 문구로 거절한다', () => {
    expect(() => load(fixture)).toThrow(`이전 저장 형식(판본 ${4})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it.each([1, 2, 3, 4])('판본 %i는 새 문구로 거절한다', version => {
    const cfg = loadScenario('SCENARIO_M1_ONE_TRADE');
    const s = createGame(cfg);
    const file = JSON.parse(serializeSave(s));
    file.formatVersion = version;
    delete file.state.culture;
    if (version <= 3) {
      delete file.state.xpAwards;
      delete file.state.xpAwardAmounts;
      for (const e of file.state.employees) delete e.xp;
    }
    if (version <= 2) {
      delete file.state.recruitment;
      for (const e of file.state.employees) delete e.availableFromDay;
    }
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: cfg.dataVersion })).toThrow(`이전 저장 형식(판본 ${version})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it.each([0, 8, '7', 6.5])('허용 목록 밖 판본 %s는 거절한다', version => {
    const file = freshFile();
    file.formatVersion = version;
    reject(file, '지원하지 않는 저장 형식 판본');
  });
});

describe('culture 모양·불변 조건', () => {
  it('경험 근거는 character_rules의 여섯 필드를 모두 보존한다', () => {
    const names = rules.country_policy.evidence_fields;
    const camel = names.map(name => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()));
    expect(Object.keys(records.experiences[0]!)).toEqual(expect.arrayContaining(camel));
  });

  it('세 기록의 완전한 모양은 허용한다', () => {
    const s = createGame(config);
    s.culture = structuredClone(records);
    expect(() => checkSaveShape(s)).not.toThrow();
  });

  it.each([undefined, null, []])('culture 객체 손상 %s의 경로를 보인다', value => {
    const file = freshFile();
    file.state.culture = value;
    reject(file, 'state.culture');
  });

  for (const group of ['reports', 'experiences', 'relationEvents'] as const) {
    it.each([undefined, null, {}])(`${group} 배열 손상 %s의 경로를 보인다`, value => {
      const file = freshFile();
      file.state.culture[group] = value;
      reject(file, `state.culture.${group}`);
    });
    for (const field of Object.keys(records[group][0]!)) {
      it.each(['누락', '잘못된 타입'])(`${group}.${field} %s을 거절한다`, damage => {
        const file = freshFile();
        file.state.culture = structuredClone(records);
        if (damage === '누락') delete file.state.culture[group][0][field];
        else file.state.culture[group][0][field] = typeof file.state.culture[group][0][field] === 'number' ? '1' : 1;
        reject(file, `state.culture.${group}[0].${field}`);
      });
    }
    it(`${group} 한 건도 culture가 꺼져 있으면 거절한다`, () => {
      const file = freshFile();
      file.state.culture[group] = structuredClone(records[group]);
      expect(() => checkSaveShape(file.state)).not.toThrow();
      reject(file, 'state.culture: 현지 활동이 꺼진 시나리오에는 기록이 없어야 합니다', { ...config, culture: null });
    });
  }

  it.each([['reports', 'status', 'VERIFIED'], ['relationEvents', 'kind', 'FRIEND']] as const)
  ('%s.%s 열거값 %s를 거절한다', (group, field, value) => {
    const file = freshFile();
    file.state.culture = structuredClone(records);
    file.state.culture[group][0][field] = value;
    reject(file, `state.culture.${group}[0].${field}`);
  });

  it('출처 인물 배열의 잘못된 원소도 경로로 거절한다', () => {
    const file = freshFile();
    file.state.culture = structuredClone(records);
    file.state.culture.reports[0].sourceContactIds = [1];
    reject(file, 'state.culture.reports[0].sourceContactIds[0]');
  });
});
