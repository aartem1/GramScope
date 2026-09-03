import type { CliContext, Step, StepCheckResult } from "../types";
import {
  detectDrift,
  isAcceptableTelegramAuthorizationCount,
  MAX_TELEGRAM_AUTHORIZATIONS,
  probeState,
  type ObservedState,
} from "../state/probe";
import { actionable, blocked, satisfied } from "../plan/executor";

let cachedState: ObservedState | null = null;

export async function getObservedState(ctx: CliContext): Promise<ObservedState> {
  if (!cachedState) {
    cachedState = await probeState(ctx.localShell, ctx.vpsShell, {
      sshHost: ctx.flags.host,
    });
  }
  return cachedState;
}

export function resetObservedStateCache(): void {
  cachedState = null;
}

export function localPreconditionSteps(): Step[] {
  return [
    step("local.node", "Node 20 or newer", async (ctx) => {
      const state = await getObservedState(ctx);
      if (!state.nodeVersion) return blocked("node not found");
      const major = Number.parseInt(state.nodeVersion.replace(/^v/, ""), 10);
      return major >= 20
        ? satisfied(`found ${state.nodeVersion}`)
        : blocked(`found ${state.nodeVersion}, need >= 20`);
    }),
    step("local.git-clean", "Clean working tree", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.gitClean
        ? satisfied("working tree clean")
        : actionable("commit or stash uncommitted changes");
    }),
    step("local.git-pushed", "Branch pushed to upstream", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.gitPushed
        ? satisfied("branch matches upstream")
        : actionable("push local commits before deploying");
    }),
    step("local.vercel-cli", "Vercel CLI present and authenticated", async (ctx) => {
      const state = await getObservedState(ctx);
      if (!state.vercelCli) return blocked("vercel CLI not found");
      return satisfied("vercel CLI available");
    }),
    step("local.vercel-linked", "Vercel project linked", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.vercelLinked
        ? satisfied(".vercel present")
        : actionable("run vercel link");
    }),
    step("local.ssh", "SSH alias reachable", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.sshReachable
        ? satisfied(`host ${ctx.flags.host} reachable`)
        : blocked(`cannot reach SSH host ${ctx.flags.host}`);
    }),
  ];
}

export function vpsStateSteps(): Step[] {
  return [
    step("vps.health", "Worker /health responds", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.workerHealthy
        ? satisfied("worker health endpoint ok")
        : actionable("install or restart the worker service");
    }),
    step("vps.telegram", "Telegram connected", async (ctx) => {
      const state = await getObservedState(ctx);
      if (!state.workerHealthy) return blocked("worker not healthy");
      return state.telegramConnected
        ? satisfied("telegram connected")
        : actionable("run ./scripts/gramscope login");
    }),
    step("vps.authorizations", "Telegram authorizations within limit", async (ctx) => {
      const state = await getObservedState(ctx);
      if (state.authorizationCount === null) {
        return blocked("authorization count unavailable");
      }
      return isAcceptableTelegramAuthorizationCount(state.authorizationCount)
        ? satisfied(
            state.authorizationCount === 1
              ? "authorization count is 1 (worker only)"
              : `authorization count is ${state.authorizationCount} (worker plus phone)`,
          )
        : blocked(
            `authorization count is ${state.authorizationCount}, expected 1–${MAX_TELEGRAM_AUTHORIZATIONS} (worker, optionally plus one phone)`,
          );
    }),
    step("vps.revision", "Worker revision matches local HEAD", async (ctx) => {
      const state = await getObservedState(ctx);
      if (!state.localHead || !state.workerRevision) {
        return actionable("deploy worker to current revision");
      }
      return state.localHead === state.workerRevision
        ? satisfied(`revision ${state.workerRevision}`)
        : actionable(
            `worker at ${state.workerRevision}, local HEAD is ${state.localHead}`,
          );
    }),
    step("vps.tls-san", "Server certificate SAN covers public IP", async (ctx) => {
      const state = await getObservedState(ctx);
      if (!state.vpsPublicIp) return blocked("VPS public IP unknown");
      return state.certSanCoversIp
        ? satisfied(`SAN covers ${state.vpsPublicIp}`)
        : actionable("reissue server certificate with current IP SAN");
    }),
  ];
}

