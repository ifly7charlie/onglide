import {execSync} from 'child_process';

const GIT_REF = process.env.GIT_REF || process.env.NEXT_PUBLIC_GIT_REF || null;

export function gitVersion() {
    try {
        if (GIT_REF) {
            return GIT_REF;
        }
        const stdout = execSync('/usr/bin/env git rev-parse --short HEAD');
        return String(stdout)?.trim() || '<unknown>';
    } catch {
        return 'unknown';
    }
}
