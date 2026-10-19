/** Keep settings adjacent and rotate their starting position across blocks. */
export function* scheduleRuns(models, arms, tasks, repeats) {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('Repeats must be a positive integer.');
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (let t = 0; t < tasks.length; t++) {
      for (let m = 0; m < models.length; m++) {
        for (let offset = 0; offset < arms.length; offset++) {
          yield { model: models[m], arm: arms[(repeat + t + m + offset) % arms.length], task: tasks[t], repeat };
        }
      }
    }
  }
}

export function modelBindingsMatch(requested, bindings) {
  return bindings.length === 3 && bindings.every((model) => model && (model.id === requested || `${model.provider}:${model.id}` === requested));
}

/**
 * A model's final reply, read as the short answer the task asked for: case,
 * surrounding quotes or emphasis, a closing full stop and spacing aside, it
 * must be one of the accepted answers, so a guess or an explanation that
 * merely mentions the answer does not pass.
 */
export function answeredExactly(accepted, reply) {
  const normal = (text) => String(text).normalize('NFKC')
    .trim().replace(/^[\s*_`"'“”‘’]+|[\s*_`"'“”‘’.!]+$/gu, '')
    .replace(/\s+/g, ' ').toLowerCase();
  const answer = normal(reply);
  return accepted.some((form) => normal(form) === answer);
}

/** Whether a page's text shows an answer at all: the scripted check's test. */
export function pageShows(accepted, text) {
  const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(accepted[0])}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

const known = (value) => Number.isFinite(value) && value >= 0 ? value : null;

/** Preserve observed usage, and never attribute a fallback model to the requested one. */
export function assessRun({ ok = false, usage = {}, stats = {}, decisions = [], error = '', modelInvalid = '' } = {}) {
  const substitution = modelInvalid || (decisions.some((entry) => entry.kind === 'failover') ? 'Model failover occurred; this run is excluded from the comparison.' : '');
  const valid = !substitution;
  return {
    valid, ok: valid && ok,
    tokens: known(usage.totalTokens) ?? known(stats.totalTokens),
    costUsd: usage.costUnknown || stats.untrackedCostCalls > 0 ? null : known(usage.estimatedCostUsd) ?? known(stats.totalCostUsd),
    usagePartial: Boolean(error),
    error: [error, substitution].filter(Boolean).join(' '),
  };
}

export function summarise(rows, tasks) {
  const lines = ['# Browser vision test', '',
    'Runs with model substitution are excluded. Usage means include available recorded usage from failed runs; unavailable values are excluded, and a failed request may have unreported usage.', '',
    '| Model | Setting | Valid runs | Done | Steps (mean) | Cost (mean; samples) | Tokens (mean; samples) |',
    '|---|---|---|---|---|---|---|'];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.model}|${row.arm}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const mean = (samples) => samples.reduce((sum, value) => sum + value, 0) / samples.length;
  for (const [key, all] of groups) {
    const [model, arm] = key.split('|');
    const valid = all.filter((row) => row.valid);
    const costs = valid.map((row) => row.costUsd).filter((value) => known(value) !== null);
    const tokens = valid.map((row) => row.tokens).filter((value) => known(value) !== null);
    lines.push(`| ${model} | ${arm} | ${valid.length}/${all.length} | ${valid.filter((row) => row.ok).length}/${valid.length} | ${valid.length ? mean(valid.map((row) => row.steps)).toFixed(1) : 'n/a'} | ${costs.length ? `$${mean(costs).toFixed(4)} (${costs.length}/${valid.length})` : 'n/a'} | ${tokens.length ? `${Math.round(mean(tokens))} (${tokens.length}/${valid.length})` : 'n/a'} |`);
  }
  lines.push('', '## By task', '', '| Task | Model | Setting | Valid runs | Done |', '|---|---|---|---|---|');
  for (const task of tasks) {
    for (const [key, all] of groups) {
      const [model, arm] = key.split('|');
      const mine = all.filter((row) => row.task === task.id);
      const valid = mine.filter((row) => row.valid);
      lines.push(`| ${task.id} | ${model} | ${arm} | ${valid.length}/${mine.length} | ${valid.filter((row) => row.ok).length}/${valid.length} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
