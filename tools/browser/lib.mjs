import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROFILE_FILE = fileURLToPath(new URL('./profiles.json', import.meta.url));
export function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
// 쓰기 경로의 기존 조상에 연결이 있으면 실제 목적지를 확인한다.
export function realOutputPath(file) {
  let ancestor = path.resolve(file);
  const tail = [];
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor));
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  return path.join(fs.realpathSync(ancestor), ...tail);
}
export function loadProfiles(file = PROFILE_FILE) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (obj.schema !== 'scitrade-browser-profiles/1' || !Number.isInteger(obj.chrome_pad_px) || obj.chrome_pad_px < 0 || !Array.isArray(obj.profiles) || !obj.profiles.length) throw new Error('프로필 형식이 올바르지 않습니다');
  const ids = new Set();
  for (const p of obj.profiles) {
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id) || ![p.width, p.height, p.scale].every(v => Number.isInteger(v) && v > 0) || typeof p.touch !== 'boolean') throw new Error('프로필 항목이 올바르지 않습니다');
    ids.add(p.id);
  }
  return { chromePadPx: obj.chrome_pad_px, profiles: obj.profiles };
}
export function selectProfiles(profiles, spec) {
  if (spec === 'all') return [...profiles];
  if (spec === 'touch' || spec === 'mouse') return profiles.filter(p => p.touch === (spec === 'touch'));
  const ids = Array.isArray(spec) ? spec : typeof spec === 'string' ? spec.split(',') : [];
  if (!ids.length) throw new Error('프로필 지정이 비었습니다');
  return ids.map(id => {
    const p = profiles.find(p => p.id === id);
    if (!p) throw new Error(`모르는 프로필: ${id}`);
    return p;
  });
}
const WHATS = ['top', 'height', 'top-from-bar', 'moved', 'scroll-y-change', 'overflow-x', 'bar-bottom', 'width', 'left-from-parent'];
export function validateScenario(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return ['시나리오 객체가 필요합니다'];
  if (obj.schema !== 'scitrade-browser-scenario/1' || typeof obj.id !== 'string' || !obj.id || typeof obj.title_ko !== 'string' || typeof obj.source_ko !== 'string') errors.push('시나리오 머리 형식이 올바르지 않습니다');
  const profiles = loadProfiles().profiles;
  const profileSpec = spec => { try { selectProfiles(profiles, spec); } catch (e) { errors.push(e.message); } };
  profileSpec(obj.profiles);
  for (const key of ['bar_selector', 'ready_selector', 'end_day_selector']) if (key in obj && (typeof obj[key] !== 'string' || !obj[key])) errors.push(`${key} 선택자가 필요합니다`);
  if (!Array.isArray(obj.steps)) return [...errors, '단계 목록이 필요합니다'];
  const names = new Set(), refs = new Set(), measures = new Set();
  for (const [i, s] of obj.steps.entries()) {
    if (!s || typeof s !== 'object') { errors.push(`${i + 1}단계 객체가 필요합니다`); continue; }
    const error = message => errors.push(`${i + 1}단계 ${s.do}: ${message}`);
    if (!['tap', 'end-day', 'select', 'scroll-top', 'scroll-to', 'wait', 'remember', 'measure'].includes(s.do)) error('모르는 동작');
    if (['tap', 'select', 'scroll-to', 'remember'].includes(s.do) && (typeof s.selector !== 'string' || !s.selector)) error('선택자가 필요합니다');
    if (s.do === 'tap' && 'index' in s && (!Number.isInteger(s.index) || s.index < 0)) error('index는 0 이상 정수입니다');
    if (s.do === 'end-day' && 'times' in s && (!Number.isInteger(s.times) || s.times < 1)) error('times는 양의 정수입니다');
    if (s.do === 'select' && (typeof s.value === 'string') === ('index' in s)) error('value와 index 가운데 하나만 씁니다');
    if (s.do === 'select' && 'index' in s && (!Number.isInteger(s.index) || s.index < 0)) error('index는 0 이상 정수입니다');
    if (s.do === 'scroll-to' && !Number.isFinite(s.offset_from_bar)) error('막대 기준 위치가 필요합니다');
    if (s.do === 'wait' && (!Number.isFinite(s.ms) || s.ms < 0)) error('대기 시간이 필요합니다');
    if (s.do === 'measure') {
      if (!WHATS.includes(s.what)) error('모르는 측정');
      if (['moved', 'scroll-y-change'].includes(s.what) && !s.ref) error('ref가 필요합니다');
      if (!['overflow-x', 'bar-bottom', 'scroll-y-change'].includes(s.what) && !s.ref && (typeof s.selector !== 'string' || !s.selector)) error('선택자 또는 ref가 필요합니다');
      if (s.ref && !refs.has(s.ref)) error('정의되지 않은 ref');
    }
    if (['remember', 'measure'].includes(s.do)) {
      if (typeof s.name !== 'string' || !s.name) error('name이 필요합니다');
      else if (names.has(s.name)) error('name이 중복됩니다');
      else { names.add(s.name); if (s.do === 'remember') refs.add(s.name); else measures.add(s.name); }
    }
  }
  if ('expect' in obj && !Array.isArray(obj.expect)) errors.push('기대 목록 형식이 올바르지 않습니다');
  else for (const e of obj.expect || []) {
    if (!e || !measures.has(e.value)) errors.push('기대 값이 정의되지 않았습니다');
    if (!e || !Number.isFinite(e.min) || !Number.isFinite(e.max) || e.min > e.max) errors.push('기대 범위가 올바르지 않습니다');
    if (e) profileSpec(e.profiles ?? 'all');
  }
  return errors;
}
export function loadScenario(file) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateScenario(obj);
  if (errors.length) throw new Error(errors.join('\n'));
  return { bar_selector: '.statusbar', ready_selector: '[data-action="end-day"]', end_day_selector: '[data-action="end-day"]', expect: [], ...obj };
}
export function resolveDistPath(distDir, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const file = path.resolve(distDir, decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, ''));
  if (!isInside(file, distDir)) return null;
  if (fs.existsSync(file) && !isInside(fs.realpathSync(file), fs.realpathSync(distDir))) return null;
  return file;
}
export function contentType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream';
}
export function fontCacheKey(url, userAgent) {
  return createHash('sha1').update(url + (url.includes('fonts.googleapis.com') ? userAgent : '')).digest('hex');
}
export function checkExpectations(scenario, runs, profiles) {
  const results = [];
  for (const e of scenario.expect || []) {
    const ids = new Set(selectProfiles(profiles, e.profiles ?? 'all').map(p => p.id));
    for (const run of runs.filter(r => ids.has(r.profile))) {
      const actual = run.values[e.value] ?? null;
      results.push({ value: e.value, profile: run.profile, actual, min: e.min, max: e.max, ok: Number.isFinite(actual) && actual >= e.min && actual <= e.max });
    }
  }
  return { ok: results.every(r => r.ok), results };
}

