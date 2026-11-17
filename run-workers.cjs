#!/usr/bin/env node
'use strict';

// Compose groups related workers while keeping the API in its own container.
// A failed worker stops the group so the container restart policy can recover it.
const { spawn } = require('node:child_process');
const { statSync } = require('node:fs');
const { resolve } = require('node:path');

const entries = process.argv.slice(2);
if (entries.length === 0 || new Set(entries).size !== entries.length) {
    console.error('Usage: node run-workers.cjs <worker.ts|worker.js> [...] (unique entries)');
    process.exit(1);
}
try {
    for (const entry of entries) {
        if (!statSync(resolve(entry)).isFile()) throw new Error('Not a file: ' + entry);
    }
} catch (error) {
    console.error('[workers] Invalid entry:', error.message);
    process.exit(1);
}

const children = new Set();
let stopping = false;
let killTimer;

function stop(signal, exitCode) {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    for (const child of children) child.kill(signal);
    if (children.size > 0) {
        killTimer = setTimeout(() => {
            console.error('[workers] Shutdown timed out; terminating remaining workers');
            for (const child of children) child.kill('SIGKILL');
        }, 25000);
        killTimer.unref();
    }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => stop(signal, 0));
}

for (const entry of entries) {
    console.log('[workers] Starting ' + entry);
    const args = entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry];
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    children.add(child);
    child.once('error', error => {
        console.error('[workers] Failed to start ' + entry + ': ' + error.message);
        stop('SIGTERM', 1);
    });
    child.once('close', (code, signal) => {
        children.delete(child);
        if (!stopping) {
            console.error('[workers] ' + entry + ' stopped unexpectedly (code=' + code + ', signal=' + signal + ')');
            stop('SIGTERM', 1);
        }
        if (children.size === 0) clearTimeout(killTimer);
    });
}
