// 동료 카드 자리표시자. 실제 일러스트가 생기면 .card-art 안의 내용만 교체한다.
// 구도(상단 이름·속성, 중앙 그림, 하단 레벨·일정)는 docs/ART_DIRECTION.md를 따르며 레퍼런스의 프레임·배지·이름은 쓰지 않는다.

import { isAvailableFromToday } from '../engine/employees';
import { levelFor, levelProgress } from '../engine/growth';
import { runningTaskOf } from '../engine/reservations';
import type { EmployeeDef, GameState, ScenarioConfig, Task } from '../engine/types';
import { coreStatsKo } from './growth';
import { crewStatusKo, taskSchedule } from './crew-status';
import { esc } from './html';
import { characterImage } from './assets';

const ATTRIBUTE: Record<string, { ko: string; icon: string }> = {
  water: { ko: '물', icon: '<path d="M12 3c3 5 6 8 6 11a6 6 0 0 1-12 0c0-3 3-6 6-11z"/>' },
  fire: { ko: '불', icon: '<path d="M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4 3-6 1 2 2 2 3 1 0-2-1-4 0-6z"/>' },
  wind: { ko: '바람', icon: '<path d="M4 9h11a3 3 0 1 0-3-3M4 14h14a3 3 0 1 1-3 3M4 19h7" fill="none" stroke-width="2.2" stroke-linecap="round"/>' },
  earth: { ko: '대지', icon: '<path d="M4 18l5-9 3 5 2-3 6 7z"/>' },
  light: { ko: '빛', icon: '<path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/>' },
  shadow: { ko: '그림자', icon: '<path d="M15 3a9 9 0 1 0 6 15A8 8 0 0 1 15 3z"/>' },
};

const ROLE_KO: Record<string, string> = { sales: '영업', operations: '운영' };

// REF-12 시각 의미 분리: 직무는 도구 모양 배지와 글자로, 속성은 문양으로, 근무 상태는 글자 라벨로 나타낸다.
// 색만으로 직무·상태를 구분하지 않는다.
const ROLE_ICON: Record<string, string> = {
  sales: '<path d="M3 5h18v11H9l-5 4v-4H3z" fill="none" stroke-width="2" stroke-linejoin="round"/><path d="M7 9h10M7 12h6" stroke-width="2" stroke-linecap="round"/>',
  operations: '<path d="M3 8l9-4 9 4v9l-9 4-9-4z" fill="none" stroke-width="2" stroke-linejoin="round"/><path d="M3 8l9 4 9-4M12 12v9" fill="none" stroke-width="2" stroke-linejoin="round"/>',
};

export function roleBadge(role: string): string {
  const ko = ROLE_KO[role] ?? role;
  const icon = ROLE_ICON[role];
  return `<span class="chip role role-${esc(role)}">${icon ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` : ''}${esc(ko)}</span>`;
}

export function attributeChip(attribute: string | null): string {
  const a = attribute ? ATTRIBUTE[attribute] : undefined;
  if (!a) return '<span class="chip">속성 미정</span>';
  return `<span class="chip attr attr-${esc(attribute ?? '')}"><svg viewBox="0 0 24 24" aria-hidden="true">${a.icon}</svg>${a.ko}</span>`;
}

export function crewCard(def: EmployeeDef, state: GameState, selected: boolean, config: ScenarioConfig, scheduleKo?: string): string {
  if (!isAvailableFromToday(state, def.id)) return '';
  const running = runningTaskOf(state, def.id);
  const schedule = scheduleKo ?? (running ? taskSchedule(running, config) : '대기 — 배정 가능');
  const initial = def.nameKo.slice(0, 1);
  const roleKo = ROLE_KO[def.role] ?? def.role;
  const art = characterImage(def.id, 'card');
  const progress = config.growth ? levelProgress(state, config, def.id) : null;
  const level = progress?.level ?? levelFor(state.employees.find((e) => e.id === def.id)!.xp);
  return `
  <article class="card creature-${esc(def.character.creatureKind ?? 'none')} attr-bg-${esc(def.character.attribute ?? 'none')} ${selected ? 'is-selected' : ''}" data-action="select-card" data-emp="${esc(def.id)}" tabindex="0" role="button" aria-pressed="${selected}"
    aria-label="${esc(def.nameKo)} 직원 카드, ${esc(roleKo)}, 레벨 ${level}, ${esc(schedule)}">
    <header class="card-top">
      <span class="card-name">${esc(def.nameKo)}</span>${selected ? '<span class="card-picked">✓ 선택됨</span>' : ''}
      ${attributeChip(def.character.attribute)}
    </header>
    <div class="card-art">
      <span class="card-tag ${running ? 'busy' : ''}">${esc(crewStatusKo(running))}</span>
      ${art
        ? `<img class="card-img pixel-art" src="${esc(art.path)}" width="${art.logicalWidth}" height="${art.logicalHeight}" data-pixel-w="${art.logicalWidth}" data-pixel-h="${art.logicalHeight}" alt="${esc(def.nameKo)} 일러스트" loading="lazy" decoding="async" />`
        : `<div class="card-face" aria-hidden="true">${esc(initial)}</div>
`}
    </div>
    <footer class="card-bottom">
      <div class="card-meta">${roleBadge(def.role)}<span class="card-level">레벨 ${level}</span></div>
      ${progress ? `<span>${esc(coreStatsKo(def, progress.stats))}</span>` : ''}
      <span class="card-schedule">${esc(schedule)}</span>
    </footer>
  </article>`;
}

/** 계약에 속하지 않는 조사·의뢰도 기존 업무 설명에 표시한다. */
export function taskName(kind: Task['kind']): string {
  return { EXPORT_PREP: '수출 준비', FORWARDING_PREP: '주선 준비', SCOUT: '현장 조사', RECRUIT_QUEST: '영입 의뢰', CULTURE: '현지 활동', TRAINING: '일반 훈련' }[kind];
}

export function roleKo(role: string): string { return ROLE_KO[role] ?? role; }
export function attributeKo(attribute: string | null): string { return (attribute ? ATTRIBUTE[attribute]?.ko : undefined) ?? '속성 미정'; }