export function vercelStateSteps(): Step[] {
  return [
    step("vercel.worker-vars", "Worker variables present in Vercel", async (ctx) => {
      const state = await getObservedState(ctx);
      const required = [
        "TELEGRAM_WORKER_URL",
        "TELEGRAM_WORKER_TOKEN",
        "TELEGRAM_WORKER_CA",
        "TELEGRAM_WORKER_CLIENT_CERT",
        "TELEGRAM_WORKER_CLIENT_KEY",
      ];
      const missing = required.filter(
        (key) => !state.workerVarsPresent.includes(key),
      );
      return missing.length === 0
        ? satisfied("all worker variables present")
        : actionable(`missing: ${missing.join(", ")}`);
    }),
    step("vercel.no-legacy", "Legacy Telegram vars absent from Vercel", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.legacyTelegramVars.length === 0
        ? satisfied("no legacy Telegram credentials")
        : actionable(
            `remove legacy vars: ${state.legacyTelegramVars.join(", ")}`,
          );
    }),
    step("vercel.deployment", "Latest production deployment ready", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.vercelDeploymentReady
        ? satisfied("production deployment READY")
        : actionable("wait for or trigger a production deployment");
    }),
    step("vercel.mcp-auth", "MCP endpoint returns 401 without token", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.mcpReturns401
        ? satisfied("MCP challenges unauthenticated callers")
        : actionable("verify MCP_RESOURCE_URL and OAuth configuration");
    }),
  ];
}

export function driftSteps(): Step[] {
  return [
    step("drift.scan", "No configuration drift detected", async (ctx) => {
      const state = await getObservedState(ctx);
      const issues = detectDrift(state);
      if (issues.length === 0) return satisfied("no drift");
      const first = issues[0];
      return actionable(`${first?.code}: ${first?.message}`);
    }),
  ];
}

export function installSteps(): Step[] {
  return [
    ...localPreconditionSteps(),
    step(
      "install.vps-user",
      "Create gramscope service user and home",
      vpsFileStep("/opt/gramscope", "id gramscope"),
      shellApply("sudo adduser --system --group --home /opt/gramscope gramscope", "vps"),
    ),
    step(
      "install.vps-clone",
      "Clone repository to /opt/gramscope",
      vpsFileStep("/opt/gramscope/.git/config", "test -f /opt/gramscope/.git/config"),
      shellApply(
        "sudo -u gramscope git clone git@github.com:aartem1/GramScope.git /opt/gramscope || true",
        "vps",
      ),
    ),
    step(
      "install.vps-tls",
      "Issue TLS material under /etc/gramscope/tls",
      vpsFileStep("/etc/gramscope/tls/worker.crt", "test -f /etc/gramscope/tls/worker.crt"),
      shellApply("sudo install -d -m 700 /etc/gramscope/tls", "vps"),
    ),
    step(
      "install.vps-env",
      "Create worker environment file",
      vpsFileStep("/etc/gramscope/worker.env", "test -f /etc/gramscope/worker.env"),
      shellApply(
        "sudo install -d -m 700 /etc/gramscope && sudo install -m 600 /dev/null /etc/gramscope/worker.env",
        "vps",
      ),
    ),
    step(
      "install.vps-systemd",
      "Install and enable gramscope-worker unit",
      systemdActiveCheck(),
      shellApply(
        "sudo cp /opt/gramscope/deploy/gramscope-worker.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now gramscope-worker",
        "vps",
      ),
    ),
    step(
      "install.vercel-vars",
      "Publish worker variables to Vercel",
      async (ctx) => {
        const state = await getObservedState(ctx);
        const missing = [
          "TELEGRAM_WORKER_URL",
          "TELEGRAM_WORKER_TOKEN",
          "TELEGRAM_WORKER_CA",
          "TELEGRAM_WORKER_CLIENT_CERT",
          "TELEGRAM_WORKER_CLIENT_KEY",
        ].filter((key) => !state.workerVarsPresent.includes(key));
        return missing.length === 0
          ? satisfied("worker variables published")
          : actionable(`publish: ${missing.join(", ")}`);
      },
      async (ctx) => {
        await publishAllWorkerVercelVars(ctx);
      },
    ),
  ];
}

