import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function replaceOnce(source, from, to) {
  const index = source.indexOf(from);
  if (index < 0 || source.indexOf(from, index + from.length) >= 0) {
    throw new Error(`Pinned reviewer patch did not match exactly once: ${from.slice(0, 100)}`);
  }
  return source.slice(0, index) + to + source.slice(index + from.length);
}

export default async function buildReviewer(outDir) {
  const entry = fileURLToPath(import.meta.resolve("@mzwing/pi-permission-auto-review"));
  const manifest = JSON.parse(await readFile(join(dirname(dirname(entry)), "package.json"), "utf8"));
  if (manifest.version !== "1.0.2") throw new Error(`Unsupported reviewer version: ${manifest.version}`);
  const defaults = JSON.parse(await readFile(join(root, "examples/pi-permission-auto-review.config.json"), "utf8"));
  delete defaults.provider;
  delete defaults.model;
  let source = await readFile(entry, "utf8");
  const patch = (from, to) => { source = replaceOnce(source, from, to); };

  patch('from "@gotgenes/pi-permission-system"', 'from "./gate.mjs"');
  patch("j as mergeConfig", "j as mergeBaseConfig");
  patch("// src/config/store.ts", `const PACKAGE_DEFAULTS = ${JSON.stringify(defaults)};
const validatedPackageDefaults = validateConfigFile(PACKAGE_DEFAULTS);
if (!validatedPackageDefaults.ok) throw new Error("Invalid packaged reviewer config: " + validatedPackageDefaults.issue);
function mergeConfig(global, project) {
  return { ...mergeBaseConfig({ ...validatedPackageDefaults.config, ...global, autoMode: { ...validatedPackageDefaults.config.autoMode, ...global.autoMode } }, project),
    provider: project.provider ?? global.provider, model: project.model ?? global.model };
}
// src/config/store.ts`);
  patch("function originOf(layers, setting) {", `function withSessionModel(config, model) {
  return { ...config, provider: config.provider ?? model?.provider, model: config.model ?? model?.id };
}
function originOf(layers, setting) {`);
  patch('return setting.isSetIn(layers.global) ? "global" : "default";', 'return setting.isSetIn(layers.global) ? "global" : setting.isSetIn(validatedPackageDefaults.config) ? "package" : setting.key === "provider" || setting.key === "model" ? "session" : "default";');
  patch("const effective = mergeConfig(layers.global, layers.project);", "const effective = withSessionModel(mergeConfig(layers.global, layers.project), ctx.model);");
  patch("[...known(effective, ctx), current]", "[...known(effective, ctx), ...(current === void 0 ? [] : [current])]");
  patch("const provider = registry.getProvider(config.provider);", `if (config.provider === void 0) return { ok: false, category: "provider-unresolved" };
  if (config.model === void 0) return { ok: false, category: "model-unresolved" };
  const provider = registry.getProvider(config.provider);`);
  patch("let conversation;\n\tconst authorize", "let conversation;\n\tlet conversationProvider;\n\tlet conversationModel;\n\tconst authorize");
  patch("const startedAt = Date.now();\n\t\tconst entryBase", `const startedAt = Date.now();
    const reviewConfig = withSessionModel(config, runtime.context.model);
    const entryBase`);
  patch("provider: config.provider,\n\t\t\tmodel: config.model", "provider: reviewConfig.provider,\n\t\t\tmodel: reviewConfig.model");
  patch("const result = await runReview(runtime, preset, details, conversation);", `const previous = conversationProvider === reviewConfig.provider && conversationModel === reviewConfig.model ? conversation : void 0;
      const result = await runReview({ ...runtime, config: reviewConfig }, preset, details, previous);`);
  patch("conversation = result.conversation;", `conversation = result.conversation;
      conversationProvider = reviewConfig.provider;
      conversationModel = reviewConfig.model;`);
  patch("[show|path|defaults|reset [global|project]|help]", "[show|path|defaults|reset [global|project]|off|help]");
  patch('const SUBCOMMANDS = [', 'const SUBCOMMANDS = [\n\t{ value: "off", label: "Disable automatic review for this session" },');
  patch('else if (normalized === "show") showConfig(ctx, controller.getActiveConfig());', `else if (normalized === "show") {
        showConfig(ctx, controller.getActiveConfig());
        if (controller.isOff()) ctx.ui.notify("Авторевью выключено до новой сессии или /reload.", "info");
      }`);
  patch('else if (normalized === "path")', `else if (normalized === "off") {
        if (ctx.mode !== "tui") ctx.ui.notify("Отключение авторевью доступно только оператору в интерактивном режиме.", "warning");
        else {
          controller.turnOff();
          ctx.ui.notify("Авторевью выключено до новой сессии или /reload; запросы передаются оператору.", "info");
        }
      }
      else if (normalized === "path")`);
  patch("function permissionAutoReview(pi) {\n\tlet generation;", "function permissionAutoReview(pi) {\n\tlet generation;\n\tlet manual = false;\n\tlet manualRevision = 0;");
  patch('current.runtime.ui.setStatus(EXTENSION_ID, statusText(current, tally));', 'current.runtime.ui.setStatus(EXTENSION_ID, manual ? "auto-review off (manual)" : statusText(current, tally));');
  patch('const verdict = await reviewer.authorize(details, query, log);\n\t\t\t\tif (generation === created)', `if (manual) return { kind: "defer" };
        const revision = manualRevision;
        let verdict = await reviewer.authorize(details, query, log);
        if (verdict.kind === "allow" && (manual || revision !== manualRevision)) verdict = { kind: "defer" };
\t\t\t\tif (generation === created)`);
  patch('pi.on("session_start", (_event, ctx) => {\n\t\tretire(generation);', 'pi.on("session_start", (_event, ctx) => {\n\t\tmanual = false;\n\t\tmanualRevision++;\n\t\tretire(generation);');
  patch('pi.on("session_shutdown", (_event, ctx) => {\n\t\tctx.ui.setStatus', 'pi.on("session_shutdown", (_event, ctx) => {\n\t\tmanualRevision++;\n\t\tctx.ui.setStatus');
  patch('getActiveConfig: () => generation?.config,\n\t\tapplyConfig', `getActiveConfig: () => generation?.config === void 0 ? void 0 : withSessionModel(generation.config, generation.runtime.model),
    isOff: () => manual,
    turnOff: () => { manual = true; manualRevision++; if (generation) renderStatus(generation); },
\t\tapplyConfig`);

  await build({
    entryPoints: [entry],
    outfile: join(outDir, "reviewer.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    external: ["./gate.mjs"],
    plugins: [{
      name: "permission-reviewer-patches",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]index\.js$/ }, (args) => args.path === entry ? { contents: source, loader: "js", resolveDir: dirname(entry) } : undefined);
      },
    }],
  });
}
