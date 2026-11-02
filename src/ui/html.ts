// 텍스트와 속성값에 같은 HTML 이스케이프 규칙을 적용한다.
export const esc = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
