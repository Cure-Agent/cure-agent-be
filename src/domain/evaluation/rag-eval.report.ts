/**
 * 기준선 리포트 렌더링 (docs/specs/27 수용 기준 5).
 *
 * 마크다운인 이유: 이 산출물의 소비처는 화면이 아니라 **PR의 전후 비교표**다 —
 * diff가 남고 리뷰에 그대로 붙는다.
 */
import { RagEvalReport } from './rag-eval.service';

const RATIO_DIGITS = 3;
const DISTANCE_DIGITS = 4;

function ratio(value: number): string {
  return value.toFixed(RATIO_DIGITS);
}

/** 표 셀이 깨지지 않게 파이프를 이스케이프하고 질문을 한 줄로 줄인다 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

export function renderEvalReport(report: RagEvalReport): string {
  const lines: string[] = [];

  lines.push('# RAG 검색 기준선');
  lines.push('');
  // 정책 버전이 다르면 지표를 나란히 놓지 않는다 — 그래서 맨 위에 둔다
  lines.push(`- retrievalPolicyVersion: \`${report.retrievalPolicyVersion}\``);
  lines.push(`- 검색 가능한 청크: ${report.corpusChunkCount}`);
  lines.push(`- 문항: answerable ${report.answerableCount} / abstain ${report.abstainCount}`);
  lines.push(`- 거리 임계값: ${report.distanceCutoff}`);
  lines.push('');

  lines.push('## 지표');
  lines.push('');
  lines.push('| 지표 | 값 |');
  lines.push('| --- | --- |');
  lines.push(`| Recall@5 | ${ratio(report.recallAt5)} |`);
  lines.push(`| MRR@5 | ${ratio(report.mrrAt5)} |`);
  lines.push(`| Recall@30 | ${ratio(report.recallAt30)} |`);
  lines.push('');
  lines.push(
    'Recall@30이 높은데 Recall@5가 낮으면 후보군엔 있고 순서가 나쁜 것이다(리랭커). ' +
      '둘 다 낮으면 애초에 못 찾는 것이다(하이브리드·임베딩 교체).',
  );
  lines.push('');

  lines.push('## 리랭크 적용 지표 (docs/specs/29)');
  lines.push('');
  lines.push(`- 리랭크 점수 컷: ${report.rerankScoreCutoff}`);
  lines.push('');
  lines.push('| 지표 | 값 |');
  lines.push('| --- | --- |');
  lines.push(`| 리랭크 Recall@5 | ${ratio(report.rerankedRecallAt5)} |`);
  lines.push(`| 리랭크 MRR@5 | ${ratio(report.rerankedMrrAt5)} |`);
  lines.push(`| 리랭크 기권 재현율 | ${ratio(report.rerankedAbstainRecall)} |`);
  lines.push(`| 리랭크 과잉 기권률 | ${ratio(report.rerankedOverAbstainRate)} |`);
  lines.push('');
  lines.push(
    '리랭크 기권 지표는 거리 게이트(§28)와 점수 게이트를 합산한 최종 판정 기준이다. ' +
      '아래 원 순위 지표와의 차이가 리랭커의 기여분이다.',
  );
  lines.push('');

  lines.push('## 기권 판정 (거리 컷 시뮬레이션)');
  lines.push('');
  lines.push('| 지표 | 값 |');
  lines.push('| --- | --- |');
  lines.push(`| 기권 재현율 | ${ratio(report.abstainRecall)} |`);
  lines.push(`| 과잉 기권률 | ${ratio(report.overAbstainRate)} |`);
  lines.push('');
  lines.push(
    '기권 재현율은 범위 밖 문항이 실제로 기권되는 비율, 과잉 기권률은 답해야 하는 문항이 ' +
      '억울하게 기권되는 비율이다. 순위 지표는 컷과 무관하게 측정된다.',
  );
  lines.push('');

  lines.push('## top-1 거리 분포');
  lines.push('');
  lines.push('| kind | 표본 | p10 | p50 | p90 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const distribution of report.distances) {
    lines.push(
      `| ${distribution.kind} | ${distribution.count} | ` +
        `${distribution.p10.toFixed(DISTANCE_DIGITS)} | ` +
        `${distribution.p50.toFixed(DISTANCE_DIGITS)} | ` +
        `${distribution.p90.toFixed(DISTANCE_DIGITS)} |`,
    );
  }
  lines.push('');
  lines.push(
    'answerable과 abstain의 분포가 갈리는 지점이 거리 임계값의 후보다 — ' +
      '겹쳐 있으면 컷으로 둘을 가를 수 없다는 뜻이므로 컷을 두지 않는다.',
  );
  lines.push('');

  lines.push(`## 실패 문항 (운영 K=5 밖) — ${report.failures.length}건`);
  lines.push('');
  if (report.failures.length === 0) {
    lines.push('없음.');
  } else {
    lines.push('| 문항 | 질문 | 발견 순위 |');
    lines.push('| --- | --- | --- |');
    for (const failure of report.failures) {
      const rank = failure.foundAtRank === null ? '없음 (top-30 밖)' : `${failure.foundAtRank}위`;
      lines.push(`| ${cell(failure.itemId)} | ${cell(failure.question)} | ${rank} |`);
    }
  }
  lines.push('');

  // 기권율만으로는 손댈 수 없다 — 게이트를 조정하려면 어느 문항이 몇 점으로 통과했는지,
  // 그게 라벨 오류(사실은 답 가능)인지 진짜 게이트 실패인지 봐야 한다
  lines.push(`## 기권 실패 문항 (기권해야 하는데 답함) — ${report.abstainFailures.length}건`);
  lines.push('');
  if (report.abstainFailures.length === 0) {
    lines.push('없음.');
  } else {
    lines.push('| 문항 | 질문 | top-1 거리 | 리랭크 점수 | top-1 지침 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const failure of report.abstainFailures) {
      lines.push(
        `| ${cell(failure.itemId)} | ${cell(failure.question)} | ` +
          `${failure.top1Distance.toFixed(DISTANCE_DIGITS)} | ${failure.top1Relevance} | ` +
          `${cell(failure.top1Guideline)} |`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}
