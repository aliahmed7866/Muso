'use strict';

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Muso is stopped</title><main><h1>Muso is stopped</h1>' +
    '<p>Start Muso in Termux with <code>~/bin/muso start</code>, then try again.</p>' +
    '<p><a href="/">Retry</a></p></main></html>',
    {status: 503, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}}
  )));
});
