import { ErrorCodes } from './error-code.registry';

describe('ErrorCodes 레지스트리', () => {
  const entries = Object.entries(ErrorCodes);

  it('status는 봉투 운영 규칙(§10.1)의 허용 집합에 속한다', () => {
    const allowed = new Set([400, 401, 403, 404, 409, 422, 429, 500, 503]);
    for (const [code, def] of entries) {
      expect({ code, ok: allowed.has(def.status) }).toEqual({ code, ok: true });
    }
  });

  it('코드 이름은 의미식 UPPER_SNAKE_CASE다', () => {
    for (const [code] of entries) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('사용자 메시지가 비어 있지 않다', () => {
    for (const [, def] of entries) {
      expect(def.message.length).toBeGreaterThan(0);
    }
  });
});