async function tap(page, selector, index, touch) {
  await page.waitForTimeout(560);
  const point = async scroll => page.evaluate(({ selector, index, scroll }) => {
    const el = document.querySelectorAll(selector)[index];
    if (!el) throw new Error('요소가 없습니다');
    if (el.disabled) throw new Error('요소가 비활성입니다');
    if (scroll) { el.scrollIntoView({ block: 'center' }); return null; }
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 20);
    const hit = document.elementFromPoint(x, y);
    return { x, y, visible: r.width > 0 && r.height > 0 && !!hit && (hit === el || el.contains(hit)) };
  }, { selector, index, scroll });
  let p = await point(false);
  if (!p.visible) { await point(true); await page.waitForTimeout(100); p = await point(false); }
  if (!p.visible) throw new Error('누를 점이 가려졌습니다');
  if (touch) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(80);
}
async function step(page, s, scenario, profile, refs, values) {
  const selector = s.selector || scenario.end_day_selector;
  if (s.do === 'tap') await tap(page, s.selector, s.index ?? 0, profile.touch);
  else if (s.do === 'end-day') for (let i = 0; i < (s.times ?? 1); i++) await tap(page, selector, 0, profile.touch);
  else if (s.do === 'select') { await page.selectOption(s.selector, 'index' in s ? { index: s.index } : s.value); await page.waitForTimeout(300); }
  else if (s.do === 'wait') await page.waitForTimeout(s.ms);
  else if (s.do === 'scroll-top') { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(100); }
  else if (s.do === 'scroll-to') {
    await page.evaluate(({ selector, bar, offset }) => {
      const el = document.querySelector(selector), b = document.querySelector(bar);
      if (!el || !b) throw new Error('요소가 없습니다');
      window.scrollBy(0, el.getBoundingClientRect().top - b.getBoundingClientRect().bottom - offset);
    }, { selector: s.selector, bar: scenario.bar_selector, offset: s.offset_from_bar });
    await page.waitForTimeout(200);
  } else if (s.do === 'remember') {
    refs[s.name] = await page.evaluate(selector => {
      const el = document.querySelector(selector);
      if (!el || !el.id) throw new Error('요소 또는 id가 없습니다');
      return { id: el.id, top: el.getBoundingClientRect().top, scrollY };
    }, s.selector);
  } else if (s.do === 'measure') {
    const value = await page.evaluate(({ s, ref, bar }) => {
      if (s.what === 'overflow-x') return document.scrollingElement.scrollWidth - innerWidth;
      if (s.what === 'scroll-y-change') return scrollY - ref.scrollY;
      const b = document.querySelector(bar);
      if (['bar-bottom', 'top-from-bar'].includes(s.what) && !b) throw new Error('막대가 없습니다');
      if (s.what === 'bar-bottom') return b.getBoundingClientRect().bottom;
      const el = ref ? document.getElementById(ref.id) : document.querySelector(s.selector);
      if (!el) throw new Error('요소가 없습니다');
      const r = el.getBoundingClientRect();
      if (s.what === 'top') return r.top;
      if (s.what === 'height') return r.height;
      if (s.what === 'width') return r.width;
      if (s.what === 'left-from-parent') {
        // 부모 내용 상자(테두리·안쪽 여백 안쪽) 왼쪽 끝에서 요소 왼쪽 끝까지. 가운데 맞춘 지도의 왼쪽 빈 띠다.
        const p = el.parentElement;
        if (!p) throw new Error('부모 요소가 없습니다');
        return r.left - (p.getBoundingClientRect().left + p.clientLeft + parseFloat(getComputedStyle(p).paddingLeft || '0'));
      }
      if (s.what === 'top-from-bar') return r.top - b.getBoundingClientRect().bottom;
      return r.top - ref.top;
    }, { s, ref: refs[s.ref], bar: scenario.bar_selector });
    values[s.name] = Math.round(value * 10) / 10;
  }
}
export async function runProfile({ distDir, scenario, profile, chromePadPx, fontCaches, offlineFonts }) {
  const result = { profile: profile.id, inner: { width: null, height: null }, dpr: null, coarse: null, size_ok: false, fonts: { cache: 0, network: 0, failed: 0, local: 0 }, fonts_ok: false, blocked_hosts: [], values: {}, page_errors: [], status: 'error', error: null };
  let browser;
  const blocked = new Set();
  let version = null;
  try {
    const { chromium } = createRequire(import.meta.url)(process.env.SCITRADE_PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');
    browser = await chromium.launch({ executablePath: process.env.SCITRADE_CHROMIUM || '/opt/pw-browsers/chromium', args: [`--force-device-scale-factor=${profile.scale}`, `--window-size=${profile.width},${profile.height + chromePadPx}`] });
    version = browser.version();
    const context = await browser.newContext({ viewport: null, hasTouch: profile.touch, locale: 'ko-KR' });
    const page = await context.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://scitrade.local') {
        const file = resolveDistPath(distDir, url.pathname);
        // 빌드에 넣은 글꼴(D16, public/fonts)은 빌드 폴더에서 주고 local로 센다. 없는 글꼴 파일은 실패로 센다.
        const font = path.extname(url.pathname) === '.woff2';
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { if (font) result.fonts.failed++; return route.fulfill({ status: 404, body: '파일이 없습니다' }); }
        if (font) result.fonts.local++;
        return route.fulfill({ contentType: contentType(file), body: fs.readFileSync(file) });
      }
      // Google Fonts 가로채기는 글꼴 내장 전 빌드(외부 글꼴 링크)를 비교해 잴 때만 쓰인다.
      if (url.protocol === 'https:' && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
        try {
          const key = fontCacheKey(url.href, ua);
          const cached = fontCaches.map(dir => path.join(dir, key)).find(file => fs.existsSync(file));
          let body;
          if (cached) { body = fs.readFileSync(cached); result.fonts.cache++; }
          else {
            if (offlineFonts) throw new Error('글꼴 캐시가 없습니다');
            body = execFileSync('curl', ['-sS', '--fail', '--max-time', '30', '-A', ua, url.href]);
            fs.mkdirSync(fontCaches[0], { recursive: true });
            fs.writeFileSync(path.join(fontCaches[0], key), body);
            result.fonts.network++;
          }
          return await route.fulfill({ body, contentType: url.hostname === 'fonts.googleapis.com' ? 'text/css; charset=utf-8' : 'font/woff2', headers: { 'access-control-allow-origin': '*' } });
        } catch { result.fonts.failed++; return route.abort(); }
      }
      blocked.add(url.hostname);
      return route.abort();
    });
    page.on('pageerror', error => result.page_errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto('http://scitrade.local/index.html');
    await page.waitForSelector(scenario.ready_selector, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const dims = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, coarse: matchMedia('(pointer: coarse)').matches }));
    result.inner = { width: dims.width, height: dims.height }; result.dpr = dims.dpr; result.coarse = dims.coarse;
    result.size_ok = dims.width === profile.width && dims.height === profile.height;
    const refs = {};
    for (const [i, s] of scenario.steps.entries()) {
      let timer;
      try {
        await Promise.race([step(page, s, scenario, profile, refs, result.values), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('15초 제한을 넘었습니다')), 15000); })]);
      } catch (error) { throw new Error(`${i + 1}단계 ${s.do} ${s.selector || s.ref || (s.do === 'end-day' ? scenario.end_day_selector : '')}: ${error.message}`); }
      finally { clearTimeout(timer); }
    }
    result.status = 'ok';
  } catch (error) { result.error = error.message; }
  finally { if (browser) await browser.close().catch(() => {}); }
  result.fonts_ok = result.fonts.failed === 0 && result.fonts.cache + result.fonts.network + result.fonts.local > 0;
  result.blocked_hosts = [...blocked].sort();
  // 판정 객체의 직렬화 키는 고정하고 버전은 별도 비열거 속성으로 전달한다.
  Object.defineProperty(result, 'chromium', { value: version });
  return result;
}
