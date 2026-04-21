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

dotenv.config({ path: path.join(process.cwd(), '.env') });

const program = new Command();

program
    .name('cos')
    .description(chalk.bold('Codebase OS') + ' — Autonomous coding intelligence with persistent graph memory')
    .version('1.0.0', '-v, --version')
    .addHelpText('after', `
${chalk.bold('Core Commands:')}
  ${chalk.cyan('cos init')}                          Initialize in current project
  ${chalk.cyan('cos config')}                        Update AI model, key, or provider
  ${chalk.cyan('cos agent "<task>"')}                Autonomous agent — plans, writes, verifies
  ${chalk.cyan('cos ask "<request>"')}               AI: plan and apply changes in plain English
  ${chalk.cyan('cos fix [file]')}                    AI: detect and fix errors automatically
  ${chalk.cyan('cos continue')}                      Resume the last interrupted AI task

${chalk.bold('Graph Intelligence (unique to Codebase OS):')}
  ${chalk.cyan('cos scan')}                          Build/update the persistent relationship graph
  ${chalk.cyan('cos plan "<task>"')}                 Compute blast radius + topological execution order
  ${chalk.cyan('cos analyze <file>')}                Impact analysis of a specific file
  ${chalk.cyan('cos visualize')}                     Interactive HTML graph visualization
  ${chalk.cyan('cos mind-map')}                      Project and plan visualization

${chalk.bold('Operations:')}
  ${chalk.cyan('cos sync')}                          Detect cross-layer sync issues
  ${chalk.cyan('cos apply <file>')}                  Apply AI-suggested fixes to impacted files
  ${chalk.cyan('cos rollback <id>')}                 Revert an AI-applied change
  ${chalk.cyan('cos history')}                       View history of AI changes across sessions
  ${chalk.cyan('cos env check')}                     Check runtimes, ports, Docker
  ${chalk.cyan('cos serve')}                         Start the live dashboard (http://localhost:3000)
  ${chalk.cyan('cos info')}                          Show project guide and credits

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

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n👋 Operation cancelled by user. Cleaning up...'));
    process.exit(0);
});

// Global error handlers for production stability
process.on('unhandledRejection', (reason) => {
    console.error(chalk.red('\n🔥 Unhandled Process Rejection:'), reason);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error(chalk.red('\n🔥 Uncaught Exception:'), err.message);
    if (process.env['COS_LOG_LEVEL'] === 'debug') console.error(err.stack);
    process.exit(1);
});

program.parseAsync(process.argv).catch((err: any) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('command failed')) {
        console.error(chalk.red('\nFatal error:'), msg);
        if (process.env['COS_LOG_LEVEL'] === 'debug' && err.stack) {
            console.error(chalk.gray(err.stack));
        }
    }
});