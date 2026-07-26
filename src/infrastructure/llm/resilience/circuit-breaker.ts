import { Injectable } from '@nestjs/common';

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

/** 프로바이더별 서킷브레이커 (architecture.md §11-2). 연속 실패 임계 초과 시 일정 시간 fail-fast. */
@Injectable()
export class CircuitBreaker {
  private readonly states = new Map<string, BreakerState>();

  isOpen(provider: string): boolean {
    const state = this.states.get(provider);
    if (!state?.openedAt) return false;
    if (Date.now() - state.openedAt >= COOLDOWN_MS) {
      // half-open: 다음 시도 1회 허용
      state.openedAt = null;
      state.consecutiveFailures = FAILURE_THRESHOLD - 1;
      return false;
    }
    return true;
  }

  recordSuccess(provider: string): void {
    this.states.set(provider, { consecutiveFailures: 0, openedAt: null });
  }

  recordFailure(provider: string): void {
    const state = this.states.get(provider) ?? { consecutiveFailures: 0, openedAt: null };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
      state.openedAt = Date.now();
    }
    this.states.set(provider, state);
  }
}
