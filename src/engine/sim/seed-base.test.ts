import { describe, expect, it } from 'vitest';
import { d03Options, simMain, type SimIo } from './cli';
import { runD03 } from './d03';
import { serializeSimOutput } from './sim';

describe('D03 표본 밖 시드', () => {
  it('기본 목록을 보존하고 기준값·개수·분할 번호를 함께 적용한다', () => {
    const defaults = { seeds: [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010,
      1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020], late: 'base', workers: 1, out: undefined, tablesFrom: undefined };
    expect(d03Options([])).toEqual(defaults);
    expect(d03Options(['--seed-base', '1001'])).toEqual(defaults);
    expect(d03Options(['--seed-base', '1021'])).toEqual({ ...defaults,
      seeds: [1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029, 1030,
        1031, 1032, 1033, 1034, 1035, 1036, 1037, 1038, 1039, 1040] });
    expect(d03Options(['--seed-base', '1021', '--seeds', '4', '--seed-from', '2', '--seed-to', '3']))
      .toEqual({ ...defaults, seeds: [1022, 1023] });
    expect(d03Options(['--seed-base', '0', '--seeds', '1'])).toEqual({ ...defaults, seeds: [0] });
    expect(d03Options(['--seed-base', '9007199254740972', '--seed-from', '20']))
      .toEqual({ ...defaults, seeds: [9007199254740991] });
  });

  it('잘못된 기준값·누락·중복을 거절하고 기본 run에는 허용하지 않는다', () => {
    for (const value of ['-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740973', '9007199254740992']) {
      expect(() => d03Options(['--seed-base', value])).toThrow('시드 기준값');
    }
    for (const args of [['--seed-base'], ['--seed-base', '1021', '--seed-base', '1022']]) {
      expect(() => d03Options(args)).toThrow('잘못된 D03 인수');
    }
    const io: SimIo = { readText: () => '', writeText: () => {}, out: () => {}, err: () => {}, now: () => 0 };
    expect(simMain(['run', '--seed-base', '1021'], io)).toBe(2);
  });

  it('CLI가 선택한 시드를 실제 실행과 저장 메타데이터까지 전달한다', () => {
    const files = new Map<string, string>();
    const io: SimIo = { readText: (path) => files.get(path)!, writeText: (path, text) => { files.set(path, text); },
      out: () => {}, err: () => {}, now: () => 0 };
    expect(simMain(['d03', '--seed-base', '1021', '--seeds', '2', '--seed-from', '2', '--policies', 'IDLE', '--out', 'oos.json'], io)).toBe(0);
    expect(files.get('oos.json')).toEqual(serializeSimOutput(runD03({ seeds: [1022], policyIds: ['IDLE'] })));
  });

  it('표본 밖 시드도 워커 1·2의 출력 바이트가 같다', async () => {
    const { execFile } = await import('node:child_process' as string) as { execFile: (file: string, args: string[], options: object, callback: (error: Error | null) => void) => void };
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs' as string) as {
      mkdtempSync: (prefix: string) => string; readFileSync: (path: string, encoding: string) => string; rmSync: (path: string, options: object) => void };
    const { tmpdir } = await import('node:os' as string) as { tmpdir: () => string };
    const { join } = await import('node:path' as string) as { join: (...paths: string[]) => string };
    const dir = mkdtempSync(join(tmpdir(), 'd03-seed-base-'));
    try {
      const files = [join(dir, 'one.json'), join(dir, 'two.json')];
      for (const [i, path] of files.entries()) await new Promise<void>((resolve, reject) => execFile('node',
        ['src/engine/sim/run.mjs', 'd03', '--seed-base', '1021', '--seeds', '2', '--policies', 'IDLE', '--workers', String(i + 1), '--out', path],
        { maxBuffer: 4 * 1024 * 1024 }, (error) => error ? reject(error) : resolve()));
      expect(readFileSync(files[0]!, 'utf8')).toEqual(serializeSimOutput(runD03({ seeds: [1021, 1022], policyIds: ['IDLE'] })));
      expect(readFileSync(files[1]!, 'utf8')).toEqual(readFileSync(files[0]!, 'utf8'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
