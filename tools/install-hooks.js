#!/usr/bin/env node
'use strict';

// Pre-Commit-Hook einrichten: jeder Commit läuft durch tools/leak-check.js.
//   node tools/install-hooks.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const r = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) { console.error('Kein Git-Repository — erst `git init`'); process.exit(1); }
const hooks = path.join(ROOT, r.stdout.trim(), 'hooks');
fs.mkdirSync(hooks, { recursive: true });
const hook = path.join(hooks, 'pre-commit');
fs.writeFileSync(hook, '#!/bin/sh\n# The Interview — Leak-Check vor jedem Commit\nnode "$(git rev-parse --show-toplevel)/tools/leak-check.js" || exit 1\n', { mode: 0o755 });
console.log(`pre-commit-Hook installiert: ${hook}`);
