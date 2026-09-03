import type { CliFlags } from "./types";

export interface ParsedCli {
  command: string;
  positional: string[];
  flags: CliFlags;
}

const DEFAULT_HOST = "gramscope-worker";

export function parseArgv(argv: string[]): ParsedCli {
  const flags: CliFlags = {
    dryRun: false,
    yes: false,
    json: false,
    verbose: false,
    host: DEFAULT_HOST,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    switch (arg) {
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--yes":
      case "-y":
        flags.yes = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--verbose":
      case "-v":
        flags.verbose = true;
        break;
      case "--host":
        flags.host = argv[++i] ?? DEFAULT_HOST;
        break;
      default:
        if (arg.startsWith("--host=")) {
          flags.host = arg.slice("--host=".length) || DEFAULT_HOST;
        } else if (arg.startsWith("-")) {
          throw new Error(`unknown flag: ${arg}`);
        } else {
          positional.push(arg);
        }
    }
  }

  const command = positional.shift() ?? "";
  return { command, positional, flags };
}

export function usage(): string {
  return `usage: gramscope <command> [options]

commands:
  doctor                 check everything, change nothing
  status                 report revisions and health
  install                first-time setup of both halves
  configure <target>     one scoped change
  login                  create or replace Telegram session on VPS
  update                 deploy current revision to both halves
  rollback               previous revision on either half
  migrate                one-time cutover from old layout

options:
  --dry-run              print the plan without applying
  --yes, -y              unattended, no prompts
  --json                 machine-readable output
  --verbose, -v          verbose logging
  --host <alias>         SSH alias for the VPS (default: ${DEFAULT_HOST})
`;
}
