import { GuidelineJobResponseDto } from '../dto/response/guideline-job.response.dto';
import { PipelineRunResponseDto } from '../dto/response/pipeline-run.response.dto';

/**
 * 잡 진행 SSE 계약 (architecture.md §8, docs/specs/22).
 *
 * §8의 대화 스트림과 달리 `seq`·`Last-Event-ID` 재생 버퍼가 없다 — 잡 진행은 델타가 아니라
 * **누적 상태**라 다시 연결해 현재 카운트를 받으면 복구가 끝난다.
 *
 * **모든 이벤트가 `job`을 함께 싣는다.** 진행률 카운터가 항상 최신이라 클라이언트가 이벤트를
 * 누적할 필요가 없다.
 */
export type GuidelineJobStreamEventDto =
  | {
      /** 첫 이벤트. 그때까지의 실행을 전부 싣는다 — 재연결과 최초 연결이 같은 경로다 */
      eventType: 'job.snapshot';
      job: GuidelineJobResponseDto;
      runs: PipelineRunResponseDto[];
    }
  | {
      /**
       * 단계에 **진입할 때마다** 나간다 — 문서당 5개
       * (ACQUIRE·PARSE·EMBED·INGEST 진입 + 종결). 문서가 끝날 때 하나만 보내면 4단계를 나눈
       * 이유가 실시간에는 사라지고, 가장 느린 다운로드 구간이 통째로 침묵이 된다.
       */
      eventType: 'run.stage';
      job: GuidelineJobResponseDto;
      run: PipelineRunResponseDto;
    }
  | {
      /**
       * **유일한 정상 종결.** 취소·중단·전건 실패도 여기로 오고 `job.status`로 구분한다 —
       * 종결을 이벤트 타입으로 쪼개면 소비자가 「어떤 이벤트가 끝인가」를 상태 수만큼 알아야 한다.
       */
      eventType: 'job.completed';
      job: GuidelineJobResponseDto;
    }
  | {
      eventType: 'error';
      code: string;
      message: string;
      retryable: boolean;
      traceId: string;
    };
