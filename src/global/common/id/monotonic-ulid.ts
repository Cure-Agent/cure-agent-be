import { monotonicFactory } from 'ulid';

/**
 * 같은 밀리초 내 생성 순서까지 보장하는 ULID.
 * 메시지처럼 id 정렬 = 시간순 계약(§5.7)이 걸린 엔티티는 반드시 이것을 사용한다 —
 * 기본 ulid()는 동일 ms에서 무작위 접미사라 순서가 뒤집힐 수 있다.
 */
export const monotonicUlid = monotonicFactory();
