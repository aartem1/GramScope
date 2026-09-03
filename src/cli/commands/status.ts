import type { CliContext } from "../types";
import {
  observedToStatus,
  probeState,
  detectDrift,
} from "../state/probe";
import {
  renderDriftHuman,
  renderDriftJson,
  renderStatusHuman,
} from "../plan/renderer";

export async function runStatus(ctx: CliContext): Promise<{
  exitCode: number;
  output: string;
}> {
  const state = await probeState(ctx.localShell, ctx.vpsShell, {
    sshHost: ctx.flags.host,
  });
  const status = observedToStatus(state);
  const drift = detectDrift(state);
  const exitCode = drift.length > 0 ? 1 : 0;

  if (ctx.flags.json) {
    return {
      exitCode,
      output: `${JSON.stringify({ ...status, drift: drift.map((d) => d.code) }, null, 2)}\n`,
    };
  }

  const lines = [renderStatusHuman(status)];
  if (drift.length > 0) {
    lines.push("", "drift:", renderDriftHuman(drift).trimEnd());
  }
  return { exitCode, output: `${lines.join("\n")}\n` };
}

export { renderDriftHuman, renderDriftJson };
