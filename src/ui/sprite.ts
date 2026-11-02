// 시트의 한 줄을 칸 넘김으로 재생한다. 시트 규격은 승인 자산에서 가져온다.
import type { CharacterSprite } from './assets';
import { esc } from './html';

export function spriteHtml(sheet: CharacterSprite, options: { row: string; scaleN: number; label?: string }): string {
  const rowIndex = sheet.rows.indexOf(options.row);
  if (rowIndex < 0) throw new RangeError('스프라이트 줄 이름을 확인해 주세요.');
  if (!Number.isInteger(options.scaleN) || options.scaleN < 1) throw new RangeError('스프라이트 배율은 1 이상의 정수여야 합니다.');
  // CSS 문자열과 HTML 속성의 이스케이프를 각각 처리한다.
  const url = sheet.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, '');
  const style = `--sprite-scale: ${options.scaleN}; --sprite-w: ${sheet.frameWidth}px; --sprite-h: ${sheet.frameHeight}px; --sprite-row: ${rowIndex}; --sprite-columns: ${sheet.framesPerRow}; --sprite-rows: ${sheet.rows.length}; background-image: url("${url}"); animation-duration: ${sheet.framesPerRow * sheet.frameMs}ms; animation-timing-function: steps(${sheet.framesPerRow});`;
  const accessibility = options.label !== undefined ? `role="img" aria-label="${esc(options.label)}"` : 'aria-hidden="true"';
  return `<span class="pixel-sprite pixel-art" style="${esc(style)}" ${accessibility}></span>`;
}
