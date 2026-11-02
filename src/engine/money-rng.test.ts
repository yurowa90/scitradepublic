import { describe, expect, it } from 'vitest';
import { applyBasisPoints, formatMoney, MoneyError, rateToBasisPoints, toMinor } from './money';
import { createRng, drawUniform } from './rng';

describe('정수 화폐', () => {
  it('USD 표시 금액을 cents로 한 번만 변환한다', () => {
    expect(toMinor('USD', 10)).toBe(1000);
    expect(toMinor('USD', 0.1)).toBe(10);
    expect(toMinor('KRW', 80000)).toBe(80000);
    expect(() => toMinor('USD', 0.001)).toThrow(MoneyError);
    expect(() => toMinor('KRW', 0.5)).toThrow(MoneyError);
  });

  it('세율은 basis point 정수로 계산하고 반올림 규칙을 고정한다', () => {
    expect(rateToBasisPoints(0.05)).toBe(500);
    expect(applyBasisPoints(100000, 500)).toBe(5000);
    expect(applyBasisPoints(1, 5000)).toBe(1); // 0.5 cent → 1 cent
    expect(applyBasisPoints(-1, 5000)).toBe(-1);
  });

  it('통화 표시를 섞지 않는다', () => {
    expect(formatMoney('USD', 875000)).toBe('8,750.00 USD');
    expect(formatMoney('KRW', 80000)).toBe('80,000원');
    expect(formatMoney('USD', -5000)).toBe('−50.00 USD');
  });
});

describe('재현 가능한 난수 흐름', () => {
  it('같은 시드·흐름·커서는 같은 값을 낸다', () => {
    const a = drawUniform(createRng(42032026), 'events');
    const b = drawUniform(createRng(42032026), 'events');
    expect(a.value).toBe(b.value);
    expect(a.rng.cursors.events).toBe(1);
  });

  it('한 흐름의 추첨 횟수가 다른 흐름의 값을 바꾸지 않는다', () => {
    let r = createRng(7);
    r = drawUniform(r, 'market').rng;
    r = drawUniform(r, 'market').rng;
    const afterMarket = drawUniform(r, 'events').value;
    const fresh = drawUniform(createRng(7), 'events').value;
    expect(afterMarket).toBe(fresh);
    expect(fresh).toBeGreaterThanOrEqual(0);
    expect(fresh).toBeLessThan(1);
  });
});
