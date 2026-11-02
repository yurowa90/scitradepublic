# 웹 글꼴 출처·라이선스 (D16)

사용자 결정 D16 가(2026-10-10): 글꼴을 지금 빌드에 넣는다. 원본 파일과 OFL 사본을 함께 넣고, 크기가 크면 한글 부분 집합을 검토한다. 적용은 평택판 빌드부터다. 부산 3판(`a8ffa35`)과 `e4f7dfa`까지는 `index.html`이 Google Fonts에서 글꼴을 불러왔다. 이 기록은 그 빌드들의 사실을 바꾸지 않는다.

| 글꼴 | 라이선스 | 예약 글꼴 이름(RFN) | 넣은 파일 | 수정 여부 |
|---|---|---|---|---|
| Gowun Dodum 400 | SIL OFL 1.1 | 없음 | 저작자 TTF(7.2MB)를 unicode-range 96조각 WOFF2로 나눔(`public/fonts/gowun-dodum/`) | 수정본(부분 집합·형식 변환). RFN이 없어 이름 그대로 |
| IBM Plex Sans KR 400·600·700 | SIL OFL 1.1 | `Plex` | IBM이 배포한 분할 WOFF2 94조각×3(`public/fonts/ibm-plex-sans-kr/`) | 수정 없음(바이트 그대로) |

연결: `index.html` → `/fonts/fonts.css`(빌드 뒤 `./fonts/fonts.css`). 글꼴 이름과 굵기(`'Gowun Dodum'` 400, `'IBM Plex Sans KR'` 400·600·700)는 전과 같아 `src/ui/style.css`를 바꾸지 않았다.

## 1. 라이선스 확인 (1차 출처)

### Gowun Dodum

- 저작자 저장소: <https://github.com/yangheeryu/Gowun-Dodum>, `master` = `6d9ef10fc745cf3b0a4aba02dad1c740f94d029b`(2021-06-10, ‘Updating for GF’). git으로 확인했다.
  - `OFL.txt` 첫 줄: `Copyright 2021 The Gowun Dodum Project Authors (https://github.com/yangheeryu/Gowun-Dodum)`.
  - 뒤에 ‘with Reserved Font Name’ 문구가 없다. 따라서 RFN은 없다(OFL 정의: RFN은 저작권 문장 뒤에 적은 이름이다).
- Google Fonts 저장소: <https://github.com/google/fonts/tree/main/ofl/gowundodum>(커밋 `bd8f81ddb5c74d5c8897b36ad88b440266245103`에서 읽음).
  - `METADATA.pb`: `license: "OFL"`, `source { repository_url: "https://github.com/yangheeryu/Gowun-Dodum" commit: "6d9ef10…" }`.
  - `GowunDodum-Regular.ttf`와 `OFL.txt`는 저작자 저장소 파일과 바이트가 같다.
- 글꼴 메타데이터(원본 TTF):
  - 이름 0(저작권)은 위와 같다.
  - 이름 13: ‘This Font Software is licensed under the SIL Open Font License, Version 1.1. …’, 이름 14: `https://scripts.sil.org/OFL`.
  - `Version 2.000`, 글리프 12,550개, 문자 12,494개, `fsType` 0(내장 제한 없음).

| 원본 파일 | 크기(바이트) | SHA-256 |
|---|---:|---|
| `fonts/ttf/GowunDodum-Regular.ttf`(= google/fonts 사본) | 7,229,088 | `a6e457933227483a11758fd0947bc74422a106d46f0bf057fdaa5af94a30067d` |
| `OFL.txt`(= `public/fonts/gowun-dodum/OFL.txt`) | 4,395 | `a7c73f9521cd646bbdfb6684c99a62311bbd7bce11898dc11ef0b3c69eda1aca` |

### IBM Plex Sans KR

