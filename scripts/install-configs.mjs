import { constants, copyFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !['--project', '--global'].includes(args[0]))) {
  console.error('Usage: node scripts/install-configs.mjs [--project | --global]');
  process.exit(1);
}

const automatic = args.length === 0;
const cwd = automatic ? process.env.INIT_CWD : process.cwd();
const prefix = process.env.npm_config_local_prefix;
if (automatic && (process.env.npm_lifecycle_event !== 'postinstall' || !cwd || !isAbsolute(cwd) || !prefix || !isAbsolute(prefix))) {
  process.exit(0);
}

function agentDirectory() {
  let path = process.env.PI_CODING_AGENT_DIR;
  if (!path) return join(homedir(), '.pi', 'agent');
  if (process.platform === 'win32' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')) {
    const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) path = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`;
  }
  if (path === '~') path = homedir();
  else if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) path = join(homedir(), path.slice(2));
  else if (/^file:\/\//.test(path)) path = fileURLToPath(path);
  return resolve(cwd, path);
}

function realpathIfExists(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function samePath(a, b) {
  if (a === undefined || b === undefined) return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const agentDir = agentDirectory();
const projectDir = join(cwd, '.pi');
let project = args[0] === '--project';
if (automatic) {
  const actual = realpathIfExists(prefix);
  const localMatch = samePath(actual, realpathIfExists(join(projectDir, 'npm')));
  const globalMatch = samePath(actual, realpathIfExists(join(agentDir, 'npm')));
  if (localMatch === globalMatch) process.exit(0);
  project = localMatch;
}

const root = project ? projectDir : agentDir;
if (project && (samePath(resolve(root), resolve(agentDir)) || samePath(realpathIfExists(root), realpathIfExists(agentDir)))) {
  console.warn(`Skipping project config installation: ${root} is the agent directory`);
  process.exit(0);
}

function projectDirectory(path) {
  try {
    mkdirSync(path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!lstatSync(path).isDirectory()) {
    console.warn(`Skipping config installation: ${path} is not a directory`);
    return false;
  }
  return true;
}

const extensions = join(root, 'extensions');
if (project && (!projectDirectory(root) || !projectDirectory(extensions))) process.exit(0);
for (const id of ['pi-permission-system', 'pi-permission-auto-review']) {
  const dir = join(extensions, id);
  if (project) {
    if (!projectDirectory(dir)) continue;
  } else {
    mkdirSync(dir, { recursive: true });
  }
  try {
    copyFileSync(new URL(`../examples/${id}.config.json`, import.meta.url), join(dir, 'config.json'), constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
