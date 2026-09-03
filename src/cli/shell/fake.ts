import type { Shell, ShellResult, ShellRunOptions } from "./types";

export type FakeShellHandler = (
  command: string,
  options?: ShellRunOptions,
) => ShellResult | Promise<ShellResult>;

export interface RecordedRun {
  command: string;
  stdin?: string;
  shell: string;
}

/**
 * Injectable shell for unit tests. Handlers match commands in registration
 * order; the first match wins. Unmatched commands return exit 127.
 */
export class FakeShell implements Shell {
  readonly label: string;
  readonly runs: RecordedRun[] = [];
  private handlers: Array<{
    match: string | RegExp;
    handler: FakeShellHandler;
  }> = [];

  constructor(label = "fake") {
    this.label = label;
  }

  when(match: string | RegExp, handler: FakeShellHandler): this {
    this.handlers.push({ match, handler });
    return this;
  }

  whenEquals(command: string, result: ShellResult): this {
    return this.when(command, () => result);
  }

  async run(command: string, options?: ShellRunOptions): Promise<ShellResult> {
    this.runs.push({
      command,
      stdin: options?.stdin,
      shell: this.label,
    });

    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const entry = this.handlers[i];
      if (!entry) continue;
      const matched =
        typeof entry.match === "string"
          ? command === entry.match
          : entry.match.test(command);
      if (!matched) continue;
      return entry.handler(command, options);
    }

    return {
      stdout: "",
      stderr: `command not mocked: ${command}`,
      exitCode: 127,
    };
  }
}

export function ok(stdout = "", stderr = ""): ShellResult {
  return { stdout, stderr, exitCode: 0 };
}

export function fail(exitCode: number, stderr: string): ShellResult {
  return { stdout: "", stderr, exitCode };
}
