// ─────────────────────────────────────────────
//  Cascade AI — Git without a process jail
// ─────────────────────────────────────────────
//
//  Where no process jail is available (Windows always; Linux without
//  bubblewrap; a Mac whose sandbox-exec fails), the git tool still runs git,
//  as it is. Git stays within what the tool checks, but its configuration
//  can name programs — a diff, merge or filter driver, a credential helper,
//  an ssh command, an fsmonitor, a signing program — and each would run
//  outside any jail, free to read .env or ~/.cascade-ai and send it on. So
//  there git runs with no configuration that names a program:
//
//  - The global and system files are not read. What they set that is only a
//    word (line endings, your name, a remote's URL rewrite) is handed to git
//    through its environment instead. A filter they define is marked
//    required, so a file that needs it fails to add or check out rather than
//    going in unfiltered.
//  - The repository's own configuration is checked, and git does not run
//    while it sets anything but such words.
//
//  What a word is, is a list (PLAIN_*): a setting not on it is treated as a
//  program, so one git adds later is refused until it is looked at.

import { execFile } from 'node:child_process';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** `section.variable` settings that are words. */
const PLAIN_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.symlinks',
  'core.ignorecase', 'core.precomposeunicode', 'core.autocrlf', 'core.eol', 'core.safecrlf', 'core.quotepath',
  'core.longpaths', 'core.fscache', 'core.preloadindex', 'core.checkstat', 'core.trustctime', 'core.untrackedcache',
  'core.sparsecheckout', 'core.sparsecheckoutcone', 'core.abbrev', 'core.commentchar', 'core.commentstring',
  'core.compression', 'core.loosecompression', 'core.splitindex', 'core.multipackindex', 'core.protectntfs',
  'core.protecthfs', 'core.checkroundtripencoding', 'core.whitespace', 'core.warnambiguousrefs',
  'core.excludesfile', 'core.hidedotfiles', 'core.bigfilethreshold', 'core.deltabasecachelimit',
  'user.name', 'user.email', 'user.signingkey', 'user.useconfigonly',
  'author.name', 'author.email', 'committer.name', 'committer.email',
  'init.defaultbranch',
  'pull.rebase', 'pull.ff',
  'push.default', 'push.autosetupremote', 'push.followtags', 'push.negotiate',
  'fetch.prune', 'fetch.prunetags', 'fetch.writecommitgraph', 'fetch.parallel', 'fetch.fsckobjects',
  'merge.ff', 'merge.conflictstyle', 'merge.renames', 'merge.renamelimit', 'merge.log', 'merge.stat',
  'diff.renames', 'diff.algorithm', 'diff.mnemonicprefix', 'diff.noprefix', 'diff.renamelimit',
  'diff.indentheuristic', 'diff.colormoved', 'diff.context', 'diff.interhunkcontext', 'diff.relative',
  'diff.statgraphwidth', 'diff.wserrorhighlight', 'diff.suppressblankempty',
  'status.showuntrackedfiles', 'status.branch', 'status.short', 'status.relativepaths', 'status.renames',
  'status.aheadbehind',
  'commit.verbose', 'commit.status', 'commit.cleanup', 'commit.gpgsign', 'tag.gpgsign',
  'gc.auto', 'gc.autopacklimit', 'gc.autodetach', 'gc.pruneexpire', 'gc.reflogexpire', 'gc.writecommitgraph',
  'index.version', 'index.threads', 'index.skiphash', 'feature.manyfiles', 'feature.experimental',
  'pack.threads', 'pack.window', 'pack.depth', 'pack.windowmemory',
  'protocol.version', 'credential.interactive',
  'extensions.objectformat', 'extensions.worktreeconfig', 'extensions.partialclone', 'extensions.preciousobjects',
  'extensions.refstorage', 'extensions.noop',
  'lfs.repositoryformatversion', 'safe.directory', 'help.autocorrect', 'rerere.enabled', 'rerere.autoupdate',
  'http.sslverify', 'http.sslbackend', 'http.sslcainfo', 'http.sslcapath', 'http.sslversion', 'http.postbuffer',
  'http.version', 'http.lowspeedlimit', 'http.lowspeedtime', 'http.proxy', 'http.proxyauthmethod',
  'http.schannelcheckrevoke', 'http.schannelusesslcainfo', 'http.followredirects', 'http.emptyauth',
  'http.extraheader',
]);

/** `section.<name>.variable` settings that are words, by section. */
const PLAIN_NAMED: Record<string, ReadonlySet<string>> = {
  remote: new Set(['url', 'pushurl', 'fetch', 'push', 'tagopt', 'prune', 'prunetags', 'mirror', 'skipdefaultupdate', 'skipfetchall', 'promisor', 'partialclonefilter']),
  branch: new Set(['remote', 'pushremote', 'merge', 'rebase', 'description', 'vscode-merge-base']),
  submodule: new Set(['url', 'active', 'branch', 'fetchrecursesubmodules', 'ignore', 'shallow']),
  url: new Set(['insteadof', 'pushinsteadof']),
  diff: new Set(['xfuncname', 'funcname', 'wordregex', 'binary']),
  http: new Set(['sslverify', 'sslbackend', 'sslcainfo', 'sslcapath', 'sslversion', 'postbuffer', 'proxy', 'proxyauthmethod', 'extraheader', 'followredirects', 'emptyauth']),
};

/** Sections whose every setting is a word. */
const PLAIN_SECTIONS = new Set(['color', 'advice']);

