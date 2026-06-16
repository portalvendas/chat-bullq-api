import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { EvalResult, EvalRunReport } from './types';

/**
 * Gera o relatório markdown de uma rodada de evals e persiste em disco
 * (`/tmp/evals-report-{timestamp}.md`). A ideia é dar um artefato
 * legível pra humanos revisarem antes de aprovar deploy do agent.
 */
@Injectable()
export class EvalReporterService {
  private readonly logger = new Logger(EvalReporterService.name);

  /**
   * Monta o EvalRunReport a partir da lista de EvalResult e metadados
   * da rodada. Não escreve em disco — use `writeMarkdown` pra isso.
   */
  buildReport(args: {
    agentName: string;
    datasetName: string;
    results: EvalResult[];
  }): EvalRunReport {
    const { agentName, datasetName, results } = args;
    const totalCases = results.length;
    const passed = results.filter((r) => r.passed).length;
    const failed = totalCases - passed;
    const scorePercent =
      totalCases === 0 ? 0 : Math.round((passed / totalCases) * 10000) / 100;
    const totalCostUsd = results.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
    const totalDurationMs = results.reduce(
      (acc, r) => acc + (r.durationMs ?? 0),
      0,
    );

    const report: EvalRunReport = {
      agentName,
      datasetName,
      totalCases,
      passed,
      failed,
      scorePercent,
      totalCostUsd,
      totalDurationMs,
      results,
      generatedAt: new Date(),
    };

    this.logger.log({
      msg: 'eval_run_completed',
      agentName,
      datasetName,
      score: scorePercent,
      passed,
      failed,
      cost: totalCostUsd,
      durationMs: totalDurationMs,
    });

    return report;
  }

  /**
   * Renderiza o relatório como markdown e grava em /tmp. Retorna o path
   * absoluto do arquivo escrito.
   */
  async writeMarkdown(report: EvalRunReport): Promise<string> {
    const timestamp = report.generatedAt
      .toISOString()
      .replace(/[:.]/g, '-');
    const path = `/tmp/evals-report-${timestamp}.md`;
    const md = this.renderMarkdown(report);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, md, 'utf8');

    this.logger.log({ msg: 'eval_report_written', path });
    return path;
  }

  // ─── markdown rendering ──────────────────────────────────────────

  private renderMarkdown(r: EvalRunReport): string {
    const lines: string[] = [];

    lines.push(`# Eval Report — ${r.agentName}`);
    lines.push('');
    lines.push(`- **Dataset**: \`${r.datasetName}\``);
    lines.push(`- **Generated at**: ${r.generatedAt.toISOString()}`);
    lines.push(
      `- **Score**: ${r.scorePercent}% (${r.passed}/${r.totalCases} passed, ${r.failed} failed)`,
    );
    lines.push(`- **Total cost**: $${r.totalCostUsd.toFixed(6)}`);
    lines.push(`- **Total duration**: ${r.totalDurationMs} ms`);
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    lines.push('| # | Case | Result | Failures | Cost (USD) | Duration (ms) |');
    lines.push('|---|------|--------|----------|------------|---------------|');
    r.results.forEach((res, idx) => {
      const status = res.passed ? 'PASS' : 'FAIL';
      lines.push(
        `| ${idx + 1} | ${escapeMd(res.case.name)} | ${status} | ${res.failures.length} | ${res.costUsd.toFixed(6)} | ${res.durationMs} |`,
      );
    });
    lines.push('');

    const failures = r.results.filter((res) => !res.passed);
    if (failures.length > 0) {
      lines.push('## Failures');
      lines.push('');
      failures.forEach((res, idx) => {
        lines.push(`### ${idx + 1}. ${res.case.name}`);
        lines.push('');
        lines.push(`**Input**: \`${escapeMd(res.case.input)}\``);
        lines.push('');

        lines.push('**Expected**:');
        lines.push('```json');
        lines.push(JSON.stringify(res.case.expect, null, 2));
        lines.push('```');
        lines.push('');

        lines.push('**Received**:');
        lines.push('```json');
        lines.push(JSON.stringify(res.agentResponse, null, 2));
        lines.push('```');
        lines.push('');

        lines.push('**Failures**:');
        res.failures.forEach((f) => {
          lines.push(`- ${f}`);
        });
        lines.push('');
      });
    }

    lines.push('## All Cases');
    lines.push('');
    r.results.forEach((res, idx) => {
      const status = res.passed ? 'PASS' : 'FAIL';
      lines.push(`### ${idx + 1}. [${status}] ${res.case.name}`);
      lines.push('');
      lines.push(`- Input: \`${escapeMd(res.case.input)}\``);
      lines.push(
        `- Tool calls: ${res.agentResponse.toolCalls.map((tc) => `\`${tc.name}\``).join(', ') || '_none_'}`,
      );
      lines.push(`- Final action: \`${res.agentResponse.finalAction}\``);
      lines.push(
        `- Final message: ${res.agentResponse.finalMessage ? `"${escapeMd(truncate(res.agentResponse.finalMessage, 200))}"` : '_empty_'}`,
      );
      if (res.failures.length > 0) {
        lines.push('- Failures:');
        res.failures.forEach((f) => lines.push(`  - ${f}`));
      }
      lines.push('');
    });

    return lines.join('\n');
  }
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
