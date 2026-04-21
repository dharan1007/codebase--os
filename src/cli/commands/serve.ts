import { Command } from 'commander';
import chalk from 'chalk';
import { LocalServer } from '../../core/server/LocalServer.js';
import { loadContext } from '../context.js';

export function serveCommand(): Command {
    return new Command('serve')
        .description('Start the Codebase OS Visual UI dashboard')
        .option('-p, --port <port>', 'Port to serve on', '3000')
        .action(async (opts: any) => {
            const ctx = await loadContext().catch(() => null);

            let failureStore: any;
            let resourceMonitor: any;

            if (ctx) {
                // Lazy import to avoid circular deps at module load time
                const { FailureStore } = await import('../../core/failure/FailureStore.js');
                const { ResourceMonitor } = await import('../../core/orchestrator/ResourceMonitor.js');
                failureStore = new FailureStore(ctx.db);
                resourceMonitor = new ResourceMonitor(ctx.db);
            }

            const server = new LocalServer(failureStore, resourceMonitor);
            const port = parseInt(opts.port, 10) || 3000;
            (server as any).port = port;

            server.start();

            console.log('');
            console.log(chalk.bold('Codebase OS — Visual Dashboard'));
            console.log(chalk.gray('─'.repeat(44)));
            console.log(`  URL:    ${chalk.cyan(`http://localhost:${port}`)}`);
            console.log(`  Stats:  ${chalk.gray(`http://localhost:${port}/api/stats`)}`);
            console.log(`  Events: ${chalk.gray(`http://localhost:${port}/events`)}`);
            console.log('');
            console.log(chalk.gray('  Run cos agent or cos fix in another terminal.'));
            console.log(chalk.gray('  The dashboard updates in real-time as the agent works.'));
            console.log(chalk.gray('  Press Ctrl+C to stop.'));
            console.log('');

            // Keep the process alive until killed
            process.on('SIGINT', () => {
                server.stop();
                process.exit(0);
            });
        });
}
