import { LocalShell } from "./local";
import { SshShell } from "./ssh";
import type { Shell } from "./types";

export type { Shell, ShellResult, ShellRunOptions } from "./types";
export { LocalShell } from "./local";
export { SshShell } from "./ssh";
export { FakeShell, ok, fail } from "./fake";

export function createShells(
  host: string,
  repoRoot?: string,
): { localShell: Shell; vpsShell: Shell } {
  return {
    localShell: new LocalShell(repoRoot),
    vpsShell: new SshShell(host),
  };
}
