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
  const planDraftPattern = "*/pi-plan-mode/drafts/????????-????-????-????-????????????/plan.md";
  defaults.permission.path_write[planDraftPattern] = "allow";
  defaults.permission.external_directory_write = {
    "*": defaults.permission.external_directory_write,
    [planDraftPattern]: "allow",
  };
  const patches = new Map([
    [join(src, "policy/rule.ts"), [
      ["import { PATH_SURFACES }", `import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import { PATH_SURFACES }`],
      ["function ruleMatches(", `function isManagedPlanDraft(value: string, flavor: PathFlavor): boolean {
  const { isAbsolute, dirname, basename, join } = flavor.impl;
  if (!isAbsolute(value) || basename(value) !== "plan.md") return false;
  const parent = dirname(value);
  const uuid = basename(parent);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(uuid)) return false;
  try {
    const expected = join(flavor.realpath(getAgentDir()), "pi-plan-mode", "drafts", uuid);
    if (flavor.fold(flavor.realpath(parent)) !== flavor.fold(expected) || !lstatSync(parent).isDirectory()) return false;
    const stat = lstatSync(value, { throwIfNoEntry: false });
    return stat === undefined || (stat.isFile() && stat.nlink === 1);
  } catch {
    return false;
  }
}

function ruleMatches(`],
      ["wildcardMatch(rule.pattern, value, matchOptions)", `wildcardMatch(rule.pattern, value, matchOptions) &&
    (rule.action !== "allow" || rule.pattern !== ${JSON.stringify(planDraftPattern)} ||
      (surface !== "path_write" && surface !== "external_directory_write") || isManagedPlanDraft(value, flavor))`],
    ]],
    [join(src, "config/config-loader.ts"), [
      ["let merged: UnifiedPermissionConfig = {};", `let merged: UnifiedPermissionConfig = ${JSON.stringify(defaults)};`],
      ["  return {\n    global: globalConfig,", "  // Only the trusted project marker can opt in; ignore legacy JSON values.\n  merged.yoloMode = false;\n  merged.authorizerChain = [\"auto-review\"];\n\n  return {\n    global: globalConfig,"],
    ]],
    [join(src, "config/config-store.ts"), [
      ["import {\n  existsSync,\n  mkdirSync,", `import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,`],
      ['import { dirname, normalize } from "node:path";', 'import { dirname, join, normalize } from "node:path";'],
      ["  getGlobalConfigPath,\n", "  getGlobalConfigDir,\n  getGlobalConfigPath,\n"],
      ["export interface CommandConfigStore extends ConfigReader {\n", `export interface CommandConfigStore extends ConfigReader {
  setProjectYoloMode(enabled: boolean, ctx: ExtensionCommandContext): boolean;
`],
      ['import { syncPermissionSystemStatus } from "./status";', `import { syncPermissionSystemStatus } from "./status";

function projectYoloMarkerPath(agentDir: string, cwd: string): string {
  return join(getGlobalConfigDir(agentDir), "yolo-projects", createHash("sha256").update(realpathSync(cwd)).digest("hex"));
}

function hasProjectYoloMarker(path: string): boolean {
  const marker = lstatSync(path, { throwIfNoEntry: false });
  if (!marker) return false;
  if (!marker.isFile() || marker.size !== 0) {
    throw new Error(\`Invalid YOLO opt-in marker at '\${path}'\`);
  }
  return true;
}`],
      ["   * untrusted repository's runtime config (`yoloMode`, `permissionReviewLog`,", "   * untrusted repository's runtime config (`permissionReviewLog`,"],
      ["    const runtimeConfig = normalizePermissionSystemConfig(mergeResult.merged);", `    if (cwd && projectTrusted === true) {
      try {
        mergeResult.merged.yoloMode = hasProjectYoloMarker(projectYoloMarkerPath(this.deps.agentDir, cwd));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mergeResult.issues.push(\`Failed to read project YOLO setting: \${message}\`);
      }
    }
    const runtimeConfig = normalizePermissionSystemConfig(mergeResult.merged);`],
      ["  /**\n   * Save updated runtime knobs", `  setProjectYoloMode(enabled: boolean, ctx: ExtensionCommandContext): boolean {
    if (!ctx.hasUI || !ctx.isProjectTrusted()) {
      ctx.ui.notify("YOLO mode requires an interactive, trusted project.", "warning");
      return false;
    }

    try {
      const path = projectYoloMarkerPath(this.deps.agentDir, ctx.cwd);
      const current = hasProjectYoloMarker(path);
      if (enabled && !current) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        try {
          writeFileSync(path, "", { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !hasProjectYoloMarker(path)) throw error;
        }
      } else if (!enabled && current) {
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify("Failed to save project YOLO setting: " + message, "error");
      return false;
    }

    this.config = { ...this.config, yoloMode: enabled };
    syncPermissionSystemStatus(ctx, this.config);
    return true;
  }

  /**
   * Save updated runtime knobs`],
      ["    const normalized = normalizePermissionSystemConfig(next);", "    const normalized = normalizePermissionSystemConfig({ ...next, yoloMode: this.config.yoloMode });"],
      ["      permissionReviewLog: normalized.permissionReviewLog,\n      yoloMode: normalized.yoloMode,\n    };\n", "      permissionReviewLog: normalized.permissionReviewLog,\n    };\n"],
    ]],
    [join(src, "config/config-modal.ts"), [
      ['"Auto-approve ask-state permission checks, including subagent approval forwarding"', '"Persistently auto-approve all asks in this trusted project, including external paths; skips auto-review. Explicit denies remain."'],
      ['    case "yoloMode":\n      return { ...config, yoloMode: value === "on" };\n', ""],
      ["          current = applySetting(current, id, newValue);\n          controller.config.save(current, ctx);", `          if (id === "yoloMode") {
            controller.config.setProjectYoloMode(newValue === "on", ctx);
          } else {
            controller.config.save(applySetting(current, id, newValue), ctx);
          }`],
      ['  if (normalized === "reset") {\n', `  if (normalized === "reset") {
    if (ctx.hasUI && ctx.isProjectTrusted() && !controller.config.setProjectYoloMode(false, ctx)) {
      return true;
    }
`],
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
