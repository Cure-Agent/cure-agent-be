import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ulid } from 'ulid';
import { TraceContext } from './trace-context.service';

/** 요청당 traceId(ULID)를 발급·전파한다 (architecture.md §10.3). */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: () => ulid(),
      },
    }),
  ],
  providers: [TraceContext],
  exports: [TraceContext],
})
export class ContextModule {}
