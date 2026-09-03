import type { PlanResult, StatusReport } from "../types";
import type { DriftDiagnosis } from "../state/probe";

export function renderPlanHuman(result: PlanResult): string {
  const lines = [`command: ${result.command}`];
  for (const outcome of result.outcomes) {
    const status = outcome.applied
      ? "applied"
      : outcome.check.status;
    const reason = outcome.check.reason ? ` — ${outcome.check.reason}` : "";
    const error = outcome.applyError ? ` (error: ${outcome.applyError})` : "";
    lines.push(`  [${status}] ${outcome.id}: ${outcome.title}${reason}${error}`);
  }
  lines.push(`exit: ${result.exitCode}`);
  return lines.join("\n");
}

export function renderPlanJson(result: PlanResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function renderStatusJson(status: StatusReport): string {
  return `${JSON.stringify(status, null, 2)}\n`;
}

export function renderStatusHuman(status: StatusReport): string {
  return [
    `local:  ${status.localRevision ?? "unknown"}`,
    `vercel: ${status.vercelRevision ?? "unknown"}`,
    `worker: ${status.workerRevision ?? "unknown"}`,
    `worker healthy: ${formatBool(status.workerHealthy)}`,
    `telegram connected: ${formatBool(status.telegramConnected)}`,
    `authorizations: ${status.authorizationCount ?? "unknown"}`,
  ].join("\n");
}

export function renderDriftJson(issues: DriftDiagnosis[]): string {
  return `${JSON.stringify({ issues }, null, 2)}\n`;
}

export function renderDriftHuman(issues: DriftDiagnosis[]): string {
  if (issues.length === 0) return "no drift detected\n";
  return issues
    .map((issue) => `[${issue.code}] ${issue.message}\n  fix: ${issue.fix}`)
    .join("\n");
}

function formatBool(value: boolean | null): string {
  if (value === null) return "unknown";
  return value ? "yes" : "no";
}
