import { Injectable } from '@nestjs/common';
import { GuidelineJobResponseDto } from '../dto/response/guideline-job.response.dto';
import { PipelineRunResponseDto } from '../dto/response/pipeline-run.response.dto';
import { GuidelineJobStreamEventDto } from './guideline-job-stream-event.dto';

type Listener = (event: GuidelineJobStreamEventDto) => void;

interface ActiveJob {
  job: GuidelineJobResponseDto;
  /** order 오름차순 — 스냅샷 뒤에 이어지는 run.stage와 같은 진행 순서여야 한다 */
  runs: PipelineRunResponseDto[];
  listeners: Set<Listener>;
}

export interface AttachResult {
  job: GuidelineJobResponseDto;
  runs: PipelineRunResponseDto[];
  detach: () => void;
}

/**
 * 잡 진행 이벤트 fan-out (docs/specs/22).
 *
 * 인프로세스 EventEmitter로 충분하다 — Redis pub/sub은 인스턴스가 여럿일 때 필요한데 지금은
 * 단일 서버·단일 컨테이너다.
 *
 * **스냅샷을 메모리에서 만드는 이유**: `attach`가 「현재 상태를 읽고」 + 「구독을 등록하는」 두
 * 일을 하는데, 상태를 DB에서 읽으면 그 사이에 `await`가 생겨 그 구간의 이벤트를 놓치거나
 * 중복으로 받는다. 진행 중인 잡의 상태를 메모리에 미러링해 두면 attach 전체가 **await 없는 단일
 * 동기 구간**이 되어 경쟁이 원천적으로 사라진다. 끝난 잡은 더 이상 변하지 않으므로 호출측이
 * DB에서 읽어도 안전하다.
 */
@Injectable()
export class GuidelineJobEventBus {
  private readonly active = new Map<string, ActiveJob>();

  /**
   * 러너가 잡을 시작할 때 — **첫 실행 행을 INSERT하기 전에** 부른다.
   * 늦게 부르면 「행은 보이는데 버스에 엔트리가 없다」는 창이 생긴다.
   */
  register(job: GuidelineJobResponseDto): void {
    this.active.set(job.id, { job, runs: [], listeners: new Set() });
  }

  /** 카운터·total 갱신을 미러에 반영한다. 이벤트는 내보내지 않는다 */
  syncJob(job: GuidelineJobResponseDto): void {
    const entry = this.active.get(job.id);
    if (entry) entry.job = job;
  }

  /**
   * 단계 진입·종결을 알린다. **DB 커밋 뒤에** 부른다 — 트랜잭션 안에서 내보내면 롤백된 상태가
   * 구독자에게 유출된다.
   */
  emitRunStage(job: GuidelineJobResponseDto, run: PipelineRunResponseDto): void {
    const entry = this.active.get(job.id);
    if (!entry) return;

    entry.job = job;
    const index = entry.runs.findIndex((existing) => existing.id === run.id);
    if (index >= 0) entry.runs[index] = run;
    else entry.runs.push(run);

    this.publish(entry, { eventType: 'run.stage', job, run });
  }

  /** 종결 이벤트를 내보내고 엔트리를 거둔다 — 이후 attach는 DB 폴백으로 간다 */
  complete(job: GuidelineJobResponseDto): void {
    const entry = this.active.get(job.id);
    if (!entry) return;

    entry.job = job;
    this.publish(entry, { eventType: 'job.completed', job });
    this.active.delete(job.id);
  }

  /**
   * 구독 등록 + 스냅샷 획득을 **한 동기 구간**에서 처리한다.
   * 진행 중이 아니면 `null` — 호출측이 DB에서 읽어 스냅샷 + 종결을 즉시 보내고 닫는다.
   */
  attach(jobId: string, listener: Listener): AttachResult | null {
    const entry = this.active.get(jobId);
    if (!entry) return null;

    entry.listeners.add(listener);
    return {
      job: entry.job,
      runs: [...entry.runs],
      detach: () => entry.listeners.delete(listener),
    };
  }

  /**
   * 구독자 예외가 잡을 죽이지 않게 격리한다 — 잡은 **스트림과 무관하게 끝까지 돈다**
   * (구독자가 0명이어도, 보던 관리자가 창을 닫아도 계속한다).
   */
  private publish(entry: ActiveJob, event: GuidelineJobStreamEventDto): void {
    for (const listener of [...entry.listeners]) {
      try {
        listener(event);
      } catch {
        entry.listeners.delete(listener);
      }
    }
  }
}
