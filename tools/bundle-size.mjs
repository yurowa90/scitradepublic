// 빌드 크기 한도 검사의 함수 모음. 명령줄은 tools/check_bundle_size.mjs다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const LIMITS = Object.freeze({ chunkRaw: 500_000, firstScreenRaw: 600_000, firstScreenGzip: 140_000, fontsRaw: 5_000_000 });

export function formatBytes(n) {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} B`;
}

export function pageRefs(html) {
  const refs = [];
  const tags = html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(script|link)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi);
  for (const [, tag, body] of tags) {
    const attrs = {};
    for (const [, name, double, single, bare] of body.replace(/\/\s*$/, '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[name.toLowerCase()] = double ?? single ?? bare ?? '';
    }
    let kind;
    let href;
    if (tag.toLowerCase() === 'script') {
      if (!Object.hasOwn(attrs, 'src')) continue;
      kind = 'script';
      href = attrs.src;
    } else {
      const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
      kind = rel.includes('modulepreload') ? 'modulepreload' : rel.includes('stylesheet') ? 'stylesheet' : undefined;
      if (!kind || !Object.hasOwn(attrs, 'href')) continue;
      href = attrs.href;
    }
    if (/^data:/i.test(href)) continue;
    const external = /^(?:https?:\/\/|\/\/)/i.test(href);
    if (!external) href = href.split(/[?#]/, 1)[0].replace(/^(?:\.\/|\/)+/, '');
    refs.push({ kind, href, external });
  }
  return refs;
}

export function cssUrls(css, cssHref) {
  const files = new Set();
  for (const [, double, single, bare] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)) {
    const href = (double ?? single ?? bare).trim();
    if (!href || /^(?:data:|https?:\/\/|\/\/)/i.test(href)) continue;
    const local = href.split(/[?#]/, 1)[0];
    if (!local) continue;
    files.add(local.startsWith('/') ? local.replace(/^\/+/, '') : path.posix.normalize(path.posix.join(path.posix.dirname(cssHref), local)));
  }
  return [...files];
}

export function isFontSheet(ref) {
  return ref.kind === 'stylesheet' && !ref.external && ref.href.startsWith('fonts/');
}

export function evaluateBudget({ chunks, firstScreen, fonts }, limits = LIMITS) {
  const overChunks = chunks.filter(({ raw }) => raw > limits.chunkRaw).map(({ file }) => file);
  const screen = { files: firstScreen.length, raw: firstScreen.reduce((n, s) => n + s.raw, 0), gzip: firstScreen.reduce((n, s) => n + s.gzip, 0) };
  const font = { stylesheets: fonts.stylesheets.length, files: fonts.files.length, raw: [...fonts.stylesheets, ...fonts.files].reduce((n, s) => n + s.raw, 0) };
  const reasons = [];
  if (overChunks.length) reasons.push(`JS 청크 ${overChunks.length}개 한도 초과`);
  if (screen.raw > limits.firstScreenRaw) reasons.push('첫 화면 원본 합계 한도 초과');
  if (screen.gzip > limits.firstScreenGzip) reasons.push('첫 화면 gzip 합계 한도 초과');
  if (font.raw > limits.fontsRaw) reasons.push('글꼴 합계 한도 초과');
  return { ok: reasons.length === 0, reasons, overChunks, firstScreen: screen, fonts: font };
}

export function sizeOf(dist, file) {
  const buf = fs.readFileSync(path.join(dist, file));
  return { file, raw: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length };
}

export function collectDist(dist) {
  const empty = missing => ({ missing, chunks: [], firstScreen: [], lazy: [], fonts: { stylesheets: [], files: [] }, external: [] });
  const isFile = file => {
    try { return fs.statSync(path.join(dist, file)).isFile(); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  };
  if (!isFile('index.html')) return empty(['index.html']);
  const refs = pageRefs(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
  const local = refs.filter(ref => !ref.external);
  const sheets = [...new Set(refs.filter(isFontSheet).map(ref => ref.href))];
  const missing = new Set(local.filter(ref => !isFile(ref.href)).map(ref => ref.href));
  const fontFiles = new Set();
  for (const sheet of sheets) {
    if (!isFile(sheet)) continue;
    for (const file of cssUrls(fs.readFileSync(path.join(dist, sheet), 'utf8'), sheet)) {
      fontFiles.add(file);
      if (!isFile(file)) missing.add(file);
    }
  }
  if (missing.size) return empty([...missing]);
  const js = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(dist, dir), { withFileTypes: true })) {
      const file = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && file.endsWith('.js')) js.push(file);
    }
  };
  walk('');
  const screenFiles = new Set(local.filter(ref => !isFontSheet(ref)).map(ref => ref.href));
  const chunks = js.sort().map(file => sizeOf(dist, file));
  return {
    missing: [], chunks,
    firstScreen: [...screenFiles].map(file => sizeOf(dist, file)),
    lazy: chunks.filter(({ file }) => !screenFiles.has(file)).map(({ file }) => file),
    fonts: { stylesheets: sheets.map(file => sizeOf(dist, file)), files: [...fontFiles].map(file => sizeOf(dist, file)) },
    external: refs.filter(ref => ref.external).map(ref => ref.href),
  };
}

export function formatReport(c, v, limits = LIMITS) {
  const lines = [`JS 청크 ${c.chunks.length}개 (하나에 ${formatBytes(limits.chunkRaw)} 이하):`];
  for (const { file, raw, gzip } of c.chunks) {
    lines.push(`  ${file} ${formatBytes(raw)}, gzip ${formatBytes(gzip)} — ${c.lazy.includes(file) ? '나중에 받음' : '첫 화면'}${raw > limits.chunkRaw ? ' — 한도 초과' : ''}`);
  }
  lines.push(`첫 화면 JS·CSS ${v.firstScreen.files}개: ${formatBytes(v.firstScreen.raw)} (한도 ${formatBytes(limits.firstScreenRaw)}), gzip ${formatBytes(v.firstScreen.gzip)} (한도 ${formatBytes(limits.firstScreenGzip)})`);
  if (!c.fonts.stylesheets.length) lines.push('글꼴: index.html이 fonts/ 스타일시트를 부르지 않는다');
  else {
    const sheetsRaw = c.fonts.stylesheets.reduce((n, s) => n + s.raw, 0);
    const filesRaw = c.fonts.files.reduce((n, s) => n + s.raw, 0);
    lines.push(`글꼴: 스타일시트 ${v.fonts.stylesheets}개 ${formatBytes(sheetsRaw)} + 글꼴 파일 ${v.fonts.files}개 ${formatBytes(filesRaw)} = ${formatBytes(v.fonts.raw)} (한도 ${formatBytes(limits.fontsRaw)}). 첫 화면 합계에 넣지 않는다`);
  }
  if (c.external.length) lines.push(`외부 참조 ${c.external.length}개(크기를 재지 않는다): ${c.external.join(' ')}`);
  lines.push(v.ok ? '판정: 통과' : `판정: 실패 — ${v.reasons.join(', ')}`);
  return lines;
}
