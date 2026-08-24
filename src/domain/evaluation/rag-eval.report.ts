/**
 * 기준선 리포트 렌더링 (docs/specs/27 수용 기준 5).
 *
 * 마크다운인 이유: 이 산출물의 소비처는 화면이 아니라 **PR의 전후 비교표**다 —
 * diff가 남고 리뷰에 그대로 붙는다.
 */
import { GateBreakdown, GenerationVerdictRecord, RagEvalReport } from './rag-eval.service';

const RATIO_DIGITS = 3;
const DISTANCE_DIGITS = 4;

function ratio(value: number): string {
  return value.toFixed(RATIO_DIGITS);
}

/** 표 셀이 깨지지 않게 파이프를 이스케이프하고 질문을 한 줄로 줄인다 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** 컷 스윕 한 kind의 네 갈래를 표 셀 순서로 편다 */
function breakdownCells(breakdown: GateBreakdown): string {
  return [
    breakdown.retrievalGate,
    breakdown.generationGate,
    breakdown.answered,
    breakdown.generationFailed,
  ].join(' | ');
}

/**
 * 생성 게이트 절 (docs/specs/40 게이트 ④).
 *
 * 컷 스윕이 이 리포트의 다른 표와 다른 점: 나머지는 **실행에 쓰인 컷 하나**를 재는데 이 표는
 * **컷 전 구간**을 잰다. 한 번의 실행으로 그게 가능한 이유는 컷이 라우팅에만 쓰이고 생성
 * 입력을 바꾸지 않기 때문이다 — 그래서 각 행은 「그 컷으로 배포했다면」의 운영 동작과 같다.
 */
function generationGateLines(report: RagEvalReport): string[] {
  const lines: string[] = [];

  lines.push('## 생성 게이트 (docs/specs/40 게이트 ④)');
  lines.push('');
  if (!report.generationMeasured) {
    lines.push(
      '- 생성 게이트: **측정하지 않음** — `--no-generation`으로 실행됐다. ' +
        '아래 스윕의 생성 축은 전부 0이고 「답변」은 검색 게이트만 통과한 수다.',
    );
  } else {
    lines.push(`- 생성 프롬프트: \`${report.promptVersion}\``);
    lines.push(
      '- 판정은 **컷과 무관하게 전 문항**에 냈다 — 컷은 라우팅 축일 뿐이라 한 번의 실행으로 ' +
        '컷 전 구간을 재구성할 수 있고, 각 행은 그 컷의 운영 동작과 일치한다.',
    );
  }
  lines.push('');

  lines.push('### 컷 스윕');
  lines.push('');
  lines.push(
    '| 컷 | ans 검색게이트 | ans 생성게이트 | ans 답변 | ans 생성실패 | ' +
      'abs 검색게이트 | abs 생성게이트 | abs 답변 | abs 생성실패 |',
  );
  lines.push(`| ${Array.from({ length: 9 }, () => '---').join(' | ')} |`);
  for (const row of report.cutSweep) {
    lines.push(
      `| ${row.cutoff} | ${breakdownCells(row.answerable)} | ${breakdownCells(row.abstain)} |`,
    );
  }
  lines.push('');
  lines.push(
    'ans=answerable(답해야 하는 문항) · abs=abstain(기권해야 하는 문항). ' +
      '컷을 한 칸 내렸을 때 **ans 검색게이트 감소분이 회수**이고 **abs 검색게이트 감소분이 누출**인데, ' +
      '그 누출 중 얼마가 다시 걸리는지는 **abs 생성게이트** 열이 답한다 — ' +
      '컷 하향의 진짜 대가는 abs 「답변」 열의 증가분이다. ' +
      '반대로 ans 「생성게이트」는 컷을 내려 살린 문항을 생성이 도로 죽인 수, 즉 과잉 기권의 새 축이다. ' +
      '「생성실패」는 판정을 받지 못한 수다 — 답변으로 섞으면 지표가 낙관 오염되므로 따로 센다.',
  );
  lines.push('');

  const triggered = report.generationVerdicts.filter(
    (verdict) => verdict.status === 'insufficient',
  );
  lines.push(`### 생성 게이트 발화 문항 — ${triggered.length}건`);
  lines.push('');
  if (triggered.length === 0) {
    lines.push('없음.');
  } else {
    lines.push('| 문항 | kind | 질문 | 원인 | 리랭크 점수 | 누락 축 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const verdict of triggered) {
      lines.push(
        `| ${cell(verdict.itemId)} | ${verdict.kind} | ${cell(verdict.question)} | ` +
          `${verdict.cause ?? '—'} | ${relevanceCell(verdict)} | ` +
          `${verdict.missingAspects.length === 0 ? '—' : cell(verdict.missingAspects.join('; '))} |`,
      );
    }
    lines.push('');
    lines.push(
      'kind가 abstain이면 **회수**(기권해야 할 문항을 생성이 잡았다)이고, answerable이면 ' +
        '**과잉 기권 후보**다. `empty_aspects`는 모델이 이유를 대지 못한 발화로, ' +
        '이 원인의 분포가 재호출·무효화 처방의 선행 조건이다(spec 40 판단표).',
    );
  }
  lines.push('');

  const failed = report.generationVerdicts.filter((verdict) => verdict.status === 'failed');
  lines.push(`### 생성 실패 문항 — ${failed.length}건`);
  lines.push('');
  if (failed.length === 0) {
    lines.push('없음.');
  } else {
    lines.push('| 문항 | kind | 사유 |');
    lines.push('| --- | --- | --- |');
    for (const verdict of failed) {
      lines.push(
        `| ${cell(verdict.itemId)} | ${verdict.kind} | ${cell(verdict.failureReason ?? '')} |`,
      );
    }
    lines.push('');
    lines.push(
      '실패 문항은 컷 스윕의 「생성실패」 열에만 들어간다 — ' +
        '이 수가 크면 스윕의 생성 축 자체를 신뢰할 수 없다는 뜻이다.',
    );
  }
  lines.push('');

  return lines;
}

