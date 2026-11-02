// 저장 파일: 게임 상태(일자 단계·처리한 명령 ID·적용한 사건 ID·난수 커서 포함)와 판본 정보.
// 다른 규칙·데이터 판본의 저장은 조용히 이어 쓰지 않고 거절한다.
// 저장 형식이 바뀌면 판본을 올리고, 형식 7만 읽고 옛 형식은 명시 문구로 거절한다.

import { loadScenario, LOADABLE_SCENARIO_IDS, type AnyScenarioId } from '../content/scenario';
import { ENGINE_VERSION, SUPPORTED_RULES_VERSIONS, type GameState, type ScenarioConfig } from './types';

import { checkSaveShape } from './save-shape';
import { checkInvariants } from './invariants';

export const SAVE_FORMAT = 'scitrade-save';
/**
 * 1: M1 (계약은 직접 무역뿐, 화물은 회사 소유뿐).
 * 2: M2a (운송 주선 계약 `serviceOfferId`, 화물 소유자 `ownerPartyId` 추가).
 * 3: 영입 후보 상태·근무 시작일·업무 대상 추가.
 * 4: 직원 누적 경험치·보상 중복 방지 키·지급액 추가.
 * 5: 현지 활동 기록(culture) 추가.
 * 6: 반복 시장·본사 운영(operations) 추가.
 * 7: 규칙 4의 놓친 견적 기록 추가. 형식 1~6은 읽지 않는다.
 */
export const SAVE_FORMAT_VERSION = 7;

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  formatVersion: number;
  engineVersion: string;
  rulesVersion: string;
  dataVersion: string;
  scenarioId: string;
  state: GameState;
}

export class SaveError extends Error {}

export const LEGACY_SAVE_MESSAGE = (n: number): string =>
  `이전 저장 형식(판본 ${n})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`;

export function serializeSave(state: GameState): string {
  const file: SaveFile = {
    format: SAVE_FORMAT,
    formatVersion: SAVE_FORMAT_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesVersion: state.meta.rulesVersion,
    dataVersion: state.meta.dataVersion,
    scenarioId: state.meta.scenarioId,
    state,
  };
  return JSON.stringify(file);
}

export function deserializeSave(text: string, expected: { dataVersion: string; rulesVersion?: string; config?: ScenarioConfig }): GameState {
  let file: SaveFile;
  try {
    file = JSON.parse(text) as SaveFile;
  } catch {
    throw new SaveError('저장 파일을 읽을 수 없습니다 (JSON 형식 오류).');
  }
  if (file?.format !== SAVE_FORMAT) throw new SaveError('Scitrade 저장 파일이 아닙니다.');
  if (typeof file.dataVersion === 'string' && /^0\.4\./.test(file.dataVersion)) {
    throw new SaveError('이전 판(부산 본사)의 저장입니다. 이번 판에서는 열 수 없습니다.');
  }
  if (Number.isInteger(file.formatVersion) && file.formatVersion >= 1 && file.formatVersion <= 6) {
    throw new SaveError(LEGACY_SAVE_MESSAGE(file.formatVersion));
  }
  if (file.formatVersion !== SAVE_FORMAT_VERSION) {
    throw new SaveError(`지원하지 않는 저장 형식 판본입니다 (${file.formatVersion}).`);
  }
  const known = (SUPPORTED_RULES_VERSIONS as readonly string[]).includes(file.rulesVersion);
  if (!known || (expected.rulesVersion !== undefined && file.rulesVersion !== expected.rulesVersion)) {
    throw new SaveError(
      `다른 경제 규칙 판본(${file.rulesVersion})의 저장입니다. ${expected.rulesVersion ? `이 시나리오의 규칙은 ${expected.rulesVersion}이며 ` : ''}규칙 판본 사이의 자동 이관은 없습니다.`,
    );
  }
  if (file.dataVersion !== expected.dataVersion) {
    throw new SaveError(`다른 데이터 판본(${file.dataVersion})의 저장입니다. 현재 데이터는 ${expected.dataVersion}입니다.`);
  }
  if (!file.state || typeof file.state.day !== 'number') throw new SaveError('저장 파일에 게임 상태가 없습니다.');
  try {
    if (!expected.config && !(LOADABLE_SCENARIO_IDS as readonly string[]).includes(file.scenarioId)) {
      throw new SaveError(`알 수 없는 저장 시나리오입니다 (${file.scenarioId}).`);
    }
    const config = expected.config ?? loadScenario(file.scenarioId as AnyScenarioId);
    if (config.id !== file.scenarioId) throw new SaveError('이관 설정과 저장 시나리오가 다릅니다.');
    const state = file.state;
    checkSaveShape(state);
    if (state.meta.scenarioId !== file.scenarioId || state.meta.rulesVersion !== file.rulesVersion
      || state.meta.dataVersion !== file.dataVersion || config.rules.rulesVersion !== file.rulesVersion
      || config.dataVersion !== file.dataVersion) throw new SaveError('저장 메타 정보와 설정이 다릅니다.');
    checkInvariants(state, config);
    return state;
  } catch (error) {
    if (error instanceof SaveError) throw error;
    throw new SaveError(`저장 상태 검증 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}
