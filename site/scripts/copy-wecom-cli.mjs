import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A native CLI cannot be bundled into JavaScript. Copy it into each independent release.
export async function copyWecomCli(source, destination) {
  const require = createRequire(join(resolve(source), "package.json"));
  const cliRequire = createRequire(require.resolve("@wecom/cli/package.json"));
  const binary = process.platform === "win32" ? "wecom-cli.exe" : "wecom-cli";
  const packageDirectory = dirname(cliRequire.resolve(`@wecom/cli-${process.platform}-${process.arch}/package.json`));
  const target = join(resolve(destination), "vendor", "wecom");
  await mkdir(target, { recursive: true });
  await cp(join(packageDirectory, "bin", binary), join(target, binary));
  await cp(join(dirname(require.resolve("@wecom/cli/package.json")), "LICENSE"), join(target, "LICENSE"));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await copyWecomCli(process.cwd(), resolve("dist/standalone"));
}
