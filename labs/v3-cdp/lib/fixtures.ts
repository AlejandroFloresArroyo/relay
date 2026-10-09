// Synthetic pages on an ephemeral loopback port. Nothing here talks to the network.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COUNT_LOADS = `<script>
  const key = 'loads:' + location.pathname;
  window.loads = Number(sessionStorage.getItem(key) ?? 0) + 1;
  sessionStorage.setItem(key, String(window.loads));
</script>`;

const PAGES: Record<string, string> = {
  '/a': `<title>A</title>${COUNT_LOADS}<h1>A</h1>`,
  '/b': `<title>B</title>${COUNT_LOADS}<h1>B</h1>`,
  '/form': `<title>Form</title>${COUNT_LOADS}
<form id="form"><input id="t" autocomplete="off" style="width:300px;font-size:20px"></form>
<p><input id="f" type="file"> <a id="dl" href="/file.txt">descargar</a></p>
<p><select id="s"><option>uno</option><option>dos</option><option>tres</option></select></p>
<div style="height:3000px"></div>
<script>
  window.clicks = 0; window.touches = 0;
  document.querySelector('#form').addEventListener('submit', (e) => { e.preventDefault(); window.submitted = document.querySelector('#t').value; });
  document.querySelector('#t').addEventListener('click', () => window.clicks++);
  document.addEventListener('touchstart', () => window.touches++);
  document.querySelector('#f').addEventListener('change', (e) => { window.picked = e.target.files[0]?.name; });
  window.ask = (kind) => { const r = kind === 'alert' ? alert('a') : kind === 'confirm' ? confirm('c') : prompt('p'); window.answer = kind + ':' + r; };
</script>`,
  '/anim': `<title>Anim</title><div id="d" style="font-size:60px"></div>
<script>(function tick() { document.querySelector('#d').textContent = performance.now().toFixed(0); requestAnimationFrame(tick); })();</script>`,
};

export type Fixtures = { url: string; uploadPath: string; downloadBody: string; close(): void };

export async function serveFixtures(): Promise<Fixtures> {
  const dir = mkdtempSync(join(tmpdir(), 'relay-lab-files-'));
  const uploadPath = join(dir, 'upload.txt');
  writeFileSync(uploadPath, 'archivo del Servidor\n');
  const downloadBody = 'descarga sintética\n';
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/file.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="relay-lab.txt"' });
      res.end(downloadBody);
      return;
    }
    const page = PAGES[path];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page ? `<!doctype html><meta charset="utf-8">${page}` : 'not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixtures: no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    uploadPath,
    downloadBody,
    close() {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
