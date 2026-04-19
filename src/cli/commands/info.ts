import { Command } from 'commander';
import chalk from 'chalk';

/**
 * info command provides technical documentation, guide, and developer credits.
 */
export function infoCommand() {
    return new Command('info')
        .description('Show project guide, command details, and developer credits')
        .action(async () => {
            console.log('\n' + chalk.bold.bgCyan('  CODEBASE OS — SOVEREIGN EDITION  ') + chalk.bold.cyan(' — Project Guide  '));
            console.log(chalk.gray('───────────────────────────────────────────────────────────────────\n'));

            // 1. Philosophy
            console.log(chalk.bold('🌟 THE SOVEREIGN PHILOSOPHY'));
            console.log('Codebase OS is an autonomous engineering unit that treats software as a system.');
            console.log('It combines Relationship Mapping, Failure Intelligence, and Design Optimization.');
            console.log(chalk.yellow('Status: All Rights Reserved. Principal-Grade Engineering.\n'));

            // 2. Intelligence Layers
            console.log(chalk.bold('🧠 INTELLIGENCE LAYERS'));
            console.log(`${chalk.green('✓')} Failure Intelligence: Root-cause identification via Git & Graph.`);
            console.log(`${chalk.green('✓')} Design Intelligence: Self-healing style tokens and layout rules.`);
            console.log(`${chalk.green('✓')} Resource Monitor: Integrated cost governance and rate-limiting.\n`);

            // 3. Technical Reference
            console.log(chalk.bold('🛠️  SOVEREIGN COMMANDS'));
            console.log(`${chalk.cyan('cos agent')}     Multi-step autonomous execution + Visual Dashboard.`);
            console.log(`${chalk.cyan('cos fix')}       Self-healing diagnostics with Root Cause analysis.`);
            console.log(`${chalk.cyan('cos scan')}      Incrementally update your codebase relationship graph.`);
            console.log(`${chalk.cyan('cos serve')}     Launch the Sovereign Dashboard (Transparency Layer).`);
            console.log(`${chalk.cyan('cos info')}      Display this Sovereign manual.\n`);

            // 4. Developer Information
            console.log(chalk.bold('👤 OWNER & AUTHOR'));
            console.log(`${chalk.white('Author:')}    Dharantej Reddy Poduvu`);
            console.log(`${chalk.white('Email:')}     dharan.poduvu@gmail.com`);
            console.log(`${chalk.white('Manual:')}    Refer to ${chalk.underline('docs/GUIDE.md')} for deep-dives.\n`);

            // 5. Legal & Safety
            console.log(chalk.bold.red('⚠️  LEGAL NOTICE'));
            console.log(chalk.red('PROPRIETARY: Modification and redistribution is strictly FORBIDDEN.'));
            console.log(chalk.yellow('Usage is at your OWN RISK. Always verify changes via the Dashboard.\n'));

            console.log(chalk.gray('───────────────────────────────────────────────────────────────────'));
            console.log(chalk.cyan('For more info, visit the GitHub repository or contact the author.\n'));
        });
}
