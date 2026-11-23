import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const packageDir = join(root, ".pi/npm/node_modules/@gotgenes/pi-permission-system");
const configPath = join(root, ".pi/extensions/pi-permission-system/config.json");

try {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (manifest.version !== "42.1.0") throw new Error(`Ожидается версия 42.1.0, установлена ${manifest.version}`);

  // Use the TypeScript loader shipped with Pi; don't reimplement its rule matcher.
  const require = createRequire(import.meta.url);
  const install = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi/agent/install");
  const release = readFileSync(join(install, "current-version"), "utf8").trim();
  const jiti = require(require.resolve("jiti", { paths: [join(install, "releases", release)] }));
  const src = join(packageDir, "src");
  const load = jiti.createJiti(import.meta.url, { alias: { "#src": src } });
  const { unifiedConfigSchema } = load(join(src, "config/config-schema.ts"));
  const { normalizeFlatConfig } = load(join(src, "policy/normalize.ts"));
  const { evaluate } = load(join(src, "policy/rule.ts"));
  const { pathFlavorForPlatform } = load(join(src, "path/path-flavor.ts"));
  const config = unifiedConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  if (!config.permission) throw new Error("Нет permission в локальном конфиге");
  const rules = normalizeFlatConfig(config.permission);
  const cases = [];
  const add = (name, surface, value, expected, reason) => cases.push({ name, surface, value, expected, reason });

  for (const prefix of ["hdfs dfs", "hadoop fs"]) {
    for (const operation of ["du", "df", "ls", "count", "stat", "test", "cat", "text", "tail", "checksum", "getfacl", "getfattr"]) {
      const command = `${prefix} -${operation} /data`;
      add(`Чтение: ${command}`, "bash", command, "ask");
    }
  }
  for (const command of ["hdfs --help", "hdfs version", "hadoop fs -help"]) {
    add(`Справка: ${command}`, "bash", command, "ask");
  }

  add("Запрет удаления HDFS с объяснением", "bash", "hdfs dfs -rm /data", "deny", true);
  add("Запрет удаления hadoop fs с объяснением", "bash", "hadoop fs -rm /data", "deny", true);
  add("Локальный скрипт требует согласования", "bash", "python3 tests/fixtures/count_rows.py", "ask");
  for (const tool of ["read", "find", "grep", "ls"]) add(`Инструмент чтения ${tool}`, tool, "*", "allow");
  for (const tool of ["write", "edit", "subagent", "unknown_tool"]) add(`Согласование инструмента ${tool}`, tool, "*", "ask");
  add("Чтение файла проекта", "path_read", join(root, "tests/fixtures/rows.txt"), "allow");
  add("Запись обычного файла разрешена на уровне пути", "path_write", join(root, "report.txt"), "allow");
  add("Запись каталога .pi запрещена", "path_write", join(root, ".pi"), "deny");
  add("Запись файла внутри .pi запрещена", "path_write", join(root, ".pi/settings.json"), "deny");
  add("Внешнее чтение требует согласования", "external_directory_read", "/outside/file.txt", "ask");
  add("Внешняя запись требует согласования", "external_directory_write", "/outside/file.txt", "ask");
  console.log("Проверка evaluator по конфигурации .pi (не запуск агента и не авторевью). Пути переданы канонически; разрешение симлинков не проверяется.");
  for (const test of cases) {
    const result = evaluate(test.surface, test.value, rules, pathFlavorForPlatform(process.platform));
    const expected = { action: test.expected, ...(test.reason ? { reason: "запрет и предложение пользователю выполнить вручную" } : {}) };
    const actual = { action: result.action, ...(test.reason ? { reason: result.reason } : {}) };
    const reasonOk = !test.reason || (typeof result.reason === "string"
      && /не\s+разреш|запрещ|недопуст/i.test(result.reason)
      && /пользовател/i.test(result.reason)
      && /самостоятель|вручную/i.test(result.reason));
    const ok = result.action === test.expected && reasonOk;
    console.log(`${ok ? "OK" : "FAIL"} ${test.name}: ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
    if (!ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(`Не удалось запустить тесты: ${error.message}\nНужны Node.js >= 22.15 и пакет @gotgenes/pi-permission-system@42.1.0, установленный Pi в .pi/npm/node_modules.`);
  process.exitCode = 1;
}
