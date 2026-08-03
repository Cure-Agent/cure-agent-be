/**
 * 참고안 구조화 리포트 렌더링 (docs/specs/33).
 * 소비처는 화면이 아니라 `docs/rag-eval/`에 커밋되는 파일이다 — 채택 판정의 근거로 남는다.
 *
 * 케이스 전문을 싣는 이유: 채택 게이트 두 축(근거·프로필 밖 창작 0건 / 프로필 오독 0건)은
 * 기계가 못 재고 사람이 읽어야 한다. 리포트가 곧 육안 전수 검토의 작업면이다.
 */
import { GuidanceEvalReport } from './guidance-eval.service';

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function ratio(part: number, total: number): string {
  return total === 0 ? '—' : `${((part / total) * 100).toFixed(1)}%`;
}

export function renderGuidanceEvalReport(report: GuidanceEvalReport): string {
  const lines: string[] = [];
  const { outcomes, legValidation: leg, latency } = report;

  lines.push('# 참고안 구조화 측정 (guidance 축)');
  lines.push('');
  lines.push(`- promptVersion: \`${report.promptVersion}\``);
  lines.push(`- 구조화기: \`${report.structurerModel}\``);
  lines.push(`- 케이스: ${report.caseCount}`);
  lines.push('');

  lines.push('## 조립 결말');
  lines.push('');
  lines.push('| 결말 | 케이스 | 비율 |');
  lines.push('| --- | --- | --- |');
  const total = outcomes.structured + outcomes.fallback + outcomes.skipped;
  lines.push(`| structured | ${outcomes.structured} | ${ratio(outcomes.structured, total)} |`);
  lines.push(`| fallback | ${outcomes.fallback} | ${ratio(outcomes.fallback, total)} |`);
  lines.push(`| skipped(인용 0건) | ${outcomes.skipped} | ${ratio(outcomes.skipped, total)} |`);
  lines.push('');
  lines.push(
    `**채택 게이트 — 폴백률 10% 미만**: ${ratio(outcomes.fallback, total)} (분모는 skipped 포함 전 케이스)`,
  );
  lines.push('');

  lines.push('## 두 다리 검증');
  lines.push('');
  lines.push('| 축 | 수 |');
  lines.push('| --- | --- |');
  lines.push(`| 구조화기가 낸 항목 | ${leg.produced} |`);
  lines.push(`| 검증 통과 항목 | ${leg.accepted} |`);
  lines.push(`| 통과율 | ${ratio(leg.accepted, leg.produced)} |`);
  lines.push('');

  lines.push('## 구조화 호출 지연');
  lines.push('');
  if (latency === null) {
    lines.push('호출 없음 — 전 케이스가 skipped다.');
  } else {
    lines.push('| p50 | p90 | max | 상한 |');
    lines.push('| --- | --- | --- | --- |');
    lines.push(
      `| ${latency.p50.toFixed(2)}s | ${latency.p90.toFixed(2)}s | ${latency.max.toFixed(2)}s | 20s |`,
    );
  }
  lines.push('');

  lines.push('## 육안 판정 대상 (전수)');
  lines.push('');
  lines.push('> 두 축을 사람이 본다: ⑴ 근거·프로필 밖 구체 임상 항목 창작 ⑵ 프로필 오독.');
  lines.push('> 둘 다 **0건**이어야 채택한다.');
  lines.push('');

  for (const item of report.cases) {
    lines.push(`### ${item.itemId} · ${item.caseLabel} — ${item.outcome}`);
    lines.push('');
    lines.push(`- 질문: ${cell(item.question)}`);
    lines.push(`- 인용 마커: ${item.citedMarkers.join(', ') || '없음'}`);
    lines.push(`- 값이 채워진 프로필 필드: ${item.profileFields.join(', ') || '없음'}`);
    lines.push(
      `- 항목: 생성 ${item.producedCount} → 통과 ${item.accepted.length}` +
        (item.durationSec === null ? '' : ` (${item.durationSec.toFixed(2)}s)`),
    );
    lines.push('');
    lines.push(`답변: ${cell(item.answer)}`);
    lines.push('');
    if (item.accepted.length === 0) {
      lines.push('통과 항목 없음 — 결정적 조립으로 폴백한다.');
      lines.push('');
      continue;
    }
    lines.push('| 적용 판단 | 제목 | 근거 | 환자 다리 | 서술 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const consideration of item.accepted) {
      const markers = consideration.citations.map((citation) => `[${citation.marker}]`).join('');
      lines.push(
        `| ${consideration.applicability ?? '—'} | ${cell(consideration.title)} | ${markers} | ` +
          `${(consideration.patientFactors ?? []).join(', ')} | ${cell(consideration.rationale)} |`,
      );
    }
    lines.push('');
  }

  if (report.failures.length > 0) {
    lines.push('## 실패 케이스');
    lines.push('');
    lines.push('| 문항 | 프로필 | 사유 |');
    lines.push('| --- | --- | --- |');
    for (const failure of report.failures) {
      lines.push(`| ${failure.itemId} | ${failure.caseLabel} | ${cell(failure.reason)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
