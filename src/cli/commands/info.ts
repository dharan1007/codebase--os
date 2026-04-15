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
            console.log('Codebase OS is a proprietary intelligent codebase management system.');
            console.log('It is designed to make software development autonomous and resilient.');
            console.log(chalk.yellow('Status: All Rights Reserved. Not Open Source.\n'));

            // 2. Commands & Guide
            console.log(chalk.bold('🛠️  TECHNICAL GUIDE & COMMANDS'));
            console.log(`${chalk.cyan('cos init')}          Prepare your project for Codebase OS.`);
            console.log(`${chalk.cyan('cos config')}        Setup your AI provider securely.`);
            console.log(`${chalk.cyan('cos ask')}           Solve bugs or implement logic in plain English.`);
            console.log(`${chalk.cyan('cos agent')}         Launch the autonomous engineering agent.`);
            console.log(`${chalk.cyan('cos scan')}          Build/Update the project relationship graph.`);
            console.log(`${chalk.cyan('cos fix')}           Identify and repair compile-time errors.`);
            console.log(`${chalk.cyan('cos info')}          Display this technical manual.\n`);

            // 3. Developer Information
            console.log(chalk.bold('👤 OWNER INFORMATION'));
            console.log(`${chalk.white('Author:')}    Dharantej Reddy Poduvu`);
            console.log(`${chalk.white('Location:')}  India`);
            console.log(`${chalk.white('Email:')}     dharan.poduvu@gmail.com`);
            console.log(`${chalk.white('License:')}   Proprietary (No Modification Allowed)\n`);

            // 4. Legal & Safety (STRICT)
            console.log(chalk.bold.red('⚠️  LEGAL NOTICE & DISCLAIMER'));
            console.log(chalk.red('PROPRIETARY SOFTWARE: All modification and redistribution is FORBIDDEN.'));
            console.log(chalk.yellow('Usage is at your OWN RISK. Dharantej Reddy Poduvu is NOT responsible'));
            console.log('for any data loss, code corruption, or system damage caused by the agent.');
            console.log(chalk.bold('Backups are mandatory. Verify all AI changes before committing.\n'));

            console.log(chalk.gray('───────────────────────────────────────────────────────────────────'));
            console.log(chalk.cyan('For more info, visit the GitHub repository or contact the author.\n'));
        });
}
