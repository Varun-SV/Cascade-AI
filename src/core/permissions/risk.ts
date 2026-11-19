// ─────────────────────────────────────────────
//  Cascade AI — How risky a tool call is
// ─────────────────────────────────────────────
//
//  Auto mode asked about every shell command, file edit and git call alike,
//  a read-only `ls` included, because "dangerous" was a property of the tool.
//  It is now a property of the call. Each call is one of:
//
//    safe         reads only.
//    recoverable  changes files in the project, which the run's checkpoint
//                 can put back (/undo), or runs the project's own code.
//    risky        one of the things a checkpoint can't undo, or that can't be
//                 told apart from one: see RiskCategory.
//
//  In auto mode only a risky call asks. Outside auto mode nothing changes.
//  When in doubt a call is risky: a classifier that guesses "fine" is the
//  one that deletes something.

import os from 'node:os';
import path from 'node:path';
import type { Risk, RiskCategory, RiskLevel } from '../../types.js';

export type { Risk, RiskCategory, RiskLevel };

/** How each kind of risk is named to a person. */
export const RISK_LABELS: Record<RiskCategory, string> = {
  delete: 'deletes files',
  'leaves-machine': 'sends something off this computer',
  'git-history': 'rewrites or discards git history',
  'install-system': 'installs software or changes the system',
  'outside-project': 'changes files outside the project',
  database: 'destroys database data',
  processes: 'stops processes or containers',
  permissions: 'changes file permissions or ownership',
  unrecorded: 'changes a file /undo can\'t put back',
  unclassified: 'runs something Cascade can\'t check',
};

/** Whether /undo can put back what a call of this kind changes. */
export function undoable(risk: Risk): boolean {
  return risk.level !== 'risky' || risk.category === 'delete';
}

const SAFE: Risk = { level: 'safe', reason: 'only reads' };
const order: Record<RiskLevel, number> = { safe: 0, recoverable: 1, risky: 2 };
const risky = (category: RiskCategory, reason: string): Risk => ({ level: 'risky', category, reason });
const recoverable = (reason: string, writes: string[] = []): Risk => ({ level: 'recoverable', reason, ...(writes.length ? { writes } : {}) });
/** The riskier of two; two undoable ones keep every file either writes. */
const worst = (a: Risk, b: Risk): Risk => {
  if (a.level === 'recoverable' && b.level === 'recoverable' && (a.writes || b.writes)) {
    return { ...a, writes: [...new Set([...(a.writes ?? []), ...(b.writes ?? [])])] };
  }
  return order[b.level] > order[a.level] ? b : a;
};

/** The risk of one tool call, given the project folder it runs in. */
export function assessRisk(tool: string, input: Record<string, unknown>, workspaceRoot: string): Risk {
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (tool) {
    case 'shell':
      return assessShell(str('command'), workspaceRoot, str('cwd') || workspaceRoot);
    case 'run_code':
      return assessCode(str('code'));
    case 'file_read': case 'file_list': case 'grep': case 'glob': case 'diff_view':
      return SAFE;
    case 'file_delete':
      return risky('delete', `deletes ${str('path') || 'a file'}`);
    case 'file_write': case 'file_edit': case 'pdf_create': case 'generate_document': {
      const target = str('path') || str('output') || str('filename');
      if (target && outside(target, workspaceRoot, workspaceRoot)) return risky('outside-project', `writes ${target}, outside the project`);
      return recoverable(`changes ${target || 'a file'} in the project (checkpointed)`, target ? [path.resolve(workspaceRoot, target)] : []);
    }
    case 'git':
      return assessGitTool(str('operation'), Array.isArray(input['args']) ? (input['args'] as unknown[]).map(String) : []);
    case 'github': {
      const op = str('operation');
      return /^(create|comment|merge|close|update|delete)/.test(op) ? risky('leaves-machine', `${op.replace(/_/g, ' ')} on ${str('repo') || 'a repository'}`) : SAFE;
    }
    case 'browser': {
      const action = str('action');
      if (['navigate', 'screenshot', 'extract_text', 'wait', 'close'].includes(action)) return SAFE;
      // Page JavaScript can do anything the page can: post a form, call an
      // API, pay. Nothing about it can be read before it runs, and a checkpoint
      // of files undoes none of it.
      if (action === 'evaluate') return risky('unclassified', 'runs JavaScript in the page, which can send or change things on the site');
      const target = `${str('selector')} ${str('text')} ${str('value')}`;
      if (action === 'click' && SUBMITS.test(target)) return risky('leaves-machine', `clicks "${target.trim().slice(0, 60)}", which may submit, pay or send`);
      return recoverable(`${action} in the browser`);
    }
    default:
      // A tool Cascade has no rules for (an MCP server's, a dynamic one):
      // one named as a read is taken at its word; any other asks.
      if (/(^|__)(get|list|search|read|fetch|find|query|describe|view|show)[_-]/i.test(tool)) return SAFE;
      return risky('unclassified', `${tool} is a tool Cascade has no rules for`);
  }
}

