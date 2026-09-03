import type { Shell, ShellResult, ShellRunOptions } from "./types";

export class SshShell implements Shell {
  readonly label: string;

  constructor(
    private readonly host: string,
    private readonly identity?: string,
  ) {
    this.label = `ssh:${host}`;
  }

  async run(command: string, options?: ShellRunOptions): Promise<ShellResult> {
    const identityFlag = this.identity ? `-i ${shellQuote(this.identity)} ` : "";
    const remote = `bash -lc ${shellQuote(command)}`;
    const sshCommand = `ssh ${identityFlag}${shellQuote(this.host)} ${shellQuote(remote)}`;

    const { LocalShell } = await import("./local");
    const local = new LocalShell(options?.cwd);
    return local.run(sshCommand, { stdin: options?.stdin });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export { shellQuote };
