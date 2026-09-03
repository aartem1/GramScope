export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellRunOptions {
  cwd?: string;
  /** Secret values travel on stdin, never as argv fragments. */
  stdin?: string;
}

export interface Shell {
  readonly label: string;
  run(command: string, options?: ShellRunOptions): Promise<ShellResult>;
}
