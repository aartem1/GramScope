import { readEnvKey } from "../env";
import { contentFingerprint } from "../secrets";
import type { Shell } from "../shell/types";
import type { StatusReport } from "../types";

export interface ObservedState {
  localHead: string | null;
  gitClean: boolean;
  gitPushed: boolean;
  nodeVersion: string | null;
  vercelCli: boolean;
  vercelLinked: boolean;
  sshReachable: boolean;
  vpsPublicIp: string | null;
  certSanCoversIp: boolean;
  workerRevision: string | null;
  workerHealthy: boolean;
  telegramConnected: boolean;
  authorizationCount: number | null;
  vercelDeploymentReady: boolean;
  vercelRevision: string | null;
  mcpReturns401: boolean;
  legacyTelegramVars: string[];
  workerVarsPresent: string[];
  workerUrl: string | null;
  expectedWorkerUrl: string | null;
  workerTokenMatches: boolean | null;
  clientCertMatches: boolean | null;
}

export async function probeState(
  localShell: Shell,
  vpsShell: Shell,
): Promise<ObservedState> {
  const [
    localHead,
    gitStatus,
    gitPush,
    nodeVersion,
    vercelVersion,
    vercelProject,
    sshProbe,
    vpsIp,
    certSan,
    health,
    vercelLs,
    mcpProbe,
    vercelEnv,
    workerTokenLocal,
    workerTokenRemote,
    clientCertLocal,
    clientCertRemote,
    workerPort,
  ] = await Promise.all([
    run(localShell, "git rev-parse HEAD"),
    run(localShell, "git status --porcelain"),
    run(localShell, "git diff --quiet @{upstream} 2>/dev/null; echo $?"),
    run(localShell, "node -v"),
    run(localShell, "vercel --version"),
    run(localShell, "test -d .vercel && echo linked || echo missing"),
    run(localShell, `ssh -o BatchMode=yes -o ConnectTimeout=5 gramscope-worker true`),
    run(vpsShell, "curl -sS https://api.ipify.org || true"),
    run(
      vpsShell,
      "openssl x509 -in /etc/gramscope/tls/worker.crt -noout -text 2>/dev/null | grep -A1 'Subject Alternative Name' || true",
    ),
    run(
      vpsShell,
      `sudo bash -c 'set -a; . /etc/gramscope/worker.env 2>/dev/null; set +a; curl -sS --cert /etc/gramscope/tls/vercel.crt --key /etc/gramscope/tls/vercel.key --cacert /etc/gramscope/tls/ca.crt -H "authorization: Bearer $TELEGRAM_WORKER_TOKEN" "https://127.0.0.1:\${TELEGRAM_WORKER_PORT:-0}/health" 2>/dev/null || true'`,
    ),
    run(localShell, "vercel ls --prod 2>/dev/null | head -n 5 || true"),
    run(localShell, "test -n \"$MCP_RESOURCE_URL\" && curl -sS -o /dev/null -w '%{http_code}' \"$MCP_RESOURCE_URL\" || echo missing"),
    run(localShell, "vercel env ls production 2>/dev/null || true"),
    run(localShell, "vercel env pull --environment production --yes - 2>/dev/null | grep '^TELEGRAM_WORKER_TOKEN=' || true"),
    run(vpsShell, "sudo sed -n 's|^TELEGRAM_WORKER_TOKEN=||p' /etc/gramscope/worker.env 2>/dev/null || true"),
    run(localShell, "vercel env pull --environment production --yes - 2>/dev/null | grep '^TELEGRAM_WORKER_CLIENT_CERT=' || true"),
    run(
      vpsShell,
      "sudo openssl base64 -A -in /etc/gramscope/tls/vercel.crt 2>/dev/null || true",
    ),
    run(vpsShell, "sudo sed -n 's|^TELEGRAM_WORKER_PORT=||p' /etc/gramscope/worker.env 2>/dev/null || true"),
  ]);

  const healthJson = parseJson(health.stdout);
  const workerRevision =
    typeof healthJson?.revision === "string" ? healthJson.revision : null;
  const telegram = healthJson?.telegram as
    | {
        connected?: boolean;
        authorizationCount?: number;
      }
    | undefined;

  const legacyKeys = ["TELEGRAM_SESSION", "TELEGRAM_API_ID", "TELEGRAM_API_HASH"];
  const legacyTelegramVars = legacyKeys.filter((key) =>
    vercelEnv.stdout.includes(key),
  );

  const requiredWorkerVars = [
    "TELEGRAM_WORKER_URL",
    "TELEGRAM_WORKER_TOKEN",
    "TELEGRAM_WORKER_CA",
    "TELEGRAM_WORKER_CLIENT_CERT",
    "TELEGRAM_WORKER_CLIENT_KEY",
  ];
  const workerVarsPresent = requiredWorkerVars.filter((key) =>
    vercelEnv.stdout.includes(key),
  );

  const vpsPublicIp = vpsIp.stdout.trim() || null;
  const certSanCoversIp =
    !!vpsPublicIp &&
    certSan.stdout.includes(`IP Address:${vpsPublicIp}`);

  const workerPortValue = workerPort.stdout.trim();
  const expectedWorkerUrl =
    vpsPublicIp && workerPortValue
      ? `https://${vpsPublicIp}:${workerPortValue}`
      : null;

  const workerUrlMatch = vercelEnv.stdout.match(/TELEGRAM_WORKER_URL[^\n]*/);
  const workerUrl = workerUrlMatch
    ? readEnvKey(`${workerUrlMatch[0]}\n`, "TELEGRAM_WORKER_URL")
    : null;

  const localToken = extractEnvValue(workerTokenLocal.stdout, "TELEGRAM_WORKER_TOKEN");
  const remoteToken = workerTokenRemote.stdout.trim();
  const workerTokenMatches =
    localToken && remoteToken
      ? contentFingerprint(localToken) === contentFingerprint(remoteToken)
      : null;

  const localCert = extractEnvValue(clientCertLocal.stdout, "TELEGRAM_WORKER_CLIENT_CERT");
  const remoteCert = clientCertRemote.stdout.trim();
  const clientCertMatches =
    localCert && remoteCert
      ? contentFingerprint(localCert) === contentFingerprint(remoteCert)
      : null;

  return {
    localHead: localHead.exitCode === 0 ? localHead.stdout.trim() : null,
    gitClean: gitStatus.exitCode === 0 && gitStatus.stdout.trim() === "",
    gitPushed: gitPush.stdout.trim() === "0",
    nodeVersion: nodeVersion.exitCode === 0 ? nodeVersion.stdout.trim() : null,
    vercelCli: vercelVersion.exitCode === 0,
    vercelLinked: vercelProject.stdout.trim() === "linked",
    sshReachable: sshProbe.exitCode === 0,
    vpsPublicIp,
    certSanCoversIp,
    workerRevision,
    workerHealthy: health.exitCode === 0 && !!healthJson,
    telegramConnected: telegram?.connected === true,
    authorizationCount:
      typeof telegram?.authorizationCount === "number"
        ? telegram.authorizationCount
        : null,
    vercelDeploymentReady: /READY/.test(vercelLs.stdout),
    vercelRevision: extractVercelRevision(vercelLs.stdout),
    mcpReturns401: mcpProbe.stdout.trim() === "401",
    legacyTelegramVars,
    workerVarsPresent,
    workerUrl: workerUrl ?? null,
    expectedWorkerUrl,
    workerTokenMatches,
    clientCertMatches,
  };
}

