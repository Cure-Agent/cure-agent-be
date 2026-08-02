/**
 * groundedness 리포트 렌더링 (docs/specs/30).
 * 소비처는 화면이 아니라 `docs/rag-eval/`에 커밋되는 파일이다 — 측정이 쌓이면
 * PR 본문만으로는 비교가 흩어진다(2026-08-02 관행).
 */
import { GroundednessReport } from './groundedness-eval.service';

/** 표 셀이 깨지지 않게 파이프를 이스케이프하고 한 줄로 줄인다 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function ratio(part: number, total: number): string {
  return total === 0 ? '—' : `${((part / total) * 100).toFixed(1)}%`;
}

export function renderGroundednessReport(report: GroundednessReport): string {
  const lines: string[] = [];
  const { verdicts, claims, mechanical, suppressionGuard: guard } = report;

  lines.push('# groundedness 평가 (생성 축)');
  lines.push('');
  // 어떤 생성 계약을 쟀는지가 비교의 전제다 — 정책 버전이 다르면 나란히 놓지 않는다
  lines.push(`- promptVersion: \`${report.promptVersion}\``);
  lines.push(`- 심판: \`${report.judgeModel}\``);
  lines.push(`- 채점 문항(answerable): ${report.answerableCount}`);
  lines.push('');

  lines.push('## verdict 분포');
  lines.push('');
  lines.push('| verdict | 문항 | 비율 |');
  lines.push('| --- | --- | --- |');
  const judged = verdicts.grounded + verdicts.partial + verdicts.ungrounded;
  lines.push(`| grounded | ${verdicts.grounded} | ${ratio(verdicts.grounded, judged)} |`);
  lines.push(`| partial | ${verdicts.partial} | ${ratio(verdicts.partial, judged)} |`);
  lines.push(`| ungrounded | ${verdicts.ungrounded} | ${ratio(verdicts.ungrounded, judged)} |`);
  lines.push('');

  lines.push('## 주장 단위');
  lines.push('');
  lines.push('| 축 | 수 | 비율 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 전체 주장 | ${claims.total} | — |`);
  lines.push(`| supported | ${claims.supported} | ${ratio(claims.supported, claims.total)} |`);
  lines.push(`| miscited | ${claims.miscited} | ${ratio(claims.miscited, claims.total)} |`);
  lines.push(`| unsupported | ${claims.unsupported} | ${ratio(claims.unsupported, claims.total)} |`);
  lines.push('');
  lines.push(
    '**miscited가 안전 최우선 축이다** — 마커가 달려 사용자에게는 검증된 것처럼 보이는데 ' +
      '근거가 그 주장을 뒷받침하지 않는다. unsupported는 할루시네이션 축이고, ' +
      '면책·한계 고지는 qa-v3 규칙 준수라 루브릭이 주장에서 제외한다.',
  );
  lines.push('');

  lines.push('## 기계 검사 (qa-v3 규칙)');
  lines.push('');
  lines.push('| 항목 | 수 |');
  lines.push('| --- | --- |');
  lines.push(`| 마크다운 위반 (규칙 6) | ${mechanical.markdownViolations} |`);
  lines.push(`| 마커 미사용 답변 (규칙 2) | ${mechanical.noMarkerAnswers} |`);
  lines.push('');

  // 프롬프트를 조이는 개선의 부작용을 잡는 축이다 — 결함률만 보면 답변이 앙상해지는
  // 방향의 «개선»을 성공으로 오독한다 (docs/specs/32)
  lines.push('## 과억제 감시');
  lines.push('');
  lines.push('| 지표 | 값 |');
  lines.push('| --- | --- |');
  lines.push(`| 문항당 평균 주장 수 | ${guard.avgClaimsPerAnswer} |`);
  lines.push(`| 평균 답변 길이 (문자) | ${guard.avgAnswerLengthChars} |`);
  lines.push(`| 근거 부족 고지 답변 수 | ${guard.insufficiencyDisclosedCount} |`);
  lines.push('');

  lines.push(`## 결함 문항 (partial·ungrounded) — ${report.flagged.length}건`);
  lines.push('');
  if (report.flagged.length === 0) {
    lines.push('없음.');
  } else {
    lines.push(
      '| 문항 | verdict | miscited | unsupported | 무근거 주장 예시 | miscited 주장 예시 |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const item of report.flagged) {
      const unsupportedExamples =
        item.unsupportedExamples.map((e) => cell(e)).join(' / ') || '—';
      const miscitedExamples = item.miscitedExamples.map((e) => cell(e)).join(' / ') || '—';
      lines.push(
        `| ${cell(item.itemId)} | ${item.verdict} | ${item.miscited} | ${item.unsupported} | ${unsupportedExamples} | ${miscitedExamples} |`,
      );
    }
  }
  lines.push('');

  lines.push(`## 실패 문항 (생성·채점) — ${report.failures.length}건`);
  lines.push('');
  if (report.failures.length === 0) {
    lines.push('없음.');
  } else {
    // 조용한 스킵은 지표를 낙관 오염시킨다 — 실패는 반드시 눈에 띄어야 한다 (§27 계보)
    lines.push('| 문항 | 단계 | 사유 |');
    lines.push('| --- | --- | --- |');
    for (const failure of report.failures) {
      lines.push(`| ${cell(failure.itemId)} | ${failure.stage} | ${cell(failure.reason)} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