/** 리랭크를 타지 않은 문항(검색 0건)은 점수가 없다 */
function relevanceCell(verdict: GenerationVerdictRecord): string {
  return verdict.top1Relevance === null ? '—' : String(verdict.top1Relevance);
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

  // 벡터 지표만 보면 「리랭커가 왜 이만큼밖에 못 올렸나」에 답할 수 없다 —
  // 후보에 없던 것인지 순서가 나빴던 것인지가 이 두 줄에서 갈린다 (docs/specs/31)
  lines.push('## 하이브리드 후보군 (docs/specs/31)');
  lines.push('');
  lines.push('| 지표 | 값 |');
  lines.push('| --- | --- |');
  lines.push(`| 키워드 arm Recall@K | ${ratio(report.keywordRecallAtK)} |`);
  lines.push(`| 합집합 후보 커버리지 | ${ratio(report.unionCoverage)} |`);
  lines.push('');
  lines.push(
    '키워드 arm은 문자 n-gram(pg_trgm) 단독 회수량이고, 합집합 커버리지는 두 arm을 합친 ' +
      '후보에 기대 근거가 있는 비율 — **리랭커가 도달할 수 있는 상한**이다. ' +
      '커버리지와 리랭크 Recall@5의 차이가 리랭커의 남은 몫이고, 커버리지 자체가 낮으면 ' +
      '리랭커를 아무리 고쳐도 그 위로 못 간다.',
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
    lines.push('| 문항 | 질문 | 벡터 순위 | 키워드 순위 |');
    lines.push('| --- | --- | --- | --- |');
    for (const failure of report.failures) {
      const rank = failure.foundAtRank === null ? '없음 (top-30 밖)' : `${failure.foundAtRank}위`;
      const keywordRank =
        failure.keywordFoundAtRank === null
          ? '없음 (top-K 밖)'
          : `${failure.keywordFoundAtRank}위`;
      lines.push(
        `| ${cell(failure.itemId)} | ${cell(failure.question)} | ${rank} | ${keywordRank} |`,
      );
    }
    lines.push('');
    // 어느 arm이 이 문항을 구제했는지가 다음 개입을 고르는 축이다:
    // 한쪽만 찾았으면 융합이 답이고, 둘 다 없으면 임베딩·코퍼스 쪽이다
    lines.push(
      '두 arm의 순위를 나란히 둔다 — 한쪽만 찾은 문항은 융합이 구제하고, ' +
        '둘 다 「없음」이면 후보군 확장으로는 풀리지 않는다(임베딩 교체·코퍼스 보강).',
    );
  }
  lines.push('');

  // 컷은 0~10 정수 위에서 정해진다 — 「9로 올리면 무엇이 갈리는가」에 답하려면 도수가 필요하다
  lines.push('## 리랭크 점수 분포 (top-1 관련도)');
  lines.push('');
  lines.push(`| kind | ${Array.from({ length: 11 }, (_, i) => i).join(' | ')} |`);
  lines.push(`| --- | ${Array.from({ length: 11 }, () => '---').join(' | ')} |`);
  for (const dist of report.relevances) {
    const cells = Array.from({ length: 11 }, (_, score) => dist.histogram[score] ?? 0);
    lines.push(`| ${dist.kind} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push(
    `현재 점수 컷은 ${report.rerankScoreCutoff}이다 — 이 값 미만이 기권이다. ` +
      'abstain 행의 컷 이상 칸이 기권 실패이고, answerable 행의 컷 미만 칸이 과잉 기권이다.',
  );
  lines.push('');

  // 위 히스토그램이 「컷을 옮기면 검색 게이트가 무엇을 가르는가」에 답하고,
  // 아래 스윕이 「그렇게 통과한 것을 생성 게이트가 얼마나 되받는가」에 답한다 — 이어서 읽는 표다
  lines.push(...generationGateLines(report));

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

  // 기권 실패 목록의 대칭축 — 컷 상향의 대가를 문항 단위로 보여준다 (issue #236)
  lines.push(
    `## 과잉 기권 문항 (답해야 하는데 기권함) — ${report.overAbstainFailures.length}건`,
  );
  lines.push('');
  if (report.overAbstainFailures.length === 0) {
    lines.push('없음.');
  } else {
    lines.push('| 문항 | 질문 | 자른 게이트 | top-1 거리 | 리랭크 점수 | 정답 순위 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const failure of report.overAbstainFailures) {
      const distance = Number.isFinite(failure.top1Distance)
        ? failure.top1Distance.toFixed(DISTANCE_DIGITS)
        : '—(검색 0건)';
      const relevance = failure.top1Relevance === null ? '—' : String(failure.top1Relevance);
      const rank = failure.foundAtRank === null ? '없음 (top-30 밖)' : `${failure.foundAtRank}위`;
      lines.push(
        `| ${cell(failure.itemId)} | ${cell(failure.question)} | ${failure.gate} | ` +
          `${distance} | ${relevance} | ${rank} |`,
      );
    }
    lines.push('');
    lines.push(
      '「자른 게이트」가 score면 컷(§29) 조정 대상이고, distance면 거리컷(§28) 쪽이다. ' +
        '정답 순위가 「없음」이면 게이트가 아니라 검색이 못 찾은 것이므로 기권이 옳은 판정이다.',
    );
  }
  lines.push('');

  return lines.join('\n');
}
