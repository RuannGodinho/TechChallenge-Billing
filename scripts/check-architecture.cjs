#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const roots = process.argv.slice(2);
if (!roots.length) roots.push(process.cwd());
const violations = [];
const databaseDrivers = new Set(['pg', 'mongodb', 'mongoose']);
const transportLibraries = new Set(['express', 'amqplib', 'nodemailer', 'jsonwebtoken']);
function files(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir,entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir,entry.name)] : []);
}
for (const rootArg of roots) {
    const root = path.resolve(rootArg);
    for (const layer of ['enterprise','application','Adapters/controllers']) {
        for (const file of files(path.join(root,'src',layer))) {
            const text = fs.readFileSync(file,'utf8');
            const pattern = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
            for (const match of text.matchAll(pattern)) {
                const target = match[1];
                const resolved = target.startsWith('.') ? path.resolve(path.dirname(file),target) : target;
                const controller = layer === 'Adapters/controllers';
                const outward = target.startsWith('.') && (resolved.includes(path.sep+'infrastructure'+path.sep) || (!controller && (resolved.includes(path.sep+'Adapters'+path.sep) || resolved.includes(path.sep+'validators'+path.sep))));
                const framework = databaseDrivers.has(target) || (!controller && transportLibraries.has(target));
                if (outward || framework) {
                    const line = text.slice(0, match.index).split('\n').length;
                    violations.push(`${path.relative(root,file)}:${line}: ${layer} depends on ${target}`);
                }
            }
        }
    }
    console.log(`Checked domain, application and controllers: ${root}`);
}
if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
else console.log('Architecture dependency checks passed.');