export function observedToStatus(state: ObservedState): StatusReport {
  return {
    localRevision: state.localHead,
    vercelRevision: state.vercelRevision,
    workerRevision: state.workerRevision,
    workerHealthy: state.workerHealthy,
    telegramConnected: state.telegramConnected,
    authorizationCount: state.authorizationCount,
  };
}

export interface DriftDiagnosis {
  code: string;
  message: string;
  fix: string;
}

export function detectDrift(state: ObservedState): DriftDiagnosis[] {
  const issues: DriftDiagnosis[] = [];

  if (state.vpsPublicIp && !state.certSanCoversIp) {
    issues.push({
      code: "san_mismatch",
      message: "Server certificate SAN no longer covers the VPS public address",
      fix: "Reissue TLS per operations.md §4.2, restart worker, republish TELEGRAM_WORKER_URL",
    });
  }

  if (state.legacyTelegramVars.length > 0) {
    issues.push({
      code: "legacy_telegram_vars",
      message: `Vercel still holds legacy Telegram credentials: ${state.legacyTelegramVars.join(", ")}`,
      fix: "Run ./scripts/gramscope migrate to complete the cutover",
    });
  }

  if (
    state.localHead &&
    state.workerRevision &&
    state.localHead !== state.workerRevision
  ) {
    issues.push({
      code: "revision_mismatch",
      message: `Worker revision ${state.workerRevision} differs from local HEAD ${state.localHead}`,
      fix: "Run ./scripts/gramscope update",
    });
  }

  if (state.workerHealthy && !state.telegramConnected) {
    issues.push({
      code: "telegram_disconnected",
      message: "Worker is up but Telegram is disconnected",
      fix: "Run ./scripts/gramscope login — this is a session problem, not a deployment problem",
    });
  }

  if (
    state.authorizationCount !== null &&
    state.authorizationCount !== 1
  ) {
    issues.push({
      code: "authorization_count",
      message: `Telegram authorization count is ${state.authorizationCount}, expected 1`,
      fix: "Terminate extra GramScope authorizations in Telegram Settings → Devices",
    });
  }

  if (
    state.expectedWorkerUrl &&
    state.workerUrl &&
    state.workerUrl !== state.expectedWorkerUrl
  ) {
    issues.push({
      code: "worker_url_mismatch",
      message: "TELEGRAM_WORKER_URL does not match the VPS address and port",
      fix: "Run ./scripts/gramscope configure worker-url",
    });
  }

  if (state.workerTokenMatches === false) {
    issues.push({
      code: "worker_token_mismatch",
      message: "TELEGRAM_WORKER_TOKEN in Vercel does not match the VPS",
      fix: "Run ./scripts/gramscope configure worker-token",
    });
  }

  if (state.clientCertMatches === false) {
    issues.push({
      code: "client_cert_mismatch",
      message: "Vercel client certificate does not match the VPS CA material",
      fix: "Re-publish TLS material per operations.md §4.6",
    });
  }

  return issues;
}

async function run(shell: Shell, command: string) {
  return shell.run(command);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractEnvValue(text: string, key: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${key}=`));
  if (!line) return undefined;
  return readEnvKey(`${line}\n`, key);
}

function extractVercelRevision(output: string): string | null {
  const match = output.match(/\b([0-9a-f]{7,40})\b/);
  return match?.[1] ?? null;
}