/** Settings git is always given here: none of them starts a program. */
const HERMETIC: Array<[string, string]> = [
  ['core.hooksPath', NULL_DEVICE],
  ['core.attributesFile', NULL_DEVICE],
  ['core.fsmonitor', 'false'],
  ['protocol.ext.allow', 'never'],
  // Signing runs gpg or ssh-keygen; a commit that should be signed is refused instead (unjailedSettings).
  ['commit.gpgSign', 'false'],
  ['tag.gpgSign', 'false'],
  ['push.gpgSign', 'false'],
  // A submodule has configuration of its own, which is not checked here.
  ['submodule.recurse', 'false'],
  ['diff.ignoreSubmodules', 'all'],
];

/** `section`, `name` (for `section.<name>.variable`, or null) and `variable` of a key as git lists it. */
function splitKey(key: string): { section: string; name: string | null; variable: string } {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first < 0) return { section: key.toLowerCase(), name: null, variable: '' };
  return {
    section: key.slice(0, first).toLowerCase(),
    name: first === last ? null : key.slice(first + 1, last),
    variable: key.slice(last + 1).toLowerCase(),
  };
}

/** Whether a git setting is a word, never a program for git to run. */
export function isPlainGitSetting(key: string): boolean {
  const { section, name, variable } = splitKey(key);
  if (PLAIN_SECTIONS.has(section)) return true;
  if (name === null) return PLAIN_KEYS.has(`${section}.${variable}`);
  return PLAIN_NAMED[section]?.has(variable) ?? false;
}

export interface GitSetting {
  scope: string;
  key: string;
  /** null for a bare `key` line, which git reads as true. */
  value: string | null;
}

/** `git config --list --show-scope -z` read into settings. */
export function parseScopedConfig(listed: string): GitSetting[] {
  const parts = listed.split('\0');
  const out: GitSetting[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!;
    const entry = parts[i + 1]!;
    const newline = entry.indexOf('\n');
    out.push(newline < 0
      ? { scope, key: entry, value: null }
      : { scope, key: entry.slice(0, newline), value: entry.slice(newline + 1) });
  }
  return out;
}

/**
 * Where git's configuration comes from besides the repository's own files
 * (which it reads here as they are): files it is told not to read, and the
 * environment, which it is given anew.
 */
const OUTSIDE_SCOPES = new Set(['system', 'global', 'command']);

const TRUE = /^(true|yes|on|1)$/i;

export type UnjailedGit =
  | {
    ok: true;
    /** The whole environment to give git. */
    env: Record<string, string>;
    /** Whether the user's configuration asks for signed commits, which cannot be made here. */
    signsCommits: boolean;
  }
  | { ok: false; reason: string };

/**
 * How to run git without a jail from what git lists as its configuration
 * in the caller's environment (`listed`), or why not to.
 */
export function unjailedSettings(listed: string, env: NodeJS.ProcessEnv): UnjailedGit {
  const settings = parseScopedConfig(listed);

  const programs = [...new Set(settings
    .filter((s) => !OUTSIDE_SCOPES.has(s.scope) && !isPlainGitSetting(s.key))
    .map((s) => s.key))];
  if (programs.length > 0) {
    const named = programs.slice(0, 5).join(', ') + (programs.length > 5 ? `, and ${programs.length - 5} more` : '');
    return {
      ok: false,
      reason: `No process jail is available, so git runs here only without settings that can start a program, and this repository's configuration has ${programs.length === 1 ? 'one' : 'some'}: ${named}. ` +
        'Remove it from .git/config, or set tools.processJail to "off" to let git use it.',
    };
  }

  const inRepository = new Set(settings.filter((s) => !OUTSIDE_SCOPES.has(s.scope)).map((s) => s.key.toLowerCase()));
  const carried: Array<[string, string]> = [];
  const filters = new Set<string>();
  for (const s of settings) {
    if (!OUTSIDE_SCOPES.has(s.scope)) continue;
    const { section, name } = splitKey(s.key);
    if (!isPlainGitSetting(s.key)) {
      if (section === 'filter' && name) filters.add(name);
      continue;
    }
    // The repository's own value is read as it is, and outranks these but for the environment's.
    if (s.scope !== 'command' && inRepository.has(s.key.toLowerCase())) continue;
    carried.push([s.key, s.value ?? 'true']);
  }
  for (const name of filters) carried.push([`filter.${name}.required`, 'true']);
  carried.push(...HERMETIC);

  const last = (key: string) => settings.filter((s) => s.key.toLowerCase() === key).at(-1);
  const gpgSign = last('commit.gpgsign');
  const signsCommits = gpgSign !== undefined && (gpgSign.value === null || TRUE.test(gpgSign.value));

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || /^GIT_CONFIG(_PARAMETERS|_COUNT|_KEY_\d+|_VALUE_\d+|_GLOBAL|_SYSTEM|_NOSYSTEM)?$/i.test(name)) continue;
    out[name] = value;
  }
  out['GIT_CONFIG_GLOBAL'] = NULL_DEVICE;
  out['GIT_CONFIG_NOSYSTEM'] = '1';
  out['GIT_ATTR_NOSYSTEM'] = '1';
  // Nothing to answer a prompt: a push that needs a password fails at once.
  out['GIT_TERMINAL_PROMPT'] = '0';
  // Cascade's own environment is the user's to set; ~/.ssh/config can name a ProxyCommand.
  if (!out['GIT_SSH_COMMAND'] && !out['GIT_SSH']) out['GIT_SSH_COMMAND'] = `ssh -F ${NULL_DEVICE}`;
  out['GIT_CONFIG_COUNT'] = String(carried.length);
  carried.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return { ok: true, env: out, signsCommits };
}

/** What git lists as its configuration in `cwd`, run with `env`; null when it cannot say. */
export function listGitConfig(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['config', '--list', '--show-scope', '-z'], {
      cwd, env, timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => resolve(err ? null : stdout));
  });
}