export function updateSteps(): Step[] {
  return [
    step("update.worker", "Deploy worker to current revision", async (ctx) => {
      const state = await getObservedState(ctx);
      if (state.localHead && state.workerRevision === state.localHead) {
        return satisfied(`worker already at ${state.workerRevision}`);
      }
      return actionable("fetch, build, and restart worker");
    }, async (ctx) => {
      const sha = (await getObservedState(ctx)).localHead ?? "main";
      await ctx.vpsShell.run(
        `cd /opt/gramscope && sudo -u gramscope git fetch origin && sudo -u gramscope git checkout ${sha} && sudo -u gramscope npm ci && sudo -u gramscope npm run build:worker && sudo -u gramscope npm prune --omit=dev && sudo systemctl restart gramscope-worker`,
      );
      resetObservedStateCache();
    }),
    step("update.vercel", "Deploy Vercel half", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.vercelDeploymentReady
        ? satisfied("production deployment ready")
        : actionable("push to main or redeploy production");
    }, async (ctx) => {
      await ctx.localShell.run("git push origin main");
      resetObservedStateCache();
    }),
    ...vpsStateSteps().filter((s) => s.id === "vps.health" || s.id === "vps.telegram"),
  ];
}

export function rollbackSteps(): Step[] {
  return [
    step("rollback.worker", "Roll worker back to previous revision", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.workerRevision
        ? actionable(`roll back from ${state.workerRevision}`)
        : blocked("worker revision unknown");
    }, async (ctx) => {
      await ctx.vpsShell.run(
        "cd /opt/gramscope && sudo -u gramscope git checkout HEAD~1 && sudo -u gramscope npm ci && sudo -u gramscope npm run build:worker && sudo systemctl restart gramscope-worker",
      );
      resetObservedStateCache();
    }),
    step(
      "rollback.vercel",
      "Roll Vercel back to previous deployment",
      async () => actionable("promote previous production deployment"),
      async (ctx) => {
      await ctx.localShell.run("vercel rollback --yes");
      resetObservedStateCache();
    }),
  ];
}

export function loginSteps(): Step[] {
  return [
    step("login.session", "Telegram session present on VPS", async (ctx) => {
      const result = await ctx.vpsShell.run(
        "sudo grep -q '^TELEGRAM_SESSION=.' /etc/gramscope/worker.env && echo present || echo absent",
      );
      return result.stdout.trim() === "present"
        ? satisfied("session present")
        : actionable("run interactive Telegram login on VPS");
    }, async (ctx) => {
      await ctx.vpsShell.run(
        "cd /opt/gramscope && sudo npm run telegram:login:worker",
      );
      await ctx.vpsShell.run("sudo systemctl restart gramscope-worker");
      resetObservedStateCache();
    }),
    ...vpsStateSteps().filter((s) => s.id === "vps.authorizations"),
  ];
}

