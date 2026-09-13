import { IsString, Length } from 'class-validator';

/**
 * 근거 도구 (docs/specs/51) — 질문에서 라벨을 지운 문자열. 진단명은 BE가 턴 스냅샷에서 붙이므로
 * 에이전트가 싣지 않는다. 길이 제약은 질문 원문(`content`)과 같다.
 */
export class GuidelineEvidenceRequestDto {
  @IsString()
  @Length(1, 4000)
  query!: string;
}
