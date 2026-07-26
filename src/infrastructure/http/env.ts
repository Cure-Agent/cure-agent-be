/**
 * 프로바이더 설정용 env 파싱 헬퍼 (llm·embedding 공용).
 * 값이 없거나 형식이 틀리면 기본값으로 떨어진다 — 필수화는 각 config가 키 유무로 판단한다.
 */

export function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function baseUrl(value: string | undefined, fallback: string): string {
  return (nonEmpty(value) ?? fallback).replace(/\/+$/, '');
}

export function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(nonEmpty(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
