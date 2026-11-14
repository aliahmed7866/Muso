'use strict';

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// The page is self-contained because the local server may be down.
const reconnectPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#15161a">
<title>Reconnecting to Muso</title>
<style>
  html { background: #15161a; color: #f7f5fb; font: 1rem/1.55 system-ui, sans-serif; }
  main { max-width: 28rem; margin: 12vh auto 0; padding: 0 1.5rem; }
  p { color: #d4d1df; }
  code { color: #f7f5fb; }
  button { border: 0; border-radius: .65rem; padding: .7rem 1.1rem; background: #d6fb78; color: #15161a; font: inherit; cursor: pointer; }
</style>
<main>
  <h1>Reconnecting to Muso</h1>
  <p id="status" role="status">Checking the local server…</p>
  <p>If Termux is stopped, open it and run <code>~/bin/muso open</code>.</p>
  <button id="retry" type="button">Check again</button>
  <noscript><p><a href="/">Open Muso</a></p></noscript>
</main>
<script>
  const statusText = document.getElementById('status');
  const retry = document.getElementById('retry');
  let checking = false;
  let nextCheck;
  async function check() {
    if (checking || document.hidden) return;
    clearTimeout(nextCheck);
    checking = true;
    retry.disabled = true;
    statusText.textContent = 'Checking the local server…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch('/api/health', {
        cache: 'no-store', redirect: 'error', signal: controller.signal
      });
      const health = response.ok ? await response.json().catch(() => null) : null;
      if (health?.app === 'Muso' && health.ok === true) {
        statusText.textContent = 'Muso is back. Opening your library…';
        location.reload();
        return;
      }
      statusText.textContent = 'This address responded, but Muso’s health check did not pass. Check the port in Termux.';
    } catch {
      statusText.textContent = 'Muso’s local server is unreachable. Checking again automatically…';
    } finally {
      clearTimeout(timeout);
      checking = false;
      retry.disabled = false;
    }
    nextCheck = setTimeout(check, 4000);
  }
  retry.addEventListener('click', check);
  document.addEventListener('visibilitychange', check);
  check();
</script>
</html>`;

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(reconnectPage, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  })));
});
