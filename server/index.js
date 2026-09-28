import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from './app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const port = Number(env.PORT) || 8080;

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

const dataDir = env.DATA_DIR || join(root, 'data');
let app;
try {
  app = createApp({
    dataDir,
    publicDir: join(root, 'public'),
    backupKeep: env.BACKUP_KEEP != null ? Math.max(0, Number(env.BACKUP_KEEP) || 0) : 14,
    cookieSecure: env.COOKIE_SECURE || 'auto',
    trustProxy: env.TRUST_PROXY === 'true',
    log,
  });
} catch (e) {
  log.error(`Start fehlgeschlagen: ${e.message}`);
  log.error(`Ist der Datenordner ${dataDir} vorhanden und beschreibbar?`);
  process.exit(1);
}

app.server.on('error', e => {
  log.error(e.code === 'EADDRINUSE' ? `Port ${port} ist bereits belegt.` : `Serverfehler: ${e.message}`);
  process.exit(1);
});
app.server.listen(port, () => log.info(`Monatsbudget läuft auf Port ${port}, Datenbank: ${app.db.file}`));

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} empfangen, beende …`);
    await app.close();
    process.exit(0);
  });
}