export function migrateSteps(): Step[] {
  return [
    step("migrate.worker-ready", "Worker installed, healthy, and connected", async (ctx) => {
      const state = await getObservedState(ctx);
      if (!state.workerHealthy) return blocked("worker not healthy");
      if (!state.telegramConnected) return blocked("telegram not connected");
      return satisfied("worker ready for cutover");
    }),
    step("migrate.publish-vars", "Publish worker variables to Vercel", async (ctx) => {
      const state = await getObservedState(ctx);
      const required = [
        "TELEGRAM_WORKER_URL",
        "TELEGRAM_WORKER_TOKEN",
        "TELEGRAM_WORKER_CA",
        "TELEGRAM_WORKER_CLIENT_CERT",
        "TELEGRAM_WORKER_CLIENT_KEY",
      ];
      const missing = required.filter((key) => !state.workerVarsPresent.includes(key));
      return missing.length === 0
        ? satisfied("worker variables published")
        : actionable(`publish: ${missing.join(", ")}`);
    }, async (ctx) => {
      await publishAllWorkerVercelVars(ctx);
    }),
    step(
      "migrate.deploy-vercel",
      "Deploy Vercel half with remote dispatch enabled",
      async (ctx) => {
        const state = await getObservedState(ctx);
        return state.vercelDeploymentReady
          ? satisfied("Vercel deployment ready")
          : actionable("deploy Vercel with remote worker dispatch");
      },
      async (ctx) => {
        await ctx.localShell.run("git push origin main");
        resetObservedStateCache();
      },
    ),
    step("migrate.verify", "Verify end-to-end chain", async (ctx) => {
      const state = await getObservedState(ctx);
      if (!state.workerHealthy || !state.telegramConnected) {
        return blocked("worker chain not healthy");
      }
      if (!state.mcpReturns401) {
        return blocked("MCP endpoint verification failed");
      }
      return satisfied("chain verified");
    }),
    step("migrate.remove-legacy", "Remove legacy Telegram vars from Vercel", async (ctx) => {
      const state = await getObservedState(ctx);
      return state.legacyTelegramVars.length === 0
        ? satisfied("legacy vars already removed")
        : actionable(`remove: ${state.legacyTelegramVars.join(", ")}`);
    }, async (ctx) => {
      for (const key of ["TELEGRAM_SESSION", "TELEGRAM_API_ID", "TELEGRAM_API_HASH"]) {
        await ctx.localShell.run(`vercel env rm ${key} production --yes`);
      }
      await ctx.localShell.run("git push origin main");
      resetObservedStateCache();
    }),
    step(
      "migrate.owner-authorizations",
      "Owner terminates unused Telegram authorizations",
      async (ctx) => {
        const state = await getObservedState(ctx);
        if (state.authorizationCount === null) {
          return blocked("authorization count unavailable");
        }
        return isAcceptableTelegramAuthorizationCount(state.authorizationCount)
          ? satisfied(
              state.authorizationCount === 1
                ? "authorization count is 1 (worker only)"
                : `authorization count is ${state.authorizationCount} (worker plus phone)`,
            )
          : actionable(
              `terminate extra authorizations in Telegram Settings → Devices until at most ${MAX_TELEGRAM_AUTHORIZATIONS} remain (worker plus optional phone), then re-run doctor`,
            );
      },
    ),
  ];
}

export function configureSteps(target: string): Step[] {
  switch (target) {
    case "worker-token":
      return [
        step(
          "configure.worker-token",
          "Rotate TELEGRAM_WORKER_TOKEN",
          async () => actionable("generate new token on VPS and publish to Vercel"),
          async (ctx) => {
          await ctx.vpsShell.run(
            "sudo sh -c 'sed -i \"s|^TELEGRAM_WORKER_TOKEN=.*|TELEGRAM_WORKER_TOKEN=$(openssl rand -base64 32)|\" /etc/gramscope/worker.env'",
          );
          await publishVercelSecretFromWorkerEnv(ctx, "TELEGRAM_WORKER_TOKEN");
          await ctx.vpsShell.run("sudo systemctl restart gramscope-worker");
          resetObservedStateCache();
        }),
      ];
    case "worker-url":
      return [
        step("configure.worker-url", "Set TELEGRAM_WORKER_URL from VPS", async (ctx) => {
          const state = await getObservedState(ctx);
          return state.expectedWorkerUrl
            ? actionable(`publish ${state.expectedWorkerUrl}`)
            : blocked("cannot derive worker URL");
        }, async (ctx) => {
          const state = await getObservedState(ctx);
          if (!state.expectedWorkerUrl) throw new Error("worker URL unknown");
          await publishVercelPlain(ctx, "TELEGRAM_WORKER_URL", state.expectedWorkerUrl);
          resetObservedStateCache();
        }),
      ];
    case "media-token-secret":
      return [
        step(
          "configure.media-token",
          "Rotate MEDIA_TOKEN_SECRET on Vercel",
          async () => actionable("generate and publish new MEDIA_TOKEN_SECRET"),
          async (ctx) => {
          const token = (await ctx.localShell.run("openssl rand -base64 32")).stdout.trim();
          await publishVercelPlain(ctx, "MEDIA_TOKEN_SECRET", token);
          resetObservedStateCache();
        }),
      ];
    case "port":
      return [
        step(
          "configure.port",
          "Change worker listener port",
          async () =>
            actionable(
              "update worker.env, restart service, republish TELEGRAM_WORKER_URL",
            ),
        ),
      ];
    case "client-cert":
    case "server-cert":
      return [
        step(
          "configure.tls",
          `Reissue ${target}`,
          async () => actionable("reissue TLS material per operations.md §4.2"),
        ),
      ];
    case "vercel-region":
      return [
        step(
          "configure.region",
          "Set Vercel function region",
          async () => actionable("update region in Vercel project settings"),
        ),
      ];
    default:
      return [
        step(
          "configure.unknown",
          `Unknown configure target: ${target}`,
          async () => blocked(`unsupported target: ${target}`),
        ),
      ];
  }
}

