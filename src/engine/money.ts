// 금액은 통화별 정수 최소 단위로만 저장한다. 표시용 소수 금액은 로더와 화면에서만 다룬다.

/** XXX는 ISO 4217의 '통화 없음' 코드. 통화 없는 검산 fixture에 사용한다. */
export type Currency = 'USD' | 'KRW' | 'XXX';

export const MINOR_PER_MAJOR: Record<Currency, number> = { USD: 100, KRW: 1, XXX: 1 };

export class MoneyError extends Error {}

/** JSON의 표시 금액(예: USD 10)을 최소 단위 정수(1000 cents)로 한 번만 변환한다. */
export function toMinor(currency: Currency, majorAmount: number): number {
  const scaled = majorAmount * MINOR_PER_MAJOR[currency];
  const rounded = Math.round(scaled);
  if (!Number.isFinite(scaled) || Math.abs(scaled - rounded) > 1e-9) {
    throw new MoneyError(`${currency} ${majorAmount}은(는) 최소 단위 정수로 표현할 수 없습니다.`);
  }
  return rounded;
}

export function assertMinor(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label}: 정수 최소 단위가 아닙니다 (${value}).`);
  }
}

/** 비율을 basis point(1/10000) 정수로 고정한다. 0.05 → 500. */
export function rateToBasisPoints(rate: number): number {
  const bp = Math.round(rate * 10000);
  if (Math.abs(rate * 10000 - bp) > 1e-9) {
    throw new MoneyError(`비율 ${rate}은(는) basis point 정수로 표현할 수 없습니다.`);
  }
  return bp;
}

/** 금액 × 비율. 반올림 규칙: 최소 단위에서 0.5는 0에서 먼 쪽으로 올린다. */
export function applyBasisPoints(minor: number, basisPoints: number): number {
  assertMinor(minor, 'amount');
  const numerator = minor * basisPoints;
  const sign = numerator < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(numerator) + 5000) / 10000);
}

export function formatMoney(currency: Currency, minor: number): string {
  const factor = MINOR_PER_MAJOR[currency];
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / factor);
  const fraction = abs % factor;
  const majorText = major.toLocaleString('ko-KR');
  if (currency === 'KRW') return `${sign}${majorText}원`;
  if (currency === 'XXX') return `${sign}${majorText}`;
  return `${sign}${majorText}.${String(fraction).padStart(2, '0')} USD`;
}
