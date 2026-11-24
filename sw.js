/* =====================================================
   TalkFav Service Worker (PWA)
   - app er file gulo cache e rakhe: druto khule, internet chole geleo page ashe
   - notun code: age network theke (tai push korle notun version pabe), na pele cache
   - /api, socket.io, Cloudinary file - egulo kokhono cache kori na
   ===================================================== */
const VERSION = 'talkfav-v2';
const SHELL = [
    '/', '/index.html', '/register.html', '/dashboard.html',
    '/assets/Css/theme.css', '/assets/Css/login.css', '/assets/Css/register.css', '/assets/Css/dashboard.css',
    '/assets/js/script.js', '/assets/js/call.js', '/assets/js/dashboard.js', '/assets/js/pwa.js', '/assets/js/google-login.js',
    '/assets/images/logo-light.png', '/assets/images/logo-dark.png',
    '/assets/icons/icon-192.png', '/assets/icons/favicon.png'
];
const EMOJI_HOST = 'cdn.jsdelivr.net';

// internet na thakle ei chhoto page
const OFFLINE_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TalkFav - Offline</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;
background:linear-gradient(135deg,#eef2ff,#fdf2f8);color:#0f172a;text-align:center;padding:20px}button{margin-top:16px;padding:10px 22px;
border:none;border-radius:20px;background:#7c5cff;color:#fff;font-size:15px;font-weight:700}</style></head><body><div>
<img src="/assets/icons/icon-192.png" width="96" height="96" alt=""><h2>You are offline</h2><p>Check your internet connection and try again.</p>
<button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(VERSION)
            .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {}))))   // ekta na pele-o thambo na
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))   // purono version muche felo
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // 3D emoji chhobi: ekbar namle cache theke (druto)
    if (url.host === EMOJI_HOST && url.pathname.includes('fluent-emoji')) {
        event.respondWith(cacheFirst(req));
        return;
    }
    if (url.origin !== self.location.origin) return;                 // Cloudinary ityadi: browser nijei
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return;

    // page: age network, na pele cache, tao na pele offline page
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).then(res => { putInCache(req, res.clone()); return res; })
                .catch(() => caches.match(req).then(c => c || caches.match('/dashboard.html'))
                    .then(c => c || new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
        );
        return;
    }

    // chhobi / icon: cache agey; css / js: network agey (notun code jeno sathe sathe ashe)
    if (/\.(png|jpg|jpeg|webp|svg|ico)$/i.test(url.pathname)) event.respondWith(cacheFirst(req));
    else event.respondWith(networkFirst(req));
});

function putInCache(req, res) {
    if (!res || res.status !== 200 || res.type === 'opaque') return;
    caches.open(VERSION).then(cache => cache.put(req, res)).catch(() => {});
}

function cacheFirst(req) {
    return caches.match(req).then(cached => cached || fetch(req).then(res => {
        if (res && (res.status === 200 || res.type === 'opaque')) {
            const copy = res.clone();                                    // body ekbar-i porha jay, tai age copy
            caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
    }));
}

function networkFirst(req) {
    return fetch(req).then(res => { putInCache(req, res.clone()); return res; })
        .catch(() => caches.match(req));
}

// ---------- Push Notification (app bondho thakleo) ----------
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'TalkFav', body: event.data ? event.data.text() : '' }; }
    const title = data.title || 'TalkFav';
    event.waitUntil(
        // app khola thakle (kono tab dekha jachhe) notification dekhabo na, app nijei dekhay
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            if (list.some(c => c.visibilityState === 'visible')) return;
            return self.registration.showNotification(title, {
                body: data.body || '',
                icon: '/assets/icons/icon-192.png',
                badge: '/assets/icons/favicon.png',
                tag: data.tag || 'talkfav',
                renotify: true,
                data: { url: data.url || '/dashboard.html' }
            });
        })
    );
});

// notification e tap korle app khulbe (khola thakle sei tab e jabe)
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/dashboard.html';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            const open = list.find(c => new URL(c.url).origin === self.location.origin);
            if (open) return open.focus();
            return self.clients.openWindow(url);
        })
    );
});
