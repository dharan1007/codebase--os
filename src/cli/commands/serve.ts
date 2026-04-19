import { Command } from 'commander';
import { LocalServer } from '../../core/server/LocalServer.js';

export function serveCommand(): Command {
    return new Command('serve')
        .description('Start the Codebase OS Visual UI dashboard locally')
        .action(() => {
            const server = new LocalServer();
            server.start();
            console.log('Use Ctrl+C to stop the server.');
        });
}
