// 재현 가능한 난수. 모듈별 흐름(stream)을 분리해 한 모듈의 추첨 횟수가 다른 모듈의 결과를 바꾸지 않게 한다.
// 값은 (시드, 흐름 이름, 커서)에서 결정되며 상태에는 커서만 저장한다. M1 시나리오는 추첨을 사용하지 않는다.

export interface RngState {
  seed: number;
  cursors: Record<string, number>;
}

export function createRng(seed: number): RngState {
  if (!Number.isSafeInteger(seed)) throw new Error(`시드는 정수여야 합니다: ${seed}`);
  return { seed, cursors: {} };
}

function hashString(text: string): number {
  // FNV-1a 32bit
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mix32(x: number): number {
  // splitmix32 finalizer
  let z = (x + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

/** [0, 1) 균등 난수를 뽑고 해당 흐름의 커서를 1 증가시킨 새 상태를 돌려준다. */
export function drawUniform(rng: RngState, stream: string): { value: number; rng: RngState } {
  const cursor = rng.cursors[stream] ?? 0;
  const word = mix32((rng.seed >>> 0) ^ mix32(hashString(stream) ^ mix32(cursor)));
  return {
    value: word / 0x1_0000_0000,
    rng: { seed: rng.seed, cursors: { ...rng.cursors, [stream]: cursor + 1 } },
  };
}
