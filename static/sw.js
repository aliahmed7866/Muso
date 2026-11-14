'use strict';

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="refresh" content="4">' +
    '<title>Reconnecting to Muso</title><main><h1>Reconnecting to Muso</h1>' +
    '<p>This page retries automatically. If Termux was closed, open it and run <code>~/bin/muso start</code>.</p>' +
    '<p><a href="/">Retry</a></p></main></html>',
    {status: 503, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}}
  )));
});
