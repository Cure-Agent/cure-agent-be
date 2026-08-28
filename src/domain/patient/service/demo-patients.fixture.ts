/**
 * 라이브 데모용 가상 환자 (docs/specs/41).
 *
 * **값은 구현에서 채운다** — 스펙의 「가상 환자 3건의 전체 값」 표가 원천이고, 그 표를 옮기는
 * 것이 구현의 일이다. 스텁에 값을 미리 넣으면 기준 4~13이 스텁 상태에서 통과해 공허해진다.
 */
export interface DemoPatientFixture {
  caseLabel: string;
  birthYear: number;
  sex: 'MALE' | 'FEMALE';
  heightCm: number;
  weightKg: number;
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes?: string;
}

export const DEMO_PATIENTS: readonly DemoPatientFixture[] = [];
