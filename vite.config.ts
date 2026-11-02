import { defineConfig, type Plugin } from 'vitest/config';
import { CHARACTER_FIELDS, droppedPaths, projectFields, releasedCharacters, type Json } from './src/content/character-fields.ts';

type ExecSync = (command: string, options?: { encoding?: string; stdio?: unknown }) => string;

/** 화면에 보일 빌드 표시. git이 없으면 'dev'. 추적 파일이 바뀌었으면 '+수정'. */
async function buildId(): Promise<string> {
  try {
    const { execSync } = (await import('node:child_process' as string)) as { execSync: ExecSync };
    const run = (command: string) => execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const hash = run('git rev-parse --short=7 HEAD');
    const dirty = run('git status --porcelain --untracked-files=no') !== '';
    return /^[0-9a-f]{7,}$/.test(hash) ? `${hash}${dirty ? '+수정' : ''}` : 'dev';
  } catch {
    return 'dev';
  }
}

/** data/characters.json 모듈의 id. 다른 자료 파일과 `?raw` 같은 질의가 붙은 id는 잡지 않는다. */
export const CHARACTERS_ID = /[\\/]data[\\/]characters\.json$/;

/**
 * data/characters.json을 화면·엔진이 읽는 칸(src/content/character-fields.ts)만 남겨 싣는다. 파일은 바꾸지 않는다.
 * 빌드: 남긴 칸만 JSON 글로 넘긴다. 모듈 id가 그대로라 아래 data 청크 묶음에 그대로 든다.
 * 시험(vitest)·개발 서버: 같은 칸을 남기고, 뺀 칸을 읽거나 쓰면 오류를 내는 접근자를 붙인다. 목록에 없는 칸을 새로 읽으면 시험이 실패한다.
 */
export function characterFieldsPlugin(): Plugin {
  let build = false;
  return {
    name: 'scitrade:character-fields',
    enforce: 'pre',
    configResolved(config) { build = config.command === 'build'; },
    transform: {
      filter: { id: CHARACTERS_ID },
      handler(code) {
        const full = JSON.parse(code) as Json;
        const kept = projectFields(releasedCharacters(full), CHARACTER_FIELDS);
        if (build) return { code: JSON.stringify(kept), map: null };
        const dropped: Record<string, string[]> = {};
        for (const path of droppedPaths(full, CHARACTER_FIELDS)) {
          const cut = path.lastIndexOf('.');
          (dropped[cut < 0 ? '' : path.slice(0, cut)] ??= []).push(cut < 0 ? path : path.slice(cut + 1));
        }
        return {
          moduleType: 'js',
          map: null,
          code: `const data = JSON.parse(${JSON.stringify(JSON.stringify(kept))});
const shape = ${JSON.stringify(CHARACTER_FIELDS)};
const dropped = ${JSON.stringify(dropped)};
function guard(value, shape, path) {
  if (shape === true || value === null || typeof value !== 'object') return;
  if (Array.isArray(shape)) { for (const item of value) guard(item, shape[0], path + '[]'); return; }
  for (const key of dropped[path] ?? []) {
    const fail = () => { throw new Error('data/characters.json의 ' + (path ? path + '.' : '') + key + ' 칸은 빌드에 싣지 않는 칸입니다. 화면·엔진에서 쓰려면 src/content/character-fields.ts의 CHARACTER_FIELDS에 더하세요.'); };
    Object.defineProperty(value, key, { enumerable: false, configurable: true, get: fail, set: fail });
  }
  for (const [key, inner] of Object.entries(shape)) if (value[key] !== undefined) guard(value[key], inner, path ? path + '.' + key : key);
}
guard(data, shape, '');
export default data;
`,
        };
      },
    },
  };
}

export default defineConfig(async () => ({
  plugins: [characterFieldsPlugin()],
  base: './',
  define: { __BUILD_ID__: JSON.stringify(await buildId()) },
  build: {
    rolldownOptions: {
      output: {
        // data/*.json을 코드와 다른 청크(data)로 나눈다. 목적은 청크마다 크기 한도(500,000 B)를 관리하는 것이다.
        // 두 청크 모두 첫 화면에서 받는다(코드는 script, data는 modulepreload). 첫 화면에 받는 양은 나누기 전과 거의 같다.
        // 코드만 바꿔도 import 순서가 바뀌어 자료 모듈의 순서가 달라지면 data 청크 이름이 바뀐다. 캐시 이득은 약속하지 않는다.
        // PACKAGE_STATUS.json·src/assets/manifest.json은 data 폴더 밖이라 코드 청크에 남는다.
        // 상황실 스냅숏은 진입할 때 지연 청크와 함께 받으며 첫 화면 자료 묶음에서 뺀다.
        codeSplitting: { groups: [{ name: 'data', test: /[\\/]data[\\/](?!(?:situation_map|market_rules)\.json$)[^\\/]+\.json$/ }] },
      },
    },
  },
  test: {
    setupFiles: ['./src/content/ops-data-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
}));
