// ─────────────────────────────────────────────
//  Cascade AI — `cascade models` Command
// ─────────────────────────────────────────────

import chalk from 'chalk';
import { ConfigManager } from '../../config/index.js';
import { CascadeRouter } from '../../core/router/index.js';

export async function modelsCommand(options: { verbose?: boolean } = {}): Promise<void> {
  console.log(chalk.magenta('\n  ◈ Cascade Models\n'));

  const cm = new ConfigManager(process.cwd());
  await cm.load();
  const config = cm.getConfig();

  const router = new CascadeRouter();
  try {
    await router.init(config);
  } catch (err) {
    console.error(chalk.red(`  Failed to initialize router: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tiers: Array<{ tier: 'T1' | 'T2' | 'T3'; label: string; color: any }> = [
    { tier: 'T1', label: 'T1 Administrator', color: chalk.hex('#7C6AF7') },
    { tier: 'T2', label: 'T2 Manager',       color: chalk.hex('#5AB4E8') },
    { tier: 'T3', label: 'T3 Worker',         color: chalk.hex('#5AE8A4') },
  ];

  let anyMissing = false;

  for (const { tier, label, color } of tiers) {
    const model = router.getTierModel(tier);
    if (model) {
      const costIn  = model.inputCostPer1kTokens === 0 ? 'free' : `$${model.inputCostPer1kTokens.toFixed(4)}/1K in`;
      const costOut = model.outputCostPer1kTokens === 0 ? 'free' : `$${model.outputCostPer1kTokens.toFixed(4)}/1K out`;
      const ctx     = model.contextWindow >= 1_000_000
        ? `${(model.contextWindow / 1_000_000).toFixed(1)}M ctx`
        : `${(model.contextWindow / 1_000).toFixed(0)}K ctx`;
      const local   = model.isLocal ? chalk.gray(' [local]') : '';
      const vision  = model.isVisionCapable ? chalk.gray(' 👁') : '';

      console.log(
        `  ${color.bold(tier)}  ${chalk.white(model.name.padEnd(24))}` +
        `${chalk.gray(model.provider.padEnd(16))}` +
        (options.verbose
          ? `${chalk.gray(ctx.padEnd(12))}${chalk.gray(`${costIn}, ${costOut}`)}`
          : `${chalk.gray(ctx)}`) +
        local + vision,
      );
    } else {
      console.log(`  ${color.bold(tier)}  ${chalk.red('No model available')}  ${chalk.gray(`(check provider config for ${label})`)}`);
      anyMissing = true;
    }
  }

  console.log();

  // Configured providers
  const providers = config.providers.map((p) => p.type).join(', ') || '(none)';
  console.log(chalk.gray(`  Configured providers: ${providers}`));

  if (options.verbose) {
    // Show all available models grouped by provider
    console.log();
    console.log(chalk.white('  Available models by provider:\n'));
    const allProviderTypes = [...new Set(config.providers.map((p) => p.type))];
    for (const providerType of allProviderTypes) {
      const available = router.getModelsForProvider(providerType as Parameters<typeof router.getModelsForProvider>[0]);
      if (available.length === 0) continue;
      console.log(chalk.gray(`  ${providerType}:`));
      for (const m of available) {
        const override = config.models.t1 === m.id ? ' ← T1'
          : config.models.t2 === m.id ? ' ← T2'
          : config.models.t3 === m.id ? ' ← T3'
          : '';
        console.log(`    ${chalk.white(m.name.padEnd(28))}${chalk.gray(m.id)}${chalk.yellow(override)}`);
      }
      console.log();
    }
  }

  if (anyMissing) {
    console.log(chalk.yellow('  Some tiers have no available model. Run `cascade doctor` for details.\n'));
  } else {
    console.log(chalk.green('  All tiers are configured.\n'));
  }
}
