import fs from 'fs';
import path from 'path';

const ALLOWED_SECRET_EXAMPLES = new Set([
    '.env.example',
    '.env.sample',
    '.env.template',
]);

const EXACT_SECRET_BASENAMES = new Set([
    '.env',
    '.npmrc',
    '.yarnrc',
    '.pypirc',
    '.netrc',
    '.git-credentials',
    'credentials',
    'credentials.json',
    'application_default_credentials.json',
    'service-account.json',
    'service_account.json',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'kubeconfig',
]);

const SECRET_NAME_PATTERNS: RegExp[] = [
    /^\.env\.(?!example$|sample$|template$).+/i,
    /(?:^|[-_.])(secret|secrets|credential|credentials|private[-_]?key|service[-_]?account)(?:[-_.]|$)/i,
    /\.(?:pem|p12|pfx|jks|keystore)$/i,
];

export function isWithinPath(candidate: string, root: string): boolean {
    return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Resolves a repository path and proves that both lexical and real paths remain
 * under the project root. Non-existent targets are checked through the nearest
 * existing ancestor so create/move/rollback paths cannot escape via symlinks.
 */
export function resolveWithinRoot(filePath: string, rootDir: string, label = filePath): string {
    const rootResolved = path.resolve(rootDir);
    const candidate = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(rootResolved, filePath);

    if (!isWithinPath(candidate, rootResolved)) {
        throw new Error(`Path sandbox violation: "${label}" resolves outside project root`);
    }

    const rootReal = fs.realpathSync(rootResolved);
    if (fs.existsSync(candidate)) {
        const candidateReal = fs.realpathSync(candidate);
        if (!isWithinPath(candidateReal, rootReal)) {
            throw new Error(`Path sandbox violation: "${label}" escapes project root through a symlink`);
        }
        return candidate;
    }

    let ancestor = path.dirname(candidate);
    while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
    }

    if (fs.existsSync(ancestor)) {
        const ancestorReal = fs.realpathSync(ancestor);
        if (!isWithinPath(ancestorReal, rootReal)) {
            throw new Error(`Path sandbox violation: parent of "${label}" escapes project root through a symlink`);
        }
    }
    return candidate;
}

export function isSensitiveProjectPath(filePath: string, rootDir: string): boolean {
    const resolved = path.resolve(filePath);
    const root = path.resolve(rootDir);
    const relative = path.relative(root, resolved).replace(/\\/g, '/');
    const basename = path.basename(resolved).toLowerCase();

    if (ALLOWED_SECRET_EXAMPLES.has(basename)) return false;
    if (EXACT_SECRET_BASENAMES.has(basename)) return true;
    if (SECRET_NAME_PATTERNS.some(pattern => pattern.test(basename))) return true;

    const segments = relative.toLowerCase().split('/');
    if (segments.includes('.ssh')) return true;
    if (segments.includes('.aws') && basename === 'credentials') return true;
    if (segments.includes('.config') && segments.includes('gcloud') && basename.includes('credentials')) return true;
    if (segments.includes('.kube') && basename === 'config') return true;
    return false;
}

/**
 * Read policy used for any content that may be sent to an external model.
 * Operators can opt in to one specific path through COS_ALLOW_SECRET_READS=1,
 * but the secure default is deny-by-default for credential-shaped files.
 */
export function resolveReadableProjectPath(filePath: string, rootDir: string): string {
    const resolved = resolveWithinRoot(filePath, rootDir, filePath);
    if (process.env['COS_ALLOW_SECRET_READS'] !== '1' && isSensitiveProjectPath(resolved, rootDir)) {
        throw new Error(
            `Sensitive-file policy: refusing to expose "${filePath}" to the AI runtime. ` +
            'Use an example/template file, or explicitly opt in with COS_ALLOW_SECRET_READS=1 for a trusted session.',
        );
    }
    return resolved;
}
