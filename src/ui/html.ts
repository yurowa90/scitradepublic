// 엔진 문장은 저장·로그를 바꾸지 않고 학생에게 보여 줄 때만 다듬는다.
const PARTICLES = /을\(를\)|은\(는\)|이\(가\)|와\(과\)|\(으\)로|으로\(로\)/g;
// 받침 판별에 필요한 마지막 음절만 적는다.
const READINGS: Record<string, string> = {
  USD: '디', KRW: '유', kg: '램', g: '램', km: '터', m: '터',
  'm³': '터', 'm²': '터', L: '터', ml: '터', pt: '트', '%': '트',
};

/** 숫자는 한자어 수 읽기, 약어는 알파벳 이름, 단위는 한국어 이름을 따른다. */
function finalSound(word: string): string | undefined {
  const token = word.trim().match(/[가-힣A-Za-z0-9_.,%³²-]+$/)?.[0];
  if (!token) return undefined;
  if (/[가-힣]$/.test(token)) return token.at(-1);
  const unit = Object.keys(READINGS).find((u) => token.endsWith(u)
    && ((token === u && u !== 'L') || /[0-9]$/.test(token.slice(0, -u.length))));
  if (unit) return READINGS[unit];
  if (/^[A-Z]+$/.test(token)) return ({ L: '엘', M: '엠', N: '엔', R: '알' } as Record<string, string>)[token.at(-1)!] ?? '이';
  const number = token.match(/\d[\d,.]*$/)?.[0]?.replace(/,/g, '');
  if (!number) return undefined;
  if (number.includes('.') || /^0+$/.test(number)) return '영일이삼사오육칠팔구'[Number(number.at(-1))];
  const zeros = number.length - number.replace(/0+$/, '').length;
  if (!zeros) return '영일이삼사오육칠팔구'[Number(number.at(-1))];
  return zeros >= 4 ? ['만', '억', '조', '경'][Math.floor(zeros / 4) - 1] : ['십', '백', '천'][zeros % 4 - 1];
}

export function josa(word: string, pair: '을/를' | '은/는' | '이/가' | '와/과' | '으로/로'): string {
  const sound = finalSound(word)?.at(-1);
  if (!sound) return pair === '으로/로' ? '(으)' + '로' : pair.replace('/', '(') + ')';
  const jong = (sound.charCodeAt(0) - 0xac00) % 28;
  const [closed, open] = pair === '와/과' ? ['과', '와'] : pair.split('/');
  return (jong !== 0 && !(pair === '으로/로' && jong === 8) ? closed : open)!;
}

export function displayKo(text: string): string {
  const copy = text.replace(/ ?\((?:M2(?:a-5)? 기능|출항 후 취소는 M3|지급 불이행 유예기간은 아직 확정되지 않음)\)/g, '').replace(/M1에서는/g, '이 시나리오에서는');
  return copy.replace(PARTICLES, (particle: string, offset: number) => {
    const before = copy.slice(0, offset);
    if (!finalSound(before)) return particle;
    const pair = ({ 을: '을/를', 은: '은/는', 이: '이/가', 와: '와/과' } as const)[particle[0] as '을' | '은' | '이' | '와'] ?? '으로/로';
    return josa(before, pair);
  });
}

// 텍스트와 속성값에 같은 표시·HTML 이스케이프 규칙을 적용한다.
export const esc = (text: string) =>
  displayKo(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
