import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  ApiEnvelopeResponse,
  ApiPageResponse,
} from '../../../global/common/response/api-envelope.decorator';
import { ApiResponseDto } from '../../../global/common/response/api-response.dto';
import { PageResult } from '../../../global/common/response/page-result';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { CreateConversationRequestDto } from '../dto/request/create-conversation.request.dto';
import { ListConversationsQueryDto } from '../dto/request/list-conversations.query.dto';
import { ListMessagesQueryDto } from '../dto/request/list-messages.query.dto';
import { SendMessageRequestDto } from '../dto/request/send-message.request.dto';
import { UpdateConversationRequestDto } from '../dto/request/update-conversation.request.dto';
import { ConversationDetailResponseDto } from '../dto/response/conversation-detail.response.dto';
import { ConversationSummaryResponseDto } from '../dto/response/conversation-summary.response.dto';
import { MessageResponseDto } from '../dto/response/message.response.dto';
import { ConversationStreamService } from '../service/conversation-stream.service';
import { ConversationService } from '../service/conversation.service';

@ApiTags('Conversation')
@Controller('conversations')
export class ConversationController {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly streamService: ConversationStreamService,
  ) {}

  @Post()
  @ApiOperation({ summary: '대화 생성 (GUIDELINE_QA)' })
  @ApiEnvelopeResponse(ConversationSummaryResponseDto, { status: 201 })
  async create(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Body() dto: CreateConversationRequestDto,
  ): Promise<ApiResponseDto<ConversationSummaryResponseDto>> {
    const created = await this.conversationService.create(principal, dto);
    return ApiResponseDto.success(created, 'CREATED');
  }

  @Get()
  @ApiOperation({
    summary: '내 대화 목록 (커서 기반)',
    description:
      '최근 대화순(lastMessageAt 내림차순) — 메시지를 주고받아야 대화가 맨 앞으로 온다. ' +
      '제목 변경·보관은 순서를 바꾸지 않는다. ' +
      '커서는 이 정렬 키를 담으므로 정렬을 바꾸면 이전에 발급된 커서는 무효(400 BAD_REQUEST)다.',
  })
  @ApiPageResponse(ConversationSummaryResponseDto)
  list(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Query() query: ListConversationsQueryDto,
  ): Promise<PageResult<ConversationSummaryResponseDto>> {
    return this.conversationService.list(principal, query);
  }

  @Get(':conversationId')
  @ApiOperation({ summary: '대화 상세' })
  @ApiEnvelopeResponse(ConversationDetailResponseDto)
  detail(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('conversationId') conversationId: string,
  ): Promise<ConversationDetailResponseDto> {
    return this.conversationService.detail(principal, conversationId);
  }

  @Patch(':conversationId')
  @ApiOperation({ summary: '대화명 변경 (§5.7)' })
  @ApiEnvelopeResponse(ConversationSummaryResponseDto)
  rename(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('conversationId') conversationId: string,
    @Body() dto: UpdateConversationRequestDto,
  ): Promise<ConversationSummaryResponseDto> {
    return this.conversationService.rename(principal, conversationId, dto.title);
  }

  @Post(':conversationId/archive')
  @HttpCode(200)
  @ApiOperation({ summary: '대화 보관 (§5.7 — 멱등)' })
  archive(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('conversationId') conversationId: string,
  ): Promise<null> {
    return this.conversationService.archive(principal, conversationId);
  }

  @Post(':conversationId/unarchive')
  @HttpCode(200)
  @ApiOperation({ summary: '대화 보관 해제 (§5.7 — 멱등)' })
  unarchive(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('conversationId') conversationId: string,
  ): Promise<null> {
    return this.conversationService.unarchive(principal, conversationId);
  }

  @Delete(':conversationId')
  @HttpCode(200)
  @ApiOperation({
    summary: '대화 삭제 (docs/specs/34 — 멱등)',
    description:
      '소프트 삭제다. 유예가 지나면 크론이 물리 삭제하며 복구 API는 없다. ' +
      '재삭제해도 파기 시각은 미뤄지지 않는다. 보관 여부와 무관하게 삭제된다.',
  })
  remove(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('conversationId') conversationId: string,
  ): Promise<null> {
    return this.conversationService.remove(principal, conversationId);
  }

  @Get(':conversationId/messages')
  @ApiOperation({ summary: '메시지 목록 (기본 시간순, order=desc 시 최신부터 역방향 — §8 복구 폴백)' })
  @ApiPageResponse(MessageResponseDto)
  listMessages(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('conversationId') conversationId: string,
    @Query() query: ListMessagesQueryDto,
  ): Promise<PageResult<MessageResponseDto>> {
    return this.conversationService.listMessages(principal, conversationId, query);
  }

  @Post(':conversationId/messages/stream')
  @ApiOperation({
    summary: '질문 전송 + SSE 스트리밍 답변',
    description:
      'message.accepted → retrieval.started → retrieval.progress(stage) → answer.started → ' +
      'retrieval.evidence(index,total) × N → retrieval.completed → answer.delta(seq) → ' +
      'answer.completed | answer.abstained | error. ' +
      'retrieval.progress의 stage는 embedded·searched·reranked이며 **실제로 일어난 단계만** 나간다 ' +
      '— 리랭크가 꺼져 있거나 기권으로 먼저 이탈하면 그 단계는 오지 않는다. ' +
      'candidates(검색이 반환한 후보 수)는 stage=searched에만 실린다. ' +
      'answer.started는 검색 게이트를 통과해 답변 생성으로 넘어가는 경계이며 큰 프레임보다 ' +
      '**앞에** 나간다 — evidenceCount(최종 근거 수)만 싣고 근거 배열은 싣지 않는다. ' +
      '검색 게이트(근거 0건·거리 컷·점수 컷) 기권에는 나가지 않고, 생성 게이트 기권에는 ' +
      '이미 발신돼 있다. 근거는 retrieval.evidence로 **1건당 한 프레임**씩 리랭크 순위대로 나가며 ' +
      'index는 0부터 연속, total은 모든 프레임에서 같다 — retrieval.completed는 근거를 싣지 않는다. ' +
      '15초 heartbeat 주석 전송.',
  })
  @ApiProduces('text/event-stream')
  async streamMessage(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('conversationId') conversationId: string,
    @Body() dto: SendMessageRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // 클라이언트 이탈 감지 → §8-4 CANCELLED 정리에 사용
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    await this.streamService.stream(principal, conversationId, dto, res, abortController.signal);
  }
}
