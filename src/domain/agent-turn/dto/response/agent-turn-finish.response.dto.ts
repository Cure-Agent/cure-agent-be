import { ApiProperty } from '@nestjs/swagger';
import { ClinicalGuidanceResponseDto } from '../../../clinical-guidance/dto/response/clinical-guidance.response.dto';
import { MessageResponseDto } from '../../../conversation/dto/response/message.response.dto';

/**
 * 에이전트 완결의 응답 (docs/specs/54) — **메시지에 선택 필드 하나가 더해진 모양이다.**
 *
 * 봉투(`{message, guidance}`)로 감싸지 않는 이유는 §51 완결 기준 전부가 `data`를 메시지로 읽기
 * 때문이다. 참고안을 만든 완결에만 `guidance` 키가 있고(환자 경로·스냅샷 없는 복합에는 없다),
 * 에이전트가 이를 떼어 `answer.completed{message, guidance}`로 갈라 보내 채팅 스트림과 같은
 * 모양을 만든다(§8). 메시지에 `guidanceId`를 싣지 않는 것도 채팅과 같다 —
 * 재조회(`GET /conversations/{id}/messages`)만이 그 축을 싣는다.
 */
export class AgentTurnFinishResponseDto extends MessageResponseDto {
  @ApiProperty({
    type: ClinicalGuidanceResponseDto,
    required: false,
    description: '복합 경로 완료 답변의 임상 참고안 — 만들어진 완결에만 실린다',
  })
  guidance?: ClinicalGuidanceResponseDto;
}