/** Words on a button that make a click hard to take back. */
const SUBMITS = /\b(buy|pay|purchase|order|checkout|check out|place order|submit|send|post|publish|delete|remove|confirm|transfer|sign ?up|subscribe|book|donate)\b/i;

// ── Shell ───────────────────────────────────────

/** Commands that only read. */
const READ_ONLY = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd',
  'pwd', 'cd', 'pushd', 'popd', 'echo', 'printf', 'which', 'where', 'whereis', 'whoami', 'id', 'hostname', 'uname',
  'date', 'env', 'printenv', 'tree', 'stat', 'file', 'du', 'df', 'ps', 'free', 'uptime', 'sort', 'uniq', 'cut',
  'jq', 'yq', 'diff', 'cmp', 'comm', 'basename', 'dirname', 'realpath', 'readlink', 'test', 'true', 'false',
  'sleep', 'nproc', 'lsof', 'netstat', 'ss', 'nslookup', 'dig', 'ping', 'cls', 'clear', 'help', 'man', 'history',
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'test-path', 'get-location', 'gl',
  'resolve-path', 'get-item', 'gi', 'measure-object', 'where-object', 'select-object', 'format-table',
  'format-list', 'out-string', 'get-command', 'get-process', 'gps', 'get-date', 'write-output', 'write-host',
  'findstr', 'ver', 'systeminfo', 'tasklist', 'xxd', 'od', 'hexdump', 'strings', 'md5sum', 'sha256sum', 'shasum',
  'certutil',
]);

