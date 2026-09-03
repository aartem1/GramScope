import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { usage, parseArgv } from "./flags";
import { createShells } from "./shell";
import {
  runConfigure,
  runDoctor,
  runInstall,
  runLogin,
  runMigrate,
  runRollback,
  runUpdate,
} from "./commands";
import { runStatus } from "./commands/status";
import {
  renderPlanHuman,
  renderPlanJson,
} from "./plan/renderer";
import { resetObservedStateCache } from "./commands/steps";

const repoRoot = join(fileURLToPath(new URL("../..", import.meta.url)));

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    return 2;
  }

  if (!parsed.command || parsed.command === "help" || parsed.command === "--help") {
    console.log(usage());
    return 0;
  }

  const { localShell, vpsShell } = createShells(parsed.flags.host, repoRoot);
  const ctx = {
    flags: parsed.flags,
    repoRoot,
    localShell,
    vpsShell,
  };

  resetObservedStateCache();

  try {
    switch (parsed.command) {
      case "doctor": {
        const result = await runDoctor(ctx);
        console.log(
          parsed.flags.json
            ? renderPlanJson(result).trimEnd()
            : renderPlanHuman(result),
        );
        return result.exitCode;
      }
      case "status": {
        const result = await runStatus(ctx);
        process.stdout.write(result.output);
        return result.exitCode;
      }
      case "install": {
        const result = await runInstall(ctx);
        console.log(
          parsed.flags.json
            ? renderPlanJson(result).trimEnd()
            : renderPlanHuman(result),
        );
        return result.exitCode;
      }
      case "configure": {
        const target = parsed.positional[0];
        if (!target) {
          console.error("configure requires a target");
          console.error(usage());
          return 2;
        }
        const result = await runConfigure(ctx, target);
        console.log(
          parsed.flags.json
            ? renderPlanJson(result).trimEnd()
            : renderPlanHuman(result),
        );
        return result.exitCode;
      }
      case "login": {
        const result = await runLogin(ctx);
        console.log(
          parsed.flags.json
            ? renderPlanJson(result).trimEnd()
            : renderPlanHuman(result),
        );
        return result.exitCode;
      }
      case "update": {
        const result = await runUpdate(ctx);
        console.log(
          parsed.flags.json
            ? renderPlanJson(result).trimEnd()
            : renderPlanHuman(result),
        );
        return result.exitCode;
      }
      case "rollback": {
        const result = await runRollback(ctx);
        console.log(
          parsed.flags.json
            ? renderPlanJson(result).trimEnd()
            : renderPlanHuman(result),
        );
        return result.exitCode;
      }
      case "migrate": {
        const result = await runMigrate(ctx);
        console.log(
          parsed.flags.json
            ? renderPlanJson(result).trimEnd()
            : renderPlanHuman(result),
        );
        return result.exitCode;
      }
      default:
        console.error(`unknown command: ${parsed.command}`);
        console.error(usage());
        return 2;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
