/** 같은 불러오기를 공유하고, 묶음마다 첫 시도와 재시도 한 번까지만 허용한다.
 * 브라우저 모듈 맵은 실패를 문서가 살아 있는 동안 기억할 수 있어 이후에는 새로 고침이 필요하다. */
export class ScreenLoadExhaustedError extends Error {}

export function lazyScreen<T>(loader: () => Promise<T>) {
  let screen: T | null = null;
  let pending: Promise<void> | null = null;
  let attempts = 0;
  return {
    get: () => screen,
    ensure(): Promise<void> {
      if (pending) return pending;
      if (attempts >= 2) return Promise.reject(new ScreenLoadExhaustedError());
      attempts++;
      pending = Promise.resolve().then(loader).then((loaded) => { screen = loaded; }).catch((error: unknown) => {
        pending = null;
        throw attempts >= 2 ? new ScreenLoadExhaustedError() : error;
      });
      return pending;
    },
  };
}