const DELETERS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'unlink', 'shred', 'srm', 'trash', 'remove-item', 'ri', 'truncate']);
const PROCESS_STOPPERS = new Set(['kill', 'killall', 'pkill', 'skill', 'xkill', 'taskkill', 'stop-process', 'spps', 'tskill']);
const PERMISSIONS = new Set(['chmod', 'chown', 'chgrp', 'chattr', 'icacls', 'cacls', 'takeown', 'setfacl', 'attrib']);
const SYSTEM = new Set([
  'sudo', 'doas', 'su', 'runas', 'gsudo', 'setx', 'crontab', 'schtasks', 'systemctl', 'service', 'launchctl',
  'shutdown', 'reboot', 'poweroff', 'halt', 'mount', 'umount', 'netsh', 'ufw', 'iptables', 'diskpart', 'format',
  'mkfs', 'fdisk', 'bcdedit', 'regedit', 'useradd', 'userdel', 'usermod', 'passwd', 'visudo',
]);
const PACKAGE_MANAGERS: Record<string, RegExp> = {
  npm: /^(install|i|add|ci|remove|rm|r|uninstall|un|unlink|update|up|upgrade|link|ln|publish|unpublish|dedupe|prune|exec)$/,
  pnpm: /^(install|i|add|remove|rm|uninstall|un|update|up|upgrade|link|publish|dlx|exec|prune)$/,
  yarn: /^(install|add|remove|upgrade|up|link|publish|dlx|global)$/,
  bun: /^(install|i|add|a|remove|rm|update|link|publish|x)$/,
  pip: /^(install|uninstall|download)$/, pip3: /^(install|uninstall|download)$/,
  uv: /^(add|remove|sync|pip|tool|python)$/,
  poetry: /^(add|install|remove|update|lock|publish)$/,
  pipenv: /^(install|uninstall|update|sync)$/,
  pipx: /^(install|uninstall|upgrade|inject)$/,
  conda: /^(install|remove|uninstall|update|create|env)$/, mamba: /^(install|remove|uninstall|update|create)$/,
  gem: /^(install|uninstall|update|push)$/,
  cargo: /^(install|uninstall|add|remove|publish)$/,
  go: /^(install|get)$/,
  composer: /^(require|install|remove|update)$/,
  dotnet: /^(add|remove|tool|workload)$/,
  apt: /./, 'apt-get': /./, yum: /./, dnf: /./, zypper: /./, pacman: /./, apk: /./, brew: /./, port: /./,
  snap: /./, choco: /./, winget: /./, scoop: /./, 'nix-env': /./, flatpak: /./,
};
/** Package manager sub-commands that only look. */
const PM_READS = /^(list|ls|show|info|search|view|outdated|freeze|check|why|audit|doctor|config|help|--version|-v|version|test|run|start|build|tree|explain)$/;
const DEPLOYERS = new Set(['vercel', 'netlify', 'firebase', 'fly', 'flyctl', 'heroku', 'surge', 'railway', 'wrangler', 'serverless', 'sls', 'now']);
const CLOUD = new Set(['aws', 'gcloud', 'az', 'kubectl', 'helm', 'terraform', 'pulumi', 'doctl', 'oc', 'eksctl']);
const CLOUD_READS = /^(get|describe|list|ls|show|plan|version|--version|status|whoami|logs|top|explain|config|info|output|validate|fmt|init)$/;
const REMOTE = new Set(['scp', 'sftp', 'ftp', 'ssh', 'mail', 'sendmail', 'mutt', 'mailx', 'nc', 'ncat', 'telnet']);
const CONTAINERS = new Set(['docker', 'podman', 'nerdctl']);
const CONTAINER_STOPS = /^(rm|rmi|kill|stop|prune|down|restart)$/;
/** Programs that write files: their path arguments are checked against the project. */
const WRITERS = new Set([
  'cp', 'mv', 'mkdir', 'touch', 'tee', 'ln', 'install', 'rsync', 'copy', 'xcopy', 'robocopy', 'move', 'ren', 'rename',
  'new-item', 'ni', 'set-content', 'sc', 'out-file', 'add-content', 'ac', 'copy-item', 'cpi', 'move-item', 'mi',
  'rename-item', 'rni', 'tar', 'unzip', 'zip', '7z', 'git', 'curl', 'wget', 'sed', 'perl', 'dd',
]);
/** Shells and interpreters whose argument is itself a command. */
const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const PASSTHROUGH = new Set(['time', 'nice', 'nohup', 'command', 'builtin', 'exec', 'xargs', 'env', 'watch', 'timeout', 'stdbuf']);