- IBM 공식 저장소: <https://github.com/IBM/plex>, 태그 `@ibm/plex-sans-kr@1.1.0` → 커밋 `1da12f02587b630c07e92692d21492d722f53614`(2024-11-11 릴리스 커밋, 부모 ‘release: v1.1.0 (#601)’). git으로 확인했다.
- 같은 판의 npm 묶음: `@ibm/plex-sans-kr` 1.1.0(<https://www.npmjs.com/package/@ibm/plex-sans-kr>, 2024-11-11 게시).
  - `gitHead`가 위 커밋과 같다. `license: "OFL-1.1"`.
  - 묶음 파일: `plex-sans-kr-1.1.0.tgz`, 17,153,875바이트. SHA-1 `2ea1c1613a974a6eea23f26a6dbbd61028c292fb`(npm `shasum`과 같음), SHA-256 `d351afb104446fe1b877144a36f10b3c05ea675de187b573c35a73023c5f9ae5`.
  - 넣은 파일 286개(조각 282 + CSS 3 + `license.txt`)는 모두 태그 트리의 `packages/plex-sans-kr/fonts/split/woff2/hinted/` git 블롭과 같다(`git hash-object` 대조, 불일치 0).
- 라이선스 문구: 묶음의 `LICENSE.txt`와 글꼴 폴더의 `license.txt`가 같은 문구다(공백·줄바꿈만 다름).
  - 첫 줄: `Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"`.
  - 따라서 RFN은 `Plex`다.
- IBM 배포 형태: 묶음 README의 ‘Web usage’에 ‘IBM Plex .woff2 and .woff files split into performant subsets of glyphs’와 CSS가 있다. IBM이 직접 만들어 배포하는 웹용 분할 파일이라는 뜻이다.
  - `fonts/split/woff2/hinted/IBMPlexSansKR-*.css`의 unicode-range가 이 조각과 짝을 이룬다.
  - 완전한 파일(`fonts/complete/woff2/hinted/`, 굵기당 370~440KB)도 있다. 첫 화면 바이트를 줄이려고 분할 파일을 골랐다.
- 글꼴 메타데이터(IBM 파일):
  - 이름 0: `Copyright 2018 IBM Corp. All rights reserved.`, 이름 13: OFL 1.1 문구, 이름 14: `http://scripts.sil.org/OFL`.
  - `Version 1.003`, `fsType` 0.
- `license.txt`(= `public/fonts/ibm-plex-sans-kr/license.txt`): 4,360바이트, SHA-256 `91c25c350d3cac39da2736d74f7ba37ef648f5237a4e330a240615bc8d8c4360`.
- 참고: npm 묶음에는 설치 때 도는 IBM 원격 측정 스크립트(`postinstall: ibmtelemetry`)가 있다. 이 작업은 `npm install`을 하지 않았다. tarball을 풀어 파일만 복사했다. `package.json` 의존성도 추가하지 않았다.
- GitHub 릴리스 페이지의 웹 zip은 이 환경의 프록시 정책(github.com 웹 403)으로 열지 못했다. 같은 태그의 git 트리와 npm 묶음으로 대조했다.
- ‘IBM Plex’는 IBM의 상표다. 글꼴 이름을 가리킬 때만 쓰고, IBM이 이 게임을 보증하는 것처럼 쓰지 않는다.

## 2. OFL FAQ 대조

기준: SIL OFL-FAQ 1.1-update7(2023-11), <https://openfontlicense.org/ofl-faq/>(2026-10-10 읽음, robots.txt 허용).

- 2.1: `@font-face`로 같은 서버에서 웹 글꼴을 주는 것은 허용되며 배포에 해당한다.
- 1.9·1.10: 글꼴이 내려받혀 오프라인에서도 쓸 수 있으면 저작권 고지와 라이선스를 함께 둔다. 그래서 OFL 사본을 글꼴 폴더에 두어 배포 사이트의 `fonts/…/OFL.txt`·`license.txt`로 함께 올라가게 했다.
- 2.2·2.2.1: TTF를 WOFF·WOFF2로 바꾸는 것은 보통 수정이다. 원래 글꼴 데이터를 압축만 하고 메타데이터를 그대로 두면 수정이 아니다.
- 2.5·2.6: 부분 집합(글리프 제거)은 수정본이다. 허용되지만 보통 RFN을 쓸 수 없다.
- 5.1: RFN은 원본과 원저작자가 만든 수정본에만 쓰는 이름이다.
- 5.6: RFN이 없으면 수정본도 원래 이름을 쓸 수 있다.

적용:

- **Gowun Dodum:** 우리 조각은 수정본(부분 집합 + WOFF2)이다. RFN이 없어 `Gowun Dodum` 이름을 그대로 쓴다. 남은 조건은 다음과 같다.
  - 조건 2: 저작권 고지와 라이선스를 함께 둔다. `OFL.txt`를 동봉하고 각 조각에 이름 0·13·14를 남겼다.
  - 조건 4: 저작자 이름으로 수정본을 홍보하지 않는다.
  - 조건 5: 수정본도 OFL로만 배포한다.
- **IBM Plex Sans KR:** 저작권자 IBM이 만든 분할 파일을 바이트 그대로 쓴다. 우리가 수정하지 않았으므로 RFN 문제가 없다.
  - CSS의 `font-family: 'IBM Plex Sans KR'`는 수정하지 않은 IBM 파일을 가리키는 이름이다.
  - **금지:** 이 파일을 우리가 다시 자르거나 형식·메타데이터를 바꾸면 수정본이 된다. 그러면 `Plex`가 든 이름(글꼴 내부 이름과 사용자에게 보이는 이름)을 쓸 수 없다. 필요하면 IBM의 새 판 분할 파일로 통째로 바꾼다.

## 3. 넣은 파일과 다시 만들기

| 폴더 | 파일 | 크기(바이트) |
|---|---|---:|
| `public/fonts/gowun-dodum/` | `GowunDodum-Regular-00.woff2`~`-95.woff2` 96개(1,380~19,136) + `OFL.txt` | 1,305,920 + 4,395 |
| `public/fonts/ibm-plex-sans-kr/` | `IBMPlexSansKR-{Regular,SemiBold,Bold}-00~93.woff2` 282개(2,544~17,712) + `license.txt` | 2,689,368 + 4,360 |
| `public/fonts/` | `fonts.css`(규칙 378개) | 173,953 |
| 합계 | 381개 | 4,177,996 |

굵기별 IBM 조각 합: Regular 923,880, SemiBold 920,280, Bold 845,208바이트.

`fonts.css`:

- Gowun Dodum의 unicode-range는 Google Fonts가 같은 글꼴(v12)에 쓰는 95개 범위를 옮겼다. 출처는 2026-10-09 측정 캐시의 CSS 응답이다. 범위(문자 목록)만 옮겼고 Google 파일은 넣지 않았다.
  - Google 범위에 없는 원본 문자 70개(결합 부호, 위·아래 첨자 숫자, `ﬁ ﬂ`, 괄호 라틴 대문자 등)는 96번째 조각(`-95`)에 담았다.
  - 이로써 원본 문자 12,494개를 모두 덮는다.
- IBM Plex Sans KR의 범위는 IBM CSS(`IBMPlexSansKR-{Regular,SemiBold,Bold}.css`)와 같다. 원본 문자 12,183개를 모두 덮는다.
  - IBM CSS의 `local()`은 뺐다. 기기에 설치된 다른 판이 쓰이지 않게 하려는 것이다.
  - `font-display: swap`을 더했다(전의 Google 링크 `display=swap`과 같다).
- 겹치는 범위의 우선순위가 Google·IBM CSS와 같도록 규칙 순서를 지켰다. 추가 조각은 다른 범위와 겹치지 않는다.

Gowun Dodum 조각 다시 만들기·확인(`tools/fonts/subset_gowun_dodum.py`):

- 실행 환경: 저장소 밖 가상 환경, `fonttools==4.60.1`, `brotli==1.1.0`.
- 입력: 원본 TTF. SHA-256을 확인한다.
- 처리: `fonts.css`의 Gowun 규칙마다 그 범위로 부분 집합을 만든다.
- 옵션: OpenType 기능 전부(`layout_features='*'`), 이름 기록 전부(`name_IDs='*'`, 모든 언어, 맥 이름), `.notdef` 윤곽 유지. 원본 수정 시각을 유지하고 WOFF2로 저장한다.
- `DSIG`는 fontTools 기본값대로 뺀다. 원본에 TrueType 힌트 표가 없다.
- `--check`는 다시 만든 결과가 저장소 파일과 바이트 단위로 같은지 본다. 2026-10-10 실행에서 96개 모두 같았다.
- 같은 범위의 Google 조각과 크기가 비슷하다. 측정 캐시에 있는 12개 조각 기준으로 Google 176,440바이트, 우리 176,032바이트다.

IBM 파일 확인: IBM/plex 태그 커밋 `1da12f0`의 `packages/plex-sans-kr/fonts/split/woff2/hinted/<파일>` 블롭 ID와 `git hash-object public/fonts/ibm-plex-sans-kr/<파일>`이 같아야 한다.

## 4. 측정 (2026-10-10, Chromium 141.0.7390.37, Playwright)

비교한 빌드:

- 이 작업 빌드: `7c4dd59`. git 작업 트리를 따로 꺼내 깨끗한 상태로 빌드했다(빌드 표시 `7c4dd59`).
- 기준 빌드: `e4f7dfa`. 같은 방식으로 빌드했다.
- 두 빌드의 JS는 빌드 표시 문자열만 다르다. CSS는 같다. `index.html`은 글꼴 링크만 다르다.
- Google 글꼴은 측정 캐시에서 줬다. 기준 빌드의 세 시나리오에서 캐시에 없던 Google 조각 9개는 측정 도구가 내려받아 저장소 밖 캐시에 더했다.

### 외부 요청과 실제 사용 글꼴 (첫 화면, 7개 프로필 모두 같음)

| 항목 | `e4f7dfa`(Google Fonts) | `7c4dd59`(내장) |
|---|---|---|
| fonts.googleapis.com·fonts.gstatic.com 요청 | 47건(CSS 1 + 조각 46) | 0건 |
| 그 밖의 외부 호스트 | 없음 | 없음 |
| `document.fonts.check`(Gowun 400, Plex 400·600·700) | 모두 참 | 모두 참 |
| 불러온 글꼴 면 / 오류 | Gowun 12·Plex 34 / 0 | Gowun 12·Plex 33 / 0 |

- 계산된 `font-family`는 두 빌드가 같다. body는 `"IBM Plex Sans KR", system-ui, sans-serif`이고, h2·h3·`.logo`·`.card-name`은 `"Gowun Dodum", "IBM Plex Sans KR", sans-serif`다.
- 실제 그린 글꼴은 CDP `CSS.getPlatformFontsForNode`로 셌다. l1366 첫 화면의 글자 요소 430개가 대상이다.
  - 두 빌드 모두 IBM Plex Sans KR 4,232글자, Gowun Dodum 588글자, Plex SemiBold 37글자다.
  - 시스템 글꼴은 그림 문자 4개(Noto Color Emoji)뿐이다.
- 8개 시나리오 × 7개 프로필 측정(아래)에서 이 작업 빌드는 56회 모두 `fonts.cache`·`network`·`failed`가 0이다. `blocked_hosts`는 비었고 `fonts.local`은 45~52다.

### 첫 화면 글꼴 바이트 (7개 프로필 모두 같음)

| 항목 | `e4f7dfa`(Google Fonts) | `7c4dd59`(내장) |
|---|---:|---:|
| WOFF2 조각 | 46개, 662,304 B | 45개, 494,556 B |
| ↳ Gowun Dodum | 12개, 176,440 B | 12개, 176,032 B |
| ↳ IBM Plex Sans KR | 34개, 485,864 B | 33개, 318,524 B |
| 글꼴 CSS 원래 크기 | 237,625 B(Chromium용 응답) | 173,953 B |
| 글꼴 CSS gzip -9 / brotli 추정 | 53,302 / 9,893 B | 46,738 / 10,386 B |
| 합계(조각 + brotli CSS) | 약 672 KB | 약 505 KB(−25%) |

- 바이트는 측정 도구가 응답한 본문 크기다. WOFF2는 이미 압축돼 전송 크기와 같다.
- CSS의 실제 전송 크기는 서버 압축에 따라 다르다. Google과 Netlify 모두 압축해 보낸다. 표의 gzip·brotli 값은 Node zlib으로 다시 압축한 추정값이다.
- Plex 조각이 작은 까닭: Google 조각(판 1.001)에는 TrueType 힌트 표(`fpgm`·`prep`·`cvt `·`VDMX`)가 있다. IBM 분할 파일(1.003)에는 없다.
- 첫 방문 뒤에는 브라우저 캐시를 쓴다. 우리 파일 이름에는 내용 해시가 없어 Netlify 기본 헤더에서는 다시 확인 요청(304)이 날 수 있다.

### 배치 비교 (8개 시나리오 × 7개 프로필, 측정값 126개)

시나리오: smoke, day-anchor, culture-result-flow3, local-tab-position, report-contract-link, schedule-toggle, crew-facet, campaign-end. 모든 실행이 `ok`이고 기대 범위를 통과했으며 쪽 오류는 0이다.

| 값 | 프로필 | `e4f7dfa` | `7c4dd59` | 빌드 표시만 `e4f7dfa`로 바꾼 `7c4dd59` |
|---|---|---:|---:|---:|
| smoke `bar_bottom_day1` | l1366·l1920 | 149.8 | 149.8 | 149.8 |
| | cb1366t | 165.8 | 165.8 | 165.8 |
| | ipadAirL·ipadmini6L | 166.3 | 166.3 | 166.3 |
| | **ipadminiL(1024×768)** | 166.3 | **219.9** | 166.3 |
| | t1000 | 219.9 | 219.9 | 219.9 |
| local-tab-position `tab_top` | l1366·l1920 / cb1366t / ipadAirL·ipadmini6L / t1000 | 175.6 / 191.6 / 192.6 / 246.2 | 같음 | 같음 |
| | **ipadminiL** | 192.6 | **246.2** | 192.6 |
| local-tab-position `tab_height` | 모두 | 44 | 44 | 44 |
| crew-facet `res_h_top_day1` | **ipadminiL** | 2081.8 | **2135.4** | 2081.8 |
| day-anchor `anchor_moved` | 모두 | −0.4~0 | 같음 | 같음 |
| culture-result-flow3 `result_from_bar` | 모두 | 36.8~43.9 | ipadminiL만 +0.1 | 같음 |
| campaign-end `settlement_from_bar` | ipadminiL | 0.2 | −0.2 | 0.2 |

- 1px를 넘는 차이 4건은 모두 ipadminiL(1024×768)의 같은 53.6px 이동이다. 글꼴 때문이 아니다.
  - 원인은 머리 줄의 빌드 표시(`시제품 · … · 빌드 <해시>`) 너비다.
  - `7c4dd59`가 `e4f7dfa`보다 6.62px 넓다. Plex 12px에서 `f`는 3.89px, 숫자는 7.2px다.
  - `e4f7dfa`에서 1024px 머리 줄의 남는 폭은 1.32px뿐이었다. 그래서 저장·불러오기 버튼 묶음이 둘째 줄로 내려가 상태 막대가 53.6px 아래로 갔다.
- 빌드 표시 문자열만 `e4f7dfa`로 바꾼 `7c4dd59` 빌드로 같은 56회를 다시 쟀다. 이 빌드는 JS가 기준 빌드와 바이트 단위로 같다. 측정값 126개가 기준 빌드와 모두 같았다(0.1px 차이도 없음).
  - 따라서 글꼴 교체에 따른 배치 차이는 이 측정 범위에서 0이다.
- 글리프 수치 대조(fontTools): 측정 캐시의 Google 조각에 든 문자를 우리 파일과 비교했다.
  - 가로 폭: Gowun 1,335자, Plex 400 1,643자, 700 1,123자는 모두 같다. Plex 600은 645자 중 `↑`·`↓` 2자만 우리 쪽이 124/1000em 넓다(16px에서 약 2px).
  - 세로 수치(`hhea` 1085/−415, Gowun 1160/−288)와 `USE_TYPO_METRICS` 꺼짐도 같다.
  - Plex 라틴 커닝 쌍(Google 조각 기준 1,447·1,551·1,454쌍)에서 다른 값은 `jY` 1쌍뿐이다(400: −60→−20, 600: −39→−6). IBM 쪽에만 있는 쌍은 21~26개다.
  - 측정 시나리오의 첫 화면과 흐름에서는 이 차이가 배치에 드러나지 않았다.

## 5. 남은 위험·열린 점

- **1024×768 머리 줄 여유(글꼴과 무관, 기존 문제):** 빌드 표시의 해시 글자에 따라 머리 줄이 두 줄이 될 수 있다.
  - 무작위 7자 해시의 약 95%는 `e4f7dfa`보다 1.32px 넘게 넓다. Plex 글자 폭으로 계산한 추정이다.
  - 따라서 평택판 ipadminiL의 `bar_bottom_day1`은 대개 219.9가 된다. `+수정` 표시가 붙어도 같다.
  - 이전 측정과 비교할 때는 빌드 표시를 같게 하거나 이 이동을 따로 본다.
  - 고치려면 `src/ui/style.css`·`main.ts`(다른 세션 담당)에서 빌드 표시 폭을 고정하거나 머리 줄 여유를 늘린다.
- **IBM Plex Sans KR 판 차이:** 3판까지는 Google이 주는 판(측정 캐시 기준 `Version 1.001`)이었다. 이제 IBM 판 `Version 1.003`이다.
  - 위에서 잰 가로 폭 차이는 SemiBold `↑↓`뿐이다. 다만 측정 캐시에 없던 문자는 대조하지 않았다.
  - IBM 파일에는 TrueType 힌트가 없다. 저배율 Windows 화면에서는 획 모양이 3판과 조금 다를 수 있다(실기기 미확인).
- **CSS 크기:** `fonts.css` 174KB는 렌더링을 막는 CSS다. 압축 전송(brotli 약 10KB)을 전제로 한다. 압축하지 않는 서버에 올리면 첫 화면이 늦어진다.
- **캐시 헤더:** 배포 스크립트(`tools/deploy/prepare_static.sh`)는 `/fonts/*`에 긴 캐시 헤더를 주지 않는다. 필요하면 별도 작업으로 정한다.
- **저장소 크기:** `public/fonts/`가 4.18MB를 더한다. Gowun 원본 TTF(7.2MB)는 넣지 않았다. 출처와 해시를 위에 적었다.
- **실기기 미확인:** 학교망·iPad Safari에서 글꼴이 보이는지는 평택판 배포 뒤 실기기 확인 항목으로 남는다(`docs/DECISIONS.md:899`).
