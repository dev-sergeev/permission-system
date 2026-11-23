import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function replaceOnce(source, before, after, file) {
  const parts = source.split(before);
  if (parts.length !== 2) {
    throw new Error(`Expected exactly one gate patch in ${file}, found ${parts.length - 1}`);
  }
  return parts.join(after);
}

export default async function buildGate(outDir) {
  const entry = require.resolve("@gotgenes/pi-permission-system");
  const src = dirname(entry);
  const manifest = JSON.parse(readFileSync(join(src, "../package.json"), "utf8"));
  if (manifest.version !== "42.1.0") {
    throw new Error(`Expected pi-permission-system 42.1.0, got ${manifest.version}`);
  }
  const defaults = JSON.parse(readFileSync(join(root, "examples/pi-permission-system.config.json"), "utf8"));
  const patches = new Map([
    [join(src, "config/config-loader.ts"), [
      ["let merged: UnifiedPermissionConfig = {};", `let merged: UnifiedPermissionConfig = ${JSON.stringify(defaults)};`],
      ["  return {\n    global: globalConfig,", "  merged.yoloMode = false;\n  merged.authorizerChain = [\"auto-review\"];\n\n  return {\n    global: globalConfig,"],
    ]],
    [join(src, "policy/permission-manager.ts"), [
      ["const { mergedPermission, origins } = mergeScopesWithOrigins([", `const { mergedPermission, origins } = mergeScopesWithOrigins([\n      ["global", { permission: ${JSON.stringify(defaults.permission)} }],`],
    ]],
    [join(src, "authority/authorizer-chain.ts"), [
      ["    async authorize(details) {\n      for (const link of links) {", `    async authorize(details) {
      const isExternal = (surface: string | null | undefined) =>
        surface === "external_directory" || surface === "external_directory_read" || surface === "external_directory_write";
      if (
        isExternal(details.accessIntent?.surface) ||
        isExternal(details.payload.request.surface) ||
        isExternal(details.surface) ||
        details.payload.kind === "external_directory" ||
        details.payload.kind === "bash_external_directory" ||
        (details.forwarding && !details.accessIntent)
      ) return terminal.authorize(details);
      for (const link of links) {`],
    ]],
    [join(src, "index.ts"), [
      ["import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";", "export { PERMISSIONS_READY_CHANNEL, getPermissionsService } from \"./service\";\nimport type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";"],
      ["const isYoloEnabled = (): boolean => isYoloModeEnabled(configStore.current());", "const isYoloEnabled = (): boolean => false;"],
      ["getAuthorizerChain: () => configStore.current().authorizerChain ?? [],", "getAuthorizerChain: () => [\"auto-review\"],"],
    ]],
  ]);
  const loaded = new Set();
  await build({
    entryPoints: [join(src, "index.ts")],
    outfile: join(outDir, "gate.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [{
      name: "embedded-permission-defaults",
      setup(builder) {
        builder.onResolve({ filter: /^#src\// }, ({ path }) => {
          const target = join(src, path.slice(5));
          return { path: existsSync(`${target}.ts`) ? `${target}.ts` : join(target, "index.ts") };
        });
        builder.onLoad({ filter: /\.ts$/ }, ({ path }) => {
          const replacements = patches.get(path);
          if (!replacements) return;
          let source = readFileSync(path, "utf8");
          for (const [before, after] of replacements) source = replaceOnce(source, before, after, path);
          loaded.add(path);
          return { contents: source, loader: "ts", resolveDir: dirname(path) };
        });
      },
    }],
  });
  for (const file of patches.keys()) {
    if (!loaded.has(file)) throw new Error(`Gate patch was not applied: ${file}`);
  }
}