function shellApply(
  command: string,
  target: "local" | "vps",
): (ctx: CliContext) => Promise<void> {
  return async (ctx) => {
    const shell = target === "local" ? ctx.localShell : ctx.vpsShell;
    await shell.run(command);
    resetObservedStateCache();
  };
}

function step(
  id: string,
  title: string,
  check: (ctx: CliContext) => Promise<StepCheckResult>,
  apply?: (ctx: CliContext) => Promise<void>,
): Step {
  return { id, title, check, apply };
}

function vpsFileStep(
  path: string,
  probeCommand: string,
): (ctx: CliContext) => Promise<StepCheckResult> {
  return async (ctx) => {
    const result = await ctx.vpsShell.run(probeCommand);
    return result.exitCode === 0
      ? satisfied(`${path} present`)
      : actionable(`create ${path}`);
  };
}

function systemdActiveCheck(): (ctx: CliContext) => Promise<StepCheckResult> {
  return async (ctx) => {
    const result = await ctx.vpsShell.run(
      "systemctl is-active gramscope-worker 2>/dev/null || true",
    );
    return result.stdout.trim() === "active"
      ? satisfied("gramscope-worker active")
      : actionable("install and start gramscope-worker");
  };
}

async function publishAllWorkerVercelVars(ctx: CliContext): Promise<void> {
  const state = await getObservedState(ctx);
  if (!state.expectedWorkerUrl) {
    throw new Error("cannot derive TELEGRAM_WORKER_URL from VPS address and port");
  }
  await publishVercelFromVps(ctx, "TELEGRAM_WORKER_CA", "ca.crt");
  await publishVercelFromVps(ctx, "TELEGRAM_WORKER_CLIENT_CERT", "vercel.crt");
  await publishVercelFromVps(ctx, "TELEGRAM_WORKER_CLIENT_KEY", "vercel.key");
  await publishVercelSecretFromWorkerEnv(ctx, "TELEGRAM_WORKER_TOKEN");
  await publishVercelPlain(ctx, "TELEGRAM_WORKER_URL", state.expectedWorkerUrl);
  resetObservedStateCache();
}

async function publishVercelFromVps(
  ctx: CliContext,
  vercelVar: string,
  tlsFile: string,
): Promise<void> {
  await ctx.localShell.run(`vercel env rm ${vercelVar} production --yes`);
  await ctx.localShell.run(
    `ssh ${ctx.flags.host} "sudo openssl base64 -A -in /etc/gramscope/tls/${tlsFile}" | vercel env add ${vercelVar} production`,
  );
}

async function publishVercelSecretFromWorkerEnv(
  ctx: CliContext,
  vercelVar: string,
): Promise<void> {
  await ctx.localShell.run(`vercel env rm ${vercelVar} production --yes`);
  const remote = await ctx.vpsShell.run(
    `sudo sed -n 's|^${vercelVar}=||p' /etc/gramscope/worker.env`,
  );
  await ctx.localShell.run(`vercel env add ${vercelVar} production`, {
    stdin: remote.stdout.trim(),
  });
}

async function publishVercelPlain(
  ctx: CliContext,
  vercelVar: string,
  value: string,
): Promise<void> {
  await ctx.localShell.run(`vercel env rm ${vercelVar} production --yes`);
  await ctx.localShell.run(`vercel env add ${vercelVar} production`, {
    stdin: value,
  });
}

export const MIGRATE_STEP_ORDER = [
  "migrate.worker-ready",
  "migrate.publish-vars",
  "migrate.deploy-vercel",
  "migrate.verify",
  "migrate.remove-legacy",
  "migrate.owner-authorizations",
] as const;

export const INSTALL_STEP_ORDER = [
  "local.node",
  "local.git-clean",
  "local.git-pushed",
  "local.vercel-cli",
  "local.vercel-linked",
  "local.ssh",
  "install.vps-user",
  "install.vps-clone",
  "install.vps-tls",
  "install.vps-env",
  "install.vps-systemd",
  "install.vercel-vars",
] as const;
