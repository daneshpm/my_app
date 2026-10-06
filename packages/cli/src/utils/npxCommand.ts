export type NpxCommand = {
  command: string;
  args: string[];
};

/** npm installs `name` as a `.cmd` shim on Windows; invoke it through cmd.exe
 * instead of relying on child_process to resolve or execute the shim, or on
 * `shell: true` with hand-rolled argument quoting. */
function buildCmdShimCommand(
  name: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): NpxCommand {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `${name}.cmd`, ...args] };
  }
  return { command: name, args: [...args] };
}

export function buildNpxCommand(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NpxCommand {
  return buildCmdShimCommand("npx", args, platform);
}

export function buildNpmCommand(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NpxCommand {
  return buildCmdShimCommand("npm", args, platform);
}

/** cmd.exe metacharacters that would be interpreted outside double quotes. */
const CMD_META = /[&|<>^%!()]/;

/**
 * Build an invocation for a third-party CLI (`gcloud`, `sam`, ...) that is a
 * `.cmd` shim on Windows. Args containing cmd.exe metacharacters are wrapped
 * in double quotes so user-controlled values cannot inject commands; args that
 * contain a double quote are rejected.
 */
export function buildShimCommand(
  name: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NpxCommand {
  if (platform !== "win32") return { command: name, args: [...args] };
  const safe = args.map((arg) => {
    if (arg.includes('"')) {
      throw new Error(`Refusing to pass an argument containing a double quote to ${name}`);
    }
    return CMD_META.test(arg) && !/\s/.test(arg) ? `"${arg}"` : arg;
  });
  return buildCmdShimCommand(name, safe, platform);
}
