// 첫 화면의 현지 탭·읽던 자리·하루 진행 알림.
import venues from '../../data/venues.json';
import { cityName } from '../engine/catalog';
import { cultureBook } from '../engine/culture';
import type { CommandResult, GameState, ScenarioConfig, Task } from '../engine/types';
import { esc } from './html';
import type { initialUiState } from './session';
import { lazyScreen } from './lazy';

type CultureUi = Pick<ReturnType<typeof initialUiState>, 'cultureOpen' | 'cultureActivityId' | 'cultureEmployeeId'
  | 'cultureBookOpen' | 'cultureSeenDay' | 'cultureShowFromDay'>;

export const CULTURE_KO = {
  local: (city: string) => `${city} 현지`,
  close: '닫기', newResult: '새 기록 있음', places: (count: number) => `장소 ${count}곳`,
  resultButton: '결과 보기',
  toastOne: (day: number, topic: string, employee: string) => `${day}일 현지 활동 기록: ${topic} — ${employee}`,
  toastRepeat: (day: number, topic: string, employee: string, reportDay: number) => `${day}일 현지 활동: ${topic} — ${employee} (회사 보고서는 ${reportDay}일에 이미 있음)`,
  toastMany: (day: number, topics: string[], newReports: number) => `${day}일 현지 활동 ${newReports === topics.length ? '기록 ' : ''}${topics.length}건${newReports === topics.length ? ''
    : newReports === 0 ? '(회사 보고서는 모두 이미 있음)' : `(새 회사 보고서 ${newReports}건)`}: ${topics.map((t) => `‘${t}’`).join(', ')}`,
  toastRejected: (day: number, reasons: string[]) => `실행하지 못한 명령: ${reasons.join(' / ')} · ${day}일 현지 활동 기록이 있습니다.`,
};
const employeeName = (config: ScenarioConfig, id: string | null) => config.employees.find((e) => e.id === id)?.nameKo ?? '';
const contactName = (config: ScenarioConfig, id: string) => config.culture?.contacts.find((c) => c.id === id)?.nameKo ?? '';
const localVenues = (config: ScenarioConfig) => venues.items.filter((v) => v.city_id === config.homeCityId);
const newest = <T>(items: T[], day: (item: T) => number): T[] => [...items].reverse().sort((a, b) => day(b) - day(a));

export function cultureResultTasks(state: GameState, config: ScenarioConfig, fromDay: number): Task[] {
  return config.culture ? newest(state.tasks.filter((t) => t.kind === 'CULTURE' && t.status === 'DONE'
    && t.completedDay !== null && t.completedDay >= fromDay), (t) => t.completedDay!) : [];
}

/** 하루 진행 뒤 읽던 자리의 블록 후보: [블록 id, 기준 제목 id]. 블록이 화면에 걸치면 제목이 막대 위여도 기준이 된다. */
export function cultureAnchorBlocks(state: GameState, config: ScenarioConfig, ui: CultureUi): [string, string][] {
  if (!config.culture || !ui.cultureOpen) return [];
  return [
    ...cultureResultTasks(state, config, ui.cultureShowFromDay ?? state.day - 1).map((t): [string, string] => [`culture-result-${t.id}`, `culture-result-h-${t.id}`]),
    ...(ui.cultureActivityId ? [['culture-employees', 'culture-emp-h'] as [string, string]] : []),
    ...(ui.cultureBookOpen ? cultureBook(state, config).reports.map((r): [string, string] => [`culture-report-${r.taskId}`, `culture-report-h-${r.taskId}`]) : []),
  ];
}

export function cultureTab(state: GameState, config: ScenarioConfig, ui: CultureUi): string {
  if (!config.culture) return '';
  const label = CULTURE_KO.local(cityName(config, config.homeCityId));
  const hint = ui.cultureOpen ? CULTURE_KO.close
    : cultureResultTasks(state, config, ui.cultureSeenDay ?? state.day - 1).length ? CULTURE_KO.newResult
      : CULTURE_KO.places(localVenues(config).length);
  return `<button id="local-tab" class="local-tab" data-action="culture-tab" aria-expanded="${ui.cultureOpen}"${ui.cultureOpen ? ' aria-controls="local-body"' : ''}><span>${esc(label)}</span><small>${esc(hint)}</small></button>`;
}

export function cultureToastText(state: GameState, config: ScenarioConfig, rejected: CommandResult[] = []) {
  const tasks = cultureResultTasks(state, config, state.day - 1).filter((t) => t.completedDay === state.day - 1);
  if (!tasks.length) return null;
  const topic = (task: Task) => config.culture!.activities.find((a) => a.id === task.subjectId)?.topic.titleKo ?? '';
  const first = tasks[0]!;
  const book = cultureBook(state, config);
  const report = book.reports.find((r) => r.activityId === first.subjectId);
  const employee = employeeName(config, first.assignedEmployeeId);
  return { kind: rejected.length ? 'warn' as const : 'info' as const, action: 'culture-result' as const,
    text: rejected.length ? CULTURE_KO.toastRejected(state.day - 1, rejected.map((r) => r.reasonKo))
      : tasks.length > 1 ? CULTURE_KO.toastMany(state.day - 1, tasks.map(topic), tasks.filter((t) => book.reports.some((r) => r.taskId === t.id)).length)
        : report && report.taskId !== first.id ? CULTURE_KO.toastRepeat(state.day - 1, topic(first), employee, report.day)
          : CULTURE_KO.toastOne(state.day - 1, topic(first), employee) };
}

export const culturePanelScreen = lazyScreen(() => import('./culture-panel'));
export const culturePanel: typeof import('./culture-panel').culturePanel = (...args) => {
  if (!args[3].culture || !args[4].cultureOpen) return '';
  return culturePanelScreen.get()!.culturePanel(...args);
};
export const cultureNotebook: typeof import('./culture-panel').cultureNotebook = (...args) => culturePanelScreen.get()!.cultureNotebook(...args);
export const cultureResults: typeof import('./culture-panel').cultureResults = (...args) => culturePanelScreen.get()!.cultureResults(...args);
export const cultureVenues: typeof import('./culture-panel').cultureVenues = (...args) => culturePanelScreen.get()!.cultureVenues(...args);
