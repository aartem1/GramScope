import type { Shell } from "./shell/types";

export type StepStatus = "satisfied" | "actionable" | "blocked";

export interface StepCheckResult {
  status: StepStatus;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface Step {
  id: string;
  title: string;
  check: (ctx: CliContext) => Promise<StepCheckResult>;
  apply?: (ctx: CliContext) => Promise<void>;
}

export interface CliFlags {
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  verbose: boolean;
  host: string;
}

export interface CliContext {
  flags: CliFlags;
  repoRoot: string;
  localShell: Shell;
  vpsShell: Shell;
}

export interface StepOutcome {
  id: string;
  title: string;
  check: StepCheckResult;
  applied: boolean;
  applyError?: string;
}

export interface PlanResult {
  command: string;
  outcomes: StepOutcome[];
  exitCode: number;
}

export interface StatusReport {
  localRevision: string | null;
  vercelRevision: string | null;
  workerRevision: string | null;
  workerHealthy: boolean | null;
  telegramConnected: boolean | null;
  authorizationCount: number | null;
}
