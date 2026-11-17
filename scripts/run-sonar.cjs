#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

function runScanner(env = process.env, spawn = spawnSync) {
    if (!env.SONAR_TOKEN) return 0;
    const result = spawn('npx', [
        'sonar-scanner',
        `-Dsonar.token=${env.SONAR_TOKEN}`,
        `-Dsonar.login=${env.SONAR_TOKEN}`,
    ], { stdio: 'inherit', shell: false, env });
    if (result.error) {
        console.error('Could not start the Sonar scanner.');
        return 1;
    }
    return result.status ?? 1;
}

if (require.main === module) process.exitCode = runScanner();
module.exports = { runScanner };