const DANGEROUS_SQL = [
  /\bdrop\s+(table|database|schema|index|view|collection|user|role)\b/i,
  /\btruncate\s+(table\s+)?["`[\w]/i,
  /\bdelete\s+from\s+[\w."`[\]]+\s*(?:;|$|["'])/i,
  /\balter\s+table\s+\S+\s+drop\b/i,
  /\.(?:drop|dropDatabase)\s*\(|\bdeleteMany\s*\(\s*\{\s*\}\s*\)/,
  /\bflushall\b|\bflushdb\b/i,
];
const DESTRUCTIVE_MIGRATIONS = [
  /\bprisma\s+(migrate\s+reset|db\s+push\b.*--force-reset)/i,
  /\b(rails|rake)\s+db:(drop|reset|rollback|purge|schema:load)\b/i,
  /\balembic\s+downgrade\b/i,
  /\bmanage\.py\s+(flush|reset_db|migrate\s+\S+\s+zero)\b/i,
  /\bflask\s+db\s+downgrade\b/i,
  /\b(knex\s+migrate:rollback|sequelize\s+db:(drop|migrate:undo))/i,
  /\bdropdb\b|\bdropuser\b/i,
  /\bnpx\s+typeorm\s+(schema:drop|migration:revert)/i,
];
/** Ways of running something that can't be read off the command line. */
const OBFUSCATED = [
  /\beval\b/i,
  /\|\s*(sh|bash|zsh|dash|ksh|fish|pwsh|powershell|iex|python\d?|node|perl|ruby|php)\b/i,
  /\bbase64\s+(-d|--decode|-D)\b/i,
  /\b(invoke-expression|iex)\b/i,
  /\s-(e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i,
  /\bsource\s+<\(|\.\s+<\(/,
  /\bfrombase64string\b/i,
];

/** The risk of a shell command line, run in `cwd` within the project at `root`. */
export function assessShell(command: string, root: string, cwd: string = root): Risk {
  const text = command.replace(/\\\r?\n/g, ' ').trim();
  if (!text) return SAFE;
  for (const p of OBFUSCATED) if (p.test(text)) return risky('unclassified', 'runs a command it builds or decodes on the fly, which can\'t be checked before it runs');
  for (const p of DESTRUCTIVE_MIGRATIONS) if (p.test(text)) return risky('database', 'rolls back or resets a database');
  if (DANGEROUS_SQL.some((p) => p.test(text))) return risky('database', 'drops, truncates or deletes database data');
  let result: Risk = SAFE;
  // Where each part runs: `cd .. && echo x > a.txt` writes outside the
  // project. null once a move can't be read before it runs (`cd -`, `cd $X`).
  let here: string | null = cwd;
  for (const segment of segments(text)) {
    const moved = directoryChange(segment, here);
    if (moved !== undefined) { here = moved; continue; }
    let r = assessSegment(segment, root, here ?? root);
    if (r.level === 'recoverable') {
      if (here === null) r = risky('outside-project', 'changes to a folder that can\'t be told before it runs, then changes files there');
      else if (outside(here, root, root)) r = risky('outside-project', `changes files in ${here}, outside the project`);
    }
    result = worst(result, r);
    if (result.level === 'risky') return result;
  }
  return result;
}

const CHANGES_DIRECTORY = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location']);

/**
 * The folder a segment moves to, if it is a `cd` (or its kin): undefined when
 * it is not one, null when where it goes can't be read before it runs.
 */
function directoryChange(segment: string, from: string | null): string | null | undefined {
  const w = words(segment);
  const prog = programName(w[0] ?? '');
  if (!CHANGES_DIRECTORY.has(prog)) return undefined;
  if (prog === 'popd' || prog === 'pop-location') return null;
  // `Set-Location -Path x`, `cd /d D:\x` (cmd), or the first word that isn't a flag.
  const args = w.slice(1).filter((a) => !/^\/d$/i.test(a));
  const named = args.findIndex((a) => /^-(path|literalpath)$/i.test(a));
  const target = named >= 0 ? args[named + 1] : args.find((a) => !a.startsWith('-'));
  if (target === undefined || target === '~') return os.homedir();
  if (target === '-' || /[$%`]/.test(target) || from === null) return null;
  if (target.startsWith('~/') || target.startsWith('~\\')) return path.join(os.homedir(), target.slice(2));
  if (/^[a-z]:[\\/]/i.test(target) && process.platform !== 'win32') return null;
  return path.resolve(from, target);
}

/** A command line's simple commands: split on && || ; | & and newlines, with $(…) and `…` read as commands of their own. */
function segments(text: string): string[] {
  const out: string[] = [];
  const inner = /\$\(([^()]*)\)|`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = inner.exec(text))) out.push(...segments(m[1] ?? m[2] ?? ''));
  const flat = text.replace(inner, ' X ').replace(/\d?>&\d/g, ' ').replace(/&>/g, '>');
  for (const part of splitOutsideQuotes(flat)) if (part.trim()) out.push(part.trim());
  return out;
}

function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Words of a simple command, quotes taken off. */
function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

const programName = (w: string): string => path.basename(w.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');

function assessSegment(segment: string, root: string, cwd: string): Risk {
  let w = words(segment);
  // Output redirected to a file: a write, checked like any other.
  const redirects: string[] = [];
  w = w.filter((word, i, all) => {
    if (/^\d?>>?$/.test(word)) { if (all[i + 1]) redirects.push(all[i + 1]!); return false; }
    const glued = /^\d?>>?(.+)$/.exec(word);
    if (glued) { redirects.push(glued[1]!); return false; }
    return i === 0 || !/^\d?>>?$/.test(all[i - 1] ?? '');
  });
  // Leading VAR=value assignments.
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift();
  if (!w.length) return writesTo(redirects, root, cwd);
  let prog = programName(w[0]!);
  let args = w.slice(1);
  // time, nohup, xargs…: the program is the one after them.
  while (PASSTHROUGH.has(prog) && args.length) {
    while (args.length && (args[0]!.startsWith('-') || /^\d+[smh]?$/.test(args[0]!))) args.shift();
    if (!args.length) break;
    prog = programName(args[0]!);
    args = args.slice(1);
  }
  if (WRAPPERS.has(prog)) {
    const script = args.findIndex((a) => /^(-c|\/c|\/k|-command|-c?ommand)$/i.test(a));
    if (script >= 0 && args[script + 1]) return worst(assessShell(args.slice(script + 1).join(' '), root, cwd), writesTo(redirects, root, cwd));
    return recoverable(`runs ${prog} ${args.join(' ')}`.trim());
  }
  const sub = (args.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
  const has = (...flags: string[]): boolean => args.some((a) => flags.includes(a.toLowerCase()) || flags.some((f) => f.startsWith('--') && a.toLowerCase().startsWith(`${f}=`)));
  const base = writesTo(redirects, root, cwd);

  if (DELETERS.has(prog)) return risky('delete', `deletes ${args.filter((a) => !a.startsWith('-')).join(' ') || 'files'}`);
  if (prog === 'find') {
    if (has('-delete') || args.some((a, i) => /^-(exec|execdir|ok|okdir)$/.test(a) && DELETERS.has(programName(args[i + 1] ?? '')))) return risky('delete', 'deletes the files it finds');
    const exec = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
    if (exec >= 0) return worst(assessShell(args.slice(exec + 1).filter((a) => a !== '{}' && a !== ';' && a !== '+' && a !== '\\;').join(' '), root, cwd), base);
    return has('-fprint', '-fprintf', '-fls') ? recoverable('find writes a list to a file') : base;
  }
  if (PROCESS_STOPPERS.has(prog)) return risky('processes', `stops processes: ${segment.slice(0, 80)}`);
  if (PERMISSIONS.has(prog)) return risky('permissions', `${prog} ${args.join(' ')}`.slice(0, 100));
  if (SYSTEM.has(prog)) return risky('install-system', `${prog} changes the system or runs with raised privileges`);
  if (prog === 'reg' && /^(add|delete|import|restore|load|unload|copy)$/.test(sub)) return risky('install-system', 'changes the Windows registry');
  if (prog === 'sc' && /^(create|delete|config|stop|start|failure)$/.test(sub)) return risky('install-system', 'changes a Windows service');
  if (/\[environment\]::setenvironmentvariable/i.test(segment)) return risky('install-system', 'changes an environment variable for good');
  if (REMOTE.has(prog)) return risky('leaves-machine', `${prog} connects to another machine`);
  if (DEPLOYERS.has(prog) && !CLOUD_READS.test(sub)) return risky('leaves-machine', `${prog} ${sub} deploys or publishes`.trim());
  if (CLOUD.has(prog)) return args.some((a) => CLOUD_READS.test(a.toLowerCase())) ? base : risky('leaves-machine', `${prog} changes cloud resources`);
  if (CONTAINERS.has(prog)) {
    if (args.some((a) => CONTAINER_STOPS.test(a.toLowerCase())) || (sub === 'compose' && args.includes('down'))) return risky('processes', `${prog} ${args.join(' ')}`.slice(0, 100));
    if (sub === 'push' || sub === 'login') return risky('leaves-machine', `${prog} ${sub}`);
    if (/^(ps|images|logs|inspect|version|info|stats|top|port|diff|history|search)$/.test(sub)) return base;
    return worst(recoverable(`${prog} ${sub}`.trim()), base);
  }
  if (prog === 'git') return worst(assessGitArgs(args), worst(base, gitPaths(args, root, cwd)));
  if (prog === 'gh') return worst(assessGh(args), base);
  if (prog === 'curl' || prog === 'wget' || prog === 'http' || prog === 'https' || /^(invoke-webrequest|iwr|invoke-restmethod|irm)$/.test(prog)) {
    const sends = /^(post|put|patch|delete)$/i;
    if (args.some((a, i) => /^(-x|--request|-method|--method)$/i.test(a) && sends.test(args[i + 1] ?? ''))
      || args.some((a) => /^(-x(post|put|patch|delete))$/i.test(a))
      || has('-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '-f', '--form', '-t', '--upload-file', '--post-data', '--post-file', '-body', '-infile')
      || ((prog === 'http' || prog === 'https') && sends.test(args[0] ?? ''))) {
      return risky('leaves-machine', `${prog} sends data to a server`);
    }
    const out = args.findIndex((a) => /^(-o|--output|-outfile|-o-)$/i.test(a));
    return worst(out >= 0 ? writesTo([args[out + 1] ?? ''], root, cwd) : SAFE, base);
  }
  if (prog === 'npx' || prog === 'pnpx' || prog === 'bunx') {
    if (has('-y', '--yes', '-p', '--package') || /@[\w.^~-]+$/.test(args.find((a) => !a.startsWith('-')) ?? '')) return risky('install-system', `${prog} downloads and runs a package`);
    const rest = args.filter((a) => !a.startsWith('-'));
    return worst(rest.length ? assessShell(rest.join(' '), root, cwd) : SAFE, base);
  }
  if ((prog === 'python' || prog === 'python3' || prog === 'py') && args[0] === '-m' && /^pip$/.test(args[1] ?? '')) {
    return PACKAGE_MANAGERS['pip']!.test(args[2] ?? '') ? risky('install-system', `pip ${args[2]} installs or removes packages`) : SAFE;
  }
  if ((prog === 'python' || prog === 'python3' || prog === 'py' || prog === 'node' || prog === 'deno' || prog === 'ruby' || prog === 'perl')
    && args.some((a) => /^(-c|-e|--eval|-p)$/.test(a))) {
    return worst(assessCode(args.slice(args.findIndex((a) => /^(-c|-e|--eval|-p)$/.test(a)) + 1).join(' ')), base);
  }
  const pm = PACKAGE_MANAGERS[prog];
  if (pm) {
    const verb = sub;
    if (has('-g', '--global') && verb && !PM_READS.test(verb)) return risky('install-system', `${prog} ${verb} changes global packages`);
    if (verb && pm.test(verb) && !PM_READS.test(verb)) {
      if (prog === 'npm' && verb === 'publish' || prog === 'yarn' && verb === 'publish' || prog === 'pnpm' && verb === 'publish' || prog === 'cargo' && verb === 'publish' || prog === 'gem' && verb === 'push' || prog === 'poetry' && verb === 'publish' || prog === 'bun' && verb === 'publish') {
        return risky('leaves-machine', `${prog} ${verb} publishes a package`);
      }
      return risky('install-system', `${prog} ${verb} installs or removes packages`);
    }
    if (!verb && (prog === 'npm' || prog === 'yarn' || prog === 'pnpm' || prog === 'bun')) return risky('install-system', `${prog} installs the project's dependencies`);
    // Listing and looking only read; test, run, build and start run the project's code.
    if (verb && PM_READS.test(verb) && !/^(test|run|start|build|exec)$/.test(verb)) return base;
    return worst(recoverable(`${prog} ${verb}`.trim()), base);
  }
  if (prog === 'twine' && sub === 'upload') return risky('leaves-machine', 'uploads a package');
  if (READ_ONLY.has(prog)) {
    if (prog === 'sed' || prog === 'perl') return SAFE;
    return base;
  }
  if (prog === 'sed' || prog === 'perl') return worst(has('-i', '--in-place') || args.some((a) => /^-i/.test(a)) ? recoverable('edits files in place (checkpointed)') : SAFE, worst(base, pathsOutside(prog, args, root, cwd, has('-i', '--in-place') || args.some((a) => /^-i/.test(a)))));
  if (WRITERS.has(prog)) {
    if (prog === 'rsync' && (has('--delete', '--del', '--delete-after', '--delete-before', '--remove-source-files'))) return risky('delete', 'rsync deletes files');
    if (prog === 'rsync' && args.some((a) => /^[\w.-]+@?[\w.-]*:/.test(a) && !/^[a-z]:[\\/]/i.test(a))) return risky('leaves-machine', 'rsync copies to another machine');
    return worst(recoverable(`${prog} changes files (checkpointed)`), worst(base, pathsOutside(prog, args, root, cwd, true)));
  }
  // Anything else runs the project's own code or a build tool: what it does
  // to the project's files the checkpoint covers.
  return worst(recoverable(`runs ${prog}${sub ? ` ${sub}` : ''}`), base);
}

/** Redirected output: a write, inside or outside the project. */
function writesTo(targets: string[], root: string, cwd: string): Risk {
  let r: Risk = SAFE;
  for (const t of targets) {
    if (!t || /^(\/dev\/(null|stdout|stderr)|nul|\$null|&\d)$/i.test(t)) continue;
    r = worst(r, outside(t, root, cwd) ? risky('outside-project', `writes ${t}, outside the project`) : recoverable(`writes ${t} (checkpointed)`, [path.resolve(cwd, t)]));
  }
  return r;
}

/** A path argument of a writing command that lands outside the project. */
function pathsOutside(prog: string, args: string[], root: string, cwd: string, writes: boolean): Risk {
  if (!writes) return SAFE;
  const paths = args.filter((a) => !a.startsWith('-') && looksLikePath(a));
  for (const a of paths) {
    if (outside(a, root, cwd)) return risky('outside-project', `${prog} changes ${a}, outside the project`);
  }
  // What it writes, for the checkpoint to vouch for: a copy writes only
  // where it copies to; anything else (mv, tee, sed -i…) every path named.
  const written = COPIES.has(prog) ? paths.slice(-1) : paths;
  return written.length ? recoverable(`${prog} changes files (checkpointed)`, written.map((p) => path.resolve(cwd, p))) : SAFE;
}

const COPIES = new Set(['cp', 'copy', 'copy-item', 'cpi', 'install', 'rsync', 'xcopy', 'robocopy']);

function gitPaths(args: string[], root: string, cwd: string): Risk {
  const c = args.findIndex((a) => a === '-C');
  if (c >= 0 && args[c + 1] && outside(args[c + 1]!, root, cwd)) return risky('outside-project', `git works in ${args[c + 1]}, outside the project`);
  return SAFE;
}

const looksLikePath = (a: string): boolean => /^(\/|~|\.\.?([\\/]|$)|[a-z]:[\\/]|\\\\|%\w+%|\$env:|\$home)/i.test(a) || a.includes('/') || a.includes('\\');

/** Whether a path, as a command would read it from `cwd`, is outside the project at `root`. */
export function outside(p: string, root: string, cwd: string): boolean {
  if (/^(%\w+%|\$env:|\$home|~)/i.test(p)) return true;
  const isWindowsAbs = /^[a-z]:[\\/]|^\\\\/i.test(p);
  if (isWindowsAbs && process.platform !== 'win32') return true;
  const resolved = path.resolve(cwd, p);
  const rel = path.relative(path.resolve(root), resolved);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

// ── git ─────────────────────────────────────────

/** git's own options, before the subcommand, that take the next word as their value. */
const GIT_OPTION_VALUES = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source', '--list-cmds']);

function assessGitArgs(args: string[]): Risk {
  // `git -C . push`, `git -c x=y reset --hard`: the subcommand comes after
  // git's own options and their values, which are not it.
  let at = 0;
  while (at < args.length && args[at]!.startsWith('-')) at += GIT_OPTION_VALUES.has(args[at]!) ? 2 : 1;
  const sub = (args[at] ?? '').toLowerCase();
  const rest = args.slice(at + 1).map((a) => a.toLowerCase());
  const has = (...f: string[]) => rest.some((a) => f.includes(a) || f.some((x) => x.startsWith('--') && a.startsWith(`${x}=`)));
  switch (sub) {
    case 'push': return risky('leaves-machine', `git push${has('-f', '--force', '--force-with-lease') ? ' --force' : ''} sends commits to a remote`);
    case 'send-email': case 'request-pull': return risky('leaves-machine', `git ${sub} sends to others`);
    case 'reset': return has('--hard', '--merge', '--keep') ? risky('git-history', 'git reset --hard discards changes and commits') : recoverable('git reset');
    case 'rebase': case 'filter-branch': case 'filter-repo': return risky('git-history', `git ${sub} rewrites history`);
    case 'clean': return risky('git-history', 'git clean deletes untracked files');
    case 'rm': return has('--cached') ? recoverable('git rm --cached') : risky('delete', 'git rm deletes files');
    case 'branch': return has('-d', '-D', '--delete', '-m', '-M', '--force', '-f') ? risky('git-history', 'deletes, renames or forces a branch') : (rest.some((a) => !a.startsWith('-')) ? recoverable('creates a branch') : SAFE);
    case 'tag': return has('-d', '--delete', '-f', '--force') ? risky('git-history', 'deletes or moves a tag') : recoverable('git tag');
    case 'stash': return /^(drop|clear)$/.test(rest[0] ?? '') ? risky('git-history', `git stash ${rest[0]} discards stashed work`) : recoverable('git stash');
    case 'checkout': return has('-f', '--force', '--', '.') || rest.includes('--') ? risky('git-history', 'git checkout discards uncommitted changes') : recoverable('git checkout');
    case 'switch': return has('-f', '--force', '--discard-changes', '-C', '--force-create') ? risky('git-history', 'git switch discards changes or overwrites a branch') : recoverable('git switch');
    case 'restore': return has('--staged') && !has('--worktree', '-W') ? recoverable('git restore --staged') : risky('git-history', 'git restore discards uncommitted changes');
    case 'commit': return has('--amend') ? risky('git-history', 'git commit --amend rewrites the last commit') : recoverable('git commit');
    case 'reflog': return /^(expire|delete)$/.test(rest[0] ?? '') ? risky('git-history', 'deletes reflog entries') : SAFE;
    case 'gc': case 'prune': return has('--prune', '--aggressive') || sub === 'prune' ? risky('git-history', 'prunes unreachable commits') : recoverable('git gc');
    case 'update-ref': return has('-d') ? risky('git-history', 'deletes a ref') : recoverable('git update-ref');
    case 'worktree': return /^(remove|prune)$/.test(rest[0] ?? '') ? risky('delete', 'removes a worktree') : recoverable('git worktree');
    case 'remote': return /^(add|remove|rm|rename|set-url)$/.test(rest[0] ?? '') ? recoverable(`git remote ${rest[0]}`) : SAFE;
    case 'config': return has('--global', '--system') && rest.some((a) => !a.startsWith('-')) && rest.filter((a) => !a.startsWith('-')).length > 1 ? risky('install-system', 'changes git config outside the project') : SAFE;
    case 'status': case 'log': case 'diff': case 'show': case 'blame': case 'ls-files': case 'rev-parse': case 'describe':
    case 'shortlog': case 'grep': case 'cat-file': case 'ls-tree': case 'whatchanged': case 'version': case 'help': case '':
      return SAFE;
    case 'fetch': return SAFE;
    default: return recoverable(`git ${sub}`);
  }
}

function assessGitTool(operation: string, args: string[]): Risk {
  if (operation === 'status' || operation === 'diff' || operation === 'log') return SAFE;
  return assessGitArgs([operation, ...args]);
}

/** The GitHub CLI: what reads, and what acts. */
function assessGh(args: string[]): Risk {
  const [area = '', verb = ''] = args.filter((a) => !a.startsWith('-')).map((a) => a.toLowerCase());
  if (area === 'api') {
    const method = args.findIndex((a) => /^(-x|--method)$/i.test(a));
    const m = method >= 0 ? (args[method + 1] ?? '').toUpperCase() : '';
    if ((m && m !== 'GET') || args.some((a) => /^(-f|-F|--field|--raw-field|--input)$/.test(a))) return risky('leaves-machine', 'gh api changes something on GitHub');
    return SAFE;
  }
  if (/^(view|list|ls|status|diff|checks|watch|download|search|browse)$/.test(verb) || /^(status|auth|search|browse|help|version|--version)$/.test(area)) return SAFE;
  if (area === 'repo' && verb === 'clone') return recoverable('gh repo clone');
  if (area === 'pr' && verb === 'checkout') return recoverable('gh pr checkout');
  return risky('leaves-machine', `gh ${area} ${verb}`.trim() + ' acts on GitHub');
}

// ── Code ────────────────────────────────────────

/** What a run_code script or an inline -c/-e program does that a checkpoint can't undo. */
export function assessCode(code: string): Risk {
  const text = code;
  if (/\b(os\.(remove|unlink|rmdir|removedirs)|shutil\.rmtree|Path\([^)]*\)\.(unlink|rmdir)|\.unlink\(|rmSync|unlinkSync|rmdirSync|fs\.rm\b|fs\.promises\.rm\b|Remove-Item|FileUtils\.rm|File\.delete)/.test(text)) {
    return risky('delete', 'the code deletes files');
  }
  if (/\b(requests|httpx|session)\.(post|put|patch|delete)\b|method\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]|\baxios\.(post|put|patch|delete)\b|\bsmtplib\b|\bnodemailer\b|urlopen\([^)]*data\s*=/i.test(text)) {
    return risky('leaves-machine', 'the code sends data to a server');
  }
  if (/\b(subprocess|os\.system|os\.popen|child_process|execSync|spawnSync|exec\(|Popen|system\(|ShellExecute|Runtime\.getRuntime)/.test(text)) {
    return risky('unclassified', 'the code runs other commands, which can\'t be checked before it runs');
  }
  if (DANGEROUS_SQL.some((p) => p.test(text))) return risky('database', 'the code drops, truncates or deletes database data');
  if (/\b(os\.kill|process\.kill|signal\.SIGKILL)\b/.test(text)) return risky('processes', 'the code stops processes');
  if (/\b(os\.chmod|os\.chown|fs\.chmod|fs\.chown)/.test(text)) return risky('permissions', 'the code changes file permissions');
  return recoverable('runs code in the project (checkpointed)');
}
