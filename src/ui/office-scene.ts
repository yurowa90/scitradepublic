// 확정된 고용·업무 상태를 읽는 사무실 장면. 열기·닫기는 시간을 진행시키지 않는다.
import './office-scene.css';
import assetIndex from '../assets/asset-index.json';
import { characterSprite } from './assets';
import type { GameState, ScenarioConfig } from '../engine/types';

// 기존 표시 함수를 호출 쪽에서 받아 첫 화면의 공유 청크가 늘지 않게 한다.
type OfficeReaders = {
  spriteHtml: typeof import('./sprite').spriteHtml;
  runningTaskOf: typeof import('../engine/reservations').runningTaskOf;
};

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const taskNames = { EXPORT_PREP: '수출 준비', FORWARDING_PREP: '주선 준비', SCOUT: '현장 조사', RECRUIT_QUEST: '영입 의뢰', CULTURE: '현지 활동', TRAINING: '일반 훈련' };
// 640×360 배경의 위쪽 책상 세 자리와 앞쪽 책상 세 자리. 좌표는 48×48 칸의 왼쪽 위다.
export const OFFICE_SEATS = [
  { x: 126, y: 142 }, { x: 174, y: 158 }, { x: 222, y: 174 },
  { x: 30, y: 230 }, { x: 78, y: 246 }, { x: 126, y: 262 },
] as const;
const background = assetIndex.assets.find((a) => a.id === 'BG_COMPANY_PX')!;

/** 폭으로 정한 기기 픽셀 정수 배율을 높이에도 맞춘다. 최소 배율에서는 내부 스크롤을 쓴다. */
export function officeScale(width: number, height: number, dpr: number): number {
  let n = Math.max(1, Math.floor(width * dpr / 640));
  while (n > 1 && 360 * n / dpr > height) n--;
  return n;
}

export function officeSceneHtml(state: GameState, config: ScenarioConfig, n: number, dpr: number, { spriteHtml, runningTaskOf }: OfficeReaders): string {
  const crew = state.employees.filter((e) => e.employmentStatus === 'employed').flatMap((e) => {
    const def = config.employees.find((d) => d.id === e.id), sheet = characterSprite(e.id);
    if (!def) return [];
    const task = runningTaskOf(state, e.id);
    return [{ sheet, row: task ? 'work' : 'idle', label: `${def.nameKo}, ${task ? `${taskNames[task.kind]} 중` : '대기'}` }];
  });
  return `<div class="office-stage" style="--office-unit: ${n / dpr}px; --pixel-dpr: ${dpr};" data-scale-n="${n}">
    <img class="pixel-art" src="${esc(background.path)}" width="640" height="360" alt="" />
    ${crew.filter((e) => e.sheet).slice(0, OFFICE_SEATS.length).map((e, i) => {
      const seat = OFFICE_SEATS[i]!;
      return `<span class="office-seat" style="left: calc(${seat.x} * var(--office-unit)); top: calc(${seat.y} * var(--office-unit));">${spriteHtml(e.sheet!, { row: e.row, scaleN: n, label: e.label })}</span>`;
    }).join('')}
  </div><ul class="office-crew">${crew.map((e) => `<li>${esc(e.label)}</li>`).join('')}</ul>`;
}

export function openOffice(state: GameState, config: ScenarioConfig, opener: HTMLElement, onClose: () => void, readers: OfficeReaders): void {
  const root = document.createElement('section');
  root.className = 'office-scene';
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'office-h');
  root.innerHTML = '<div class="office-dialog"><h2 id="office-h" tabindex="-1">사무실</h2><button data-office-close>닫기</button><div class="office-viewport"></div></div>';
  const outside = document.querySelector<HTMLElement>('#app')!;
  const previousInert = outside.inert;
  const progress = outside.querySelector<HTMLButtonElement>('[data-action="end-day"]')!;
  const previousDisabled = progress.disabled;
  outside.inert = true; progress.disabled = true;
  const viewport = root.querySelector<HTMLElement>('.office-viewport')!;
  let lastSize = '';
  const redraw = () => {
    const dpr = window.devicePixelRatio || 1;
    const headerHeight = viewport.getBoundingClientRect().top - root.querySelector<HTMLElement>('.office-dialog')!.getBoundingClientRect().top;
    const availableHeight = Math.max(0, window.innerHeight - headerHeight - 48);
    const n = officeScale(viewport.clientWidth, availableHeight, dpr);
    const size = `${n}:${dpr}`;
    if (size === lastSize) return;
    lastSize = size;
    viewport.innerHTML = officeSceneHtml(state, config, n, dpr, readers);
  };
  const observer = new ResizeObserver(redraw);
  const close = () => {
    observer.disconnect(); window.removeEventListener('resize', redraw);
    root.remove(); outside.inert = previousInert; progress.disabled = previousDisabled;
    onClose(); opener.focus({ preventScroll: true });
  };
  const button = root.querySelector<HTMLButtonElement>('[data-office-close]')!;
  button.addEventListener('click', close);
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ev.repeat && !ev.isComposing && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
      ev.preventDefault(); ev.stopPropagation(); close();
    }
    if (ev.key === 'Tab') { ev.preventDefault(); button.focus(); }
  });
  document.body.appendChild(root); redraw(); observer.observe(viewport);
  window.addEventListener('resize', redraw);
  root.querySelector<HTMLElement>('#office-h')!.focus({ preventScroll: true });
}
