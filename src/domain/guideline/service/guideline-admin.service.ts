import { Injectable } from '@nestjs/common';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { PageResult } from '../../../global/common/response/page-result';
import { ListAdminGuidelinesQueryDto } from '../dto/request/list-admin-guidelines.query.dto';
import { RunPipelineRequestDto } from '../dto/request/run-pipeline.request.dto';
import { UpdateVersionStatusRequestDto } from '../dto/request/update-version-status.request.dto';
import { AdminGuidelineVersionResponseDto } from '../dto/response/admin-guideline-version.response.dto';
import { AdminGuidelineResponseDto } from '../dto/response/admin-guideline.response.dto';
import { AdminIngestResponseDto } from '../dto/response/admin-ingest.response.dto';

/**
 * 지침 코퍼스 관리 유스케이스 (docs/specs/21).
 *
 * 파싱과 적재를 합치고 적재 전 검토 경로는 두지 않는다 — §20 실패 가드가 구조 문제를 막고,
 * 이 스텝의 revision·SUPERSEDED·삭제가 "적재 후 되돌리기"를 제공하기 때문이다.
 */
@Injectable()
export class GuidelineAdminService {
  /** 1건 수집→파싱→적재. PDF는 메모리에서 파싱하고 버린다 — 디스크에 쓰면 누적된다. */
  // TODO(docs/specs/21): 스텁
  runPipeline(_request: RunPipelineRequestDto): Promise<AdminIngestResponseDto> {
    return Promise.reject(new ServiceException('INTERNAL_ERROR'));
  }

  // TODO(docs/specs/21): 스텁
  listGuidelines(
    _query: ListAdminGuidelinesQueryDto,
  ): Promise<PageResult<AdminGuidelineResponseDto>> {
    return Promise.reject(new ServiceException('INTERNAL_ERROR'));
  }

  // TODO(docs/specs/21): 스텁
  updateVersionStatus(
    _versionId: string,
    _request: UpdateVersionStatusRequestDto,
  ): Promise<AdminGuidelineVersionResponseDto> {
    return Promise.reject(new ServiceException('INTERNAL_ERROR'));
  }

  /** 인용된 청크가 하나라도 있으면 409로 거부하고 아무것도 지우지 않는다 (부분 삭제 금지). */
  // TODO(docs/specs/21): 스텁
  deleteVersion(_versionId: string): Promise<void> {
    return Promise.reject(new ServiceException('INTERNAL_ERROR'));
  }
}
