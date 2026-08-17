#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import path from 'path';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';
import { continueCommand } from './commands/continue.js';
import { mindMapCommand } from './commands/mindMap.js';
import { scanCommand } from './commands/scan.js';
import { analyzeCommand } from './commands/analyze.js';
import { watchCommand } from './commands/watch.js';
import { applyCommand } from './commands/apply.js';
import { rollbackCommand } from './commands/rollback.js';
import { graphCommand } from './commands/graph.js';
import { envCommand } from './commands/env.js';
import { syncCommand } from './commands/sync.js';
import { historyCommand } from './commands/history.js';
import { visualizeCommand } from './commands/visualize.js';
import { askCommand } from './commands/ask.js';
import { gitCommand } from './commands/git.js';
import { deployCommand } from './commands/deploy.js';
import { fixCommand } from './commands/fix.js';
import { agentCommand } from './commands/agent.js';
import { infoCommand } from './commands/info.js';
import { serveCommand } from './commands/serve.js';
import { planCommand } from './commands/plan.js';
import { chatCommand } from './commands/chat.js';
import { propagateCommand } from './commands/propagate.js';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const program = new Command();

program
    .name('cos')
    .description(chalk.bold('Codebase OS') + ' — transactional AI-assisted software-change runtime')
    .version('1.0.0', '-v, --version')
    .addHelpText('after', `
${chalk.bold('Verified engineering:')}
  ${chalk.cyan('cos chat')}                          Interactive session using the hardened AgentLoop
  ${chalk.cyan('cos agent "<task>"')}                Autonomous task with independent completion verification
  ${chalk.cyan('cos fix [file]')}                    Diagnose and repair supported project errors
  ${chalk.cyan('cos continue')}                      Resume the latest durable incomplete checkpoint

${chalk.bold('Repository intelligence:')}
  ${chalk.cyan('cos scan')}                          Incrementally refresh the persistent relationship graph
  ${chalk.cyan('cos scan --force')}                  Force full analysis instead of hash-based skipping
  ${chalk.cyan('cos plan "<task>"')}                 Typed blast radius and dependency-first file ordering
  ${chalk.cyan('cos analyze <file>')}                Inspect impact for a specific file
  ${chalk.cyan('cos propagate')}                     Watch changes and propose verified downstream compatibility patches
  ${chalk.cyan('cos visualize')}                     Visualize the persistent graph

${chalk.bold('Operations:')}
  ${chalk.cyan('cos sync')}                          Inspect cross-layer synchronization issues
  ${chalk.cyan('cos rollback <id>')}                 Conflict-safe rollback of a recorded transaction
  ${chalk.cyan('cos history')}                       Inspect durable Codebase OS change history
  ${chalk.cyan('cos serve')}                         Start the loopback-only local dashboard
  ${chalk.cyan('cos init')}                          Initialize Codebase OS state in the current project

${chalk.gray('Completion is evidence-gated: a model can request finish, but the runtime decides whether verification passed.')}
`);

program.addCommand(initCommand());
program.addCommand(configCommand());
program.addCommand(mindMapCommand());
program.addCommand(scanCommand());
program.addCommand(analyzeCommand());
program.addCommand(watchCommand());
program.addCommand(applyCommand());
program.addCommand(rollbackCommand());
program.addCommand(graphCommand());
program.addCommand(envCommand());
program.addCommand(syncCommand());
program.addCommand(historyCommand());
program.addCommand(visualizeCommand());
program.addCommand(askCommand());
program.addCommand(agentCommand());
program.addCommand(gitCommand());
program.addCommand(deployCommand());
program.addCommand(fixCommand());
program.addCommand(continueCommand());
program.addCommand(infoCommand());
program.addCommand(serveCommand());
program.addCommand(planCommand());
program.addCommand(chatCommand());
program.addCommand(propagateCommand());

process.on('SIGINT', () => {
    console.log(chalk.yellow('\nOperation cancelled.'));
});

process.on('unhandledRejection', reason => {
    console.error(chalk.red('\nUnhandled promise rejection:'), reason);
    process.exitCode = 1;
});

process.on('uncaughtException', err => {
    console.error(chalk.red('\nUncaught exception:'), err.message);
    if (process.env['COS_LOG_LEVEL'] === 'debug') console.error(err.stack);
    process.exitCode = 1;
});

program.parseAsync(process.argv).catch((err: any) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('command failed')) {
        console.error(chalk.red('\nFatal error:'), message);
        if (process.env['COS_LOG_LEVEL'] === 'debug' && err.stack) {
            console.error(chalk.gray(err.stack));
        }
    }
    process.exitCode = 1;
});
