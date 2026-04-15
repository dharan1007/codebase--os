import { Command } from 'commander';
import chalk from 'chalk';

/**
 * info command provides technical documentation, guide, and developer credits.
 */
export function infoCommand() {
    return new Command('info')
        .description('Show project guide, command details, and developer credits')
        .action(async () => {
            console.log('\n' + chalk.bold.bgCyan('  CODEBASE OS  ') + chalk.bold.cyan(' — Project Guide & Information  '));
            console.log(chalk.gray('───────────────────────────────────────────────────────────────────\n'));

            // 1. Vision
            console.log(chalk.bold('🌟 VISION'));
            console.log('Codebase OS is an intelligent codebase management system designed to make');
            console.log('software development autonomous, secure, and resilient. It bridge the gap');
            console.log('between raw AI and actual file-system engineering.\n');

            // 2. Commands & Guide
            console.log(chalk.bold('🛠️  TECHNICAL GUIDE & COMMANDS'));
            console.log(`${chalk.cyan('cos init')}          Initialize Codebase OS in your project root.`);
            console.log(`${chalk.cyan('cos config')}        Setup your AI provider (OpenRouter, Gemini, etc.).`);
            console.log(`${chalk.cyan('cos ask')}           Solve a specific bug or implementation in plain English.`);
            console.log(`${chalk.cyan('cos agent')}         Launch an autonomous agent for complex, multi-step tasks.`);
            console.log(`${chalk.cyan('cos scan')}          Build a local relationship graph of all types and symbols.`);
            console.log(`${chalk.cyan('cos fix')}           Automatically detect and fix compilation errors.`);
            console.log(`${chalk.cyan('cos visualize')}     Launch an interactive HTML dashboard for your codebase.\n`);

            // 3. Developer Information
            console.log(chalk.bold('👤 DEVELOPER INFORMATION'));
            console.log(`${chalk.white('Author:')}    Dharantej Reddy Poduvu`);
            console.log(`${chalk.white('Location:')}  India`);
            console.log(`${chalk.white('Email:')}     dharan.poduvu@gmail.com`);
            console.log(`${chalk.white('Verson:')}    v1.0.0 (Production Ready)\n`);

            // 4. Legal & Safety (OWN RISK)
            console.log(chalk.bold.red('⚠️  LEGAL DISCLAIMER & SAFETY'));
            console.log(chalk.yellow('The use of Codebase OS is at your OWN RISK.'));
            console.log('Codebase OS uses AI to modify source code. Dharantej Reddy Poduvu is NOT');
            console.log('responsible for any data loss, system damage, or unintended code changes.');
            console.log(chalk.bold('Safety Rule: Always use Codebase OS in a Git-controlled repository.'));
            console.log('AI-suggested changes should be verified before manual deployment.\n');

            console.log(chalk.gray('───────────────────────────────────────────────────────────────────'));
            console.log(chalk.cyan('For more info, visit the GitHub repository or contact the author.\n'));
        });
}
