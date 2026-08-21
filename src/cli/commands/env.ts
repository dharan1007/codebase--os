import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import inquirer from 'inquirer';
import { loadContext } from '../context.js';
import { EnvironmentOrchestrator } from '../../core/environment/EnvironmentOrchestrator.js';

export function envCommand(): Command {
    const cmd = new Command('env').description('Inspect and manage the development environment');

    cmd.command('check')
        .description('Read-only environment status: ports, runtimes, dependencies, Docker')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;
            const orchestrator = new EnvironmentOrchestrator(ctx.config);
            const spinner = ora('Checking environment (read-only)...').start();
            const report = await orchestrator.initialize();
            spinner.stop();

            console.log('\nEnvironment Report');
            console.log(chalk.gray('─'.repeat(60)));

            console.log('\nRuntime Versions:');
            if (report.runtimeVersions.length === 0) {
                console.log(chalk.gray('  No runtime constraints detected'));
            } else {
                const rt = new Table({
                    head: [chalk.cyan('Runtime'), chalk.cyan('Required'), chalk.cyan('Installed'), chalk.cyan('Compatible')],
                    colWidths: [12, 15, 15, 12],
                });
                for (const rv of report.runtimeVersions) {
                    rt.push([rv.runtime, rv.required, rv.installed ?? chalk.red('not found'), rv.compatible ? chalk.green('yes') : chalk.red('no')]);
                }
                console.log(rt.toString());
            }

            console.log('\nPort Conflicts:');
            if (report.portConflicts.length === 0) console.log(chalk.green('  No port conflicts'));
            else {
                for (const conflict of report.portConflicts) {
                    console.log(chalk.yellow(
                        `  ${conflict.serviceName}: port ${conflict.port} used by '${conflict.occupiedBy ?? 'unknown'}'; suggested ${conflict.resolvedPort}`,
                    ));
                }
            }

            console.log('\nDependencies:');
            if (report.dependencyStatus.success) {
                console.log(chalk.green(`  Ready (${report.dependencyStatus.packageManager ?? 'package manager'}, install present)`));
            } else {
                console.log(chalk.yellow(`  Incomplete: ${report.dependencyStatus.error ?? report.dependencyStatus.missing.join(', ')}`));
                console.log(chalk.gray('  No installation was performed. Run `cos env install` explicitly to install project dependencies.'));
            }

            console.log('\nDocker:');
            if (report.dockerAvailable) {
                console.log(chalk.green('  Docker daemon available'));
                if (report.containerStatuses.length > 0) {
                    const cs = new Table({ head: [chalk.cyan('Container'), chalk.cyan('Status')], colWidths: [30, 20] });
                    for (const { name, status } of report.containerStatuses) cs.push([name, status]);
                    console.log(cs.toString());
                }
            } else {
                console.log(chalk.yellow('  Docker daemon not available or not running'));
            }
        });

    cmd.command('install')
        .description('Explicitly install project dependencies using the detected package manager')
        .option('-y, --yes', 'Skip confirmation')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;
            if (!opts.yes) {
                const { confirmed } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'confirmed',
                    message: 'Install project dependencies? This may modify node_modules and package-manager metadata.',
                    default: false,
                }]);
                if (!confirmed) return;
            }

            const orchestrator = new EnvironmentOrchestrator(ctx.config);
            const spinner = ora('Installing project dependencies...').start();
            const result = await orchestrator.installDependencies();
            if (result.success) spinner.succeed('Dependencies installed successfully.');
            else {
                spinner.fail('Dependency installation failed.');
                if (result.error) console.log(chalk.red(result.error.slice(-4000)));
                process.exitCode = 1;
            }
        });

    cmd.command('start')
        .description('Start all configured services via Docker without installing dependencies')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;
            const orchestrator = new EnvironmentOrchestrator(ctx.config);
            const spinner = ora('Inspecting environment...').start();
            const report = await orchestrator.initialize();
            spinner.stop();

            if (!report.dockerAvailable) {
                console.log(chalk.red('\nDocker is not available. Cannot start services.'));
                process.exitCode = 1;
                return;
            }

            const spinnerStart = ora('Starting services...').start();
            const results = await orchestrator.startServices(report.resolvedConfig);
            spinnerStart.stop();
            let failures = 0;
            for (const { name, success } of results) {
                if (success) console.log(chalk.green(`  ${name} started`));
                else {
                    failures++;
                    console.log(chalk.red(`  ${name} failed to start`));
                }
            }
            if (failures > 0) process.exitCode = 1;
        });

    cmd.command('docker-compose')
        .description('Generate docker-compose YAML from the normalized environment config')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;
            const orchestrator = new EnvironmentOrchestrator(ctx.config);
            const report = await orchestrator.initialize();
            console.log(chalk.gray('─'.repeat(60)));
            console.log(orchestrator.generateDockerCompose(report.resolvedConfig));
        });

    return cmd;
}
