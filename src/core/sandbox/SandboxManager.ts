import { spawn } from 'child_process';
import { logger } from '../../utils/logger.js';

export class SandboxManager {
    private allowlist = ['npm', 'npx', 'tsc', 'node', 'jest', 'mocha', 'eslint', 'prettier'];

    constructor(private rootDir: string) {}

    async execute(command: string, requireNetwork = false, onStreamingOutput?: (data: string) => void): Promise<{ success: boolean; output: string; error?: string }> {
        const bin = command.trim().split(' ')[0];
        
        if (!this.allowlist.includes(bin)) {
            const err = `Sandbox blocked execution: command '${bin}' is not in the allowlist. Allowed: ${this.allowlist.join(', ')}`;
            logger.warn(err);
            return { success: false, output: err, error: err };
        }

        const networkFlag = requireNetwork ? '' : '--network none';
        const cpuMemFlags = '--cpus 1.0 -m 512m';
        const mountFlag = `-v "${this.rootDir}:/workspace"`;
        const workdirFlag = '-w /workspace';
        const image = 'node:18-alpine';

        // Escape double quotes in the command to safely pass it to sh -c "..."
        const safeCommand = command.replace(/"/g, '\\"');
        const dockerCmd = `docker run --rm ${networkFlag} ${cpuMemFlags} ${mountFlag} ${workdirFlag} ${image} sh -c "${safeCommand}"`;

        logger.info(`Sandbox executing: ${command}`);

        return new Promise((resolve) => {
            const child = spawn(dockerCmd, { shell: true });
            let out = '';
            
            child.stdout.on('data', d => {
                const chunk = d.toString();
                out += chunk;
                if (onStreamingOutput) onStreamingOutput(chunk);
            });

            child.stderr.on('data', d => {
                const chunk = d.toString();
                out += chunk;
                if (onStreamingOutput) onStreamingOutput(chunk);
            });
            
            child.on('close', code => resolve({ success: code === 0 || code === null, output: out }));
            child.on('error', err => resolve({ success: false, output: out, error: err.message }));
            
            // Timeout after 80s
            setTimeout(() => {
                child.kill();
                resolve({ success: false, output: out, error: 'Sandbox execution timed out after 80s' });
            }, 80000);
        });
    }
}
