import { describe, expect, it, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { parseArgv, usage } from "../src/cli/flags";
import { readEnvKey } from "../src/cli/env";
import {
  fingerprintSecret,
  redactSecret,
  secretMatches,
} from "../src/cli/secrets";
import { FakeShell, ok } from "../src/cli/shell/fake";
import {
  deriveResumablePlan,
  evaluateSteps,
  planExitCode,
  runPlan,
  satisfied,
  actionable,
  blocked,
} from "../src/cli/plan/executor";
import type { CliContext, Step } from "../src/cli/types";
import {
  detectDrift,
  probeState,
  type ObservedState,
} from "../src/cli/state/probe";
import {
  runDoctor,
  runLogin,
  runRollback,
  runUpdate,
  runConfigure,
  INSTALL_STEP_ORDER,
  MIGRATE_STEP_ORDER,
  migrateSteps,
  installSteps,
} from "../src/cli/commands";
import { runStatus } from "../src/cli/commands/status";
import {
  renderPlanHuman,
  renderPlanJson,
} from "../src/cli/plan/renderer";
import {
  resetObservedStateCache,
} from "../src/cli/commands/steps";

const HEAD = "abc1234567890abcdef1234567890abcdef1234";
const HEALTH_OK = JSON.stringify({
  uptimeSeconds: 42,
  revision: HEAD,
  telegram: {
    connected: true,
    sessionFingerprint: "0123456789abcdef",
    authorizationCount: 1,
    lastErrorClass: null,
  },
});

function baseLocalShell(): FakeShell {
  return new FakeShell("local")
    .whenEquals("git rev-parse HEAD", ok(HEAD))
    .whenEquals("git status --porcelain", ok(""))
    .whenEquals("git diff --quiet @{upstream} 2>/dev/null; echo $?", ok("0\n"))
    .whenEquals("node -v", ok("v20.11.0\n"))
    .whenEquals("vercel --version", ok("41.0.0\n"))
    .whenEquals("test -d .vercel && echo linked || echo missing", ok("linked\n"))
    .when(
      /ssh -o BatchMode=yes -o ConnectTimeout=5 gramscope-worker true/,
      () => ok(""),
    )
    .when(/vercel ls --prod/, () =>
      ok(`Production deployments\n  ${HEAD}  READY  https://gramscope.vercel.app\n`),
    )
    .when(/curl -sS -o \/dev\/null -w '%\{http_code\}'/, () => ok("401"))
    .when(/vercel env ls production/, () =>
      ok(
        [
          "TELEGRAM_WORKER_URL",
          "TELEGRAM_WORKER_TOKEN",
          "TELEGRAM_WORKER_CA",
          "TELEGRAM_WORKER_CLIENT_CERT",
          "TELEGRAM_WORKER_CLIENT_KEY",
        ].join("\n"),
      ),
    )
    .when(/vercel env pull/, () =>
      ok(
        "TELEGRAM_WORKER_TOKEN=remote-token-value\nTELEGRAM_WORKER_CLIENT_CERT=YmFzZTY0Y2VydA==\n",
      ),
    );
}

function baseVpsShell(ip = "203.0.113.10"): FakeShell {
  return new FakeShell("vps")
    .when(/api.ipify.org/, () => ok(`${ip}\n`))
    .when(/Subject Alternative Name/, () =>
      ok(`X509v3 Subject Alternative Name:\n                IP Address:${ip}, IP Address:127.0.0.1\n`),
    )
    .when(/\/health/, () => ok(HEALTH_OK))
    .when(
      "sudo sed -n 's|^TELEGRAM_WORKER_TOKEN=||p' /etc/gramscope/worker.env 2>/dev/null || true",
      () => ok("remote-token-value\n"),
    )
    .when(
      "sudo sed -n 's|^TELEGRAM_WORKER_PORT=||p' /etc/gramscope/worker.env 2>/dev/null || true",
      () => ok("8443\n"),
    )
    .when("sudo cat /etc/gramscope/worker.env 2>/dev/null || true", () =>
      ok(
        "TELEGRAM_API_ID=1\nTELEGRAM_API_HASH=h\nTELEGRAM_SESSION=s\nTELEGRAM_WORKER_TOKEN=remote-token-value\nTELEGRAM_WORKER_PORT=8443\n",
      ),
    )
    .when(
      "sudo openssl base64 -A -in /etc/gramscope/tls/vercel.crt 2>/dev/null || true",
      () => ok("YmFzZTY0Y2VydA=="),
    )
    .whenEquals("id gramscope", ok(""))
    .when("test -f /opt/gramscope/.git/config", () => ok(""))
    .when("test -f /etc/gramscope/tls/worker.crt", () => ok(""))
    .when("test -f /etc/gramscope/worker.env", () => ok(""))
    .when("systemctl is-active gramscope-worker 2>/dev/null || true", () =>
      ok("active\n"),
    );
}

function ctx(
  localShell: FakeShell,
  vpsShell: FakeShell,
  flags: Partial<CliContext["flags"]> = {},
): CliContext {
  return {
    flags: {
      dryRun: false,
      yes: true,
      json: false,
      verbose: false,
      host: "gramscope-worker",
      ...flags,
    },
    repoRoot: "/repo",
    localShell,
    vpsShell,
  };
}

describe("gramscope CLI flags", () => {
  it("parses global flags and configure positional", () => {
    const parsed = parseArgv([
      "--dry-run",
      "--yes",
      "--json",
      "--verbose",
      "--host",
      "my-host",
      "configure",
      "worker-token",
    ]);
    expect(parsed.command).toBe("configure");
    expect(parsed.positional).toEqual(["worker-token"]);
    expect(parsed.flags).toEqual({
      dryRun: true,
      yes: true,
      json: true,
      verbose: true,
      host: "my-host",
    });
  });

  it("documents all commands", () => {
    expect(usage()).toContain("doctor");
    expect(usage()).toContain("migrate");
    expect(usage()).toContain("--dry-run");
  });
});

describe("plan/apply framework", () => {
  const steps: Step[] = [
    {
      id: "one",
      title: "First",
      check: async () => satisfied("already done"),
    },
    {
      id: "two",
      title: "Second",
      check: async () => actionable("needs work"),
      apply: async () => undefined,
    },
    {
      id: "three",
      title: "Third",
      check: async () => blocked("cannot proceed"),
    },
  ];

  it("classifies check tri-state", async () => {
    const shell = new FakeShell();
    const outcomes = await evaluateSteps(steps, ctx(shell, shell));
    expect(outcomes.map((o) => o.check.status)).toEqual([
      "satisfied",
      "actionable",
      "blocked",
    ]);
  });

  it("dry-run leaves apply side effects unrecorded", async () => {
    const local = new FakeShell();
    const result = await runPlan("install", steps, ctx(local, local, { dryRun: true }), {
      apply: true,
    });
    expect(local.runs.some((r) => r.command.includes("apply"))).toBe(false);
    expect(result.outcomes.find((o) => o.id === "two")?.applied).toBe(false);
  });

  it("resumes from the first still-actionable step after partial apply", async () => {
    let applied = false;
    const resumable: Step[] = [
      {
        id: "a",
        title: "A",
        check: async () => (applied ? satisfied() : actionable()),
        apply: async () => {
          applied = true;
        },
      },
      {
        id: "b",
        title: "B",
        check: async () => actionable("still pending"),
      },
    ];

    const firstPass = await runPlan("install", resumable, ctx(new FakeShell(), new FakeShell()), {
      apply: true,
    });
    expect(firstPass.outcomes[0]?.applied).toBe(true);

    const remaining = await deriveResumablePlan(resumable, ctx(new FakeShell(), new FakeShell()));
    expect(remaining).toEqual(["b"]);
  });

  it("exits non-zero when actionable steps remain or blocked", () => {
    expect(
      planExitCode([
        {
          id: "x",
          title: "x",
          check: actionable(),
          applied: false,
        },
      ]),
    ).toBe(1);
    expect(
      planExitCode([
        {
          id: "x",
          title: "x",
          check: blocked("nope"),
          applied: false,
        },
      ]),
    ).toBe(1);
  });
});

describe("secret handling", () => {
  it("compares secrets by fingerprint without exposing values", () => {
    expect(secretMatches("super-secret", "super-secret")).toBe(true);
    expect(redactSecret("super-secret")).toBe(
      `fp:${fingerprintSecret("super-secret")}`,
    );
    expect(redactSecret("super-secret")).not.toContain("super-secret");
  });

  it("never places secret values in vercel env add argv", async () => {
    const local = baseLocalShell();
    const vps = baseVpsShell();
    await runConfigure(ctx(local, vps, { dryRun: false }), "worker-token");
    const envAdds = local.runs.filter((r) => r.command.includes("vercel env add"));
    for (const run of envAdds) {
      expect(run.command).not.toContain("remote-token-value");
      expect(run.stdin).toBeDefined();
    }
  });
});

describe("drift recognition", () => {
  function driftState(overrides: Partial<ObservedState>): ObservedState {
    return {
      localHead: HEAD,
      gitClean: true,
      gitPushed: true,
      nodeVersion: "v20.11.0",
      vercelCli: true,
      vercelLinked: true,
      sshReachable: true,
      vpsPublicIp: "203.0.113.10",
      certSanCoversIp: true,
      workerRevision: HEAD,
      workerHealthy: true,
      telegramConnected: true,
      authorizationCount: 1,
      vercelDeploymentReady: true,
      vercelRevision: HEAD,
      mcpReturns401: true,
      legacyTelegramVars: [],
      workerVarsPresent: [
        "TELEGRAM_WORKER_URL",
        "TELEGRAM_WORKER_TOKEN",
        "TELEGRAM_WORKER_CA",
        "TELEGRAM_WORKER_CLIENT_CERT",
        "TELEGRAM_WORKER_CLIENT_KEY",
      ],
      workerUrl: "https://203.0.113.10:8443",
      expectedWorkerUrl: "https://203.0.113.10:8443",
      workerTokenMatches: true,
      clientCertMatches: true,
      ...overrides,
    };
  }

  it("detects SAN mismatch", () => {
    const issues = detectDrift(
      driftState({ vpsPublicIp: "198.51.100.2", certSanCoversIp: false }),
    );
    expect(issues.some((i) => i.code === "san_mismatch")).toBe(true);
  });

  it("detects legacy Telegram vars in Vercel", () => {
    const issues = detectDrift(
      driftState({ legacyTelegramVars: ["TELEGRAM_SESSION"] }),
    );
    expect(issues.some((i) => i.code === "legacy_telegram_vars")).toBe(true);
  });

  it("detects revision mismatch", () => {
    const issues = detectDrift(
      driftState({ workerRevision: "oldsha1" }),
    );
    expect(issues.some((i) => i.code === "revision_mismatch")).toBe(true);
  });

  it("detects disconnected Telegram with healthy worker", () => {
    const issues = detectDrift(
      driftState({ telegramConnected: false }),
    );
    expect(issues.some((i) => i.code === "telegram_disconnected")).toBe(true);
  });

  it("detects authorization count != 1", () => {
    const issues = detectDrift(driftState({ authorizationCount: 2 }));
    expect(issues.some((i) => i.code === "authorization_count")).toBe(true);
  });
});

describe("command plans and ordering", () => {
  beforeEach(() => {
    resetObservedStateCache();
  });

  it("doctor runs checks without apply side effects", async () => {
    const local = baseLocalShell();
    const vps = baseVpsShell();
    const result = await runDoctor(ctx(local, vps));
    expect(result.command).toBe("doctor");
    expect(vps.runs.some((r) => r.command.includes("systemctl restart"))).toBe(
      false,
    );
    expect(renderPlanJson(result)).toContain('"command": "doctor"');
  });

  it("install steps follow the documented order", () => {
    expect(installSteps().map((s) => s.id)).toEqual([...INSTALL_STEP_ORDER]);
  });

  it("migrate steps follow the strict cutover order", () => {
    expect(migrateSteps().map((s) => s.id)).toEqual([...MIGRATE_STEP_ORDER]);
  });

  it("status reports revisions and health", async () => {
    const local = baseLocalShell();
    const vps = baseVpsShell();
    const result = await runStatus(ctx(local, vps, { json: true }));
    expect(result.output).toContain(HEAD);
    expect(result.output).toContain("authorizationCount");
    expect(result.exitCode).toBe(0);
  });

  it("update plans worker before verification", async () => {
    resetObservedStateCache();
    const local = baseLocalShell();
    const vps = baseVpsShell();
    const staleHealth = JSON.stringify({
      ...JSON.parse(HEALTH_OK),
      revision: "stale123",
    });
    vps.when(/\/health/, () => ok(staleHealth));
    const result = await runUpdate(ctx(local, vps, { dryRun: true }));
    expect(result.outcomes[0]?.id).toBe("update.worker");
    expect(result.outcomes[0]?.check.status).toBe("actionable");
  });

  it("rollback includes worker and vercel steps", async () => {
    const result = await runRollback(
      ctx(baseLocalShell(), baseVpsShell(), { dryRun: true }),
    );
    expect(result.outcomes.map((o) => o.id)).toEqual([
      "rollback.worker",
      "rollback.vercel",
    ]);
  });

  it("login targets session creation on VPS", async () => {
    const local = baseLocalShell();
    const vps = baseVpsShell();
    vps.when(
      /grep -q '\^TELEGRAM_SESSION=.'/,
      () => ok("absent\n"),
    );
    const result = await runLogin(ctx(local, vps, { dryRun: true }));
    expect(result.outcomes[0]?.check.status).toBe("actionable");
  });

  it("configure rejects unknown targets as blocked", async () => {
    const result = await runConfigure(
      ctx(baseLocalShell(), baseVpsShell()),
      "not-a-target",
    );
    expect(result.outcomes[0]?.check.status).toBe("blocked");
  });
});

describe("repository hygiene", () => {
  it("removed provision.sh in favor of gramscope CLI", () => {
    expect(existsSync("scripts/provision.sh")).toBe(false);
    expect(existsSync("scripts/gramscope")).toBe(true);
  });

  it("keeps deferred scripts until Task 8", () => {
    expect(existsSync("scripts/assert-session-isolation.ts")).toBe(true);
    expect(existsSync("scripts/rotate-telegram-sessions.sh")).toBe(true);
    expect(existsSync("scripts/env-file.ts")).toBe(true);
  });
});

describe("readEnvKey in CLI", () => {
  it("reads values for probe parsing", () => {
    expect(readEnvKey("TELEGRAM_WORKER_URL=https://x:1\n", "TELEGRAM_WORKER_URL")).toBe(
      "https://x:1",
    );
  });
});

describe("renderers", () => {
  it("renders stable human and json plan output", async () => {
    const result = await runDoctor(ctx(baseLocalShell(), baseVpsShell()));
    expect(renderPlanHuman(result)).toContain("command: doctor");
    expect(JSON.parse(renderPlanJson(result)).command).toBe("doctor");
  });
});

describe("probeState with fake shells", () => {
  it("derives state from shell outputs", async () => {
    const state = await probeState(baseLocalShell(), baseVpsShell());
    expect(state.localHead).toBe(HEAD);
    expect(state.workerHealthy).toBe(true);
    expect(state.authorizationCount).toBe(1);
  });
});
