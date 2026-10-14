#!/usr/bin/env node
// Generate a factual last-seven-days wiki digest from the checked-out main history.
// No third-party API calls, model prose or direct code execution from commits.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: node scripts/wiki-weekly-digest.mjs <wiki-output.md>');
  process.exit(2);
}
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}
function md(value) {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}
const repo = process.env.GITHUB_REPOSITORY || 'Varun-SV/Cascade-AI';
const since = process.env.WIKI_DIGEST_SINCE || '7 days ago';
const lines = git('log', '--first-parent', '--since=' + since,
  '--format=%H%x09%s', 'HEAD').split('\n').filter(Boolean);
const groups = [
  ['Agent orchestration / routing', /^(src\/core|src\/providers|src\/config|src\/memory)\//],
  ['CLI / developer experience', /^(src\/cli|src\/dashboard|src\/retrieval|web)\//],
  ['Desktop', /^app\//],
  ['Cloud / auth / API / web', /^cloud\//],
  ['Browser and tools', /^(src\/browser|src\/tools|src\/mcp)\//],
  ['Deployment / automation', /^(Dockerfile|docker-compose|railway\.json|\.github\/workflows)\b/],
];
const changed = [];
for (const line of lines) {
  const tab = line.indexOf('\t');
  if (tab < 0) continue;
  const sha = line.slice(0, tab);
  const title = line.slice(tab + 1);
  let paths = [];
  try {
    paths = git('diff', '--name-only', sha + '^1', sha, '--').split('\n').filter(Boolean);
  } catch {
    continue;
  }
  const sourcePaths = paths.filter(p =>
    !p.startsWith('docs/wiki/') &&
    p !== 'CHANGELOG.md' &&
    p !== '.github/workflows/wiki-publish.yml' &&
    p !== 'scripts/wiki-weekly-digest.mjs');
  if (!sourcePaths.length) continue;
  const areas = [...new Set(sourcePaths.map(p => groups.find(([, re]) => re.test(p))?.[0] || 'Other'))];
  changed.push({ sha, title, paths: sourcePaths, areas });
}
if (changed.length === 0) {
  console.log('No relevant mainline code changes in the last seven days; retaining prior digest.');
  process.exit(0);
}
const date = new Date().toISOString().slice(0, 10);
const document = [
  '# Weekly Code Changes',
  '',
  '> Automatically generated from commits already merged into [main](https://github.com/' + repo + '/tree/main).',
  '> These are code-change summaries, not independent claims that any release has deployed or passed production validation.',
  '',
  '**Updated (UTC):** ' + date + '  ',
  '**Window:** last seven days, first-parent history  ',
  '**Code-changing mainline commits:** ' + changed.length,
  '',
  '| Commit | Change | Area(s) | Files |',
  '| --- | --- | --- | ---: |',
  ...changed.map(c => '| [' + c.sha.slice(0, 8) + '](https://github.com/' + repo + '/commit/' +
    c.sha + ') | ' + md(c.title) + ' | ' + c.areas.map(md).join(', ') +
    ' | ' + c.paths.length + ' |'),
  '',
  '## Source and maintenance',
  '',
  'This report counts code changes on the first-parent path of main; merge commits are compared to their first parent. It is generated weekly without AI. The substantive wiki guides are maintained by reviewed changes to [docs/wiki](https://github.com/' + repo + '/tree/main/docs/wiki).',
  'For user-facing release notes, see [CHANGELOG.md](https://github.com/' + repo + '/blob/main/CHANGELOG.md).',
  '',
].join('\n');
writeFileSync(outputPath, document, 'utf8');
console.log('Wrote weekly wiki digest for ' + changed.length + ' commits.');
