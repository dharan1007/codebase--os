import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { DeployManager, DeployTarget } from '../../core/deploy/DeployManager.js';
import { GitManager } from '../../core/git/GitManager.js';
import { loadContext } from '../context.js';

export function deployCommand(): Command {
    const deploy = new Command('deploy').description('Deploy your project to Vercel, Firebase, Fly.io, or Docker');

    function makeDeployAction(target: DeployTarget, extraArgs?: (cmd: Command) => Command) {
        let sub = new Command(target).description(`Deploy to ${target}`);
        if (target === 'vercel') {
            sub = sub.option('--prod', 'Deploy to production');
        }
        if (target === 'docker') {
            sub = sub.option('--tag <tag>', 'Docker image tag', 'latest');
        }
        if (target === 'firebase') {
            sub = sub.option('--only <target>', 'Deploy only specific resource');
        }
        sub = sub.option('--dry-run', 'Show what would be deployed without actually deploying');
        sub = sub.action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const gitManager = new GitManager(ctx.config.rootDir);
            if (gitManager.isGitRepo() && gitManager.hasUncommittedChanges()) {
                console.log(chalk.yellow('\nWarning: You have uncommitted changes.'));
                const { proceed } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Deploy with uncommitted changes?',
                    default: false,
                }]);
                if (!proceed) {
                    console.log(chalk.yellow('Deployment cancelled.'));
                    return;
                }
            }

            const actionLabel = opts.dryRun ? 'Previewing' : 'Deploying';
            const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: `${actionLabel} to ${target}${opts.prod ? ' (PRODUCTION)' : ''}. Continue?`,
                default: true,
            }]);
            if (!confirm) { console.log(chalk.yellow('Cancelled.')); return; }

            const spinner = ora(`${actionLabel} to ${target}...`).start();
            const manager = new DeployManager(ctx.config.rootDir);
            const outputLines: string[] = [];

            const result = await manager.deploy(target, {
                production: opts.prod ?? false,
                tag: opts.tag,
                target: opts.only,
                dryRun: opts.dryRun ?? false,
            }, (line) => {
                spinner.text = line.slice(0, 80);
                outputLines.push(line);
            });

            if (result.success) {
                spinner.succeed(chalk.green(`Deployed to ${target} successfully!`));
                if (result.url) {
                    console.log(chalk.bold(`\nLive URL: ${chalk.cyan(result.url)}`));
                }
            } else {
                spinner.fail(chalk.red(`Deployment to ${target} failed.`));
                console.log(chalk.red(result.error ?? ''));
                console.log(chalk.gray('\nFull output:'));
                outputLines.slice(-20).forEach(l => console.log(chalk.gray(l)));
            }
        });

        return sub;
    }

    deploy.addCommand(makeDeployAction('vercel'));
    deploy.addCommand(makeDeployAction('firebase'));
    deploy.addCommand(makeDeployAction('fly'));
    deploy.addCommand(makeDeployAction('docker'));

    return deploy;
}
