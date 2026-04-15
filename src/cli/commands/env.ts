import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { loadContext } from '../context.js';
import { EnvironmentOrchestrator } from '../../core/environment/EnvironmentOrchestrator.js';

export function envCommand(): Command {
    const cmd = new Command('env').description('Manage the development environment');

    cmd
        .command('check')
        .description('Check environment status: ports, runtimes, dependencies')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { config } = ctx;

            const orchestrator = new EnvironmentOrchestrator(config);
            const spinner = ora('Checking environment...').start();
            const report = await orchestrator.initialize();
            spinner.stop();

            console.log('\nEnvironment Report');
            console.log(chalk.gray('─'.repeat(60)));

            console.log('\nRuntime Versions:');
            if (report.runtimeVersions.length === 0) {
                console.log(chalk.gray('  No runtime constraints detected'));
            } else {
                const rt = new Table({ head: [chalk.cyan('Runtime'), chalk.cyan('Required'), chalk.cyan('Installed'), chalk.cyan('Compatible')], colWidths: [12, 15, 15, 12] });
                for (const rv of report.runtimeVersions) {
                    rt.push([
                        rv.runtime,
                        rv.required,
                        rv.installed ?? chalk.red('not found'),
                        rv.compatible ? chalk.green('✓') : chalk.red('✗'),
                    ]);
                }
                console.log(rt.toString());
            }

            console.log('\nPort Conflicts:');
            if (report.portConflicts.length === 0) {
                console.log(chalk.green('  ✓ No port conflicts'));
            } else {
                for (const c of report.portConflicts) {
                    console.log(`  ${chalk.yellow('⚠')} ${c.serviceName}: port ${c.port} in use by '${c.occupiedBy ?? 'unknown'}' → resolved to ${chalk.green(String(c.resolvedPort))}`);
                }
            }

            console.log('\nDependencies:');
            if (report.dependencyStatus.success) {
                console.log(chalk.green('  ✓ All dependencies installed'));
            } else {
                console.log(chalk.red(`  ✗ Dependency issues: ${report.dependencyStatus.error ?? 'unknown'}`));
            }

            console.log('\nDocker:');
            if (report.dockerAvailable) {
                console.log(chalk.green('  ✓ Docker daemon available'));
                if (report.containerStatuses.length > 0) {
                    const cs = new Table({ head: [chalk.cyan('Container'), chalk.cyan('Status')], colWidths: [30, 20] });
                    for (const { name, status } of report.containerStatuses) {
                        cs.push([name, status === 'running' ? chalk.green(status) : chalk.yellow(status)]);
                    }
                    console.log(cs.toString());
                }
            } else {
                console.log(chalk.yellow('  ⚠ Docker daemon not available or not running'));
            }
        });

    cmd
        .command('start')
        .description('Start all configured services via Docker')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { config } = ctx;

            const orchestrator = new EnvironmentOrchestrator(config);
            const spinner = ora('Initializing environment...').start();
            const report = await orchestrator.initialize();
            spinner.stop();

            if (!report.dockerAvailable) {
                console.log(chalk.red('\n✗ Docker is not available. Cannot start services.'));
                return;
            }

            const spinnerStart = ora('Starting services...').start();
            const results = await orchestrator.startServices(report.resolvedConfig);
            spinnerStart.stop();

            for (const { name, success } of results) {
                if (success) {
                    console.log(chalk.green(`  ✓ ${name} started`));
                } else {
                    console.log(chalk.red(`  ✗ ${name} failed to start`));
                }
            }
        });

    cmd
        .command('docker-compose')
        .description('Generate a docker-compose.yaml from environment config')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { config } = ctx;

            const orchestrator = new EnvironmentOrchestrator(config);
            const report = await orchestrator.initialize();
            const composeyml = orchestrator.generateDockerCompose(report.resolvedConfig);

            console.log(chalk.gray('─'.repeat(60)));
            console.log(composeyml);
        });

    return cmd;
}