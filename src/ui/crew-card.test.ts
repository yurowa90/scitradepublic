import { describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame, openDay } from '../engine/engine';
import { crewEntries, crewEntryCard } from './recruitment';

describe('M1 카드와 카드 배치 유지',()=>{
  it('M1 카드 HTML은 이전 레벨·강화·접근 이름을 유지한다',()=>{
    const cfg=loadScenario('SCENARIO_M1_ONE_TRADE');
    const s=openDay(createGame(cfg),cfg).state;
    // TASK-0079: 카드 종류 클래스 한 조각만 걷고 이전 HTML을 그대로 대조한다.
    expect(crewEntryCard(crewEntries(s,cfg,'all')[0]!,s,cfg,false).replace(/ creature-(animal|myth_inspired|none)/g,'').replace(/[ \t]+$/gm,'')).toMatchInlineSnapshot(`
      "
        <article class="card attr-bg-light " data-action="select-card" data-emp="EMP01" tabindex="0" role="button" aria-pressed="false"
          aria-label="귀솔 직원 카드, 영업, 레벨 1, 대기 — 배정 가능">
          <header class="card-top">
            <span class="card-name">귀솔</span>
            <span class="chip attr attr-light"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/></svg>빛</span>
          </header>
          <div class="card-art">
            <span class="card-tag ">○ 대기</span>
            <div class="card-face" aria-hidden="true">귀</div>

          </div>
          <footer class="card-bottom">
            <div class="card-meta"><span class="chip role role-sales"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v11H9l-5 4v-4H3z" fill="none" stroke-width="2" stroke-linejoin="round"/><path d="M7 9h10M7 12h6" stroke-width="2" stroke-linecap="round"/></svg>영업</span><span class="card-level">레벨 1</span></div>

            <span class="card-schedule">대기 — 배정 가능</span>
          </footer>
        </article>"
    `);
  });
  it('카드 격자는 여러 열과 최대 300px 폭을 쓰며 기울기와 움직임 줄이기를 유지한다',async()=>{
    const {readFileSync}=await vi.importActual<{readFileSync:(path:URL,encoding:string)=>string}>('node:fs');
    const css=readFileSync(new URL('./style.css',import.meta.url),'utf8');
    expect(css).toMatch(/\.crew-cards\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(200px,\s*100%\),\s*1fr\)\)/);
    expect(css).toMatch(/\.crew-cards > \.card\s*\{[^}]*max-width:\s*300px/);
    expect(css).toContain('perspective(700px) rotateX(var(--tilt-x)) rotateY(var(--tilt-y))');
    expect(css).toMatch(/\.card\.is-selected\s*\{[^}]*--tilt-y:\s*-6deg/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.card\s*\{[^}]*transform:\s*none/);
  });
});

describe('TASK-0018 카드와 운영표 선택 의미',()=>{
  it.each([false,true])('선택 %s는 직원·후보 카드와 이름 단추에 같은 의미로 나타난다',async(selected)=>{
    const {candidateCard,crewRow}=await import('./recruitment');
    const cfg=loadScenario('SCENARIO_M2_MULTI_TRADE'),s=openDay(createGame(cfg),cfg).state;
    const entry=crewEntries(s,cfg,'all')[0]!;
    const c=s.recruitment.candidates[0]!,e=cfg.employees.find((e)=>e.id===c.employeeId)!;
    for(const html of [crewEntryCard(entry,s,cfg,selected),candidateCard(e,s,c,selected,cfg)]) {
      expect(html).toContain(`tabindex="0" role="button" aria-pressed="${selected}"`);
      expect(html.includes('✓ 선택됨')).toBe(selected);
    }
    const row=crewRow(entry.def,s,cfg,selected),tag=row.match(/<tr[^>]*>/)![0];
    expect(tag).not.toContain('tabindex');expect(tag).not.toContain('aria-selected');
    expect(row.match(/class="roster-pick"/g)).toHaveLength(1);
    expect(row).toContain(`aria-pressed="${selected}"><span class="nm">`);
    expect(row.includes('✓ 선택됨')).toBe(selected);
  });
});
