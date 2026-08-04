import { registerAs } from '@nestjs/config';

/**
 * 클리닉 초대 설정 (docs/specs/35).
 *
 * 초대 링크는 **1회용 + 만료**다 — 링크가 메신저로 전달되므로 유출 창을 좁힌다(§4.2 신규 가입
 * 티켓의 1회성 관행과 같은 이유). 만료 판정은 **앱 계층에서 계산**해 리포지토리에 넘긴다:
 * SQL의 `now()`로 계산하면 수용 기준 4·18의 시각 주입이 성립하지 않는다 (§34 기준 14와 같은
 * 이유 — 코드베이스에 Clock 추상화가 없고 `jest.useFakeTimers()`가 제어하는 것은 `Date.now()`뿐이다).
 */
export const clinicInvitationConfig = registerAs('clinicInvitation', () => ({
  ttlDays: Number(process.env.CLINIC_INVITATION_TTL_DAYS ?? 7),
}));
