import { spawn } from "node:child_process";
import type { Shell, ShellResult, ShellRunOptions } from "./types";

export class LocalShell implements Shell {
  readonly label = "local";

  constructor(private readonly cwd?: string) {}

  async run(command: string, options?: ShellRunOptions): Promise<ShellResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-lc", command], {
        cwd: options?.cwd ?? this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode: code ?? 1,
        });
      });

      if (options?.stdin !== undefined) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    });
  }
}
