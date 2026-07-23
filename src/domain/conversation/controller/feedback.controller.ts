import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { SubmitFeedbackRequestDto } from '../dto/request/submit-feedback.request.dto';
import { ConversationService } from '../service/conversation.service';

@ApiTags('Feedback')
@Controller('messages')
export class FeedbackController {
  constructor(private readonly conversationService: ConversationService) {}

  @Post(':messageId/feedback')
  @HttpCode(200)
  @ApiOperation({ summary: '답변 평가 (재제출 시 갱신)' })
  submit(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('messageId') messageId: string,
    @Body() dto: SubmitFeedbackRequestDto,
  ): Promise<null> {
    return this.conversationService.submitFeedback(principal, messageId, dto);
  }
}
