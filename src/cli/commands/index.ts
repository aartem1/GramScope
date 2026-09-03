import type { CliContext, PlanResult } from "../types";
import { runPlan } from "../plan/executor";
import {
  driftSteps,
  installSteps,
  localPreconditionSteps,
  loginSteps,
  migrateSteps,
  rollbackSteps,
  updateSteps,
  vercelStateSteps,
  vpsStateSteps,
} from "./steps";

export async function runDoctor(ctx: CliContext): Promise<PlanResult> {
  const steps = [
    ...localPreconditionSteps(),
    ...vpsStateSteps(),
    ...vercelStateSteps(),
    ...driftSteps(),
  ];
  return runPlan("doctor", steps, ctx);
}

export async function runInstall(ctx: CliContext): Promise<PlanResult> {
  return runPlan("install", installSteps(), ctx, { apply: !ctx.flags.dryRun });
}

export async function runUpdate(ctx: CliContext): Promise<PlanResult> {
  return runPlan("update", updateSteps(), ctx, { apply: !ctx.flags.dryRun });
}

export async function runRollback(ctx: CliContext): Promise<PlanResult> {
  return runPlan("rollback", rollbackSteps(), ctx, { apply: !ctx.flags.dryRun });
}

export async function runLogin(ctx: CliContext): Promise<PlanResult> {
  return runPlan("login", loginSteps(), ctx, { apply: !ctx.flags.dryRun });
}

export async function runMigrate(ctx: CliContext): Promise<PlanResult> {
  return runPlan("migrate", migrateSteps(), ctx, { apply: !ctx.flags.dryRun });
}

export {
  configureSteps,
  INSTALL_STEP_ORDER,
  MIGRATE_STEP_ORDER,
  migrateSteps,
} from "./steps";

export async function runConfigure(
  ctx: CliContext,
  target: string,
): Promise<PlanResult> {
  const { configureSteps } = await import("./steps");
  return runPlan(`configure ${target}`, configureSteps(target), ctx, {
    apply: !ctx.flags.dryRun,
  });
}

export { installSteps, updateSteps, rollbackSteps, loginSteps };
