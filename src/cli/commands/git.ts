import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import { GitManager } from '../../core/git/GitManager.js';
import { loadContext } from '../context.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { logger } from '../../utils/logger.js';

export function gitCommand(): Command {
    const git = new Command('git').description('Git integration — status, diff, commit, push, PR');

    git.command('status')
        .description('Show working tree status')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;
            const manager = new GitManager(ctx.config.rootDir);
            if (!manager.isGitRepo()) {
                console.log(chalk.red('Not a git repository.'));
                return;
            }
            const status = manager.status();
            console.log('');
            console.log(chalk.bold(`Branch: ${chalk.cyan(status.branch)}`));
            if (status.ahead > 0) console.log(chalk.yellow(`  ${status.ahead} commit(s) ahead of remote`));
            if (status.behind > 0) console.log(chalk.red(`  ${status.behind} commit(s) behind remote`));
            console.log('');

            const table = new Table({ head: [chalk.cyan('Status'), chalk.cyan('File')], colWidths: [12, 60] });
            for (const f of status.staged) table.push([chalk.green('staged'), f]);
            for (const f of status.unstaged) table.push([chalk.yellow('modified'), f]);
            for (const f of status.untracked) table.push([chalk.gray('untracked'), f]);

            if (table.length === 0) {
                console.log(chalk.green('  Working tree clean. Nothing to commit.'));
            } else {
                console.log(table.toString());
            }
            console.log('');
        });

    git.command('diff')
        .description('Show file diffs')
        .argument('[file]', 'Specific file to diff')
        .option('--staged', 'Show staged changes')
        .action(async (file?: string, opts?: any) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const manager = new GitManager(ctx.config.rootDir);
            const result = manager.diff(opts?.staged ?? false, file);

            if (!result.raw) {
                console.log(chalk.green('No changes to show.'));
                return;
            }

            for (const line of result.raw.split('\n')) {
                if (line.startsWith('+') && !line.startsWith('+++')) console.log(chalk.green(line));
                else if (line.startsWith('-') && !line.startsWith('---')) console.log(chalk.red(line));
                else if (line.startsWith('@@')) console.log(chalk.cyan(line));
                else if (line.startsWith('diff ') || line.startsWith('index ')) console.log(chalk.bold(line));
                else console.log(chalk.gray(line));
            }
            console.log('');
            console.log(chalk.gray(`+${result.additions} additions  -${result.deletions} deletions  across ${result.files.length} file(s)`));
        });

    git.command('commit')
        .description('Stage all changes and commit with a message')
        .argument('[message]', 'Commit message')
        .option('--all', 'Stage all changes before committing', true)
        .action(async (message?: string, opts?: any) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const manager = new GitManager(ctx.config.rootDir);

            if (!manager.hasUncommittedChanges()) {
                console.log(chalk.green('Nothing to commit.'));
                return;
            }

            let commitMessage = message;
            if (!commitMessage) {
                const answers = await inquirer.prompt([{
                    type: 'input',
                    name: 'msg',
                    message: 'Commit message:',
                    validate: (v: string) => v.trim().length > 0 || 'Message cannot be empty',
                }]);
                commitMessage = answers.msg as string;
            }

            const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: `Commit with message: "${commitMessage}"?`,
                default: true,
            }]);

            if (!confirm) { console.log(chalk.yellow('Cancelled.')); return; }

            if (opts?.all) {
                manager.add([]);
                console.log(chalk.gray('Staged all changes.'));
            }

            const ok = manager.commit(commitMessage);
            if (ok) {
                console.log(chalk.green(`Committed: "${commitMessage}"`));
            } else {
                console.log(chalk.red('Commit failed. Check logs for details.'));
            }
        });

    git.command('push')
        .description('Push current branch to remote')
        .argument('[remote]', 'Remote name', 'origin')
        .action(async (remote: string) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const manager = new GitManager(ctx.config.rootDir);
            const branch = manager.branch();

            const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: `Push branch "${branch}" to "${remote}"?`,
                default: true,
            }]);

            if (!confirm) { console.log(chalk.yellow('Cancelled.')); return; }

            console.log(chalk.gray(`Pushing ${branch} to ${remote}...`));
            const ok = manager.push(remote, branch);
            if (ok) {
                console.log(chalk.green(`Pushed "${branch}" to "${remote}".`));
            } else {
                console.log(chalk.red('Push failed. Check logs for details.'));
            }
        });

    git.command('log')
        .description('Show recent commit history')
        .option('-n, --count <number>', 'Number of commits to show', '15')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const manager = new GitManager(ctx.config.rootDir);
            const commits = manager.log(parseInt(opts.count as string, 10));

            if (commits.length === 0) {
                console.log(chalk.gray('No commits found.'));
                return;
            }

            console.log('');
            const table = new Table({
                head: [chalk.cyan('Hash'), chalk.cyan('Date'), chalk.cyan('Author'), chalk.cyan('Message')],
                colWidths: [10, 12, 18, 50],
                wordWrap: true,
            });
            for (const c of commits) {
                table.push([chalk.yellow(c.hash), c.date, chalk.gray(c.author), c.message]);
            }
            console.log(table.toString());
        });

    git.command('pr')
        .description('Create a GitHub Pull Request (requires gh CLI)')
        .argument('[title]', 'PR title')
        .option('--ai', 'Generate title and body using AI')
        .action(async (title?: string, opts?: any) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const manager = new GitManager(ctx.config.rootDir);
            const status = manager.status();

            let prTitle = title ?? '';
            let prBody = '';

            if (opts?.ai || !prTitle) {
                try {
                    const provider = AIProviderFactory.create(ctx.config);
                    const recentLog = manager.log(5).map(c => `- ${c.message}`).join('\n');
                    const result = await provider.execute({
                        taskType: 'simple',
                        priority: 'low',
                        context: `Generate a GitHub PR title and description for these recent commits:\n${recentLog}\n\nRespond with JSON: { "title": "...", "body": "..." }`,
                        systemPrompt: 'You are a helpful assistant who writes concise GitHub PR titles and descriptions.',
                        maxTokens: 500,
                    });
                    const parsed = JSON.parse(result.content) as { title: string; body: string };
                    prTitle = parsed.title ?? prTitle;
                    prBody = parsed.body ?? '';
                    console.log(chalk.gray(`AI generated title: "${prTitle}"`));
                } catch (err) {
                    logger.debug('AI PR generation failed', { error: String(err) });
                    if (!prTitle) {
                        const answers = await inquirer.prompt([{ type: 'input', name: 'title', message: 'PR title:' }]);
                        prTitle = answers.title as string;
                    }
                }
            }

            const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: `Create PR "${prTitle}" from branch "${status.branch}"?`,
                default: true,
            }]);

            if (!confirm) { console.log(chalk.yellow('Cancelled.')); return; }

            const ok = manager.createPR(prTitle, prBody || `Changes from branch ${status.branch}`);
            if (ok) {
                console.log(chalk.green('PR created successfully.'));
            } else {
                console.log(chalk.red('PR creation failed. Ensure "gh" CLI is installed and authenticated.'));
            }
        });

    return git;
}
