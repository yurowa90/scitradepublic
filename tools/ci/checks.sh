#!/usr/bin/env bash
# 저장소 자동 검사 묶음. CI와 로컬에서 같은 검사를 돌린다.
# 외부 API 키 변수를 지운 환경에서 돌린다.
# 브라우저 화면 확인은 포함하지 않는다.
# 사용법: tools/ci/checks.sh [--check] [기준]
# --check: MANIFEST.json을 다시 쓰지 않고 확인만 한다. 검사 전후 작업 트리 상태가 같은지도 본다.
set -uo pipefail
usage() { echo '사용법: tools/ci/checks.sh [--check] [기준]'; }
mode=수정
base=HEAD
positions=0
for arg in "$@"; do
  case "$arg" in
    --check) mode=확인 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "알 수 없는 옵션: $arg"; usage; exit 2 ;;
    *) positions=$((positions+1)); base="$arg" ;;
  esac
done
if ((positions>1)); then usage; exit 2; fi
root="$(git rev-parse --show-toplevel)"
cd "$root"
run() {
  total=$((total+1))
  echo "▶ $*"
  if env -u CODEX_API_KEY -u OPENAI_API_KEY "$@"; then echo '  통과'; else echo "  실패 ($*)"; fails=$((fails+1)); fi
}
tree_state() {
  git status --porcelain=v1 --untracked-files=all
  git diff --binary HEAD | sha256sum
  git ls-files --others --exclude-standard -z | xargs -0 -r sha256sum
}
total=0
fails=0
if [[ "$mode" == 확인 ]]; then before="$(tree_state)"; run python3 tools/build_package.py --check
else run python3 tools/build_package.py --manifest-only; fi
run python3 tools/validate_data.py
run npm run --silent typecheck
run npx vitest run
build_fails=$fails
run npm run --silent build
# 크기 한도 검사는 방금 빌드가 성공했을 때만 한다. 실패했으면 남아 있을 수 있는 옛 dist를 재지 않고 실패로 센다.
if ((fails == build_fails)); then run node tools/check_bundle_size.mjs dist
else
  total=$((total+1)); fails=$((fails+1))
  echo '▶ node tools/check_bundle_size.mjs dist'
  echo '  실패 (빌드가 실패해 재지 않았다)'
fi
run node tools/check_rules2_golden.mjs
run node --test tools/check_rules2_golden.test.mjs
run node tools/check_rules3_golden.mjs
run node --test tools/check_rules3_golden.test.mjs
# 그림 도구와 지도 생성 시험. 지도 원본 재생성 시험은 원본 폴더(SCITRADE_MAP_SOURCES, 없으면 저장소 옆 map/)가 있을 때만 돈다.
run python3 tools/art/test_pixel_tools.py
run python3 -m unittest discover -s scripts -p 'test_*.py'
run python3 tools/test_validate_data.py
run python3 tools/check_fact_mixing.py
run python3 tools/test_check_fact_mixing.py
run node --test tools/browser/lib.test.mjs
run node --test tools/check_bundle_size.test.mjs
if [[ "$mode" == 확인 ]]; then
  after="$(tree_state)"
  total=$((total+1))
  echo '▶ 작업 트리 변화 없음'
  if [[ "$before" == "$after" ]]; then echo '  통과'
  else
    echo '  실패 (검사가 작업 트리를 바꿨다)'
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") || true
    fails=$((fails+1))
  fi
fi
echo "검사 $total종, 실패 $fails종 (모드: $mode)"
echo
echo "변경 요약 (기준: $base):"
git diff --stat "$base"
git status --short --untracked-files=all | grep '^??' || true
if ((fails)); then exit 1; fi
