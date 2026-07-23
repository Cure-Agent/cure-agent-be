import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

/** 요청당 traceId(ULID) 접근자. CLS 밖(부트스트랩 등)에서는 빈 문자열을 반환한다. */
@Injectable()
export class TraceContext {
  constructor(private readonly cls: ClsService) {}

  get traceId(): string {
    return this.cls.isActive() ? (this.cls.getId() ?? '') : '';
  }
}
