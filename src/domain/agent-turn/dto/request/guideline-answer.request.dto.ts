import { IsString, Length } from 'class-validator';

/** 지침 도구 (docs/specs/51) — 경로를 정한 분류기 버전을 턴에 남긴다(「왜 이 경로였나」) */
export class GuidelineAnswerRequestDto {
  @IsString()
  @Length(1, 100)
  classifierVersion!: string;
}
