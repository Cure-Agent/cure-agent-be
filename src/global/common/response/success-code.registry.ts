/**
 * 성공코드 단일 소스.
 * 도메인 단계에서 화면 분기가 필요한 코드(PATIENT_FETCHED 등)를 여기에 추가한다.
 */
export const SuccessCodes = {
  SUCCESS: { message: '요청에 성공하였습니다.' },
  CREATED: { message: '생성되었습니다.' },
} as const satisfies Record<string, { message: string }>;

export type SuccessCode = keyof typeof SuccessCodes;
