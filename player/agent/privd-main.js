// Root-Dienst: führt ausschließlich erlaubte Aktionen aus /run/dfm/privd aus (siehe lib/privd.js).
import { execFile } from 'node:child_process';
import { mkdirSync, chmodSync, chownSync } from 'node:fs';
import { processDir } from './lib/privd.js';

const dir = process.env.DFM_PRIVD_DIR ?? '/run/dfm/privd';
mkdirSync(dir, { recursive: true });
const exec = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: 60000 }, (e) => (e ? rej(e) : res())));
await processDir(dir, exec, (...m) => console.error(...m));
