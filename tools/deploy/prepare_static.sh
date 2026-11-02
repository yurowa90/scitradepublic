#!/usr/bin/env bash
set -euo pipefail
usage() { echo '사용법: tools/deploy/prepare_static.sh <출력 폴더> [--allow-dirty]'; }
dirty_allowed=false
output_arg=''
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) dirty_allowed=true ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "알 수 없는 옵션: $arg"; usage; exit 2 ;;
    *) if [[ -n "$output_arg" ]]; then usage; exit 2; fi; output_arg="$arg" ;;
  esac
done
if [[ -z "$output_arg" ]]; then usage; exit 2; fi
root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo 'git 저장소가 아닙니다'; exit 2; }
output="$(realpath -m -- "$output_arg")" || exit 2
cd "$root"
if [[ "$output" == "$root" || "$output" == "$root/"* ]]; then echo '출력 폴더는 저장소 밖이어야 합니다'; exit 2; fi
if [[ -e "$output" ]]; then
  if [[ ! -d "$output" ]]; then echo '출력 경로가 폴더가 아닙니다'; exit 2; fi
  if [[ -n "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then echo '출력 폴더가 비어 있지 않습니다. 지우지 않습니다'; exit 2; fi
fi
state="$(git status --porcelain=v1 --untracked-files=normal)"
# public/ 아래의 무시된 파일(.env.local, .DS_Store 등)도 Vite가 그대로 복사하므로 깨끗하지 않은 트리로 본다(Claude 검수).
ignored_public="$(git ls-files --others --ignored --exclude-standard -- public)"
if [[ -n "$ignored_public" ]]; then state="${state:+$state
}$(printf '%s\n' "$ignored_public" | sed 's/^/!! /')"; fi
tree=clean
if [[ -n "$state" ]]; then
  if ! "$dirty_allowed"; then printf '%s\n' "$state" | sed -n '1,20p'; echo '작업 트리가 깨끗하지 않습니다. 커밋한 뒤 다시 실행하세요'; exit 3; fi
  tree=dirty
  echo '경고: 깨끗하지 않은 트리입니다. 배포용이 아닙니다'
fi
if [[ ! -d node_modules ]]; then echo 'node_modules가 없습니다(원본 node_modules를 cp -r로 복사하세요)'; exit 4; fi
before="$(git status --porcelain=v1 --untracked-files=all)"
if ! npm run --silent build; then exit 4; fi
if [[ ! -f dist/index.html ]]; then echo 'dist/index.html이 없습니다'; exit 4; fi
zips="$(find dist -name '*.zip')"
if [[ -n "$zips" ]]; then printf '%s\n' "$zips"; echo 'dist에 ZIP이 있습니다'; exit 4; fi
if [[ "$before" != "$(git status --porcelain=v1 --untracked-files=all)" ]]; then echo '빌드가 작업 트리를 바꿨습니다'; exit 4; fi
mkdir -p -- "$output"
cp -R dist/. "$output/"
cat > "$output/netlify.toml" <<'TEXT'
[build]
  publish = "."
  command = ""
TEXT
cat > "$output/_headers" <<'TEXT'
/*
  X-Robots-Tag: noindex, nofollow
TEXT
cat > "$output/robots.txt" <<'TEXT'
User-agent: *
Disallow: /
TEXT
commit="$(git rev-parse HEAD)"
package_version="$(python3 -c 'import json; print(json.load(open("PACKAGE_STATUS.json"))["package_version"])')"
printf 'commit: %s\ncommit_date: %s\nbuilt_at: %s\ntree: %s\npackage_version: %s\n' "$commit" "$(git show -s --format=%cI HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tree" "$package_version" > "$output/version.txt"
echo "출력 폴더: $output"
echo "파일 수: $(find "$output" -type f | wc -l)"
du -sh -- "$output"
echo "commit: $commit"
echo "tree: $tree"
echo '배포는 Claude가 한다(WORKFLOW ‘시험 빌드 정적 배포’). 이 스크립트는 올리지 않는다.'
