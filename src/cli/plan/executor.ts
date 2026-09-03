import type {
  CliContext,
  PlanResult,
  Step,
  StepCheckResult,
  StepOutcome,
} from "../types";

export async function evaluateSteps(
  steps: Step[],
  ctx: CliContext,
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    const check = await step.check(ctx);
    outcomes.push({
      id: step.id,
      title: step.title,
      check,
      applied: false,
    });
  }
  return outcomes;
}

export async function applyActionableSteps(
  steps: Step[],
  outcomes: StepOutcome[],
  ctx: CliContext,
): Promise<StepOutcome[]> {
  const updated = [...outcomes];
  const byId = new Map(steps.map((step) => [step.id, step]));

  for (let i = 0; i < updated.length; i++) {
    const outcome = updated[i];
    if (!outcome) continue;
    if (outcome.check.status !== "actionable") continue;

    const step = byId.get(outcome.id);
    if (!step?.apply) {
      updated[i] = {
        ...outcome,
        applyError: "no apply handler",
      };
      continue;
    }

    if (ctx.flags.dryRun) continue;

    try {
      await step.apply(ctx);
      const recheck = await step.check(ctx);
      updated[i] = { ...outcome, applied: true, check: recheck };
    } catch (err) {
      updated[i] = {
        ...outcome,
        applyError: err instanceof Error ? err.message : String(err),
      };
      break;
    }
  }

  return updated;
}

export function planExitCode(outcomes: StepOutcome[]): number {
  if (outcomes.some((o) => o.check.status === "blocked" || o.applyError)) {
    return 1;
  }
  if (outcomes.some((o) => o.check.status === "actionable" && !o.applied)) {
    return 1;
  }
  return 0;
}

export async function runPlan(
  command: string,
  steps: Step[],
  ctx: CliContext,
  options?: { apply?: boolean },
): Promise<PlanResult> {
  let outcomes = await evaluateSteps(steps, ctx);

  if (options?.apply) {
    outcomes = await applyActionableSteps(steps, outcomes, ctx);
  }

  return {
    command,
    outcomes,
    exitCode: planExitCode(outcomes),
  };
}

export function satisfied(reason?: string): StepCheckResult {
  return { status: "satisfied", reason };
}

export function actionable(reason?: string): StepCheckResult {
  return { status: "actionable", reason };
}

export function blocked(reason: string): StepCheckResult {
  return { status: "blocked", reason };
}

export async function deriveResumablePlan(
  steps: Step[],
  ctx: CliContext,
): Promise<string[]> {
  const outcomes = await evaluateSteps(steps, ctx);
  return outcomes
    .filter((o) => o.check.status === "actionable")
    .map((o) => o.id);
}
