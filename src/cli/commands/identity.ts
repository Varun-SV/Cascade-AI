import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../../memory/store.js';
import { CASCADE_DB_FILE } from '../../constants.js';

export function makeIdentityCommand(workspacePath = process.cwd()): Command {
  const identity = new Command('identity')
    .alias('id')
    .description('Manage Cascade identities');

  identity
    .command('list')
    .description('List all available identities')
    .action(() => {
      const store = new MemoryStore(path.join(workspacePath, CASCADE_DB_FILE));
      const identities = store.listIdentities();
      
      console.log(chalk.bold('\n  Identities:'));
      if (identities.length === 0) {
        console.log(chalk.gray('  No identities found.'));
      } else {
        identities.forEach(id => {
          const defaultLabel = id.isDefault ? chalk.green(' [Default]') : '';
          console.log(`  - ${chalk.cyan(id.name)}${defaultLabel}`);
          console.log(chalk.gray(`    ID: ${id.id}`));
          if (id.description) console.log(chalk.gray(`    ${id.description}`));
        });
      }
      console.log();
    });

  identity
    .command('create <name>')
    .description('Create a new identity')
    .option('-d, --desc <text>', 'Description of the identity')
    .option('-s, --system <text>', 'System prompt')
    .option('--default', 'Set as default identity')
    .action((name, options) => {
      const store = new MemoryStore(path.join(workspacePath, CASCADE_DB_FILE));
      
      if (options.default) {
        // Clear existing default
        const existingDefault = store.getDefaultIdentity();
        if (existingDefault) {
          store.updateIdentity(existingDefault.id, { isDefault: false });
        }
      }

      const id = randomUUID();
      store.createIdentity({
        id,
        name,
        description: options.desc,
        systemPrompt: options.system,
        isDefault: !!options.default,
        createdAt: new Date().toISOString()
      });

      console.log(chalk.green(`\n  Successfully created identity: ${name} (${id})`));
      if (options.default) console.log(chalk.green('  Set as default.'));
      console.log();
    });

  identity
    .command('set-default <name>')
    .description('Set an identity as default by name or ID')
    .action((query) => {
      const store = new MemoryStore(path.join(workspacePath, CASCADE_DB_FILE));
      const identities = store.listIdentities();
      const match = identities.find(i => i.id === query || i.name.toLowerCase() === query.toLowerCase());

      if (!match) {
        console.log(chalk.red(`\n  Identity '${query}' not found.\n`));
        return;
      }

      const existingDefault = store.getDefaultIdentity();
      if (existingDefault && existingDefault.id !== match.id) {
        store.updateIdentity(existingDefault.id, { isDefault: false });
      }

      store.updateIdentity(match.id, { isDefault: true });
      console.log(chalk.green(`\n  Identity ${match.name} is now the default.\n`));
    });

  return identity;
}
