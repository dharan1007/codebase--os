const fs = require('fs');
const glob = require('fast-glob');
const CLI_DIR = 'src/cli/commands';
const files = glob.sync(`${CLI_DIR}/*.ts`);
for (const file of [...files, 'src/cli/index.ts']) {
    let content = fs.readFileSync(file, 'utf-8');
    content = content.replace(/\(opts\)/g, '(opts: any)');
    content = content.replace(/\(file: string, opts\)/g, '(file: string, opts: any)');
    content = content.replace(/\(name: string, opts\)/g, '(name: string, opts: any)');
    content = content.replace(/\(changeId: string \| undefined, opts\)/g, '(changeId: string | undefined, opts: any)');
    content = content.replace(/\.catch\(err => \{/, '.catch((err: any) => {');
    fs.writeFileSync(file, content, 'utf-8');
}
