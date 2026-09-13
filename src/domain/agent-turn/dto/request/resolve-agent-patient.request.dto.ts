import { IsString, Length } from 'class-validator';

/** 환자 도구 (docs/specs/51) — 질문에 적힌 케이스 라벨. 제약은 환자 등록의 `caseLabel`과 같다 */
export class ResolveAgentPatientRequestDto {
  @IsString()
  @Length(1, 50)
  caseLabel!: string;
}
