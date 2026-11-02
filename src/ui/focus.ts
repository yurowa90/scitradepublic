/** 대상별 제목을 먼저 찾고 대기열 제목을 마지막 대안으로 쓴다. */
export const FOCUS_FALLBACK_SELECTORS = ['.employee-detail', '.recruit-site', '.recruit-candidate'] as const;
export function focusFallbackIds(data:Record<string,string|undefined>, blockHeading?:string):string[] {
  return [data.action==='train' && data.emp ? `growth-h-${data.emp}` : undefined, blockHeading, 'queue-h']
    .filter((id):id is string=>Boolean(id));
}

export const FIXED_REGION_SELECTOR = '.statusbar, .skip-links, .flash-toast';
