# Scitrade

현대 무역·물류 경영과 동물·신수 동료 수집을 결합한 **교육용 경영 게임**의 공개 저장소입니다. 학생이 평택 본사의 작은 무역상사를 운영하며 환율·운임·관세·결제 조건 같은 국제물류와 무역의 판단을 직접 해 봅니다.

> **상태: 개발 중인 시제품입니다.** 공개 플레이용 완성판이 아닙니다. 게임 수치는 설계용 가상값(DESIGN)이며, 실제 경제 자료로 보정하지 않았습니다. 사람 플레이테스트와 교육 효과 검증도 아직 하지 않았습니다.

## 무엇이 들어 있나

| 위치 | 내용 |
|---|---|
| `src/engine` | UI와 분리된 TypeScript 결정적 시뮬레이션 엔진(계약·운송 주선·자원 예약·환율·관세·클레임·수금, 동료 영입·성장) |
| `src/ui` | 최소 화면(견적판·계약 목록·자원 패널·동료 카드·픽셀 세계지도·상황실 지도·결산) |
| `data`, `schemas` | 시나리오·품목·노선·동료 등 구조화 콘텐츠와 JSON 스키마 |
| `tests` | 인수 명세(acceptance cases) |
| `tools` | 자료 검사기, 골든 결과 비교기, 픽셀 그림 검사 도구, 묶음 크기 검사 |
| `docs` | 설계(v0.4), 화면 명세, 흐름도, 동료·조직 설계, 미술 방향·픽셀 규격, 검증 범위 |

## 실행

Node.js 22 이상, Python 3.11 이상에서:

```bash
npm install
npm run dev        # 화면 (http://localhost:5173)
npm test           # 엔진·화면 시험
npm run typecheck
python3 tools/validate_data.py   # 자료 검사
bash tools/ci/checks.sh --check  # CI와 같은 검사 묶음
```

## 설계 원칙

- **결정적 엔진:** 같은 상태·명령·시드에서 같은 결과를 냅니다. 골든 결과 비교로 회귀를 막습니다.
- **가상값과 실측의 구분:** 게임 수치는 가상값이며 출처·판본·기준일을 자료에 남깁니다. 실명 기업·선박을 쓰지 않습니다.
- **동료 표현:** 실제 동물과 각 지역 전승의 신수를 원전·보전 자료와 대조해 그리고, 국가 상징·상표와 겹치는 도상을 피합니다. 멸종위기종은 포획·구매로 얻지 않습니다.

## 참고 사항

- 자료와 코드 주석에 나오는 `docs/DECISIONS.md`, `docs/STATUS.md`, `docs/ai/…` 등의 경로는 **비공개 개발 기록**을 가리킵니다. 이 공개 저장소에는 포함하지 않았습니다.
- 그림 자산은 AI 이미지 생성 결과를 픽셀화·보정한 것입니다(절차는 `docs/art/PIXEL_SPEC.md`, `docs/art/PROMPTS.md`).

## 출처와 크레딧

- 지도: [Natural Earth](https://www.naturalearthdata.com/) (퍼블릭 도메인)
- 야간 불빛 레이어: NASA Black Marble 기반 가공 이미지. Credit: NASA Earth Observatory / NASA Black Marble
- 국가 지표 레이어: World Bank, World Development Indicators (CC BY 4.0)
- 글꼴: Gowun Dodum, IBM Plex Sans KR (SIL Open Font License 1.1, `public/fonts/*/` 라이선스 파일, `docs/art/FONT_LICENSES.md`)
- 그 밖의 자료 출처는 `data/sources.json`에 링크로 기록했습니다(원자료를 재배포하지 않습니다).

## 라이선스

`LICENSE`를 봅니다.
