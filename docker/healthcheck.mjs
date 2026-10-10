// Gesundheitsprüfung für Docker: Antwortet der Hub über HTTPS? (Das Zertifikat ist selbst erstellt, darum wird es hier nicht geprüft – es geht nur um „läuft“.)
import { request } from 'node:https';

const port = Number(process.env.DFM_HTTPS_PORT ?? 8443);
const req = request({ host: '127.0.0.1', port, path: '/api/v1/setup/state', method: 'GET', rejectUnauthorized: false, timeout: 4000 }, (res) => {
  res.resume(); res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
req.end();
