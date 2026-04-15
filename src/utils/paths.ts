import path from 'path';

/**
 * Normalizes a path to use forward slashes for cross-platform consistency in the graph.
 */
export function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

/**
 * Joins and normalizes paths.
 */
export function joinNormalized(...segments: string[]): string {
    return normalizePath(path.join(...segments));
}

/**
 * Resolves and normalizes paths.
 */
export function resolveNormalized(...segments: string[]): string {
    return normalizePath(path.resolve(...segments));
}
