# 브라우저 화면 측정

정적 빌드를 포트 없이 요청 경로로 제공하고 실제 Chromium 배율에서 화면 좌표를 잰다. 프로필은 마우스 1366×657·1920×969, 터치 1366×657·1180×820·1024×768·1133×744·1000×700의 7개다. 창 높이는 화면 높이 + 87이며 viewport는 null이다.

```bash
node --test tools/browser/lib.test.mjs
node tools/browser/measure.mjs --dist dist --scenario tools/browser/scenarios/smoke.json --dry-run
node tools/browser/measure.mjs --dist dist --scenario tools/browser/scenarios/day-anchor.json --profiles all --font-cache /tmp/scitrade-font-cache --out /tmp/day-anchor.json
node tools/browser/measure.mjs --dist dist --scenario tools/browser/scenarios/culture-result-flow3.json --font-cache /tmp/scitrade-font-cache --out /tmp/culture-result-flow3.json
node tools/browser/measure.mjs --dist dist --scenario tools/browser/scenarios/local-tab-position.json --font-cache /tmp/scitrade-font-cache --out /tmp/local-tab-position.json
```

Claude는 비교할 두 빌드의 `--dist`와 출력 이름을 바꿔 같은 명령을 실행한다. 이전 회귀 빌드의 day-anchor 실패도 확인한다. Playwright와 Chromium은 기존 설치를 쓰고 `SCITRADE_PLAYWRIGHT`·`SCITRADE_CHROMIUM`으로 경로를 바꿀 수 있다. Codex 샌드박스에서는 Chromium이 죽을 수 있으므로 내장 시험과 `--dry-run`을 쓴다. 실행 시도에는 `--offline-fonts`를 붙인다. 빌드에 넣은 글꼴(D16, `public/fonts/` → 빌드의 `fonts/`)은 빌드 폴더에서 주고 `fonts.local`로 센다. 이런 빌드는 Google Fonts에 요청하지 않으므로 글꼴 캐시가 없어도 된다. `--font-cache`와 Google Fonts 가로채기는 글꼴을 넣기 전 빌드(3판 `a8ffa35`, `e4f7dfa` 등)를 비교해 잴 때만 쓰인다. 그런 빌드에서 글꼴 캐시가 없으면 글꼴 판정이 실패하며 그 수치는 비교에 쓰지 않는다.

시나리오는 schema·id·title_ko·source_ko·profiles·steps와 선택적 expect를 가진 JSON이다. profiles는 all·touch·mouse 또는 프로필 ID 목록이다. 단계는 tap·end-day·select·scroll-top·scroll-to·wait·remember·measure다. remember는 요소 id와 위치를 저장하고 measure의 ref가 다시 찾는다. 측정은 top·height·width·left-from-parent·top-from-bar·moved·scroll-y-change·overflow-x·bar-bottom이며 expect는 측정 이름의 min·max와 적용 프로필을 정한다. 선택자는 화면 속성과 제목 id 접두어로 고른다.

출력 JSON 키는 schema·scenario·dist·dist_index_sha256·chromium·runs·expect·ok 순서이며 시간 값은 없다. runs에는 실제 크기·배율·터치 여부·글꼴 요청 수(`cache`·`network`·`failed`·`local`)와 성공 여부·외부 차단 호스트·측정값·쪽 오류·단계 오류가 있다. 글꼴 성공은 실패 0건이고 글꼴 파일을 1건 이상 준 경우다. 빌드 폴더에 없는 `.woff2` 요청은 실패로 센다. 출력과 첫 글꼴 캐시 경로는 저장소 밖이어야 한다. 첫 캐시에만 새 글꼴을 쓰고 이후 캐시는 읽기만 한다.

종료 코드는 0(실행·글꼴·크기·기대 통과), 1(측정 실패), 2(사용법·설정 오류)다. dry-run은 브라우저 없이 빌드·시나리오·프로필·쓰기 경로를 검증한다.
