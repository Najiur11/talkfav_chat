const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const dns = require('dns').promises;
const net = require('net');
const { base32Encode, verifyTotp } = require('./lib/totp');          // 2FA code
const { isPrivateIp } = require('./lib/net-safety');                 // SSRF suroksha
// Push notification library (npm install korle pawa jabe; na thakle push bondho, baki sob chole)
let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }
require('dotenv').config();

const app = express();
const server = http.createServer(app);                       // express + socket.io ek-i server e
// kon kon site theke API / socket use kora jabe (nijer site + localhost). .env e ALLOWED_ORIGINS diye aro deya jay
const ALLOWED_ORIGINS = ['http://localhost:3000', 'https://talkfav-chat.onrender.com']
    .concat(String(process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
const originOk = (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(null, false);
const io = new Server(server, { cors: { origin: originOk } });

// Middleware
app.use(cors({ origin: originOk }));
app.disable('x-powered-by');                                   // "Express" lukai

// nirapotta header (Helmet er moto, kono package chhara)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');           // browser file er dhoron onuman korbe na
    res.setHeader('X-Frame-Options', 'DENY');                     // onno site amader page iframe e dhukate parbe na
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), display-capture=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');   // Google login popup chalbe
    if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// ---------- Rate limit (ekjon beshi request dile kichukkhon atkano) ----------
const rateBuckets = new Map();
function rateLimit({ name, windowMs, max, key, message }) {
    return (req, res, next) => {
        const k = name + ':' + key(req);
        const now = Date.now();
        let b = rateBuckets.get(k);
        if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; rateBuckets.set(k, b); }
        b.count++;
        if (b.count > max) {
            const wait = Math.ceil((b.start + windowMs - now) / 1000);
            res.setHeader('Retry-After', String(wait));
            return res.status(429).json({ message: (message || 'Too many attempts.') + ' Please try again in ' + (wait > 90 ? Math.ceil(wait / 60) + ' minutes.' : wait + ' seconds.'), retry_after: wait });
        }
        next();
    };
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
// purono bucket muche felo (memory jeno na bhore)
setInterval(() => { const now = Date.now(); for (const [k, b] of rateBuckets) if (now - b.start > 60 * 60 * 1000) rateBuckets.delete(k); }, 10 * 60 * 1000);

const limitLogin = rateLimit({ name: 'login', windowMs: 15 * 60 * 1000, max: 10, message: 'Too many login attempts.',
    key: (req) => clientIp(req) + '|' + String((req.body && req.body.email) || '').toLowerCase() });
const limitLoginIp = rateLimit({ name: 'login-ip', windowMs: 15 * 60 * 1000, max: 40, message: 'Too many login attempts.', key: clientIp });
const limitRegister = rateLimit({ name: 'register', windowMs: 60 * 60 * 1000, max: 8, message: 'Too many accounts created from this network.', key: clientIp });
const limitTwoFa = rateLimit({ name: '2fa', windowMs: 15 * 60 * 1000, max: 10, message: 'Too many code attempts.', key: clientIp });
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ==========================================
// Frontend: shudhu assets folder ar 3 ta page public
// (age puro folder public chhilo, tai server.js / package.json o je keu dekhte parto)
// ==========================================
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const sendPage = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
// prothom page: Landing (app er porichoy). Login page /index.html e
app.get('/', sendPage('landing.html'));
app.get('/landing.html', sendPage('landing.html'));
app.get('/index.html', sendPage('index.html'));
app.get('/register.html', sendPage('register.html'));
app.get('/dashboard.html', sendPage('dashboard.html'));
app.get('/privacy.html', sendPage('privacy.html'));
// QR / share link: /u/username -> app e sei manusher profile
app.get('/u/:username', (req, res) => {
    const u = String(req.params.username || '').replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 30);
    res.redirect('/dashboard.html#u=' + encodeURIComponent(u));
});

// PWA: phone e app hisebe install (manifest + service worker + icon)
app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.sendFile(path.join(__dirname, 'manifest.webmanifest'));
});
app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');                 // service worker sobsomoy notun ta check korbe
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'assets', 'icons', 'favicon.ico')));

// ==========================================
// Database: PostgreSQL (Aiven). .env e DATABASE_URL lagbe
// ==========================================
if (!process.env.DATABASE_URL) {
    console.error('.env e DATABASE_URL nai! Aiven er Service URI ta DATABASE_URL=... hisebe dao.');
    process.exit(1);
}

// URL er "sslmode" bad dei, nicher ssl setting ta-i kaj korbe
const dbUrl = new URL(process.env.DATABASE_URL);
dbUrl.searchParams.delete('sslmode');

// DB_CA_CERT dile certificate puro jachai hobe (beshi nirapod), na dile shudhu encrypted connection
const sslOption = process.env.DB_SSL === 'false'
    ? false
    : (process.env.DB_CA_CERT
        ? { ca: process.env.DB_CA_CERT.replace(/\\n/g, '\n'), rejectUnauthorized: true }
        : { rejectUnauthorized: false });

const db = new Pool({
    connectionString: dbUrl.toString(),
    ssl: sslOption,
    max: 10,
    idleTimeoutMillis: 30000
});

db.on('error', (err) => console.error('Database error:', err.message));

// ==========================================
// Login token (HMAC-signed, 7 din valid) - kono extra package lage na
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
    console.warn('WARNING: .env e JWT_SECRET nai. Server restart dile sobai logout hoye jabe. .env e JWT_SECRET=<lomba random lekha> dao.');
}

function signToken(userId, sid) {
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ uid: userId, sid: sid || undefined, iat: now, exp: now + 7 * 24 * 3600 })).toString('base64url');
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
    return payload + '.' + sig;
}

// valid hole user id, nahole null
function verifyToken(token) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!data.uid || data.exp < Math.floor(Date.now() / 1000)) return null;
        return Number(data.uid);
    } catch (e) { return null; }
}

function decodeToken(token) {
    if (!verifyToken(token)) return null;
    try { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()); } catch (e) { return null; }
}

// ---------- Session (Active Sessions / logout / ban) ----------
// protita login = ekta session (device). Token e session id thake; session bondho hole token o bondho
const authCache = new Map();            // token er shesh ongsho -> { ok, uid, sid, at } (30 sec)
const sessionTouched = new Map();       // sid -> shesh kokhon last_used update korechi

async function authToken(token) {
    const data = decodeToken(token);
    if (!data) return null;
    const key = token.slice(-32);
    const hit = authCache.get(key);
    if (hit && Date.now() - hit.at < 30000) return hit.ok ? hit : null;
    let ok = false;
    const u = (await db.query('SELECT banned, sessions_revoked_at FROM users WHERE id = $1', [data.uid])).rows[0];
    if (u && !u.banned) {
        if (data.sid) {
            ok = !!(await db.query('SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND revoked = FALSE', [data.sid, data.uid])).rows[0];
            if (ok && Date.now() - (sessionTouched.get(data.sid) || 0) > 5 * 60 * 1000) {
                sessionTouched.set(data.sid, Date.now());
                db.query('UPDATE sessions SET last_used = NOW() WHERE id = $1', [data.sid]).catch(() => {});
            }
        } else {
            // purono token (session id chhara): "sob device theke logout" er age er hole bondho
            ok = !u.sessions_revoked_at || (data.iat && data.iat * 1000 > new Date(u.sessions_revoked_at).getTime());
        }
    }
    const entry = { ok, uid: Number(data.uid), sid: data.sid || null, at: Date.now() };
    authCache.set(key, entry);
    if (authCache.size > 5000) authCache.delete(authCache.keys().next().value);
    return ok ? entry : null;
}

async function createSession(userId, req) {
    const sid = crypto.randomBytes(16).toString('hex');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60);
    await db.query('INSERT INTO sessions (id, user_id, user_agent, ip) VALUES ($1, $2, $3, $4)',
        [sid, userId, String(req.headers['user-agent'] || '').slice(0, 300), ip]);
    return signToken(userId, sid);
}

// session bondho korle sei device er realtime connection o kete dei
function kickSessions(userId, keepSid) {
    authCache.clear();
    for (const [, sk] of io.sockets.sockets) {
        if (sk.data.userId === userId && (!keepSid || sk.data.sid !== keepSid)) {
            sk.emit('session:revoked', {});
            sk.disconnect(true);
        }
    }
}

async function revokeSessions(userId, keepSid) {
    if (keepSid) await db.query('UPDATE sessions SET revoked = TRUE WHERE user_id = $1 AND id <> $2', [userId, keepSid]);
    else await db.query('UPDATE sessions SET revoked = TRUE WHERE user_id = $1', [userId]);
    await db.query('UPDATE users SET sessions_revoked_at = NOW() WHERE id = $1', [userId]);
    kickSessions(userId, keepSid);
}

// ==========================================
// File upload: Cloudinary (chhobi, video, voice, PDF, document)
// Browser sorasori Cloudinary te upload kore; server shudhu ekta "onumoti-potro" (signature) dey.
// API secret kokhono browser e jay na.
// ==========================================
const CLOUD = {
    name: process.env.CLOUDINARY_CLOUD_NAME,
    key: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET
};
const cloudReady = !!(CLOUD.name && CLOUD.key && CLOUD.secret);
if (!cloudReady) console.warn('WARNING: Cloudinary er 3 ta .env value nai, file pathano kaj korbe na.');

// kon dhoron er file koto MB porjonto (Cloudinary free plan er shima mathay rekhe)
const UPLOAD_LIMIT_MB = { image: 10, video: 50, audio: 10, file: 10 };
// Cloudinary te audio-o "video" dhoron e rakhte hoy, ar PDF/Word/Excel holo "raw"
const CLOUD_RESOURCE = { image: 'image', video: 'video', audio: 'video', file: 'raw' };

// Cloudinary er niyom: parameter gulo A-Z sajiye "&" diye jora, sheshe secret, tarpor SHA-1
function cloudSign(params) {
    const str = Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
    return crypto.createHash('sha1').update(str + CLOUD.secret).digest('hex');
}

// unsend korle Cloudinary theke-o file muche felo (bhul hole shudhu log)
async function cloudDestroy(publicId, type) {
    if (!cloudReady || !publicId || !CLOUD_RESOURCE[type]) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const body = new URLSearchParams({
        public_id: publicId, timestamp: String(timestamp), api_key: CLOUD.key,
        signature: cloudSign({ public_id: publicId, timestamp })
    });
    try {
        await fetch(`https://api.cloudinary.com/v1_1/${CLOUD.name}/${CLOUD_RESOURCE[type]}/destroy`, { method: 'POST', body });
    } catch (e) { console.error('Cloudinary delete failed:', e.message); }
}

// browser theke asha attachment ta ashol kina jachai: amader Cloudinary + ei user er folder
function cleanAttachment(a, userId) {
    if (!a || typeof a !== 'object' || !cloudReady) return null;
    const type = Object.keys(UPLOAD_LIMIT_MB).includes(a.type) ? a.type : null;
    const url = typeof a.url === 'string' ? a.url : '';
    const publicId = typeof a.public_id === 'string' ? a.public_id : '';
    if (!type) return null;
    if (!url.startsWith(`https://res.cloudinary.com/${CLOUD.name}/`)) return null;
    if (!publicId.startsWith(`talkfav/${userId}/`)) return null;
    return {
        type, url, publicId,
        name: String(a.name || 'file').slice(0, 200),
        size: Math.max(0, parseInt(a.size, 10) || 0),
        mime: String(a.mime || '').slice(0, 100),
        duration: Number(a.duration) > 0 ? Number(a.duration) : null
    };
}

// ==========================================
// Realtime (Socket.IO): online status, typing, instant message
// ==========================================
const onlineUsers = new Map();      // userId -> koyta socket (tab) connected

// ei user-er sob accepted friend-er id
async function friendIdsOf(userId) {
    const { rows } = await db.query(`
        SELECT DISTINCT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS friend_id
        FROM friend_requests
        WHERE status = 'accepted' AND (sender_id = $1 OR receiver_id = $1)
    `, [userId]);
    return rows.map(r => Number(r.friend_id));
}

async function isFriend(a, b) {
    const { rows } = await db.query(`
        SELECT 1 FROM friend_requests
        WHERE status = 'accepted'
          AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
        LIMIT 1
    `, [a, b]);
    return rows.length > 0;
}

// duijoner je kono ekjon onnojon ke block korechhe kina
async function isBlockedEither(a, b) {
    const { rows } = await db.query(`
        SELECT 1 FROM user_blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
        LIMIT 1
    `, [a, b]);
    return rows.length > 0;
}

// ---------- Group helper ----------
// group + amar role (member na hole null)
async function groupAccess(groupId, userId) {
    const { rows } = await db.query(`
        SELECT g.*, gm.role, gm.muted FROM chat_groups g
        JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $2
        WHERE g.id = $1
    `, [groupId, userId]);
    return rows[0] || null;
}

async function groupMemberIds(groupId) {
    const { rows } = await db.query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
    return rows.map(r => r.user_id);
}

function emitMany(ids, event, payload) {
    [...new Set(ids)].forEach(id => { if (id) emitToUser(id, event, payload); });
}

// group e "Rahim added Karim" dhoroner message (sobai dekhe)
async function systemMessage(groupId, actorId, text) {
    const { rows } = await db.query(
        'INSERT INTO messages (sender_id, group_id, message, is_system) VALUES ($1, $2, $3, TRUE) RETURNING id',
        [actorId, groupId, text]
    );
    emitMany(await groupMemberIds(groupId), 'group:message', { group_id: groupId, id: rows[0].id, sender_id: actorId, system: true });
}

// message ta ke ke dekhte pare: DM hole duijon, group hole sob member (na parle null)
async function messageAccess(messageId, userId, allowDeleted) {
    const { rows } = await db.query(
        'SELECT id, sender_id, receiver_id, group_id, deleted_at, is_system, attachment_public_id, attachment_type FROM messages WHERE id = $1',
        [messageId]
    );
    if (!rows.length) return null;
    const m = rows[0];
    if (m.deleted_at && !allowDeleted) return null;
    if (m.group_id) {
        if (!(await groupAccess(m.group_id, userId))) return null;
        m.audience = await groupMemberIds(m.group_id);
    } else {
        if (m.sender_id !== userId && m.receiver_id !== userId) return null;
        m.audience = [m.sender_id, m.receiver_id];
    }
    return m;
}

// socket er code callback style e lekha, tai ei duita wrapper
function getFriendIds(userId, cb) { friendIdsOf(userId).then(cb, () => cb([])); }
function areFriends(a, b, cb) { isFriend(a, b).then(cb, () => cb(false)); }

function emitToUser(userId, event, payload) {
    io.to('user:' + userId).emit(event, payload);
}

// ==========================================
// Push Notification (app bondho thakleo phone e notification)
// .env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:tomar@email.com)
// ==========================================
const VAPID = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY, subject: process.env.VAPID_SUBJECT || 'mailto:admin@talkfav.app' };
let pushReady = false;
if (webpush && VAPID.pub && VAPID.priv) {
    try { webpush.setVapidDetails(VAPID.subject, VAPID.pub, VAPID.priv); pushReady = true; }
    catch (e) { console.error('VAPID setup failed:', e.message); }
} else {
    console.warn('WARNING: Push notification bondho (web-push install / VAPID key nai).');
}

function previewText(message, attType, attName) {
    if (message) return message.length > 120 ? message.slice(0, 120) + '…' : message;
    if (attType === 'image') return '📷 Photo';
    if (attType === 'video') return '🎬 Video';
    if (attType === 'audio') return (attName || '').startsWith('voice-') ? '🎤 Voice message' : '🎵 Audio';
    if (attType === 'file') return '📎 ' + (attName || 'File');
    if (attType === 'gif') return '🎞️ GIF';
    if (attType === 'sticker') return '🧸 Sticker';
    if (attType === 'location') return '📍 Location';
    return 'New message';
}

// je user ra ekhon online na (app khola nei), shudhu tader phone e push
async function sendPush(userIds, payload) {
    if (!pushReady) return;
    const targets = [...new Set(userIds)].filter(id => id && !onlineUsers.has(id));
    if (!targets.length) return;
    let subs;
    try {
        subs = (await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::int[])', [targets])).rows;
    } catch (e) { return; }
    const body = JSON.stringify(payload);
    await Promise.all(subs.map(sub =>
        webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, { TTL: 3600 })
            .catch(err => {
                // device theke unsubscribe hoye gechhe -> muche felo
                if (err.statusCode === 404 || err.statusCode === 410) db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]).catch(() => {});
            })
    ));
}

// friend er chat mute kora kina
async function isDmMuted(userId, friendId) {
    const { rows } = await db.query("SELECT muted FROM chat_settings WHERE user_id = $1 AND chat_type = 'u' AND chat_id = $2", [userId, friendId]);
    return !!(rows[0] && rows[0].muted);
}

// ---------- audio/video call (shudhu signaling; audio/video browser to browser) ----------
const activeCalls = new Map();      // userId -> call { caller, callee, accepted, timer }

function finishCall(call, reason) {
    if (call.finished) return;                          // duibar shesh na hoy
    call.finished = true;
    clearTimeout(call.timer);
    clearTimeout(call.dropTimer);
    if (activeCalls.get(call.caller) === call) activeCalls.delete(call.caller);
    if (activeCalls.get(call.callee) === call) activeCalls.delete(call.callee);
    emitToUser(call.caller, 'call:ended', { from: call.callee, reason });
    emitToUser(call.callee, 'call:ended', { from: call.caller, reason });

    // Call History: dhorle "answered", na dhorle "missed", kete dile "rejected"
    const status = call.accepted ? 'answered' : (reason === 'rejected' ? 'rejected' : 'missed');
    saveCallEnd(call, status);
}

// ---------- Call History (database) ----------
function saveCallStart(call, video) {
    call.dbReady = db.query(
        'INSERT INTO calls (caller_id, callee_id, video) VALUES ($1, $2, $3) RETURNING id',
        [call.caller, call.callee, video]
    ).then(r => r.rows[0].id).catch(err => { console.error('call log failed:', err.message); return null; });
}

function saveCallEnd(call, status) {
    if (!call.dbReady) return;
    call.dbReady.then(id => {
        if (!id) return;
        return db.query('UPDATE calls SET status = $1, ended_at = NOW() WHERE id = $2', [status, id]);
    }).then(() => {
        emitToUser(call.caller, 'calls:changed', {});
        emitToUser(call.callee, 'calls:changed', {});
        if (status === 'missed') emitToUser(call.callee, 'call:missed', { from: call.caller });
    }).catch(err => console.error('call log failed:', err.message));
}

// je dhorte parlo na (offline / busy) tar jonno shorasori "missed" lekha
function saveMissedCall(caller, callee, video) {
    db.query(
        "INSERT INTO calls (caller_id, callee_id, video, status, ended_at) VALUES ($1, $2, $3, 'missed', NOW())",
        [caller, callee, video]
    ).then(() => {
        emitToUser(caller, 'calls:changed', {});
        emitToUser(callee, 'calls:changed', {});
        emitToUser(callee, 'call:missed', { from: caller });
        return db.query('SELECT name FROM users WHERE id = $1', [caller]);
    }).then(r => {
        const name = r && r.rows[0] ? r.rows[0].name : 'Someone';
        sendPush([callee], { title: '📞 Missed call', body: 'from ' + name + (video ? ' (video)' : ''), tag: 'call-' + caller, url: '/dashboard.html' });
    }).catch(err => console.error('call log failed:', err.message));
}

// login token chhara socket connect hobe na (session bondho / ban holeo na)
io.use(async (socket, next) => {
    try {
        const a = await authToken(socket.handshake.auth && socket.handshake.auth.token);
        if (!a) return next(new Error('unauthorized'));
        socket.data.userId = a.uid;
        socket.data.sid = a.sid;
        next();
    } catch (e) { next(new Error('unauthorized')); }
});

io.on('connection', (socket) => {
    const userId = socket.data.userId;
    if (!userId) { socket.disconnect(true); return; }

    socket.join('user:' + userId);

    const count = (onlineUsers.get(userId) || 0) + 1;
    onlineUsers.set(userId, count);

    // nijer online friend der list pathao + friend der bolo "ami online"
    // je friend "Online lukao" chalu korechhe, take online dekhabo na
    const sendPresence = () => getFriendIds(userId, async (friendIds) => {
        const on = friendIds.filter(id => onlineUsers.has(id));
        let hidden = [];
        try { if (on.length) hidden = (await db.query('SELECT id FROM users WHERE id = ANY($1::int[]) AND hide_online', [on])).rows.map(r => r.id); } catch (e) {}
        socket.emit('presence:list', on.filter(id => !hidden.includes(id)));
    });
    sendPresence();
    if (count === 1) {
        db.query('SELECT hide_online FROM users WHERE id = $1', [userId]).then(r => {
            if (r.rows[0] && r.rows[0].hide_online) return;
            getFriendIds(userId, (friendIds) => {
                friendIds.forEach(id => emitToUser(id, 'presence', { user_id: userId, online: true }));
            });
        }).catch(() => {});
    }

    socket.on('presence:request', sendPresence);

    // typing: from onno keu fake korte parbe na (socket-er user id thekei nei)
    socket.on('typing', (data) => {
        // group e typing: baki sob member ke
        const gid = parseInt(data && data.group_id, 10);
        if (gid) {
            groupAccess(gid, userId).then(g => {
                if (!g) return;
                return groupMemberIds(gid).then(ids => emitMany(ids.filter(id => id !== userId), 'typing', { group_id: gid, from: userId, typing: !!data.typing }));
            }).catch(() => {});
            return;
        }
        const to = parseInt(data && data.to, 10);
        if (!to) return;
        areFriends(userId, to, (ok) => {
            if (ok) emitToUser(to, 'typing', { from: userId, typing: !!data.typing });
        });
    });

    // ---- call signaling ----
    socket.on('call:invite', (data) => {
        const to = parseInt(data && data.to, 10);
        if (!to || to === userId) return;
        if (activeCalls.has(userId)) return socket.emit('call:unavailable', { to, reason: 'busy-self' });

        areFriends(userId, to, (ok) => {
            if (!ok) return;
            const video = !!(data && data.video);
            if (!onlineUsers.has(to)) { saveMissedCall(userId, to, video); return socket.emit('call:unavailable', { to, reason: 'offline' }); }
            if (activeCalls.has(to)) { saveMissedCall(userId, to, video); return socket.emit('call:unavailable', { to, reason: 'busy' }); }
            if (activeCalls.has(userId)) return socket.emit('call:unavailable', { to, reason: 'busy-self' });

            const call = { caller: userId, callee: to, accepted: false, timer: null };
            saveCallStart(call, video);
            call.timer = setTimeout(() => { if (!call.accepted) finishCall(call, 'noanswer'); }, 45000);
            activeCalls.set(userId, call);
            activeCalls.set(to, call);
            emitToUser(to, 'call:incoming', { from: userId, video: !!(data && data.video) });
        });
    });

    socket.on('call:accept', () => {
        const call = activeCalls.get(userId);
        if (!call || call.callee !== userId || call.accepted) return;
        call.accepted = true;
        clearTimeout(call.timer);
        if (call.dbReady) call.dbReady.then(id => id && db.query("UPDATE calls SET status = 'answered', answered_at = NOW() WHERE id = $1", [id])).catch(() => {});
        emitToUser(call.caller, 'call:accepted', { from: userId });
        emitToUser(userId, 'call:handled', {});         // callee-r onno tab e ring bondho
    });

    socket.on('call:reject', () => {
        const call = activeCalls.get(userId);
        if (call && call.callee === userId && !call.accepted) finishCall(call, 'rejected');
    });

    socket.on('call:cancel', () => {
        const call = activeCalls.get(userId);
        if (call && call.caller === userId && !call.accepted) finishCall(call, 'cancelled');
    });

    socket.on('call:end', () => {
        const call = activeCalls.get(userId);
        if (call) finishCall(call, 'ended');
    });

    // offer / answer / ice candidate: shudhu call-er opor-pasher user ke
    socket.on('call:signal', (data) => {
        const call = activeCalls.get(userId);
        if (!call || !call.accepted || !data || !data.data) return;
        if (JSON.stringify(data.data).length > 20000) return;
        const peer = call.caller === userId ? call.callee : call.caller;
        emitToUser(peer, 'call:signal', { from: userId, data: data.data });
    });

    socket.on('disconnect', () => {
        const left = (onlineUsers.get(userId) || 1) - 1;
        if (left > 0) { onlineUsers.set(userId, left); return; }
        onlineUsers.delete(userId);
        // shesh kokhon online chhilo (Last Seen)
        db.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]).catch(() => {});
        const dropped = activeCalls.get(userId);
        if (dropped) {
            if (!dropped.accepted) finishCall(dropped, 'disconnected');
            else {
                // Reconnect: internet ektu chole gele 20 sec opekkha, abar ashle call chalu thakbe
                clearTimeout(dropped.dropTimer);
                dropped.dropTimer = setTimeout(() => {
                    if (!onlineUsers.has(userId)) finishCall(dropped, 'disconnected');
                }, 20000);
            }
        }
        getFriendIds(userId, (friendIds) => {
            friendIds.forEach(id => emitToUser(id, 'presence', { user_id: userId, online: false }));
        });
    });
});

// ==========================================
// Table gulo (na thakle) toiri kora - server chalu holei ekbar
// ==========================================
async function setupDatabase() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            country VARCHAR(100),
            phone VARCHAR(50) NOT NULL,
            password VARCHAR(255) NOT NULL,
            avatar TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    console.log('Users table ready!');

    await db.query(`
        CREATE TABLE IF NOT EXISTS friend_requests (
            id SERIAL PRIMARY KEY,
            sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            receiver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    console.log('Friend requests table ready!');

    await db.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            receiver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            is_read BOOLEAN NOT NULL DEFAULT FALSE,
            edited_at TIMESTAMPTZ,
            deleted_at TIMESTAMPTZ,
            reply_to_id INT REFERENCES messages(id) ON DELETE SET NULL,
            is_forwarded BOOLEAN NOT NULL DEFAULT FALSE,
            pinned_at TIMESTAMPTZ,
            pinned_by INT
        )`);
    console.log('Messages table ready!');

    // Last Seen: shesh kokhon online chhilo
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ');

    // Block: blocker_id je block korechhe, blocked_id jake
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_blocks (
            blocker_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            blocked_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (blocker_id, blocked_id)
        )`);

    // Report: Aiven er SQL editor e "SELECT * FROM user_reports" diye dekha jabe
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_reports (
            id SERIAL PRIMARY KEY,
            reporter_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reported_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reason VARCHAR(30) NOT NULL,
            details TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

    // file pathanor jonno notun column (age theke table thakleo jog hobe)
    const attachmentColumns = [
        'attachment_url TEXT', 'attachment_type VARCHAR(10)', 'attachment_name TEXT',
        'attachment_size INT', 'attachment_mime VARCHAR(100)', 'attachment_public_id TEXT',
        'attachment_duration REAL'
    ];
    for (const col of attachmentColumns) {
        await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS ' + col);
    }

    // ---------- GROUP CHAT ----------
    await db.query(`
        CREATE TABLE IF NOT EXISTS chat_groups (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            description TEXT,
            photo TEXT,
            photo_public_id TEXT,
            created_by INT REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            add_permission VARCHAR(10) NOT NULL DEFAULT 'admins',
            edit_permission VARCHAR(10) NOT NULL DEFAULT 'admins',
            send_permission VARCHAR(10) NOT NULL DEFAULT 'all'
        )`);
    await db.query(`
        CREATE TABLE IF NOT EXISTS group_members (
            group_id INT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role VARCHAR(10) NOT NULL DEFAULT 'member',
            joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_read_id INT NOT NULL DEFAULT 0,
            muted BOOLEAN NOT NULL DEFAULT FALSE,
            PRIMARY KEY (group_id, user_id)
        )`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user_id)');
    // group er message o eki "messages" table e: receiver_id khali, group_id bhora
    await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id INT REFERENCES chat_groups(id) ON DELETE CASCADE');
    await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE');
    await db.query('ALTER TABLE messages ALTER COLUMN receiver_id DROP NOT NULL');
    await db.query('CREATE INDEX IF NOT EXISTS idx_messages_group ON messages (group_id, id)');

    // "Delete for me": ke kon message nijer kach theke lukiyeche
    await db.query(`
        CREATE TABLE IF NOT EXISTS message_hidden (
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            PRIMARY KEY (user_id, message_id)
        )`);

    // Reaction: protita user ek message e ekta reaction (love/haha/like/wow/fire)
    await db.query(`
        CREATE TABLE IF NOT EXISTS message_reactions (
            message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reaction VARCHAR(10) NOT NULL,
            PRIMARY KEY (message_id, user_id)
        )`);

    // index: onek message holeo query druto thakbe
    await db.query('CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, receiver_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (receiver_id, is_read)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_friend_sender ON friend_requests (sender_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_friend_receiver ON friend_requests (receiver_id)');
    // ---- porer feature gulo (base table gulo toiri howar por, notun database eo cholbe) ----
    // Cover photo (Cloudinary)
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS cover TEXT');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_public_id TEXT');

    // Call History / Missed Calls
    await db.query(`
        CREATE TABLE IF NOT EXISTS calls (
            id SERIAL PRIMARY KEY,
            caller_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            callee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            video BOOLEAN NOT NULL DEFAULT FALSE,
            status VARCHAR(12) NOT NULL DEFAULT 'ringing',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            answered_at TIMESTAMPTZ,
            ended_at TIMESTAMPTZ,
            seen BOOLEAN NOT NULL DEFAULT FALSE
        )`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls (caller_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls (callee_id)');
    // server bondho hoye gele je call "ringing" e atke chhilo
    await db.query("UPDATE calls SET status = 'missed', ended_at = NOW() WHERE status = 'ringing'");

    // Google Login
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT');
    await db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users (google_id) WHERE google_id IS NOT NULL');

    // Push Notification: protita device er subscription
    await db.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id)');

    // @Mention: kake kake daka hoyeche
    await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions INT[]');

    // Poll
    await db.query(`
        CREATE TABLE IF NOT EXISTS polls (
            id SERIAL PRIMARY KEY,
            message_id INT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
            question TEXT NOT NULL,
            options JSONB NOT NULL,
            multiple BOOLEAN NOT NULL DEFAULT FALSE,
            closed BOOLEAN NOT NULL DEFAULT FALSE,
            created_by INT REFERENCES users(id) ON DELETE SET NULL
        )`);
    await db.query(`
        CREATE TABLE IF NOT EXISTS poll_votes (
            poll_id INT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            option_index INT NOT NULL,
            PRIMARY KEY (poll_id, user_id, option_index)
        )`);

    // Saved Messages (star)
    await db.query(`
        CREATE TABLE IF NOT EXISTS saved_messages (
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, message_id)
        )`);

    // Pin / Archive / Mute chat (protita user er nijer setting). chat_type: 'u' = friend, 'g' = group
    await db.query(`
        CREATE TABLE IF NOT EXISTS chat_settings (
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            chat_type CHAR(1) NOT NULL,
            chat_id INT NOT NULL,
            pinned_at TIMESTAMPTZ,
            archived BOOLEAN NOT NULL DEFAULT FALSE,
            muted BOOLEAN NOT NULL DEFAULT FALSE,
            PRIMARY KEY (user_id, chat_type, chat_id)
        )`);

    // Profile: @username, bio, link, demo account
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(30)');
    await db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username)) WHERE username IS NOT NULL');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(200)');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS links TEXT[]');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE');
    await db.query('ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT FALSE');
    // aage theke thaka user der jonno nam theke @username banai (talkfav_12 er moto)
    const { rows: noName } = await db.query('SELECT id, name, email FROM users WHERE username IS NULL LIMIT 5000');
    for (const u of noName) await assignUsername(u);

    // Speed: beshi khoja jayga gulote index
    const idx = [
        'CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email))',
        'CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver_id ON messages (sender_id, receiver_id, id)',
        'CREATE INDEX IF NOT EXISTS idx_messages_receiver_sender_id ON messages (receiver_id, sender_id, id)',
        'CREATE INDEX IF NOT EXISTS idx_messages_attach_pid ON messages (attachment_public_id) WHERE attachment_public_id IS NOT NULL',
        'CREATE INDEX IF NOT EXISTS idx_friend_status ON friend_requests (status, sender_id, receiver_id)',
        'CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions (message_id)',
        'CREATE INDEX IF NOT EXISTS idx_hidden_user ON message_hidden (user_id, message_id)',
        'CREATE INDEX IF NOT EXISTS idx_status_views_status ON status_views (status_id)'
    ];
    for (const q of idx) { try { await db.query(q); } catch (e) { console.error('index failed:', e.message); } }

    // Error log (server + browser er bhul)
    await db.query(`
        CREATE TABLE IF NOT EXISTS error_logs (
            id SERIAL PRIMARY KEY,
            source VARCHAR(10) NOT NULL,
            message TEXT NOT NULL,
            stack TEXT,
            path TEXT,
            user_id INT,
            user_agent TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_error_logs_time ON error_logs (created_at DESC)');

    // 2FA (Google Authenticator)
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending TEXT');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup TEXT[]');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS login_alerts BOOLEAN NOT NULL DEFAULT TRUE');

    // Account: session, password reset, ban, admin
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMPTZ');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set BOOLEAN NOT NULL DEFAULT TRUE');
    await db.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_used TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            user_agent TEXT,
            ip TEXT,
            revoked BOOLEAN NOT NULL DEFAULT FALSE
        )`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)');
    await db.query(`
        CREATE TABLE IF NOT EXISTS password_resets (
            user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            code_hash TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            attempts INT NOT NULL DEFAULT 0
        )`);
    await db.query('ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT FALSE');
    // Scheduled messages
    await db.query(`
        CREATE TABLE IF NOT EXISTS scheduled_messages (
            id SERIAL PRIMARY KEY,
            sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            receiver_id INT REFERENCES users(id) ON DELETE CASCADE,
            group_id INT REFERENCES chat_groups(id) ON DELETE CASCADE,
            message TEXT NOT NULL,
            send_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages (send_at)');

    // Disappearing messages: meyad shesh hole message muche jabe
    await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
    await db.query('CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages (expires_at) WHERE expires_at IS NOT NULL');
    await db.query('ALTER TABLE chat_groups ADD COLUMN IF NOT EXISTS disappear_seconds INT NOT NULL DEFAULT 0');
    // friend er sathe chat er timer (duijoner jonno eki): user_a < user_b
    await db.query(`
        CREATE TABLE IF NOT EXISTS dm_settings (
            user_a INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            user_b INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            disappear_seconds INT NOT NULL DEFAULT 0,
            PRIMARY KEY (user_a, user_b)
        )`);
    // Chat wallpaper (protita user er nijer, chat onujayi). chat_type 'a' = sob chat er default
    await db.query('ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS wallpaper TEXT');

    // Privacy settings
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_online BOOLEAN NOT NULL DEFAULT FALSE');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_last_seen BOOLEAN NOT NULL DEFAULT FALSE');
    await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_visibility VARCHAR(10) NOT NULL DEFAULT 'everyone'");
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS read_receipts BOOLEAN NOT NULL DEFAULT TRUE');

    // Status / Story (24 ghonta)
    await db.query(`
        CREATE TABLE IF NOT EXISTS statuses (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type VARCHAR(10) NOT NULL,
            text TEXT,
            bg VARCHAR(20),
            media_url TEXT,
            media_public_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
        )`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_statuses_user ON statuses (user_id, expires_at)');
    await db.query(`
        CREATE TABLE IF NOT EXISTS status_views (
            status_id INT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
            viewer_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (status_id, viewer_id)
        )`);

    // Link Preview cache: eki link bar bar ana lagbe na
    await db.query(`
        CREATE TABLE IF NOT EXISTS link_previews (
            url TEXT PRIMARY KEY,
            data JSONB,
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

    console.log('All tables ready!');
}

// ==========================================
// Login check: register/login chhara sob /api e token lagbe
// ==========================================
const PUBLIC_API = ['/register', '/login', '/config', '/auth/google', '/auth/forgot', '/auth/reset', '/auth/2fa', '/logs/client', '/auth/demo'];
app.use('/api', async (req, res, next) => {
    if (PUBLIC_API.includes(req.path)) return next();
    const header = req.headers.authorization || '';
    try {
        const a = await authToken(header.startsWith('Bearer ') ? header.slice(7) : '');
        if (!a) return res.status(401).json({ message: 'Please login again.' });
        req.userId = a.uid;
        req.sessionId = a.sid;
        next();
    } catch (e) { res.status(500).json({ message: 'Server error. Please try again.' }); }
});

// URL e deya id nijer id na hole block
const sameUser = (req, res, id) => {
    if (String(id) === String(req.userId)) return true;
    res.status(403).json({ message: 'Not allowed.' });
    return false;
};

// async route e kono error hole: terminal e log + user ke shudhu ekta sadharon message
// (database er bhitorer tottho bahire jabe na)
const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        console.error(req.method, req.path, '->', err.message);
        logError('server', err.message, err.stack, req.method + ' ' + req.path, req.userId, req.headers['user-agent']);
        if (!res.headersSent) res.status(500).json({ message: 'Server error. Please try again.' });
    }
};

// ==========================================
// 1. User Registration Route
// ==========================================
app.post('/api/register', limitRegister, handle(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const country = String(req.body.country || '').trim();
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '');
    if (!name || !email || !phone || !password) {
        return res.status(400).json({ message: 'Please fill in all required fields.' });
    }
    // server o jachai kore (browser er jachai bypass kora jay)
    if (name.length > 100) return res.status(400).json({ message: 'Name is too long.', field: 'name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 255) return res.status(400).json({ message: 'Please enter a valid email address.', field: 'email' });
    if (!/^[+\d][\d\s()-]{5,29}$/.test(phone)) return res.status(400).json({ message: 'Please enter a valid phone number.', field: 'phone' });
    if (password.length < 6 || password.length > 100) return res.status(400).json({ message: 'Password must be at least 6 characters.', field: 'password' });

    const exists = await db.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (exists.rows.length) return res.status(400).json({ message: 'This email is already registered. Try logging in.', field: 'email' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query(
        'INSERT INTO users (name, email, country, phone, password) VALUES ($1, $2, $3, $4, $5)',
        [name, email, country.slice(0, 100) || null, phone, hashedPassword]
    );
    const nu = (await db.query('SELECT id, name, email FROM users WHERE LOWER(email) = $1', [email])).rows[0];
    if (nu) await assignUsername(nu);
    res.status(201).json({ message: 'User registered successfully!' });
}));

// ==========================================
// 2. User Login Route
// ==========================================
app.post('/api/login', limitLoginIp, limitLogin, handle(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required!' });

    const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [String(email || '').trim()]);
    if (!rows.length) return res.status(400).json({ message: 'No account found with this email.', field: 'email' });

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Wrong password. Please try again.', field: 'password' });
    if (user.banned) return res.status(403).json({ message: 'This account has been suspended.' });

    res.status(200).json(await loginResult(user, req));
}));

// ==========================================
// 3. SEARCH USERS ROUTE
// ==========================================
app.get('/api/users/search', handle(async (req, res) => {
    let query = String(req.query.query || '').trim();
    if (query.startsWith('@')) query = query.slice(1);          // @username diye khoja
    if (!query) return res.status(200).json({ users: [] });
    // ILIKE = boro/choto hater okkhor er parthokko chhara khoje
    // relation: friend / sent (ami pathiyechi) / received (se pathiyechhe) / none
    // block kora (je kono dik theke) manush search e ashbe na
    const { rows } = await db.query(`
        SELECT u.id, u.name, u.email, u.country, u.username,
               CASE WHEN u.avatar_visibility = 'friends' AND COALESCE(fr.status, '') <> 'accepted' THEN NULL ELSE u.avatar END AS avatar,
               CASE WHEN fr.status = 'accepted' THEN 'friend'
                    WHEN fr.status = 'pending' AND fr.sender_id = $2 THEN 'sent'
                    WHEN fr.status = 'pending' THEN 'received'
                    ELSE 'none' END AS relation,
               fr.id AS request_id
        FROM users u
        LEFT JOIN friend_requests fr
               ON (fr.sender_id = $2 AND fr.receiver_id = u.id) OR (fr.sender_id = u.id AND fr.receiver_id = $2)
        WHERE (u.name ILIKE $1 OR u.email ILIKE $1 OR u.username ILIKE $1) AND u.id <> $2 AND NOT u.banned
          AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
              WHERE (b.blocker_id = $2 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $2))
        ORDER BY u.name LIMIT 30
    `, ['%' + query + '%', req.userId]);
    res.status(200).json({ users: rows });
}));

// ==========================================
// 4. FRIEND REQUEST ROUTES
// ==========================================
app.post('/api/friend-request/send', handle(async (req, res) => {
    if (await isDemoUser(req.userId)) return res.status(403).json({ message: 'The demo account can only chat with its demo friends.' });
    const sender_id = req.userId;
    const receiver_id = parseInt(req.body.receiver_id, 10);
    if (!receiver_id || receiver_id === sender_id) return res.status(400).json({ message: 'Invalid user.' });
    // block thakle request jabe na (ke block korechhe seta bola hoy na)
    if (await isBlockedEither(sender_id, receiver_id)) {
        return res.status(403).json({ message: "You can't send a friend request to this user." });
    }

    // duijoner moddhe age theke request ba friendship ache kina (je-i pathak)
    const { rows } = await db.query(`
        SELECT sender_id, status FROM friend_requests
        WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
        LIMIT 1
    `, [sender_id, receiver_id]);
    if (rows.length) {
        const r = rows[0];
        if (r.status === 'accepted') return res.status(409).json({ message: 'You are already friends.' });
        if (r.sender_id === sender_id) return res.status(409).json({ message: 'Request already sent.' });
        return res.status(409).json({ message: 'This user already sent you a request. Check Friend Requests.' });
    }

    await db.query("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'pending')", [sender_id, receiver_id]);
    emitToUser(receiver_id, 'requests:changed', { from: sender_id });
    res.status(200).json({ message: 'Friend request sent successfully!' });
}));

app.get('/api/friend-request/pending/:userId', handle(async (req, res) => {
    if (!sameUser(req, res, req.params.userId)) return;
    const { rows } = await db.query(`
        SELECT fr.id AS request_id, u.id AS sender_id, u.name, u.email, u.avatar
        FROM friend_requests fr
        JOIN users u ON fr.sender_id = u.id
        WHERE fr.receiver_id = $1 AND fr.status = 'pending'
        ORDER BY fr.id DESC
    `, [req.userId]);
    res.status(200).json({ requests: rows });
}));

app.post('/api/friend-request/accept', handle(async (req, res) => {
    const request_id = parseInt(req.body.request_id, 10);
    if (!request_id) return res.status(400).json({ message: 'request_id is required' });
    // shudhu je receiver, se-i accept korte parbe
    const { rows } = await db.query(`
        UPDATE friend_requests SET status = 'accepted'
        WHERE id = $1 AND receiver_id = $2 AND status = 'pending'
        RETURNING sender_id, receiver_id
    `, [request_id, req.userId]);
    if (!rows.length) return res.status(403).json({ message: 'Not allowed.' });
    emitToUser(rows[0].sender_id, 'friends:changed', {});
    emitToUser(rows[0].receiver_id, 'friends:changed', {});
    res.status(200).json({ message: 'Friend request accepted!' });
}));

app.get('/api/friends/:userId', handle(async (req, res) => {
    if (!sameUser(req, res, req.params.userId)) return;
    const { rows } = await db.query(`
        SELECT DISTINCT u.id, u.name, u.email, u.country, u.phone, u.avatar, u.username,
               CASE WHEN u.hide_last_seen THEN NULL ELSE u.last_seen_at END AS last_seen_at
        FROM users u
        JOIN friend_requests fr ON (u.id = fr.sender_id OR u.id = fr.receiver_id)
        WHERE (fr.sender_id = $1 OR fr.receiver_id = $1)
          AND fr.status = 'accepted'
          AND u.id <> $1
    `, [req.userId]);
    res.status(200).json({ friends: rows });
}));

// Ami je request pathiyechi (Cancel korar jonno)
app.get('/api/friend-request/sent/:userId', handle(async (req, res) => {
    if (!sameUser(req, res, req.params.userId)) return;
    const { rows } = await db.query(`
        SELECT fr.id AS request_id, u.id AS receiver_id, u.name, u.email, u.avatar
        FROM friend_requests fr
        JOIN users u ON fr.receiver_id = u.id
        WHERE fr.sender_id = $1 AND fr.status = 'pending'
        ORDER BY fr.id DESC
    `, [req.userId]);
    res.status(200).json({ requests: rows });
}));

// Reject: ami receiver, je pathiyechhe tar id
app.post('/api/friend-request/decline', handle(async (req, res) => {
    const sender_id = parseInt(req.body.sender_id, 10);
    if (!sender_id) return res.status(400).json({ message: 'sender_id is required' });
    const result = await db.query(
        "DELETE FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'",
        [sender_id, req.userId]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'Request not found.' });
    emitToUser(sender_id, 'requests:changed', {});
    emitToUser(req.userId, 'requests:changed', {});
    res.status(200).json({ ok: true, message: 'Request rejected.' });
}));

// Cancel: ami sender, jake pathiyechi tar id
app.post('/api/friend-request/cancel', handle(async (req, res) => {
    const receiver_id = parseInt(req.body.receiver_id, 10);
    if (!receiver_id) return res.status(400).json({ message: 'receiver_id is required' });
    const result = await db.query(
        "DELETE FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'",
        [req.userId, receiver_id]
    );
    if (!result.rowCount) return res.status(404).json({ message: 'Request not found.' });
    emitToUser(receiver_id, 'requests:changed', {});
    emitToUser(req.userId, 'requests:changed', {});
    res.status(200).json({ ok: true, message: 'Request cancelled.' });
}));

// Remove Friend: je-i age request pathak, dui dikei check
app.post('/api/friends/unfriend', handle(async (req, res) => {
    const friend_id = parseInt(req.body.friend_id, 10);
    if (!friend_id) return res.status(400).json({ message: 'friend_id is required' });
    const result = await db.query(`
        DELETE FROM friend_requests
        WHERE status = 'accepted'
          AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
    `, [req.userId, friend_id]);
    if (!result.rowCount) return res.status(404).json({ message: 'You are not friends.' });
    endCallBetween(req.userId, friend_id);
    emitToUser(friend_id, 'friends:changed', {});
    emitToUser(req.userId, 'friends:changed', {});
    res.status(200).json({ ok: true, message: 'Friend removed.' });
}));

// duijoner moddhe call cholle seta bondho (unfriend / block er por)
function endCallBetween(a, b) {
    const call = activeCalls.get(a);
    if (call && (call.caller === b || call.callee === b)) finishCall(call, 'ended');
}

// ==========================================
// 4b. BLOCK / UNBLOCK / REPORT / PROFILE
// ==========================================

// Block: friendship + request muche jay, ar keu karo kache message/call/request pathate parbe na
app.post('/api/users/block', handle(async (req, res) => {
    const target = parseInt(req.body.user_id, 10);
    if (!target || target === req.userId) return res.status(400).json({ message: 'Invalid user.' });
    const exists = await db.query('SELECT 1 FROM users WHERE id = $1', [target]);
    if (!exists.rows.length) return res.status(404).json({ message: 'User not found.' });

    await db.query(
        'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.userId, target]
    );
    await db.query(`
        DELETE FROM friend_requests
        WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
    `, [req.userId, target]);
    endCallBetween(req.userId, target);
    // dujoner list e bodlabe (ke block korechhe seta oke bola hoy na)
    emitToUser(target, 'friends:changed', {});
    emitToUser(req.userId, 'friends:changed', {});
    res.status(200).json({ ok: true, message: 'User blocked.' });
}));

// Unblock: shudhu block ta uthe jay; abar friend hote notun request lagbe
app.post('/api/users/unblock', handle(async (req, res) => {
    const target = parseInt(req.body.user_id, 10);
    if (!target) return res.status(400).json({ message: 'Invalid user.' });
    const result = await db.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.userId, target]);
    if (!result.rowCount) return res.status(404).json({ message: 'User is not blocked.' });
    res.status(200).json({ ok: true, message: 'User unblocked.' });
}));

// Ami jader block korechi
app.get('/api/users/blocked', handle(async (req, res) => {
    const { rows } = await db.query(`
        SELECT u.id, u.name, u.email, u.avatar, b.created_at AS blocked_at
        FROM user_blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1
        ORDER BY b.created_at DESC
    `, [req.userId]);
    res.status(200).json({ users: rows });
}));

// Report: database e joma thake, pore admin dekhe
const REPORT_REASONS = ['spam', 'harassment', 'fake', 'inappropriate', 'other'];
app.post('/api/users/report', handle(async (req, res) => {
    const target = parseInt(req.body.user_id, 10);
    const reason = req.body.reason;
    const details = typeof req.body.details === 'string' ? req.body.details.trim().slice(0, 1000) : '';
    if (!target || target === req.userId || !REPORT_REASONS.includes(reason)) {
        return res.status(400).json({ message: 'Please choose a reason.' });
    }
    // eki manush ke 24 ghontay ekbar-i report kora jabe (spam thekate)
    const recent = await db.query(`
        SELECT 1 FROM user_reports
        WHERE reporter_id = $1 AND reported_id = $2 AND created_at > NOW() - INTERVAL '24 hours'
    `, [req.userId, target]);
    if (recent.rows.length) return res.status(429).json({ message: 'You already reported this user today.' });

    await db.query(
        'INSERT INTO user_reports (reporter_id, reported_id, reason, details) VALUES ($1, $2, $3, $4)',
        [req.userId, target, reason, details || null]
    );
    res.status(200).json({ ok: true, message: 'Thanks. Your report has been sent.' });
}));

// User Profile: onner profile + mutual friends. Email/last seen shudhu friend ra dekhe
app.get('/api/users/:id/profile', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'Invalid user.' });
    const me = req.userId;

    // ke block korechhe: ami korle Unblock dekhabo; se korle "user not found" (tader kotha bolbo na)
    const blocks = await db.query(`
        SELECT blocker_id FROM user_blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
    `, [me, id]);
    const blockedByMe = blocks.rows.some(r => r.blocker_id === me);
    const blockedMe = blocks.rows.some(r => r.blocker_id === id);
    if (blockedMe && !blockedByMe) return res.status(404).json({ message: 'User not found.' });

    const u = await db.query('SELECT id, name, email, country, avatar, cover, created_at, last_seen_at, hide_last_seen, hide_online, avatar_visibility, username, bio, links FROM users WHERE id = $1', [id]);
    if (!u.rows.length) return res.status(404).json({ message: 'User not found.' });
    const user = u.rows[0];

    const rel = await db.query(`
        SELECT id, sender_id, status FROM friend_requests
        WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
        LIMIT 1
    `, [me, id]);
    let relation = 'none', request_id = null;
    if (id === me) relation = 'self';
    else if (blockedByMe) relation = 'blocked';
    else if (rel.rows.length) {
        const r = rel.rows[0];
        request_id = r.id;
        relation = r.status === 'accepted' ? 'friend' : (r.sender_id === me ? 'sent' : 'received');
    }

    // mutual friends: amar friend ar tar friend - duijon tei ache emon manush
    const mutual = await db.query(`
        WITH mine AS (
            SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS fid
            FROM friend_requests WHERE status = 'accepted' AND (sender_id = $1 OR receiver_id = $1)
        ), theirs AS (
            SELECT CASE WHEN sender_id = $2 THEN receiver_id ELSE sender_id END AS fid
            FROM friend_requests WHERE status = 'accepted' AND (sender_id = $2 OR receiver_id = $2)
        )
        SELECT DISTINCT u.id, u.name, u.avatar
        FROM users u JOIN mine ON mine.fid = u.id JOIN theirs ON theirs.fid = u.id
        ORDER BY u.name
    `, [me, id]);

    const close = relation === 'friend' || relation === 'self';
    res.status(200).json({
        user: {
            id: user.id,
            name: user.name,
            country: user.country,
            avatar: (user.avatar_visibility === 'friends' && !close) ? null : user.avatar,
            username: user.username, bio: user.bio || '', links: user.links || [],
            cover: user.cover,
            created_at: user.created_at,
            email: close ? user.email : null,
            last_seen_at: relation === 'friend' && !user.hide_last_seen ? user.last_seen_at : null,
            online: relation === 'friend' && !user.hide_online ? onlineUsers.has(user.id) : null
        },
        relation,
        request_id,
        mutual: id === me ? [] : mutual.rows
    });
}));

// ==========================================
// 5. MESSAGING ROUTES
// ==========================================
app.post('/api/messages/send', handle(async (req, res) => {
    const sender_id = req.userId;
    const group_id = parseInt(req.body.group_id, 10) || null;
    const receiver_id = group_id ? null : parseInt(req.body.receiver_id, 10);
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    let reply_to_id = parseInt(req.body.reply_to_id, 10) || null;
    const att = req.body.attachment
        ? (req.body.attachment.type === 'gif' ? cleanGif(req.body.attachment)
            : req.body.attachment.type === 'sticker' ? cleanSticker(req.body.attachment)
            : req.body.attachment.type === 'location' ? cleanLocation(req.body.attachment)
            : cleanAttachment(req.body.attachment, sender_id))
        : null;
    if (req.body.attachment && !att) return res.status(400).json({ message: 'Invalid file.' });
    // lekha othoba file - je kono ekta thaktei hobe
    if ((!receiver_id && !group_id) || (!message && !att) || message.length > 5000) return res.status(400).json({ message: 'Invalid message.' });

    let groupRow = null;
    let mentions = null;
    if (group_id) {
        // group: member hote hobe; "shudhu admin message dite parbe" setting thakle admin
        const g = await groupAccess(group_id, sender_id);
        groupRow = g;
        if (!g) return res.status(403).json({ message: 'You are not a member of this group.' });
        if (g.send_permission === 'admins' && g.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can send messages in this group.' });
        }
    } else if (!(await isFriend(sender_id, receiver_id))) {
        // shudhu friend ke message pathano jabe
        return res.status(403).json({ message: 'You can only message your friends.' });
    }

    // @Mention: shudhu ei group er member der (nijeke na)
    if (group_id && Array.isArray(req.body.mention_ids) && req.body.mention_ids.length) {
        const memberIds = await groupMemberIds(group_id);
        const ids = [...new Set(req.body.mention_ids.map(Number))].filter(id => id !== sender_id && memberIds.includes(id));
        if (ids.length) mentions = ids.slice(0, 50);
    }

    // reply: je message e reply, seta eki conversation er hote hobe
    if (reply_to_id) {
        const check = group_id
            ? await db.query('SELECT 1 FROM messages WHERE id = $1 AND group_id = $2', [reply_to_id, group_id])
            : await db.query(`
                SELECT 1 FROM messages WHERE id = $1
                  AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2))
            `, [reply_to_id, sender_id, receiver_id]);
        if (!check.rows.length) reply_to_id = null;
    }

    const { rows } = await db.query(`
        INSERT INTO messages (sender_id, receiver_id, group_id, message, reply_to_id,
            attachment_url, attachment_type, attachment_name, attachment_size,
            attachment_mime, attachment_public_id, attachment_duration, mentions, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id
    `, [sender_id, receiver_id, group_id, message, reply_to_id,
        att && att.url, att && att.type, att && att.name, att && att.size,
        att && att.mime, att && att.publicId, att && att.duration, mentions,
        await expiryFor(group_id ? 'g' : 'u', group_id || receiver_id, sender_id)]);

    if (group_id) {
        await db.query('UPDATE group_members SET last_read_id = $1 WHERE group_id = $2 AND user_id = $3', [rows[0].id, group_id, sender_id]);
        emitMany(await groupMemberIds(group_id), 'group:message', { group_id, id: rows[0].id, sender_id, mentions: mentions || [] });
    } else {
        const payload = { id: rows[0].id, sender_id, receiver_id };
        emitToUser(receiver_id, 'message:new', payload);     // jar kache gelo
        emitToUser(sender_id, 'message:new', payload);       // nijer onno tab
    }
    res.status(200).json({ ok: true, message: 'Message sent!' });

    // ---- Push (response pathanor por, tai deri hoy na) ----
    try {
        const me = (await db.query('SELECT name FROM users WHERE id = $1', [sender_id])).rows[0];
        const name = me ? me.name : 'Someone';
        const text = previewText(message, att && att.type, att && att.name);
        if (group_id) {
            // mute na kora member ra; mention kora hole mute holeo pabe
            const { rows: mem } = await db.query('SELECT user_id, muted FROM group_members WHERE group_id = $1 AND user_id <> $2', [group_id, sender_id]);
            const mentioned = mentions || [];
            const normal = mem.filter(m => !m.muted && !mentioned.includes(m.user_id)).map(m => m.user_id);
            sendPush(normal, { title: '👥 ' + groupRow.name, body: name.split(' ')[0] + ': ' + text, tag: 'group-' + group_id, url: '/dashboard.html' });
            if (mentioned.length) sendPush(mentioned, { title: '@ ' + name + ' mentioned you', body: groupRow.name + ': ' + text, tag: 'mention-' + group_id, url: '/dashboard.html' });
        } else if (!(await isDmMuted(receiver_id, sender_id))) {
            sendPush([receiver_id], { title: name, body: text, tag: 'dm-' + sender_id, url: '/dashboard.html' });
        }
    } catch (e) { console.error('push failed:', e.message); }
}));

// NOTE: eta '/api/messages/:user1/:user2' er AGE thakte hobe
app.get('/api/messages/unread/:userId', handle(async (req, res) => {
    if (!sameUser(req, res, req.params.userId)) return;
    // COUNT(*) postgres e "bigint" (lekha hisebe ase), tai ::int diye number banai
    const { rows } = await db.query(`
        SELECT m.sender_id, c.cnt AS count, m.id AS last_id,
               CASE WHEN m.message <> '' THEN m.message
                    WHEN m.attachment_type = 'image' THEN '📷 Photo'
                    WHEN m.attachment_type = 'video' THEN '🎬 Video'
                    WHEN m.attachment_type = 'audio' AND m.attachment_name LIKE 'voice-%' THEN '🎤 Voice message'
                    WHEN m.attachment_type = 'audio' THEN '🎵 Audio'
                    WHEN m.attachment_type = 'file' THEN '📎 ' || m.attachment_name
                    WHEN m.attachment_type = 'gif' THEN '🎞️ GIF'
                    WHEN m.attachment_type = 'sticker' THEN '🧸 Sticker'
                    WHEN m.attachment_type = 'location' THEN '📍 Location'
                    ELSE '' END AS last_message
        FROM messages m
        JOIN (
            SELECT sender_id, COUNT(*)::int AS cnt, MAX(id) AS mx
            FROM messages
            WHERE receiver_id = $1 AND is_read = FALSE AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
            GROUP BY sender_id
        ) c ON m.id = c.mx
    `, [req.userId]);
    res.status(200).json({ unread: rows });
}));

// ==========================================
// Message Pagination: ekbare sob na, 50 ta kore
//   ?limit=50        -> shesh 50 ta (chat khulle)
//   ?before=ID       -> ID er ager 50 ta (upore scroll korle)
//   ?from=ID         -> ID theke shesh porjonto (refresh: ja already load kora ache tar notun obostha)
// ==========================================
const PAGE_SIZE = 50;

async function fetchConversation(convoSql, convoParams, userId, q) {
    const params = [...convoParams];
    const p = (v) => { params.push(v); return '$' + params.length; };
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || PAGE_SIZE, 1), 100);
    const before = parseInt(q.before, 10) || null;
    const from = parseInt(q.from, 10) || null;

    let extra = '', order = 'DESC', lim = '';
    if (from) { extra = ' AND m.id >= ' + p(from); order = 'ASC'; lim = ' LIMIT 3000'; }
    else {
        if (before) extra = ' AND m.id < ' + p(before);
        lim = ' LIMIT ' + p(limit + 1);                 // ekta beshi ani: thakle bujhbo aro ache
    }
    const hiddenFor = p(userId);

    // "Delete for me" kora message bad + reply hole mul message er choto preview
    let { rows } = await db.query(`
        SELECT m.*, su.name AS sender_name, su.avatar AS sender_avatar,
               r.message    AS reply_message,
               r.sender_id  AS reply_sender_id,
               r.deleted_at AS reply_deleted_at,
               r.attachment_type AS reply_attachment_type,
               r.attachment_name AS reply_attachment_name,
               ru.name AS reply_sender_name,
               (sv.message_id IS NOT NULL) AS saved
        FROM messages m
        JOIN users su ON su.id = m.sender_id
        LEFT JOIN message_hidden h ON h.message_id = m.id AND h.user_id = ${hiddenFor}
        LEFT JOIN saved_messages sv ON sv.message_id = m.id AND sv.user_id = ${hiddenFor}
        LEFT JOIN messages r ON r.id = m.reply_to_id
        LEFT JOIN users ru ON ru.id = r.sender_id
        WHERE (${convoSql}) AND h.message_id IS NULL AND (m.expires_at IS NULL OR m.expires_at > NOW()) ${extra}
        ORDER BY m.id ${order}${lim}
    `, params);

    let has_more = false;
    if (!from) {
        has_more = rows.length > limit;
        rows = rows.slice(0, limit).reverse();          // purono -> notun kromey
    }

    // ei message gulor sob reaction ek query te ene protita message e jure dao
    if (rows.length) {
        const { rows: reactions } = await db.query(
            'SELECT message_id, user_id, reaction FROM message_reactions WHERE message_id = ANY($1::int[])',
            [rows.map(m => m.id)]
        );
        const byMsg = {};
        reactions.forEach(r => { (byMsg[r.message_id] = byMsg[r.message_id] || []).push({ user_id: r.user_id, reaction: r.reaction }); });
        rows.forEach(m => { m.reactions = byMsg[m.id] || []; });
        await attachPolls(rows, userId);
    }

    // pin kora message alada kore (purono message load na thakleo pinned bar e dekhabe)
    const { rows: pinned } = await db.query(`
        SELECT m.id, m.message, m.attachment_type, m.attachment_name, m.pinned_at, m.sender_id
        FROM messages m
        WHERE (${convoSql}) AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
        ORDER BY m.pinned_at DESC LIMIT 20
    `, convoParams);

    return { messages: rows, has_more, pinned };
}

// Message Search: puro history te khoje (shudhu load kora gulo na), mil thaka message er id ferot dey
app.get('/api/messages/search', handle(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.status(200).json({ ids: [] });
    let convoSql, params;
    if (req.query.group) {
        const gid = parseInt(req.query.group, 10);
        if (!gid || !(await groupAccess(gid, req.userId))) return res.status(404).json({ message: 'Group not found.' });
        convoSql = 'm.group_id = $1';
        params = [gid];
    } else {
        const other = parseInt(req.query.user, 10);
        if (!other) return res.status(400).json({ message: 'Invalid chat.' });
        convoSql = '(m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)';
        params = [req.userId, other];
    }
    // % ar _ LIKE e bishesh okkhor, tai escape
    params.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
    const like = '$' + params.length;
    params.push(req.userId);
    const me = '$' + params.length;
    const { rows } = await db.query(`
        SELECT m.id FROM messages m
        LEFT JOIN message_hidden h ON h.message_id = m.id AND h.user_id = ${me}
        WHERE (${convoSql}) AND h.message_id IS NULL AND m.deleted_at IS NULL
          AND m.is_system = FALSE AND m.message ILIKE ${like} AND (m.expires_at IS NULL OR m.expires_at > NOW())
        ORDER BY m.id ASC LIMIT 500
    `, params);
    res.status(200).json({ ids: rows.map(r => r.id) });
}));

app.get('/api/messages/:user1/:user2', handle(async (req, res) => {
    const { user1, user2 } = req.params;
    if (!sameUser(req, res, user1)) return;
    const other = parseInt(user2, 10);
    if (!other) return res.status(400).json({ message: 'Invalid user.' });
    const data = await fetchConversation('(m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)', [req.userId, other], req.userId, req.query);
    // duijoner keu "Read receipts" bondho korle ✓✓ dekhabe na (WhatsApp er moto)
    const rr = (await db.query('SELECT id, read_receipts FROM users WHERE id = ANY($1::int[])', [[req.userId, other]])).rows;
    if (rr.some(r => !r.read_receipts)) data.messages.forEach(m => { if (m.sender_id === req.userId) m.is_read = false; });
    await hideAvatars(data.messages, req.userId);
    res.status(200).json(data);
}));

/*for avatar and profile photo*/
app.post('/api/users/avatar', handle(async (req, res) => {
    const { avatar } = req.body;
    if (avatar) {
        const valid = typeof avatar === 'string' && avatar.length <= 400000 &&
            /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(avatar);
        if (!valid) return res.status(400).json({ message: 'Invalid image. Please choose another photo.' });
    }
    await db.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar || null, req.userId]);
    res.status(200).json({ message: 'Photo updated!', avatar: avatar || null });
}));

/*for unseen / seen messages*/
// chat khulle / message dekhle "seen" kore dao
app.post('/api/messages/mark-read', handle(async (req, res) => {
    const friend_id = parseInt(req.body.friend_id, 10);
    if (!friend_id) return res.status(400).json({ message: 'friend_id is required' });
    await db.query(
        'UPDATE messages SET is_read = TRUE WHERE receiver_id = $1 AND sender_id = $2 AND is_read = FALSE',
        [req.userId, friend_id]
    );
    // "Read receipts" bondho thakle opor pash ✓✓ pabe na
    const me = (await db.query('SELECT read_receipts FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me || me.read_receipts) emitToUser(friend_id, 'messages:read', { reader_id: req.userId });   // sender er ✓✓
    res.status(200).json({ message: 'Marked as read' });
}));

// ==========================================
// 5b. UNSEND / DELETE FOR ME / EDIT / FORWARD
// ==========================================

// Unsend: shudhu nijer pathano message, sobar jonno
app.post('/api/messages/unsend', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    if (!message_id) return res.status(400).json({ message: 'message_id is required' });

    const m = await messageAccess(message_id, req.userId);
    if (!m || m.sender_id !== req.userId || m.is_system) return res.status(404).json({ message: 'Message not found.' });

    // lekha + file muche felo, row ta rakho (soft delete)
    await db.query(`
        UPDATE messages SET message = '', deleted_at = NOW(), pinned_at = NULL, pinned_by = NULL,
            attachment_url = NULL, attachment_type = NULL, attachment_name = NULL, attachment_size = NULL,
            attachment_mime = NULL, attachment_public_id = NULL, attachment_duration = NULL
        WHERE id = $1
    `, [message_id]);
    await db.query('DELETE FROM message_reactions WHERE message_id = $1', [message_id]);

    // file ta forward kore onno kotha-o thakte pare - shudhu keu ar na use korle Cloudinary theke muchbo
    if (m.attachment_public_id) {
        const still = await db.query('SELECT 1 FROM messages WHERE attachment_public_id = $1 LIMIT 1', [m.attachment_public_id]);
        if (!still.rows.length) cloudDestroy(m.attachment_public_id, m.attachment_type);
    }

    emitMany(m.audience, 'message:changed', { id: message_id, group_id: m.group_id });
    res.status(200).json({ ok: true, message: 'Message unsent.' });
}));

// Delete for me: shudhu nijer screen theke lukano
app.post('/api/messages/delete-for-me', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    if (!message_id) return res.status(400).json({ message: 'message_id is required' });

    // shudhu je message dekhte pari setai lukano jabe. Age theke thakle kichu korbe na
    const m = await messageAccess(message_id, req.userId, true);
    if (!m) return res.status(404).json({ message: 'Message not found.' });
    await db.query(
        'INSERT INTO message_hidden (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.userId, message_id]
    );
    emitToUser(req.userId, 'message:changed', { id: message_id, group_id: m.group_id });   // nijer onno tab
    res.status(200).json({ ok: true, message: 'Deleted for you.' });
}));

// Edit: shudhu nijer pathano, unsend na kora message
app.post('/api/messages/edit', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message_id || !message || message.length > 5000) return res.status(400).json({ message: 'Invalid message.' });

    const m = await messageAccess(message_id, req.userId);
    if (!m || m.sender_id !== req.userId || m.is_system) return res.status(404).json({ message: 'Message not found.' });
    await db.query('UPDATE messages SET message = $1, edited_at = NOW() WHERE id = $2', [message, message_id]);

    emitMany(m.audience, 'message:changed', { id: message_id, group_id: m.group_id });
    res.status(200).json({ ok: true, message: 'Message edited.' });
}));

// Forward: ek message ek sathe koyekjon friend ke
app.post('/api/messages/forward', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    const ids = Array.isArray(req.body.friend_ids) ? req.body.friend_ids.map(Number).filter(Boolean) : [];
    if (!message_id || !ids.length || ids.length > 20) return res.status(400).json({ message: 'Choose 1 to 20 friends.' });

    // je message forward korbo seta ami dekhte pari (DM ba amar group), ar unsend kora na
    const m = await messageAccess(message_id, req.userId);
    if (!m || m.is_system) return res.status(404).json({ message: 'Message not found.' });

    // shudhu ashol friend der kache jabe
    const friendIds = await friendIdsOf(req.userId);
    const targets = [...new Set(ids)].filter(id => friendIds.includes(id));
    if (!targets.length) return res.status(403).json({ message: 'You can only forward to your friends.' });

    // unnest = list er protita id er jonno ekta kore row (ek query te sob). File thakle seta-o copy
    await db.query(`
        INSERT INTO messages (sender_id, receiver_id, message, is_forwarded,
            attachment_url, attachment_type, attachment_name, attachment_size,
            attachment_mime, attachment_public_id, attachment_duration)
        SELECT $1::int, t.id, m.message, TRUE,
            m.attachment_url, m.attachment_type, m.attachment_name, m.attachment_size,
            m.attachment_mime, m.attachment_public_id, m.attachment_duration
        FROM messages m, unnest($2::int[]) AS t(id)
        WHERE m.id = $3
    `, [req.userId, targets, message_id]);

    targets.forEach(id => emitToUser(id, 'message:new', { sender_id: req.userId, receiver_id: id }));
    emitToUser(req.userId, 'message:new', {});
    res.status(200).json({ ok: true, count: targets.length, message: 'Forwarded.' });
}));

// ==========================================
// 5d. FILE UPLOAD: Cloudinary signature
// ==========================================
app.post('/api/upload/sign', handle(async (req, res) => {
    if (!cloudReady) return res.status(503).json({ message: 'File upload is not set up on the server yet.' });
    const kind = req.body.kind;
    const size = Number(req.body.size) || 0;
    const name = String(req.body.name || 'file');
    if (!UPLOAD_LIMIT_MB[kind]) return res.status(400).json({ message: 'Unknown file type.' });
    if (!size || size > UPLOAD_LIMIT_MB[kind] * 1024 * 1024) {
        return res.status(413).json({ message: `File is too large. Max ${UPLOAD_LIMIT_MB[kind]} MB.` });
    }

    // protita user er alada "folder" (public_id er shurute), nam e random ongsho,
    // tai keu onner file er nam anuman korte parbe na
    const extMatch = name.match(/\.([a-z0-9]{1,8})$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    const base = name.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'file';
    // PDF/Word (raw) e extension nam er moddhei rakhte hoy, nahole download e file er dhoron hariye jay
    const public_id = `talkfav/${req.userId}/` + crypto.randomBytes(6).toString('hex') + '_' + base +
        (kind === 'file' && ext ? '.' + ext : '');
    const timestamp = Math.floor(Date.now() / 1000);

    // browser ei "fields" gulo hubohu file er sathe Cloudinary te pathabe
    res.status(200).json({
        ok: true,
        uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD.name}/${CLOUD_RESOURCE[kind]}/upload`,
        fields: {
            api_key: CLOUD.key,
            timestamp: String(timestamp),
            public_id,
            signature: cloudSign({ public_id, timestamp })
        }
    });
}));

// ==========================================
// 5e. COVER PHOTO
// ==========================================
app.post('/api/users/cover', handle(async (req, res) => {
    const old = await db.query('SELECT cover_public_id FROM users WHERE id = $1', [req.userId]);
    const oldId = old.rows.length ? old.rows[0].cover_public_id : null;

    // khali pathale cover muche jay
    if (!req.body.url) {
        await db.query('UPDATE users SET cover = NULL, cover_public_id = NULL WHERE id = $1', [req.userId]);
        if (oldId) cloudDestroy(oldId, 'image');
        return res.status(200).json({ ok: true, cover: null });
    }
    const att = cleanAttachment({ type: 'image', url: req.body.url, public_id: req.body.public_id }, req.userId);
    if (!att) return res.status(400).json({ message: 'Invalid image.' });
    await db.query('UPDATE users SET cover = $1, cover_public_id = $2 WHERE id = $3', [att.url, att.publicId, req.userId]);
    if (oldId && oldId !== att.publicId) cloudDestroy(oldId, 'image');      // purono cover Cloudinary theke muche felo
    res.status(200).json({ ok: true, cover: att.url });
}));

// ==========================================
// 5f. CALL HISTORY / MISSED CALLS
// ==========================================
app.get('/api/calls', handle(async (req, res) => {
    const { rows } = await db.query(`
        SELECT c.id, c.video, c.status, c.started_at, c.answered_at, c.ended_at,
               (c.caller_id = $1) AS outgoing,
               u.id AS peer_id, u.name AS peer_name, u.avatar AS peer_avatar
        FROM calls c
        JOIN users u ON u.id = CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END
        WHERE (c.caller_id = $1 OR c.callee_id = $1) AND c.status <> 'ringing'
        ORDER BY c.id DESC
        LIMIT 60
    `, [req.userId]);
    const missed = await db.query(
        "SELECT COUNT(*)::int AS n FROM calls WHERE callee_id = $1 AND status = 'missed' AND seen = FALSE",
        [req.userId]
    );
    res.status(200).json({ calls: rows, missed: missed.rows[0].n });
}));

// Calls tab khulle missed call gulo "dekha hoyeche"
app.post('/api/calls/seen', handle(async (req, res) => {
    await db.query('UPDATE calls SET seen = TRUE WHERE callee_id = $1 AND seen = FALSE', [req.userId]);
    res.status(200).json({ ok: true });
}));

// ==========================================
// 5g. TURN SERVER: mobile data / kothin network e call jure dite
// Tinti upay (je kono ekta .env e dilei hobe):
//   1) Metered username/password (sobcheye sohoj): METERED_USERNAME + METERED_PASSWORD
//   2) Metered API key:                            METERED_DOMAIN + METERED_API_KEY
//   3) Cloudflare (card lage):                     CF_TURN_KEY_ID + CF_TURN_API_TOKEN
// Gopon key server ei thake; browser pay shudhu TURN credential
// ==========================================
const METERED = {
    domain: process.env.METERED_DOMAIN, key: process.env.METERED_API_KEY,
    username: process.env.METERED_USERNAME, password: process.env.METERED_PASSWORD
};
const TURN = { keyId: process.env.CF_TURN_KEY_ID, token: process.env.CF_TURN_API_TOKEN };
const turnReady = !!((METERED.username && METERED.password) || (METERED.domain && METERED.key) || (TURN.keyId && TURN.token));
if (!turnReady) console.warn('WARNING: TURN er .env value nai (METERED_... ba CF_TURN_...), mobile data te call na-o jurte pare.');
const STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
let meteredCache = { servers: null, at: 0 };

// port 53 browser e block thake, tai bad (nahole connect hote deri hoy)
const cleanIce = (list) => list.filter(Boolean).map(sv => ({ ...sv, urls: [].concat(sv.urls).filter(u => !/:53(\?|$)/.test(u)) }));

async function fetchIceServers() {
    // Metered dashboard er username/password sorasori (kono API call lage na)
    if (METERED.username && METERED.password) {
        const auth = { username: METERED.username, credential: METERED.password };
        return [
            { urls: 'stun:stun.relay.metered.ca:80' },
            { urls: 'turn:global.relay.metered.ca:80', ...auth },
            { urls: 'turn:global.relay.metered.ca:80?transport=tcp', ...auth },
            { urls: 'turn:global.relay.metered.ca:443', ...auth },
            { urls: 'turns:global.relay.metered.ca:443?transport=tcp', ...auth }
        ];
    }
    if (METERED.domain && METERED.key) {
        // Metered er credential onekkhon thake, tai 1 ghonta cache
        if (meteredCache.servers && Date.now() - meteredCache.at < 60 * 60 * 1000) return meteredCache.servers;
        const host = METERED.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const r = await fetch(`https://${host}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED.key)}`);
        if (!r.ok) throw new Error('Metered TURN ' + r.status);
        const data = await r.json();
        if (!Array.isArray(data) || !data.length) throw new Error('Metered TURN: empty response');
        meteredCache = { servers: cleanIce(data), at: Date.now() };
        return meteredCache.servers;
    }
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${TURN.keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TURN.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 21600 })                        // 6 ghonta
    });
    if (!r.ok) throw new Error('Cloudflare TURN ' + r.status);
    const data = await r.json();
    return cleanIce(Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers]);
}

app.get('/api/ice-servers', handle(async (req, res) => {
    if (!turnReady) return res.status(200).json({ iceServers: STUN_ONLY, turn: false });
    try {
        res.status(200).json({ iceServers: await fetchIceServers(), turn: true });
    } catch (err) {
        console.error('TURN credential failed:', err.message);
        res.status(200).json({ iceServers: STUN_ONLY, turn: false });      // TURN na pele-o call cheshta korbe
    }
}));

// ==========================================
// 5h. LINK PREVIEW: link er chhobi, shironam, bibaron
// Browser onner site sorasori porte pare na (CORS), tai server ene dey.
// Nirapotta: shudhu http/https, private / local IP te jabo na (SSRF), 6 sec timeout, 600 KB porjonto
// ==========================================
const PREVIEW_TTL_DAYS = 7;
const previewRate = new Map();                     // userId -> { count, start } (minit e 30 bar)

// link ta ki nirapod public site? (localhost / ghorer router / server er bhitor na)
async function safePublicUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (u.port && !['80', '443'].includes(u.port)) return null;
    if (u.username || u.password) return null;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
    try {
        const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
        if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) return null;
    } catch (e) { return null; }
    return u;
}

function decodeEntities(str) {
    return String(str || '')
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
        .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; } })
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim();
}

// <meta property="og:title" content="..."> theke tottho
function parseMeta(html, pageUrl) {
    const head = html.slice(0, 300000);
    const meta = {};
    const tagRe = /<meta\b[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(head))) {
        const tag = m[0];
        const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
        const val = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
        if (key && val !== undefined && !meta[key.toLowerCase()]) meta[key.toLowerCase()] = val;
    }
    const titleTag = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const pick = (...keys) => { for (const k of keys) if (meta[k]) return decodeEntities(meta[k]); return ''; };

    let image = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image');
    if (image) {
        try {
            const abs = new URL(image, pageUrl);
            if (abs.protocol === 'http:') abs.protocol = 'https:';          // https page e http chhobi dekhay na
            image = abs.protocol === 'https:' ? abs.href : '';
        } catch (e) { image = ''; }
    }
    const title = pick('og:title', 'twitter:title') || decodeEntities(titleTag);
    const description = pick('og:description', 'twitter:description', 'description');
    const site = pick('og:site_name', 'application-name') || new URL(pageUrl).hostname.replace(/^www\./, '');
    if (!title && !description && !image) return null;
    return {
        url: pageUrl,
        title: title.slice(0, 200),
        description: description.slice(0, 300),
        image: image.slice(0, 1000),
        site: site.slice(0, 100)
    };
}

// page ana: redirect nijei mani (protita dhape abar nirapotta check), boro page er shudhu shurur ongsho
// YouTube bot der page dey na, tai tader oEmbed API theke shironam + thumbnail
function youtubeId(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const host = u.hostname.replace(/^www\.|^m\./, '');
        if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
        if (u.searchParams.get('v')) return u.searchParams.get('v');
        const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
        return m ? m[1] : null;
    } catch (e) { return null; }
}

async function youtubePreview(rawUrl) {
    const id = youtubeId(rawUrl);
    // oEmbed na pele-o (kichu server er IP YouTube atkay) video id theke thumbnail dekhai
    const fallback = id && /^[\w-]{6,20}$/.test(id) ? {
        url: rawUrl, title: 'YouTube video', description: '',
        image: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg', site: 'YouTube'
    } : null;
    try {
        const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(rawUrl), { signal: AbortSignal.timeout(6000) });
        if (!r.ok) return fallback;
        const d = await r.json();
        return {
            url: rawUrl,
            title: String(d.title || '').slice(0, 200),
            description: d.author_name ? 'by ' + String(d.author_name).slice(0, 100) : '',
            image: /^https:\/\//.test(d.thumbnail_url || '') ? d.thumbnail_url : '',
            site: 'YouTube'
        };
    } catch (e) { return fallback; }
}

async function fetchPreview(rawUrl) {
    try {
        const host = new URL(rawUrl).hostname.replace(/^www\.|^m\./, '');
        if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') return youtubePreview(rawUrl);
    } catch (e) { return null; }
    let current = rawUrl;
    for (let hop = 0; hop < 4; hop++) {
        const u = await safePublicUrl(current);
        if (!u) return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        let res;
        try {
            res = await fetch(u.href, {
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TalkFavBot/1.0; +https://talkfav-chat.onrender.com)',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en,bn;q=0.8'
                }
            });
        } catch (e) { clearTimeout(timer); return null; }

        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            clearTimeout(timer);
            current = new URL(res.headers.get('location'), u).href;
            continue;
        }
        if (!res.ok || !/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '')) { clearTimeout(timer); return null; }

        // 600 KB porjonto porhi (puro boro page na)
        const reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        try {
            while (size < 600000) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                size += value.length;
            }
        } catch (e) { /* timeout hole ja peyechi tai diye */ }
        clearTimeout(timer);
        try { reader.cancel(); } catch (e) {}
        const html = new TextDecoder('utf-8').decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
        return parseMeta(html, u.href);
    }
    return null;
}

app.get('/api/link-preview', handle(async (req, res) => {
    const raw = String(req.query.url || '').trim().slice(0, 2000);
    if (!/^https?:\/\//i.test(raw)) return res.status(400).json({ message: 'Invalid link.' });

    // cache e thakle sorasori (na paoa gulo-o 1 din mone rakhi)
    const cached = await db.query('SELECT data, fetched_at FROM link_previews WHERE url = $1', [raw]);
    if (cached.rows.length) {
        const row = cached.rows[0];
        const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / 86400000;
        // pawa gele 7 din, na pele 1 ghonta por abar cheshta
        if (ageDays < (row.data ? PREVIEW_TTL_DAYS : 1 / 24)) return res.status(200).json({ preview: row.data });
    }

    // ekjon minit e 30 tar beshi notun link ante parbe na
    const now = Date.now();
    const r = previewRate.get(req.userId) || { count: 0, start: now };
    if (now - r.start > 60000) { r.count = 0; r.start = now; }
    if (++r.count > 30) return res.status(429).json({ message: 'Too many previews. Try again in a minute.' });
    previewRate.set(req.userId, r);

    let preview = null;
    try { preview = await fetchPreview(raw); } catch (e) { preview = null; }
    await db.query(`
        INSERT INTO link_previews (url, data, fetched_at) VALUES ($1, $2, NOW())
        ON CONFLICT (url) DO UPDATE SET data = EXCLUDED.data, fetched_at = NOW()
    `, [raw, preview ? JSON.stringify(preview) : null]);
    res.status(200).json({ preview });
}));

// ==========================================
// 8. CONFIG (login er age-o lage): Google client id, push key
// ==========================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
if (!GOOGLE_CLIENT_ID) console.warn('WARNING: GOOGLE_CLIENT_ID nai, Google Login bondho.');

app.get('/api/config', (req, res) => {
    res.status(200).json({ googleClientId: GOOGLE_CLIENT_ID || null, vapidPublicKey: pushReady ? VAPID.pub : null, gifEnabled: gifReady, gifProvider: GIF_KEYS.tenor ? 'Tenor' : (GIF_KEYS.giphy ? 'GIPHY' : null) });
});

// ==========================================
// 9. GOOGLE LOGIN
// Browser Google theke ekta "ID token" pay; amra Google ke diyei seta jachai kori
// ==========================================
app.post('/api/auth/google', limitLoginIp, handle(async (req, res) => {
    if (!GOOGLE_CLIENT_ID) return res.status(503).json({ message: 'Google login is not set up yet.' });
    const credential = typeof req.body.credential === 'string' ? req.body.credential : '';
    const accessToken = typeof req.body.access_token === 'string' ? req.body.access_token : '';
    if (!credential && !accessToken) return res.status(400).json({ message: 'Google sign-in failed.' });
    const fail = () => res.status(401).json({ message: 'Google sign-in failed. Please try again.' });

    let info;
    if (accessToken) {
        // amader nijer design er button: Google "access token" dey.
        // Age dekhi token ta AMADER app er jonno deya kina (onner app er token chalano jabe na)
        const t = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken), { signal: AbortSignal.timeout(8000) });
        if (!t.ok) return fail();
        const ti = await t.json();
        if ((ti.aud !== GOOGLE_CLIENT_ID && ti.azp !== GOOGLE_CLIENT_ID) || !(Number(ti.expires_in) > 0)) return fail();
        // tarpor nam, email, chhobi
        const u = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(8000)
        });
        if (!u.ok) return fail();
        const ui = await u.json();
        if (!ui.sub || ui.sub !== ti.sub) return fail();
        info = { sub: ui.sub, email: ui.email, email_verified: ui.email_verified, name: ui.name, picture: ui.picture };
        if (String(info.email_verified) !== 'true' || !info.email) return fail();
    } else {
        // Google er official button: "ID token"
        const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return fail();
        info = await r.json();
        // token ta amader app er jonno, Google er deya, meyad ache, email jachai kora
        const okIssuer = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
        if (info.aud !== GOOGLE_CLIENT_ID || !okIssuer || Number(info.exp) * 1000 < Date.now() || String(info.email_verified) !== 'true' || !info.email) {
            return fail();
        }
    }
    const email = String(info.email).toLowerCase();
    const name = String(info.name || email.split('@')[0]).slice(0, 255);

    // age Google diye, ba eki email e account thakle sei account; nahole notun
    let { rows } = await db.query('SELECT * FROM users WHERE google_id = $1 OR LOWER(email) = $2 ORDER BY (google_id = $1) DESC LIMIT 1', [info.sub, email]);
    let user = rows[0];
    if (user && user.banned) return res.status(403).json({ message: 'This account has been suspended.' });
    if (user) {
        if (!user.google_id) await db.query('UPDATE users SET google_id = $1 WHERE id = $2', [info.sub, user.id]);
    } else {
        const randomPass = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);   // password diye login kora jabe na
        const ins = await db.query(
            'INSERT INTO users (name, email, phone, password, google_id, avatar, password_set) VALUES ($1, $2, $3, $4, $5, $6, FALSE) RETURNING *',
            [name, email, '', randomPass, info.sub, /^https:\/\//.test(info.picture || '') ? info.picture : null]
        );
        user = ins.rows[0];
        await assignUsername(user);
    }
    res.status(200).json(await loginResult(user, req));
}));

// ==========================================
// 10. PUSH SUBSCRIBE
// ==========================================
app.post('/api/push/subscribe', handle(async (req, res) => {
    const sub = req.body.subscription || {};
    const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
    const keys = sub.keys || {};
    if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth || endpoint.length > 1000) {
        return res.status(400).json({ message: 'Invalid subscription.' });
    }
    await db.query(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
        ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
    `, [req.userId, endpoint, String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 100)]);
    res.status(200).json({ ok: true });
}));

app.post('/api/push/unsubscribe', handle(async (req, res) => {
    const endpoint = typeof req.body.endpoint === 'string' ? req.body.endpoint : '';
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.userId]);
    res.status(200).json({ ok: true });
}));

// ==========================================
// 11. POLL (group e vote)
// ==========================================
async function attachPolls(messages, userId) {
    const ids = messages.map(m => m.id);
    if (!ids.length) return;
    const { rows: polls } = await db.query('SELECT * FROM polls WHERE message_id = ANY($1::int[])', [ids]);
    if (!polls.length) return;
    const { rows: votes } = await db.query('SELECT poll_id, user_id, option_index FROM poll_votes WHERE poll_id = ANY($1::int[])', [polls.map(p => p.id)]);
    const byMsg = {};
    polls.forEach(p => {
        const pv = votes.filter(v => v.poll_id === p.id);
        const counts = p.options.map((_, i) => pv.filter(v => v.option_index === i).length);
        byMsg[p.message_id] = {
            id: p.id, question: p.question, options: p.options, multiple: p.multiple, closed: p.closed,
            created_by: p.created_by, counts,
            voters: new Set(pv.map(v => v.user_id)).size,
            mine: pv.filter(v => v.user_id === userId).map(v => v.option_index)
        };
    });
    messages.forEach(m => { if (byMsg[m.id]) m.poll = byMsg[m.id]; });
}

async function pollWithAccess(pollId, userId) {
    const { rows } = await db.query('SELECT p.*, m.group_id, m.deleted_at FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.id = $1', [pollId]);
    const p = rows[0];
    if (!p || p.deleted_at) return null;
    const g = await groupAccess(p.group_id, userId);
    if (!g) return null;
    p.myRole = g.role;
    return p;
}

app.post('/api/polls', handle(async (req, res) => {
    const group_id = parseInt(req.body.group_id, 10);
    const question = typeof req.body.question === 'string' ? req.body.question.trim().slice(0, 300) : '';
    const options = (Array.isArray(req.body.options) ? req.body.options : [])
        .map(o => String(o || '').trim().slice(0, 100)).filter(Boolean);
    const unique = [...new Set(options)];
    if (!group_id || !question || unique.length < 2 || unique.length > 10) {
        return res.status(400).json({ message: 'A poll needs a question and 2 to 10 different options.' });
    }
    const g = await groupAccess(group_id, req.userId);
    if (!g) return res.status(403).json({ message: 'You are not a member of this group.' });
    if (g.send_permission === 'admins' && g.role !== 'admin') return res.status(403).json({ message: 'Only admins can send messages in this group.' });

    const { rows } = await db.query(
        'INSERT INTO messages (sender_id, group_id, message, expires_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [req.userId, group_id, '📊 ' + question, await expiryFor('g', group_id, req.userId)]
    );
    await db.query(
        'INSERT INTO polls (message_id, question, options, multiple, created_by) VALUES ($1, $2, $3, $4, $5)',
        [rows[0].id, question, JSON.stringify(unique), !!req.body.multiple, req.userId]
    );
    await db.query('UPDATE group_members SET last_read_id = $1 WHERE group_id = $2 AND user_id = $3', [rows[0].id, group_id, req.userId]);
    emitMany(await groupMemberIds(group_id), 'group:message', { group_id, id: rows[0].id, sender_id: req.userId, mentions: [] });
    res.status(200).json({ ok: true });
}));

// vote: amar ager vote bodle notun ta (ekta na onek, poll er setting onujayi). Khali dile vote tule nay
app.post('/api/polls/:id/vote', handle(async (req, res) => {
    const p = await pollWithAccess(parseInt(req.params.id, 10), req.userId);
    if (!p) return res.status(404).json({ message: 'Poll not found.' });
    if (p.closed) return res.status(400).json({ message: 'This poll is closed.' });
    let choice = (Array.isArray(req.body.options) ? req.body.options : []).map(Number)
        .filter(i => Number.isInteger(i) && i >= 0 && i < p.options.length);
    choice = [...new Set(choice)];
    if (!p.multiple) choice = choice.slice(0, 1);
    await db.query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [p.id, req.userId]);
    if (choice.length) {
        await db.query('INSERT INTO poll_votes (poll_id, user_id, option_index) SELECT $1, $2, unnest($3::int[])', [p.id, req.userId, choice]);
    }
    emitMany(await groupMemberIds(p.group_id), 'message:changed', { id: p.message_id, group_id: p.group_id });
    res.status(200).json({ ok: true });
}));

app.post('/api/polls/:id/close', handle(async (req, res) => {
    const p = await pollWithAccess(parseInt(req.params.id, 10), req.userId);
    if (!p) return res.status(404).json({ message: 'Poll not found.' });
    if (p.created_by !== req.userId && p.myRole !== 'admin') return res.status(403).json({ message: 'Only the poll creator or an admin can close it.' });
    await db.query('UPDATE polls SET closed = TRUE WHERE id = $1', [p.id]);
    emitMany(await groupMemberIds(p.group_id), 'message:changed', { id: p.message_id, group_id: p.group_id });
    res.status(200).json({ ok: true });
}));

// ==========================================
// 12. SAVED MESSAGES (star)
// ==========================================
app.post('/api/messages/save', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    const m = message_id && await messageAccess(message_id, req.userId);
    if (!m || m.is_system) return res.status(404).json({ message: 'Message not found.' });
    if (req.body.save === false) await db.query('DELETE FROM saved_messages WHERE user_id = $1 AND message_id = $2', [req.userId, message_id]);
    else await db.query('INSERT INTO saved_messages (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, message_id]);
    emitToUser(req.userId, 'message:changed', { id: message_id, group_id: m.group_id });
    res.status(200).json({ ok: true });
}));

app.get('/api/messages/saved', handle(async (req, res) => {
    // shudhu ekhono dekhte pari emon (group theke ber hoye gele sei group er gulo na)
    const { rows } = await db.query(`
        SELECT m.id, m.message, m.attachment_url, m.attachment_type, m.attachment_name, m.created_at,
               m.sender_id, su.name AS sender_name, su.avatar AS sender_avatar,
               m.group_id, g.name AS group_name, g.photo AS group_photo,
               CASE WHEN m.group_id IS NULL THEN (CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END) END AS peer_id,
               s.saved_at
        FROM saved_messages s
        JOIN messages m ON m.id = s.message_id
        JOIN users su ON su.id = m.sender_id
        LEFT JOIN chat_groups g ON g.id = m.group_id
        WHERE s.user_id = $1 AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > NOW())
          AND (m.group_id IS NULL OR EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = m.group_id AND gm.user_id = $1))
        ORDER BY s.saved_at DESC LIMIT 200
    `, [req.userId]);
    res.status(200).json({ saved: rows });
}));

// ==========================================
// 13. PIN / ARCHIVE / MUTE CHAT
// ==========================================
app.get('/api/chat-settings', handle(async (req, res) => {
    const { rows } = await db.query('SELECT chat_type, chat_id, pinned_at, archived, muted, wallpaper, favorite FROM chat_settings WHERE user_id = $1', [req.userId]);
    res.status(200).json({ settings: rows });
}));

app.post('/api/chat-settings', handle(async (req, res) => {
    const type = ['g', 'u', 'a'].includes(req.body.type) ? req.body.type : null;
    const id = type === 'a' ? 0 : parseInt(req.body.id, 10);
    if (!type || (type !== 'a' && !id)) return res.status(400).json({ message: 'Invalid chat.' });
    // nijer chat i hote hobe ('a' = sob chat er default wallpaper)
    if (type !== 'a' && (type === 'g' ? !(await groupAccess(id, req.userId)) : !(await isFriend(req.userId, id)))) {
        return res.status(404).json({ message: 'Chat not found.' });
    }
    // wallpaper: ready kora nam (preset) othoba nijer upload kora chhobi (Cloudinary)
    let wallpaperChange;
    if (req.body.wallpaper !== undefined) {
        const w = req.body.wallpaper;
        if (!w) wallpaperChange = null;
        else if (typeof w === 'string' && WALLPAPER_PRESETS.includes(w)) wallpaperChange = w;
        else if (w && typeof w === 'object' && cleanAttachment({ type: 'image', url: w.url, public_id: w.public_id }, req.userId)) wallpaperChange = w.url;
        else return res.status(400).json({ message: 'Invalid wallpaper.' });
    }
    const cur = (await db.query('SELECT * FROM chat_settings WHERE user_id = $1 AND chat_type = $2 AND chat_id = $3', [req.userId, type, id])).rows[0]
        || { pinned_at: null, archived: false, muted: false, wallpaper: null, favorite: false };
    const favorite = req.body.favorite === undefined ? cur.favorite : !!req.body.favorite;
    const wallpaper = wallpaperChange === undefined ? cur.wallpaper : wallpaperChange;
    let pinned_at = req.body.pinned === undefined ? cur.pinned_at : (req.body.pinned ? new Date() : null);
    let archived = req.body.archived === undefined ? cur.archived : !!req.body.archived;
    const muted = req.body.muted === undefined ? cur.muted : !!req.body.muted;
    if (req.body.archived === true) pinned_at = null;     // archive korle pin uthe jay
    if (pinned_at) archived = false;                       // pin korle archive theke ber hoy
    await db.query(`
        INSERT INTO chat_settings (user_id, chat_type, chat_id, pinned_at, archived, muted, wallpaper, favorite) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (user_id, chat_type, chat_id) DO UPDATE SET pinned_at = EXCLUDED.pinned_at, archived = EXCLUDED.archived,
            muted = EXCLUDED.muted, wallpaper = EXCLUDED.wallpaper, favorite = EXCLUDED.favorite
    `, [req.userId, type, id, pinned_at, archived, muted, wallpaper, favorite]);
    // group er mute group_members e-o (group notification er jonno)
    if (type === 'g' && req.body.muted !== undefined) {
        await db.query('UPDATE group_members SET muted = $1 WHERE group_id = $2 AND user_id = $3', [muted, id, req.userId]);
    }
    emitToUser(req.userId, 'chat-settings:changed', {});
    if (type === 'g') emitToUser(req.userId, 'groups:changed', { group_id: id });
    res.status(200).json({ ok: true });
}));

// ==========================================
// 14. PRIVACY SETTINGS
// ==========================================
// message e onner chhobi: "shudhu friend ra dekhbe" holeo friend na hole lukao
async function hideAvatars(messages, userId) {
    const others = [...new Set(messages.map(m => m.sender_id).filter(id => id !== userId))];
    if (!others.length) return;
    const { rows } = await db.query("SELECT id FROM users WHERE id = ANY($1::int[]) AND avatar_visibility = 'friends'", [others]);
    if (!rows.length) return;
    const friendIds = await friendIdsOf(userId);
    const hide = rows.map(r => r.id).filter(id => !friendIds.includes(id));
    messages.forEach(m => { if (hide.includes(m.sender_id)) m.sender_avatar = null; });
}

app.get('/api/users/privacy', handle(async (req, res) => {
    const { rows } = await db.query('SELECT hide_online, hide_last_seen, avatar_visibility, read_receipts FROM users WHERE id = $1', [req.userId]);
    res.status(200).json({ privacy: rows[0] });
}));

app.post('/api/users/privacy', handle(async (req, res) => {
    const cur = (await db.query('SELECT hide_online, hide_last_seen, avatar_visibility, read_receipts FROM users WHERE id = $1', [req.userId])).rows[0];
    const b = req.body;
    const next = {
        hide_online: typeof b.hide_online === 'boolean' ? b.hide_online : cur.hide_online,
        hide_last_seen: typeof b.hide_last_seen === 'boolean' ? b.hide_last_seen : cur.hide_last_seen,
        avatar_visibility: ['everyone', 'friends'].includes(b.avatar_visibility) ? b.avatar_visibility : cur.avatar_visibility,
        read_receipts: typeof b.read_receipts === 'boolean' ? b.read_receipts : cur.read_receipts
    };
    await db.query(
        'UPDATE users SET hide_online = $1, hide_last_seen = $2, avatar_visibility = $3, read_receipts = $4 WHERE id = $5',
        [next.hide_online, next.hide_last_seen, next.avatar_visibility, next.read_receipts, req.userId]
    );
    // online lukano bodlale friend der shathe shathe janai
    if (next.hide_online !== cur.hide_online) {
        const friendIds = await friendIdsOf(req.userId);
        const online = !next.hide_online && onlineUsers.has(req.userId);
        friendIds.forEach(id => emitToUser(id, 'presence', { user_id: req.userId, online }));
    }
    res.status(200).json({ ok: true, privacy: next });
}));

// ==========================================
// 15. GROUP "SEEN BY"
// ==========================================
app.get('/api/groups/:id/messages/:mid/seen', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const mid = parseInt(req.params.mid, 10);
    if (!id || !mid || !(await groupAccess(id, req.userId))) return res.status(404).json({ message: 'Group not found.' });
    const msg = (await db.query('SELECT sender_id FROM messages WHERE id = $1 AND group_id = $2', [mid, id])).rows[0];
    if (!msg) return res.status(404).json({ message: 'Message not found.' });
    const { rows } = await db.query(`
        SELECT u.id, u.name, u.avatar, gm.last_read_id >= $2 AS seen
        FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1 AND gm.user_id <> $3 AND u.read_receipts
        ORDER BY seen DESC, u.name
    `, [id, mid, msg.sender_id]);
    res.status(200).json({ seen: rows.filter(r => r.seen), not_seen: rows.filter(r => !r.seen) });
}));

// ==========================================
// 16. STATUS / STORY (24 ghonta, shudhu friend ra dekhe)
// ==========================================
const STATUS_BGS = ['#7c5cff', '#2f7bff', '#ec1fc8', '#16a34a', '#f59e0b', '#ef4444', '#0f172a', '#0ea5e9'];

app.get('/api/statuses', handle(async (req, res) => {
    const friendIds = await friendIdsOf(req.userId);
    const { rows } = await db.query(`
        SELECT s.id, s.user_id, s.type, s.text, s.bg, s.media_url, s.created_at, s.expires_at,
               u.name, u.avatar, (v.viewer_id IS NOT NULL) AS viewed,
               CASE WHEN s.user_id = $1 THEN (SELECT COUNT(*)::int FROM status_views x WHERE x.status_id = s.id) END AS view_count
        FROM statuses s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN status_views v ON v.status_id = s.id AND v.viewer_id = $1
        WHERE s.expires_at > NOW() AND (s.user_id = $1 OR s.user_id = ANY($2::int[]))
        ORDER BY s.created_at ASC
    `, [req.userId, friendIds]);
    // manush onujayi sajano: ami agey, tarpor na dekha gulo, tarpor notun gulo
    const byUser = new Map();
    rows.forEach(r => {
        if (!byUser.has(r.user_id)) byUser.set(r.user_id, { user: { id: r.user_id, name: r.name, avatar: r.avatar }, statuses: [] });
        byUser.get(r.user_id).statuses.push({
            id: r.id, type: r.type, text: r.text, bg: r.bg, media_url: r.media_url,
            created_at: r.created_at, expires_at: r.expires_at, viewed: r.viewed, view_count: r.view_count
        });
    });
    const groupsList = [...byUser.values()].map(g => ({ ...g, all_viewed: g.statuses.every(x => x.viewed), latest: g.statuses[g.statuses.length - 1].created_at }));
    groupsList.sort((a, b) => (b.user.id === req.userId) - (a.user.id === req.userId) || (a.all_viewed - b.all_viewed) || (new Date(b.latest) - new Date(a.latest)));
    res.status(200).json({ statuses: groupsList });
}));

app.post('/api/statuses', handle(async (req, res) => {
    const type = ['text', 'image', 'video'].includes(req.body.type) ? req.body.type : null;
    if (!type) return res.status(400).json({ message: 'Invalid status.' });
    const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 700) : '';
    let bg = null, media = null;
    if (type === 'text') {
        if (!text) return res.status(400).json({ message: 'Write something for your status.' });
        bg = STATUS_BGS.includes(req.body.bg) ? req.body.bg : STATUS_BGS[0];
    } else {
        media = cleanAttachment({ type, url: req.body.url, public_id: req.body.public_id }, req.userId);
        if (!media) return res.status(400).json({ message: 'Invalid photo or video.' });
    }
    // ekdine 30 tar beshi na
    const count = (await db.query('SELECT COUNT(*)::int AS n FROM statuses WHERE user_id = $1 AND expires_at > NOW()', [req.userId])).rows[0].n;
    if (count >= 30) return res.status(429).json({ message: 'You can have at most 30 active statuses.' });
    await db.query(
        'INSERT INTO statuses (user_id, type, text, bg, media_url, media_public_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.userId, type, text || null, bg, media && media.url, media && media.publicId]
    );
    emitMany([req.userId, ...(await friendIdsOf(req.userId))], 'statuses:changed', { user_id: req.userId });
    res.status(200).json({ ok: true });
}));

app.post('/api/statuses/:id/view', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const st = (await db.query('SELECT user_id FROM statuses WHERE id = $1 AND expires_at > NOW()', [id])).rows[0];
    if (!st) return res.status(404).json({ message: 'Status not found.' });
    if (st.user_id === req.userId) return res.status(200).json({ ok: true });
    if (!(await isFriend(st.user_id, req.userId))) return res.status(404).json({ message: 'Status not found.' });
    const r = await db.query('INSERT INTO status_views (status_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, req.userId]);
    if (r.rowCount) emitToUser(st.user_id, 'statuses:viewed', { status_id: id });
    res.status(200).json({ ok: true });
}));

app.get('/api/statuses/:id/viewers', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const st = (await db.query('SELECT user_id FROM statuses WHERE id = $1', [id])).rows[0];
    if (!st || st.user_id !== req.userId) return res.status(404).json({ message: 'Status not found.' });
    const { rows } = await db.query(`
        SELECT u.id, u.name, u.avatar, v.viewed_at FROM status_views v JOIN users u ON u.id = v.viewer_id
        WHERE v.status_id = $1 ORDER BY v.viewed_at DESC
    `, [id]);
    res.status(200).json({ viewers: rows });
}));

app.post('/api/statuses/:id/delete', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query('DELETE FROM statuses WHERE id = $1 AND user_id = $2 RETURNING media_public_id, type', [id, req.userId]);
    if (!rows.length) return res.status(404).json({ message: 'Status not found.' });
    if (rows[0].media_public_id) cloudDestroy(rows[0].media_public_id, rows[0].type);
    emitMany([req.userId, ...(await friendIdsOf(req.userId))], 'statuses:changed', { user_id: req.userId });
    res.status(200).json({ ok: true });
}));

// meyad shesh status proti ghontay muche felo (Cloudinary theke-o)
async function cleanupStatuses() {
    try {
        const { rows } = await db.query('DELETE FROM statuses WHERE expires_at <= NOW() RETURNING media_public_id, type');
        rows.forEach(r => { if (r.media_public_id) cloudDestroy(r.media_public_id, r.type); });
    } catch (e) { console.error('status cleanup failed:', e.message); }
}
setInterval(cleanupStatuses, 60 * 60 * 1000);

// ==========================================
// 17. DISAPPEARING MESSAGES
// ==========================================
const TIMER_OPTIONS = [0, 3600, 86400, 604800, 7776000];          // off, 1 ghonta, 24 ghonta, 7 din, 90 din

async function chatTimer(type, id, userId) {
    if (type === 'g') {
        const r = await db.query('SELECT disappear_seconds FROM chat_groups WHERE id = $1', [id]);
        return r.rows[0] ? r.rows[0].disappear_seconds : 0;
    }
    const [a, b] = [Math.min(id, userId), Math.max(id, userId)];
    const r = await db.query('SELECT disappear_seconds FROM dm_settings WHERE user_a = $1 AND user_b = $2', [a, b]);
    return r.rows[0] ? r.rows[0].disappear_seconds : 0;
}

// notun message kokhon muchbe (timer bondho hole null)
async function expiryFor(type, id, userId) {
    const sec = await chatTimer(type, id, userId);
    return sec ? new Date(Date.now() + sec * 1000) : null;
}

function timerLabel(sec) {
    return ({ 3600: '1 hour', 86400: '24 hours', 604800: '7 days', 7776000: '90 days' })[sec] || 'off';
}

app.get('/api/chat-timer', handle(async (req, res) => {
    const type = req.query.type === 'g' ? 'g' : 'u';
    const id = parseInt(req.query.id, 10);
    if (!id || (type === 'g' ? !(await groupAccess(id, req.userId)) : !(await isFriend(req.userId, id)))) return res.status(404).json({ message: 'Chat not found.' });
    res.status(200).json({ seconds: await chatTimer(type, id, req.userId) });
}));

app.post('/api/chat-timer', handle(async (req, res) => {
    const type = req.body.type === 'g' ? 'g' : 'u';
    const id = parseInt(req.body.id, 10);
    const seconds = Number(req.body.seconds);
    if (!id || !TIMER_OPTIONS.includes(seconds)) return res.status(400).json({ message: 'Invalid timer.' });

    let audience;
    if (type === 'g') {
        const g = await groupAccess(id, req.userId);
        if (!g) return res.status(404).json({ message: 'Chat not found.' });
        if (g.role !== 'admin' && g.edit_permission !== 'all') return res.status(403).json({ message: 'Only admins can change this.' });
        await db.query('UPDATE chat_groups SET disappear_seconds = $1 WHERE id = $2', [seconds, id]);
        await systemMessage(id, req.userId, seconds ? 'turned on disappearing messages (' + timerLabel(seconds) + ')' : 'turned off disappearing messages');
        audience = await groupMemberIds(id);
    } else {
        if (!(await isFriend(req.userId, id))) return res.status(404).json({ message: 'Chat not found.' });
        const [a, b] = [Math.min(id, req.userId), Math.max(id, req.userId)];
        await db.query(`
            INSERT INTO dm_settings (user_a, user_b, disappear_seconds) VALUES ($1, $2, $3)
            ON CONFLICT (user_a, user_b) DO UPDATE SET disappear_seconds = EXCLUDED.disappear_seconds
        `, [a, b, seconds]);
        // chat e chhoto lekha: "X turned on disappearing messages"
        await db.query(
            'INSERT INTO messages (sender_id, receiver_id, message, is_system, is_read) VALUES ($1, $2, $3, TRUE, TRUE)',
            [req.userId, id, seconds ? 'turned on disappearing messages (' + timerLabel(seconds) + ')' : 'turned off disappearing messages']
        );
        audience = [req.userId, id];
        emitToUser(id, 'message:new', { sender_id: req.userId, receiver_id: id });
        emitToUser(req.userId, 'message:new', {});
    }
    emitMany(audience, 'chat-timer:changed', { type, id: type === 'g' ? id : null });
    res.status(200).json({ ok: true, seconds });
}));

// meyad shesh message 5 minit por por muche felo (file keu ar na use korle Cloudinary theke-o)
async function cleanupExpiredMessages() {
    try {
        const { rows } = await db.query('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= NOW() RETURNING attachment_public_id, attachment_type');
        for (const r of rows) {
            if (!r.attachment_public_id) continue;
            const still = await db.query('SELECT 1 FROM messages WHERE attachment_public_id = $1 LIMIT 1', [r.attachment_public_id]);
            if (!still.rows.length) cloudDestroy(r.attachment_public_id, r.attachment_type);
        }
    } catch (e) { console.error('message cleanup failed:', e.message); }
}
setInterval(cleanupExpiredMessages, 5 * 60 * 1000);

// ==========================================
// 18. GIF (Tenor ba GIPHY) - key server ei thake
// ==========================================
const GIF_KEYS = { tenor: process.env.TENOR_API_KEY, giphy: process.env.GIPHY_API_KEY };
const gifReady = !!(GIF_KEYS.tenor || GIF_KEYS.giphy);
if (!gifReady) console.warn('WARNING: TENOR_API_KEY / GIPHY_API_KEY nai, GIF bondho.');
const gifCache = new Map();             // "q|pos" -> { at, data }
const gifRate = new Map();

// shudhu Tenor / GIPHY er chhobi (onno kono link na)
function cleanGif(a) {
    if (!a || typeof a.url !== 'string') return null;
    let u;
    try { u = new URL(a.url); } catch (e) { return null; }
    const okHost = u.protocol === 'https:' && (/^(media\d*|c)\.tenor\.com$/.test(u.hostname) || /^(media\d*|i)\.giphy\.com$/.test(u.hostname));
    if (!okHost) return null;
    return { type: 'gif', url: u.href, name: String(a.name || 'GIF').slice(0, 100), size: 0, mime: 'image/gif', publicId: null, duration: null };
}

app.get('/api/gifs', handle(async (req, res) => {
    if (!gifReady) return res.status(503).json({ message: 'GIFs are not set up yet.' });
    const now = Date.now();
    const r = gifRate.get(req.userId) || { count: 0, start: now };
    if (now - r.start > 60000) { r.count = 0; r.start = now; }
    if (++r.count > 60) return res.status(429).json({ message: 'Too many searches. Wait a minute.' });
    gifRate.set(req.userId, r);

    const q = String(req.query.q || '').trim().slice(0, 50);
    const pos = String(req.query.pos || '').slice(0, 50);
    const key = q.toLowerCase() + '|' + pos;
    const hit = gifCache.get(key);
    if (hit && now - hit.at < 10 * 60 * 1000) return res.status(200).json(hit.data);

    let data;
    if (GIF_KEYS.tenor) {
        const params = new URLSearchParams({ key: GIF_KEYS.tenor, client_key: 'talkfav', limit: '24', media_filter: 'tinygif,gif', contentfilter: 'medium' });
        if (q) params.set('q', q);
        if (pos) params.set('pos', pos);
        const r2 = await fetch('https://tenor.googleapis.com/v2/' + (q ? 'search' : 'featured') + '?' + params, { signal: AbortSignal.timeout(8000) });
        if (!r2.ok) return res.status(502).json({ message: 'Could not load GIFs.' });
        const j = await r2.json();
        data = {
            next: j.next || null,
            gifs: (j.results || []).map(g => ({
                id: g.id,
                preview: g.media_formats && g.media_formats.tinygif && g.media_formats.tinygif.url,
                url: g.media_formats && (g.media_formats.gif || g.media_formats.tinygif) && (g.media_formats.gif || g.media_formats.tinygif).url,
                title: g.content_description || 'GIF'
            })).filter(g => g.preview && g.url)
        };
    } else {
        const offset = parseInt(pos, 10) || 0;
        const params = new URLSearchParams({ api_key: GIF_KEYS.giphy, limit: '24', offset: String(offset), rating: 'pg-13' });
        if (q) params.set('q', q);
        const r2 = await fetch('https://api.giphy.com/v1/gifs/' + (q ? 'search' : 'trending') + '?' + params, { signal: AbortSignal.timeout(8000) });
        if (!r2.ok) return res.status(502).json({ message: 'Could not load GIFs.' });
        const j = await r2.json();
        const total = j.pagination ? j.pagination.total_count : 0;
        data = {
            next: offset + 24 < total ? String(offset + 24) : null,
            gifs: (j.data || []).map(g => ({
                id: g.id,
                preview: g.images && g.images.fixed_height_small && g.images.fixed_height_small.url,
                url: g.images && (g.images.downsized_medium || g.images.fixed_height) && (g.images.downsized_medium || g.images.fixed_height).url,
                title: g.title || 'GIF'
            })).filter(g => g.preview && g.url)
        };
    }
    gifCache.set(key, { at: now, data });
    if (gifCache.size > 500) gifCache.delete(gifCache.keys().next().value);
    res.status(200).json(data);
}));

// ==========================================
// 19. CHAT WALLPAPER (preset nam gulo; nijer chhobi o deya jay)
// ==========================================
const WALLPAPER_PRESETS = ['sky', 'sunset', 'mint', 'lavender', 'peach', 'night', 'ocean', 'forest', 'dots', 'doodle', 'hearts', 'grid'];

// ==========================================
// 20. ACCOUNT: Edit Profile, Change Password, Delete Account, Sessions
// ==========================================
app.post('/api/users/profile', handle(async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const country = typeof req.body.country === 'string' ? req.body.country.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ message: 'Name is required (max 100 characters).' });
    if (phone && !/^[+\d][\d\s()-]{3,29}$/.test(phone)) return res.status(400).json({ message: 'Please enter a valid phone number.' });
    if (country.length > 100) return res.status(400).json({ message: 'Country name is too long.' });
    // @username: 3-20 okkhor, shudhu a-z 0-9 _ .
    const cur = (await db.query('SELECT username, bio, links FROM users WHERE id = $1', [req.userId])).rows[0];
    let username = req.body.username === undefined ? cur.username : String(req.body.username || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_.]{3,20}$/.test(username || '')) return res.status(400).json({ message: 'Username must be 3–20 characters: letters, numbers, _ or .', field: 'username' });
    if (/^[._]|[._]$|\.\./.test(username)) return res.status(400).json({ message: 'Username cannot start or end with . or _', field: 'username' });
    const taken = await db.query('SELECT 1 FROM users WHERE LOWER(username) = $1 AND id <> $2', [username, req.userId]);
    if (taken.rows.length) return res.status(400).json({ message: '@' + username + ' is already taken.', field: 'username' });
    const bio = req.body.bio === undefined ? (cur.bio || '') : String(req.body.bio || '').trim().slice(0, 160);
    let links = cur.links || [];
    if (Array.isArray(req.body.links)) {
        links = [];
        for (const raw of req.body.links.slice(0, 3)) {
            const t = String(raw || '').trim();
            if (!t) continue;
            let url;
            try { url = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t); } catch (e) { return res.status(400).json({ message: 'One of the links is not valid.', field: 'links' }); }
            if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return res.status(400).json({ message: 'One of the links is not valid.', field: 'links' });
            links.push(url.href.slice(0, 300));
        }
    }
    const { rows } = await db.query(
        'UPDATE users SET name = $1, phone = $2, country = $3, username = $4, bio = $5, links = $6 WHERE id = $7 RETURNING id, name, email, phone, country, username, bio, links',
        [name, phone, country || null, username, bio || null, links, req.userId]
    );
    emitMany(await friendIdsOf(req.userId), 'friends:changed', {});      // friend der list e notun nam
    res.status(200).json({ ok: true, user: rows[0] });
}));

app.get('/api/users/me', handle(async (req, res) => {
    const { rows } = await db.query('SELECT id, name, email, phone, country, username, bio, links, is_demo, password_set, google_id IS NOT NULL AS google FROM users WHERE id = $1', [req.userId]);
    res.status(200).json({ user: rows[0], is_admin: await isAdmin(req.userId) });
}));

app.post('/api/users/password', handle(async (req, res) => {
    if (await isDemoUser(req.userId)) return res.status(403).json({ message: 'This is not available in the demo account.' });
    const current = String(req.body.current || '');
    const next = String(req.body.password || '');
    if (next.length < 6 || next.length > 100) return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    const u = (await db.query('SELECT password, password_set FROM users WHERE id = $1', [req.userId])).rows[0];
    // Google diye khola account e age kono password chhilo na
    if (u.password_set && !(await bcrypt.compare(current, u.password))) return res.status(400).json({ message: 'Current password is wrong.' });
    await db.query('UPDATE users SET password = $1, password_set = TRUE WHERE id = $2', [await bcrypt.hash(next, 10), req.userId]);
    await revokeSessions(req.userId, req.sessionId);                  // onno sob device theke logout
    res.status(200).json({ ok: true, message: 'Password changed. Other devices were logged out.' });
}));

// ekta browser/phone er nam: "Chrome · Windows"
function deviceName(ua) {
    ua = ua || '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iPhone / iPad'
        : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
    return browser + ' · ' + os;
}

app.get('/api/sessions', handle(async (req, res) => {
    const { rows } = await db.query(`
        SELECT id, created_at, last_used, user_agent, ip FROM sessions
        WHERE user_id = $1 AND revoked = FALSE AND created_at > NOW() - INTERVAL '8 days'
        ORDER BY last_used DESC
    `, [req.userId]);
    res.status(200).json({
        sessions: rows.map(r => ({
            id: r.id, device: deviceName(r.user_agent), created_at: r.created_at, last_used: r.last_used,
            ip: (r.ip || '').replace(/(\d+)\.(\d+)$/, 'x.x'),            // pura IP dekhai na
            current: r.id === req.sessionId
        })),
        legacy: !req.sessionId
    });
}));

app.post('/api/sessions/:id/revoke', handle(async (req, res) => {
    const r = await db.query('UPDATE sessions SET revoked = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (!r.rowCount) return res.status(404).json({ message: 'Session not found.' });
    authCache.clear();
    for (const [, sk] of io.sockets.sockets) if (sk.data.sid === req.params.id) { sk.emit('session:revoked', {}); sk.disconnect(true); }
    res.status(200).json({ ok: true });
}));

app.post('/api/sessions/revoke-others', handle(async (req, res) => {
    await revokeSessions(req.userId, req.sessionId);
    res.status(200).json({ ok: true });
}));

app.post('/api/auth/logout', handle(async (req, res) => {
    if (req.sessionId) {
        await db.query('UPDATE sessions SET revoked = TRUE WHERE id = $1', [req.sessionId]);
        authCache.clear();
    }
    res.status(200).json({ ok: true });
}));

// Delete Account: sob muche jay (message, group membership, file)
app.post('/api/users/delete', handle(async (req, res) => {
    if (await isDemoUser(req.userId)) return res.status(403).json({ message: 'This is not available in the demo account.' });
    if (req.body.confirm !== 'DELETE') return res.status(400).json({ message: 'Type DELETE to confirm.' });
    const u = (await db.query('SELECT password, password_set, cover_public_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (u.password_set && !(await bcrypt.compare(String(req.body.password || ''), u.password))) {
        return res.status(400).json({ message: 'Password is wrong.' });
    }
    const friends = await friendIdsOf(req.userId);
    // je group e ami ekmatro admin, sekhane shobcheye purono member ke admin kori
    const { rows: adminGroups } = await db.query(`
        SELECT gm.group_id FROM group_members gm
        WHERE gm.user_id = $1 AND gm.role = 'admin'
          AND NOT EXISTS (SELECT 1 FROM group_members x WHERE x.group_id = gm.group_id AND x.role = 'admin' AND x.user_id <> $1)
    `, [req.userId]);
    for (const g of adminGroups) {
        await db.query(`
            UPDATE group_members SET role = 'admin'
            WHERE group_id = $1 AND user_id = (SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2 ORDER BY joined_at LIMIT 1)
        `, [g.group_id, req.userId]);
    }
    // Cloudinary file gulo (onno kothao forward kora na thakle)
    const { rows: files } = await db.query(
        "SELECT DISTINCT attachment_public_id AS pid, attachment_type AS t FROM messages WHERE sender_id = $1 AND attachment_public_id IS NOT NULL LIMIT 1000",
        [req.userId]
    );
    const { rows: statusFiles } = await db.query('SELECT media_public_id AS pid, type AS t FROM statuses WHERE user_id = $1 AND media_public_id IS NOT NULL', [req.userId]);
    kickSessions(req.userId);
    await db.query('DELETE FROM users WHERE id = $1', [req.userId]);
    for (const f of files) {
        const still = await db.query('SELECT 1 FROM messages WHERE attachment_public_id = $1 LIMIT 1', [f.pid]);
        if (!still.rows.length) cloudDestroy(f.pid, f.t);
    }
    statusFiles.forEach(f => cloudDestroy(f.pid, f.t));
    if (u.cover_public_id) cloudDestroy(u.cover_public_id, 'image');
    emitMany(friends, 'friends:changed', {});
    res.status(200).json({ ok: true });
}));

// ==========================================
// 21. FORGOT PASSWORD (email e 6 sonkhar code) - Brevo diye email
// .env: BREVO_API_KEY, MAIL_FROM (Brevo te verify kora email), MAIL_FROM_NAME (choile)
// ==========================================
const MAIL = { key: process.env.BREVO_API_KEY, from: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || 'TalkFav' };
const mailReady = !!(MAIL.key && MAIL.from);
if (!mailReady) console.warn('WARNING: BREVO_API_KEY / MAIL_FROM nai, Forgot Password er email jabe na.');
const forgotRate = new Map();           // ip -> { count, start }

async function sendMail(to, subject, html) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': MAIL.key, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { email: MAIL.from, name: MAIL.name }, to: [{ email: to }], subject, htmlContent: html }),
        signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error('Brevo ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

const codeHash = (userId, code) => crypto.createHash('sha256').update(userId + ':' + code + ':' + JWT_SECRET).digest('hex');

app.post('/api/auth/forgot', handle(async (req, res) => {
    if (!mailReady) return res.status(503).json({ message: 'Password reset by email is not set up yet.' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const r = forgotRate.get(ip) || { count: 0, start: now };
    if (now - r.start > 15 * 60 * 1000) { r.count = 0; r.start = now; }
    if (++r.count > 5) return res.status(429).json({ message: 'Too many requests. Try again in 15 minutes.' });
    forgotRate.set(ip, r);

    const email = String(req.body.email || '').trim().toLowerCase();
    const okMsg = { ok: true, message: 'If this email is registered, we sent a 6-digit code to it.' };
    const user = (await db.query('SELECT id, name, banned FROM users WHERE LOWER(email) = $1', [email])).rows[0];
    if (!user || user.banned) return res.status(200).json(okMsg);          // account ache kina bolbo na

    const code = String(crypto.randomInt(100000, 1000000));
    await db.query(`
        INSERT INTO password_resets (user_id, code_hash, expires_at, attempts) VALUES ($1, $2, NOW() + INTERVAL '15 minutes', 0)
        ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0
    `, [user.id, codeHash(user.id, code)]);
    try {
        await sendMail(email, 'Your TalkFav password reset code',
            `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border-radius:16px;background:#f5f3ff">
               <h2 style="margin:0 0 8px;color:#7c5cff">TalkFav</h2>
               <p>Hi ${String(user.name).replace(/[<>&"]/g, '')},</p>
               <p>Use this code to reset your password. It expires in 15 minutes.</p>
               <p style="font-size:32px;font-weight:bold;letter-spacing:6px;text-align:center;background:#fff;padding:14px;border-radius:12px">${code}</p>
               <p style="color:#64748b;font-size:13px">If you didn't ask for this, you can ignore this email.</p>
             </div>`);
    } catch (e) {
        console.error('mail failed:', e.message);
        return res.status(502).json({ message: 'Could not send the email. Please try again later.' });
    }
    res.status(200).json(okMsg);
}));

app.post('/api/auth/reset', handle(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '');
    if (password.length < 6 || password.length > 100) return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    const user = (await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [email])).rows[0];
    const row = user && (await db.query('SELECT * FROM password_resets WHERE user_id = $1', [user.id])).rows[0];
    if (!row || new Date(row.expires_at) < new Date() || row.attempts >= 5) {
        return res.status(400).json({ message: 'This code has expired. Please request a new one.' });
    }
    if (row.code_hash !== codeHash(user.id, code)) {
        await db.query('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = $1', [user.id]);
        return res.status(400).json({ message: 'Wrong code. ' + Math.max(0, 4 - row.attempts) + ' tries left.' });
    }
    await db.query('UPDATE users SET password = $1, password_set = TRUE WHERE id = $2', [await bcrypt.hash(password, 10), user.id]);
    await db.query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);
    await revokeSessions(user.id);                                   // sob device theke logout
    res.status(200).json({ ok: true, message: 'Password changed. Please log in with your new password.' });
}));

// ==========================================
// 22. PEOPLE YOU MAY KNOW (mutual friend dekhe)
// ==========================================
app.get('/api/users/suggestions', handle(async (req, res) => {
    const { rows } = await db.query(`
        WITH mine AS (
            SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS fid
            FROM friend_requests WHERE status = 'accepted' AND (sender_id = $1 OR receiver_id = $1)
        ), fof AS (
            SELECT CASE WHEN fr.sender_id = m.fid THEN fr.receiver_id ELSE fr.sender_id END AS uid, m.fid
            FROM friend_requests fr JOIN mine m ON (fr.sender_id = m.fid OR fr.receiver_id = m.fid)
            WHERE fr.status = 'accepted'
        )
        SELECT u.id, u.name, CASE WHEN u.avatar_visibility = 'friends' THEN NULL ELSE u.avatar END AS avatar,
               COUNT(DISTINCT fof.fid)::int AS mutual
        FROM fof JOIN users u ON u.id = fof.uid
        WHERE fof.uid <> $1 AND fof.uid NOT IN (SELECT fid FROM mine) AND NOT u.banned
          AND NOT EXISTS (SELECT 1 FROM friend_requests x WHERE (x.sender_id = $1 AND x.receiver_id = u.id) OR (x.sender_id = u.id AND x.receiver_id = $1))
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
        GROUP BY u.id ORDER BY mutual DESC, u.name LIMIT 12
    `, [req.userId]);
    res.status(200).json({ users: rows });
}));

// ==========================================
// 23. STICKER + LOCATION (message er notun dhoron)
// ==========================================
const STICKERS = ['1f431', '1f436', '1f984', '1f43c', '1f98a', '1f438', '1f435', '1f427', '1f43b', '1f430', '1f428', '1f42f', '1f389', '1f496', '1f525', '1f44d', '1f602', '1f60d', '1f973', '1f62d', '1f60e', '1f914', '1f64f', '1f4af', '1f339', '1f355', '2615', '1f382', '1f308', '1f680', '1f47b', '1f381'];

function cleanSticker(a) {
    const code = String(a && a.name || '');
    if (!STICKERS.includes(code)) return null;
    return { type: 'sticker', url: '/assets/stickers/' + code + '.webp', name: code, size: 0, mime: 'image/webp', publicId: null, duration: null };
}

function cleanLocation(a) {
    const lat = Number(a && a.lat), lon = Number(a && a.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const la = lat.toFixed(5), lo = lon.toFixed(5);
    return {
        type: 'location', url: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`,
        name: la + ',' + lo, size: 0, mime: 'location', publicId: null, duration: null
    };
}

// ==========================================
// 24. SCHEDULED MESSAGES (nirdishto somoye nijei pathabe)
// ==========================================
app.post('/api/messages/schedule', handle(async (req, res) => {
    const group_id = parseInt(req.body.group_id, 10) || null;
    const receiver_id = group_id ? null : parseInt(req.body.receiver_id, 10);
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const sendAt = new Date(req.body.send_at);
    if ((!group_id && !receiver_id) || !message || message.length > 5000) return res.status(400).json({ message: 'Write a message first.' });
    if (isNaN(sendAt) || sendAt.getTime() < Date.now() + 30 * 1000 || sendAt.getTime() > Date.now() + 30 * 86400000) {
        return res.status(400).json({ message: 'Pick a time between 1 minute and 30 days from now.' });
    }
    if (group_id ? !(await groupAccess(group_id, req.userId)) : !(await isFriend(req.userId, receiver_id))) return res.status(403).json({ message: 'Not allowed.' });
    const count = (await db.query('SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE sender_id = $1', [req.userId])).rows[0].n;
    if (count >= 50) return res.status(429).json({ message: 'You can schedule at most 50 messages.' });
    await db.query('INSERT INTO scheduled_messages (sender_id, receiver_id, group_id, message, send_at) VALUES ($1, $2, $3, $4, $5)',
        [req.userId, receiver_id, group_id, message, sendAt]);
    res.status(200).json({ ok: true });
}));

app.get('/api/messages/scheduled', handle(async (req, res) => {
    const group_id = parseInt(req.query.group, 10) || null;
    const user = parseInt(req.query.user, 10) || null;
    const { rows } = await db.query(`
        SELECT id, message, send_at FROM scheduled_messages
        WHERE sender_id = $1 AND ${group_id ? 'group_id = $2' : 'receiver_id = $2'}
        ORDER BY send_at
    `, [req.userId, group_id || user]);
    res.status(200).json({ scheduled: rows });
}));

app.post('/api/messages/scheduled/:id/cancel', handle(async (req, res) => {
    const r = await db.query('DELETE FROM scheduled_messages WHERE id = $1 AND sender_id = $2', [parseInt(req.params.id, 10), req.userId]);
    if (!r.rowCount) return res.status(404).json({ message: 'Not found.' });
    res.status(200).json({ ok: true });
}));

// somoy hole pathano (30 sec por por check)
async function deliverScheduled() {
    let rows;
    try { rows = (await db.query('DELETE FROM scheduled_messages WHERE send_at <= NOW() RETURNING *')).rows; }
    catch (e) { return; }
    for (const sm of rows) {
        try {
            if (sm.group_id) {
                const g = await groupAccess(sm.group_id, sm.sender_id);
                if (!g || (g.send_permission === 'admins' && g.role !== 'admin')) continue;
            } else if (!(await isFriend(sm.sender_id, sm.receiver_id))) continue;
            const ins = await db.query(
                'INSERT INTO messages (sender_id, receiver_id, group_id, message, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [sm.sender_id, sm.receiver_id, sm.group_id, sm.message, await expiryFor(sm.group_id ? 'g' : 'u', sm.group_id || sm.receiver_id, sm.sender_id)]
            );
            const name = ((await db.query('SELECT name FROM users WHERE id = $1', [sm.sender_id])).rows[0] || {}).name || 'Someone';
            if (sm.group_id) {
                await db.query('UPDATE group_members SET last_read_id = $1 WHERE group_id = $2 AND user_id = $3', [ins.rows[0].id, sm.group_id, sm.sender_id]);
                const members = await groupMemberIds(sm.group_id);
                emitMany(members, 'group:message', { group_id: sm.group_id, id: ins.rows[0].id, sender_id: sm.sender_id, mentions: [] });
                const { rows: mem } = await db.query('SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2 AND NOT muted', [sm.group_id, sm.sender_id]);
                const gname = ((await db.query('SELECT name FROM chat_groups WHERE id = $1', [sm.group_id])).rows[0] || {}).name || 'Group';
                sendPush(mem.map(m => m.user_id), { title: '👥 ' + gname, body: name.split(' ')[0] + ': ' + previewText(sm.message), tag: 'group-' + sm.group_id, url: '/dashboard.html' });
            } else {
                const payload = { id: ins.rows[0].id, sender_id: sm.sender_id, receiver_id: sm.receiver_id };
                emitToUser(sm.receiver_id, 'message:new', payload);
                emitToUser(sm.sender_id, 'message:new', payload);
                if (!(await isDmMuted(sm.receiver_id, sm.sender_id))) sendPush([sm.receiver_id], { title: name, body: previewText(sm.message), tag: 'dm-' + sm.sender_id, url: '/dashboard.html' });
            }
        } catch (e) { console.error('scheduled send failed:', e.message); }
    }
}
setInterval(deliverScheduled, 30 * 1000);

// ==========================================
// 25. CHAT EXPORT (.txt file)
// ==========================================
app.get('/api/chats/export', handle(async (req, res) => {
    const group_id = parseInt(req.query.group, 10) || null;
    const other = parseInt(req.query.user, 10) || null;
    let convo, params, title;
    if (group_id) {
        const g = await groupAccess(group_id, req.userId);
        if (!g) return res.status(404).json({ message: 'Chat not found.' });
        convo = 'm.group_id = $1'; params = [group_id]; title = g.name;
    } else {
        if (!other) return res.status(400).json({ message: 'Invalid chat.' });
        const o = (await db.query('SELECT name FROM users WHERE id = $1', [other])).rows[0];
        if (!o) return res.status(404).json({ message: 'Chat not found.' });
        convo = '(m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)'; params = [req.userId, other]; title = o.name;
    }
    params.push(req.userId);
    const me = '$' + params.length;
    const { rows } = await db.query(`
        SELECT m.created_at, m.message, m.is_system, m.deleted_at, m.attachment_type, m.attachment_url, m.attachment_name, u.name
        FROM messages m JOIN users u ON u.id = m.sender_id
        LEFT JOIN message_hidden h ON h.message_id = m.id AND h.user_id = ${me}
        WHERE (${convo}) AND h.message_id IS NULL AND (m.expires_at IS NULL OR m.expires_at > NOW())
        ORDER BY m.id LIMIT 20000
    `, params);
    const lines = ['TalkFav chat with ' + title, 'Exported ' + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC', ''];
    rows.forEach(m => {
        const t = new Date(m.created_at).toISOString().replace('T', ' ').slice(0, 16);
        let text = m.deleted_at ? '[message unsent]' : m.message;
        if (!m.deleted_at && m.attachment_type) text = (text ? text + ' ' : '') + '[' + previewText('', m.attachment_type, m.attachment_name) + ': ' + (m.attachment_url || '') + ']';
        lines.push(m.is_system ? `[${t}] — ${m.name} ${m.message}` : `[${t}] ${m.name}: ${text}`);
    });
    const safe = title.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'chat';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="talkfav-${safe}.txt"`);
    res.status(200).send('\ufeff' + lines.join('\r\n'));
}));

// ==========================================
// 26. ADMIN PANEL (.env e ADMIN_EMAILS=tomar@gmail.com)
// ==========================================
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
async function isAdmin(userId) {
    if (!ADMIN_EMAILS.length) return false;
    const r = await db.query('SELECT LOWER(email) AS e FROM users WHERE id = $1', [userId]);
    return !!(r.rows[0] && ADMIN_EMAILS.includes(r.rows[0].e));
}
const adminOnly = (fn) => handle(async (req, res) => {
    if (!(await isAdmin(req.userId))) return res.status(403).json({ message: 'Admins only.' });
    return fn(req, res);
});

app.get('/api/admin/stats', adminOnly(async (req, res) => {
    const q = async (sql) => (await db.query(sql)).rows[0].n;
    res.status(200).json({
        users: await q('SELECT COUNT(*)::int AS n FROM users'),
        new_users_7d: await q("SELECT COUNT(*)::int AS n FROM users WHERE created_at > NOW() - INTERVAL '7 days'"),
        messages: await q('SELECT COUNT(*)::int AS n FROM messages'),
        messages_today: await q("SELECT COUNT(*)::int AS n FROM messages WHERE created_at > NOW() - INTERVAL '1 day'"),
        groups: await q('SELECT COUNT(*)::int AS n FROM chat_groups'),
        open_reports: await q('SELECT COUNT(*)::int AS n FROM user_reports WHERE NOT resolved'),
        banned: await q('SELECT COUNT(*)::int AS n FROM users WHERE banned'),
        online: onlineUsers.size
    });
}));

app.get('/api/admin/reports', adminOnly(async (req, res) => {
    const { rows } = await db.query(`
        SELECT r.id, r.reason, r.details, r.created_at, r.resolved,
               a.id AS reporter_id, a.name AS reporter, b.id AS reported_id, b.name AS reported, b.email AS reported_email, b.banned
        FROM user_reports r JOIN users a ON a.id = r.reporter_id JOIN users b ON b.id = r.reported_id
        ORDER BY r.resolved, r.created_at DESC LIMIT 200
    `);
    res.status(200).json({ reports: rows });
}));

app.post('/api/admin/reports/:id/resolve', adminOnly(async (req, res) => {
    await db.query('UPDATE user_reports SET resolved = TRUE WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.status(200).json({ ok: true });
}));

app.get('/api/admin/users', adminOnly(async (req, res) => {
    const q = '%' + String(req.query.q || '').trim().slice(0, 50) + '%';
    const { rows } = await db.query(`
        SELECT id, name, email, created_at, banned, last_seen_at,
               (SELECT COUNT(*)::int FROM user_reports r WHERE r.reported_id = users.id) AS reports
        FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY created_at DESC LIMIT 50
    `, [q]);
    res.status(200).json({ users: rows });
}));

app.post('/api/admin/users/:id/ban', adminOnly(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (id === req.userId || (await isAdmin(id))) return res.status(400).json({ message: 'You cannot ban an admin.' });
    const ban = !!req.body.ban;
    const r = await db.query('UPDATE users SET banned = $1 WHERE id = $2', [ban, id]);
    if (!r.rowCount) return res.status(404).json({ message: 'User not found.' });
    if (ban) await revokeSessions(id);            // sathe sathe sob device theke ber
    authCache.clear();
    res.status(200).json({ ok: true });
}));

// ==========================================
// 27. ERROR LOG (server + browser)
// ==========================================
function logError(source, message, stack, path, userId, ua) {
    db.query(
        'INSERT INTO error_logs (source, message, stack, path, user_id, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
        [source, String(message || 'Unknown error').slice(0, 1000), stack ? String(stack).slice(0, 4000) : null,
         path ? String(path).slice(0, 300) : null, userId || null, ua ? String(ua).slice(0, 300) : null]
    ).catch(() => {});
}
process.on('unhandledRejection', (err) => { console.error('unhandledRejection:', err); logError('server', err && err.message || String(err), err && err.stack, 'unhandledRejection'); });
// 30 din er purono log muche felo
setInterval(() => db.query("DELETE FROM error_logs WHERE created_at < NOW() - INTERVAL '30 days'").catch(() => {}), 24 * 60 * 60 * 1000);

// browser er bhul (dashboard.js pathay). login chharao, tai rate limit
const limitClientLog = rateLimit({ name: 'clientlog', windowMs: 60 * 1000, max: 20, key: clientIp });
app.post('/api/logs/client', limitClientLog, (req, res) => {
    const b = req.body || {};
    const header = req.headers.authorization || '';
    const data = decodeToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    logError('client', b.message, b.stack, b.path, data && data.uid, req.headers['user-agent']);
    res.status(204).end();
});

app.get('/api/admin/errors', adminOnly(async (req, res) => {
    const { rows } = await db.query(`
        SELECT e.id, e.source, e.message, e.stack, e.path, e.user_agent, e.created_at, u.name AS user_name
        FROM error_logs e LEFT JOIN users u ON u.id = e.user_id
        ORDER BY e.created_at DESC LIMIT 100
    `);
    res.status(200).json({ errors: rows });
}));
app.post('/api/admin/errors/clear', adminOnly(async (req, res) => {
    await db.query('DELETE FROM error_logs');
    res.status(200).json({ ok: true });
}));

// ==========================================
// 28. TWO-STEP VERIFICATION (TOTP: Google Authenticator / Microsoft Authenticator)
// ==========================================
const backupHash = (code) => crypto.createHash('sha256').update(String(code).replace(/[\s-]/g, '').toLowerCase() + ':' + JWT_SECRET).digest('hex');

// login er majhpothe: password thik, ekhon 2FA code lagbe (5 minit er "ticket")
function signTicket(userId) {
    const payload = Buffer.from(JSON.stringify({ uid: userId, p: '2fa', exp: Date.now() + 5 * 60 * 1000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', JWT_SECRET + ':2fa').update(payload).digest('base64url');
    return payload + '.' + sig;
}
function readTicket(ticket) {
    const [payload, sig] = String(ticket || '').split('.');
    if (!payload || !sig) return null;
    const good = crypto.createHmac('sha256', JWT_SECRET + ':2fa').update(payload).digest('base64url');
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    try { const d = JSON.parse(Buffer.from(payload, 'base64url').toString()); return d.p === '2fa' && d.exp > Date.now() ? d.uid : null; } catch (e) { return null; }
}

function publicUser(user, token) {
    return { id: user.id, name: user.name, email: user.email, country: user.country, phone: user.phone,
             avatar: user.avatar || null, cover: user.cover || null, token };
}

// password / Google thik hole: 2FA chalu thakle ticket, na hole session + notun device hole alert
async function loginResult(user, req) {
    if (user.totp_enabled) return { need_2fa: true, ticket: signTicket(user.id), message: 'Enter the code from your authenticator app.' };
    const isNew = await isNewDevice(user.id, req);
    const token = await createSession(user.id, req);
    if (isNew) sendLoginAlert(user, req).catch(e => console.error('login alert failed:', e.message));
    return { message: 'Login successful!', user: publicUser(user, token) };
}

app.post('/api/auth/2fa', limitTwoFa, handle(async (req, res) => {
    const uid = readTicket(req.body.ticket);
    if (!uid) return res.status(401).json({ message: 'This sign-in expired. Please log in again.', expired: true });
    const user = (await db.query('SELECT * FROM users WHERE id = $1', [uid])).rows[0];
    if (!user || user.banned || !user.totp_enabled) return res.status(401).json({ message: 'Please log in again.', expired: true });
    const code = String(req.body.code || '').trim();
    let ok = verifyTotp(user.totp_secret, code);
    let usedBackup = false;
    if (!ok && code.replace(/[\s-]/g, '').length === 10) {
        // backup code (ekbar-i chole)
        const h = backupHash(code);
        const list = user.totp_backup || [];
        if (list.includes(h)) {
            ok = true; usedBackup = true;
            await db.query('UPDATE users SET totp_backup = $1 WHERE id = $2', [list.filter(x => x !== h), user.id]);
        }
    }
    if (!ok) return res.status(400).json({ message: 'Wrong code. Check your authenticator app and try again.', field: 'code' });
    const isNew = await isNewDevice(user.id, req);
    const token = await createSession(user.id, req);
    if (isNew) sendLoginAlert(user, req).catch(() => {});
    const left = usedBackup ? (user.totp_backup || []).length - 1 : null;
    res.status(200).json({ message: 'Login successful!', user: publicUser(user, token), backup_left: left });
}));

app.get('/api/2fa/status', handle(async (req, res) => {
    const u = (await db.query('SELECT totp_enabled, totp_backup, login_alerts FROM users WHERE id = $1', [req.userId])).rows[0];
    res.status(200).json({ enabled: !!u.totp_enabled, backup_left: (u.totp_backup || []).length, login_alerts: u.login_alerts });
}));

// chalu korar prothom dhap: notun gopon chabi (app e scan korar jonno)
app.post('/api/2fa/setup', handle(async (req, res) => {
    if (await isDemoUser(req.userId)) return res.status(403).json({ message: 'This is not available in the demo account.' });
    const u = (await db.query('SELECT email, totp_enabled FROM users WHERE id = $1', [req.userId])).rows[0];
    if (u.totp_enabled) return res.status(400).json({ message: 'Two-step verification is already on.' });
    const secret = base32Encode(crypto.randomBytes(20));
    await db.query('UPDATE users SET totp_pending = $1 WHERE id = $2', [secret, req.userId]);
    const label = encodeURIComponent('TalkFav:' + u.email);
    res.status(200).json({ secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=TalkFav&algorithm=SHA1&digits=6&period=30` });
}));

// app er code diye jachai -> chalu + 8 ta backup code (ekbar-i dekhai)
app.post('/api/2fa/enable', handle(async (req, res) => {
    const u = (await db.query('SELECT totp_pending FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!u.totp_pending) return res.status(400).json({ message: 'Start the setup again.' });
    if (!verifyTotp(u.totp_pending, req.body.code)) return res.status(400).json({ message: 'Wrong code. Try the newest code from your app.', field: 'code' });
    const codes = Array.from({ length: 8 }, () => {
        const raw = crypto.randomBytes(5).toString('hex');
        return raw.slice(0, 5) + '-' + raw.slice(5);
    });
    await db.query('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = TRUE, totp_backup = $1 WHERE id = $2',
        [codes.map(backupHash), req.userId]);
    await revokeSessions(req.userId, req.sessionId);           // onno device e abar login (code soho)
    res.status(200).json({ ok: true, backup_codes: codes });
}));

// bondho: app er code othoba password lagbe
app.post('/api/2fa/disable', handle(async (req, res) => {
    const u = (await db.query('SELECT password, password_set, totp_secret, totp_enabled FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!u.totp_enabled) return res.status(400).json({ message: 'Two-step verification is already off.' });
    const byCode = verifyTotp(u.totp_secret, req.body.code);
    const byPass = u.password_set && req.body.password && await bcrypt.compare(String(req.body.password), u.password);
    if (!byCode && !byPass) return res.status(400).json({ message: 'Enter a code from your app (or your password).' });
    await db.query('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_pending = NULL, totp_backup = NULL WHERE id = $1', [req.userId]);
    res.status(200).json({ ok: true });
}));

// notun backup code (purono gulo batil)
app.post('/api/2fa/backup', handle(async (req, res) => {
    const u = (await db.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!u.totp_enabled) return res.status(400).json({ message: 'Turn on two-step verification first.' });
    if (!verifyTotp(u.totp_secret, req.body.code)) return res.status(400).json({ message: 'Wrong code.', field: 'code' });
    const codes = Array.from({ length: 8 }, () => { const r = crypto.randomBytes(5).toString('hex'); return r.slice(0, 5) + '-' + r.slice(5); });
    await db.query('UPDATE users SET totp_backup = $1 WHERE id = $2', [codes.map(backupHash), req.userId]);
    res.status(200).json({ ok: true, backup_codes: codes });
}));

// ==========================================
// 29. NOTUN DEVICE E LOGIN HOLE SOTORKOTA (email + push)
// ==========================================
async function isNewDevice(userId, req) {
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const { rows } = await db.query('SELECT user_agent FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
    if (!rows.length) return false;                              // ekdom prothom login: alert na
    const dev = deviceName(ua);
    return !rows.some(r => deviceName(r.user_agent) === dev);    // eki browser + OS aage chhilo na
}

async function sendLoginAlert(user, req) {
    const u = (await db.query('SELECT login_alerts FROM users WHERE id = $1', [user.id])).rows[0];
    if (!u || !u.login_alerts) return;
    const device = deviceName(req.headers['user-agent']);
    const ip = clientIp(req).replace(/(\d+)\.(\d+)$/, 'x.x');
    const when = new Date().toUTCString();
    sendPush([user.id], { title: '🔐 New login to TalkFav', body: device + ' · ' + when, tag: 'login-alert', url: '/dashboard.html' });
    if (!mailReady) return;
    const safe = (x) => String(x).replace(/[<>&"]/g, '');
    await sendMail(user.email, 'New login to your TalkFav account',
        `<div style="font-family:Arial,sans-serif;max-width:440px;margin:auto;padding:24px;border-radius:16px;background:#F0FAF5">
           <h2 style="margin:0 0 8px;color:#0E8F5B">TalkFav</h2>
           <p>Hi ${safe(user.name)},</p>
           <p>Your account was just used to log in on a new device:</p>
           <p style="background:#fff;padding:12px 14px;border-radius:12px;line-height:1.6"><b>${safe(device)}</b><br>IP: ${safe(ip)}<br>${safe(when)}</p>
           <p>If this was you, you don't need to do anything.</p>
           <p style="color:#B91C1C"><b>If this wasn't you</b>, open TalkFav → Settings → Privacy &amp; security, change your password and log out other devices.</p>
         </div>`);
}

app.post('/api/users/login-alerts', handle(async (req, res) => {
    await db.query('UPDATE users SET login_alerts = $1 WHERE id = $2', [!!req.body.on, req.userId]);
    res.status(200).json({ ok: true });
}));

// ==========================================
// 30. @USERNAME + PROFILE LINK
// ==========================================
async function assignUsername(u) {
    let base = String(u.name || u.email || 'user').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 14);
    if (base.length < 3) base = (String(u.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '') + 'user').slice(0, 14);
    for (let i = 0; i < 50; i++) {
        const name = i === 0 ? base : base + (i < 10 ? i : Math.floor(Math.random() * 9000 + 100));
        try {
            const r = await db.query('UPDATE users SET username = $1 WHERE id = $2 AND username IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE LOWER(username) = $1)', [name, u.id]);
            if (r.rowCount) return name;
            const already = await db.query('SELECT username FROM users WHERE id = $1', [u.id]);
            if (already.rows[0] && already.rows[0].username) return already.rows[0].username;
        } catch (e) { /* eki somoy onno keu nile abar cheshta */ }
    }
    return null;
}

app.get('/api/users/by-username/:username', handle(async (req, res) => {
    const name = String(req.params.username || '').toLowerCase().replace(/^@/, '');
    const r = await db.query('SELECT id FROM users WHERE LOWER(username) = $1 AND NOT banned', [name]);
    if (!r.rows.length) return res.status(404).json({ message: 'No user with this username.' });
    res.status(200).json({ id: r.rows[0].id });
}));

app.get('/api/users/username-available', handle(async (req, res) => {
    const name = String(req.query.u || '').toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_.]{3,20}$/.test(name)) return res.status(200).json({ ok: false, reason: 'format' });
    const r = await db.query('SELECT 1 FROM users WHERE LOWER(username) = $1 AND id <> $2', [name, req.userId]);
    res.status(200).json({ ok: !r.rows.length });
}));

// ==========================================
// 31. DEMO ACCOUNT (recruiter / visitor ek click e dekhte parbe)
// ==========================================
const DEMO_EMAIL = 'demo@talkfav.app';
async function isDemoUser(id) {
    const r = await db.query('SELECT is_demo FROM users WHERE id = $1', [id]);
    return !!(r.rows[0] && r.rows[0].is_demo);
}

// demo user + 2 jon demo bondhu + kichu chat + ekta group (protidin notun kore)
async function seedDemo() {
    const pw = await bcrypt.hash(crypto.randomBytes(18).toString('hex'), 10);     // password diye login kora jabe na
    const people = [
        { email: DEMO_EMAIL, name: 'Demo Visitor', username: 'demo', bio: 'Exploring TalkFav 👋', country: 'Bangladesh' },
        { email: 'nadia.demo@talkfav.app', name: 'Nadia Rahman', username: 'nadia.demo', bio: 'Coffee, books and long voice notes.', country: 'Bangladesh' },
        { email: 'rafi.demo@talkfav.app', name: 'Rafi Ahmed', username: 'rafi.demo', bio: 'Weekend cricket captain 🏏', country: 'Bangladesh' }
    ];
    const ids = [];
    for (const p of people) {
        const ex = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [p.email]);
        if (ex.rows.length) {
            ids.push(ex.rows[0].id);
            await db.query('UPDATE users SET name = $1, bio = $2, is_demo = TRUE, banned = FALSE, totp_enabled = FALSE WHERE id = $3', [p.name, p.bio, ex.rows[0].id]);
        } else {
            const ins = await db.query(
                'INSERT INTO users (name, email, phone, country, password, password_set, is_demo, bio, username) VALUES ($1, $2, $3, $4, $5, FALSE, TRUE, $6, $7) RETURNING id',
                [p.name, p.email, '+8801700000000', p.country, pw, p.bio, p.username]
            );
            ids.push(ins.rows[0].id);
        }
    }
    const [demo, nadia, rafi] = ids;
    // purono demo chat muche notun kore (onno user der sathe kichu chhui na)
    await db.query('DELETE FROM messages WHERE sender_id = ANY($1::int[]) OR receiver_id = ANY($1::int[])', [ids]);
    await db.query('DELETE FROM chat_groups WHERE created_by = ANY($1::int[])', [ids]);
    await db.query('DELETE FROM friend_requests WHERE sender_id = ANY($1::int[]) OR receiver_id = ANY($1::int[])', [ids]);
    await db.query('DELETE FROM statuses WHERE user_id = ANY($1::int[])', [ids]);
    for (const f of [nadia, rafi]) {
        await db.query("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'accepted')", [f, demo]);
    }
    await db.query("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'accepted')", [nadia, rafi]);
    const ago = (min) => new Date(Date.now() - min * 60000);
    const dm = [
        [nadia, demo, 'Hey! Welcome to TalkFav 😊', 95], [demo, nadia, 'Thanks! This looks really clean.', 93],
        [nadia, demo, 'Try sending a voice message or a sticker 🎤', 90], [demo, nadia, 'On it! Video call later?', 60],
        [nadia, demo, 'Sure, after 8? I will call you 📞', 12],
        [rafi, demo, 'Cricket on Friday? 🏏', 40], [demo, rafi, 'Count me in!', 38], [rafi, demo, 'Great, I made a group for the team', 35]
    ];
    for (const [from, to, text, min] of dm) {
        await db.query('INSERT INTO messages (sender_id, receiver_id, message, created_at, is_read) VALUES ($1, $2, $3, $4, $5)', [from, to, text, ago(min), from === demo || min > 20]);
    }
    const g = await db.query('INSERT INTO chat_groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING id', ['Friday Cricket 🏏', 'Weekend matches and plans', rafi]);
    const gid = g.rows[0].id;
    await db.query("INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')", [gid, rafi, demo, nadia]);
    const gm = [[rafi, 'Match starts at 4 PM, field near the lake', 34], [nadia, 'I will bring snacks 🍿', 33], [rafi, '📊 Which time works best?', 32]];
    let pollMsg = null;
    for (const [from, text, min] of gm) {
        const r = await db.query('INSERT INTO messages (sender_id, group_id, message, created_at) VALUES ($1, $2, $3, $4) RETURNING id', [from, gid, text, ago(min)]);
        pollMsg = r.rows[0].id;
    }
    const poll = await db.query('INSERT INTO polls (message_id, question, options, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [pollMsg, 'Which time works best?', JSON.stringify(['4 PM', '5 PM', '6 PM']), rafi]);
    await db.query('INSERT INTO poll_votes (poll_id, user_id, option_index) VALUES ($1, $2, 0), ($1, $3, 1)', [poll.rows[0].id, rafi, nadia]);
    await db.query("INSERT INTO statuses (user_id, type, text, bg) VALUES ($1, 'text', 'Good vibes only ✨', '#0E8F5B')", [nadia]);
    return demo;
}

const limitDemo = rateLimit({ name: 'demo', windowMs: 15 * 60 * 1000, max: 20, message: 'Too many demo logins.', key: clientIp });
app.post('/api/auth/demo', limitDemo, handle(async (req, res) => {
    let r = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [DEMO_EMAIL]);
    if (!r.rows.length) { await seedDemo(); r = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [DEMO_EMAIL]); }
    const user = r.rows[0];
    const token = await createSession(user.id, req);
    res.status(200).json({ message: 'Welcome to the demo!', user: publicUser(user, token) });
}));
// protidin demo notun kore (keu kichu bodlale-o)
setInterval(() => seedDemo().catch(e => console.error('demo seed failed:', e.message)), 24 * 60 * 60 * 1000);

// ==========================================
// 5c. REACTION / PIN
// ==========================================
const REACTIONS = ['love', 'haha', 'like', 'wow', 'fire'];

// Reaction: notun dile boshao/bodlao, eki ta abar dile tule nao
app.post('/api/messages/react', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    const reaction = req.body.reaction;
    if (!message_id || !REACTIONS.includes(reaction)) return res.status(400).json({ message: 'Invalid reaction.' });

    const m = await messageAccess(message_id, req.userId);
    if (!m || m.is_system) return res.status(404).json({ message: 'Message not found.' });

    const { rows } = await db.query(
        'SELECT reaction FROM message_reactions WHERE message_id = $1 AND user_id = $2',
        [message_id, req.userId]
    );
    const same = rows.length > 0 && rows[0].reaction === reaction;
    if (same) {
        await db.query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2', [message_id, req.userId]);
    } else {
        // ON CONFLICT ... DO UPDATE = na thakle notun, thakle bodlao
        await db.query(`
            INSERT INTO message_reactions (message_id, user_id, reaction) VALUES ($1, $2, $3)
            ON CONFLICT (message_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction
        `, [message_id, req.userId, reaction]);
    }
    emitMany(m.audience, 'message:changed', { id: message_id, group_id: m.group_id });
    res.status(200).json({ ok: true, removed: same });
}));

// Pin / Unpin: conversation er je keu korte parbe, sobai dekhbe
app.post('/api/messages/pin', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    const pin = !!req.body.pin;
    if (!message_id) return res.status(400).json({ message: 'message_id is required' });

    const m = await messageAccess(message_id, req.userId);
    if (!m || m.is_system) return res.status(404).json({ message: 'Message not found.' });

    if (pin) await db.query('UPDATE messages SET pinned_at = NOW(), pinned_by = $1 WHERE id = $2', [req.userId, message_id]);
    else await db.query('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1', [message_id]);

    emitMany(m.audience, 'message:changed', { id: message_id, group_id: m.group_id });
    res.status(200).json({ ok: true });
}));

// ==========================================
// 7. GROUP CHAT
// ==========================================
const PERMISSION_VALUES = ['admins', 'all'];
const MAX_GROUP_MEMBERS = 100;

// je kaj korte "admins" ba "all" setting lage
function allowed(group, setting) {
    return group.role === 'admin' || group[setting] === 'all';
}

async function userNames(ids) {
    if (!ids.length) return [];
    const { rows } = await db.query('SELECT name FROM users WHERE id = ANY($1::int[]) ORDER BY name', [ids]);
    return rows.map(r => r.name);
}

// add korar moto manush: amar friend, block nai, ekhono member na
async function addableUsers(actorId, groupId, ids) {
    const friendIds = await friendIdsOf(actorId);
    const wanted = [...new Set(ids.map(Number).filter(Boolean))].filter(id => friendIds.includes(id));
    if (!wanted.length) return [];
    const { rows } = await db.query(`
        SELECT u.id FROM users u
        WHERE u.id = ANY($1::int[])
          AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = $2 AND gm.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM user_blocks b
                          WHERE (b.blocker_id = $3 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $3))
    `, [wanted, groupId || 0, actorId]);
    return rows.map(r => r.id);
}

// Create Group: nam + (choile) description + friend der bachhai
app.post('/api/groups', handle(async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body.description === 'string' ? req.body.description.trim().slice(0, 500) : '';
    const ids = Array.isArray(req.body.member_ids) ? req.body.member_ids : [];
    if (!name || name.length > 100) return res.status(400).json({ message: 'Group name is required (max 100 characters).' });

    const members = await addableUsers(req.userId, null, ids);
    if (!members.length) return res.status(400).json({ message: 'Choose at least one friend.' });
    if (members.length + 1 > MAX_GROUP_MEMBERS) return res.status(400).json({ message: `A group can have at most ${MAX_GROUP_MEMBERS} members.` });

    const { rows } = await db.query(
        'INSERT INTO chat_groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING id',
        [name, description || null, req.userId]
    );
    const groupId = rows[0].id;
    // je banalo se admin, baki sobai member
    await db.query("INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')", [groupId, req.userId]);
    await db.query(
        "INSERT INTO group_members (group_id, user_id, role) SELECT $1, unnest($2::int[]), 'member'",
        [groupId, members]
    );
    await systemMessage(groupId, req.userId, 'created the group "' + name + '"');
    emitMany([req.userId, ...members], 'groups:changed', { group_id: groupId });
    res.status(200).json({ ok: true, group_id: groupId });
}));

// amar sob group: unread, shesh message, member songkhya
app.get('/api/groups', handle(async (req, res) => {
    const { rows } = await db.query(`
        SELECT g.id, g.name, g.photo, g.description, gm.role, gm.muted,
               (SELECT COUNT(*)::int FROM group_members x WHERE x.group_id = g.id) AS member_count,
               (SELECT COUNT(*)::int FROM messages m
                 WHERE m.group_id = g.id AND m.id > gm.last_read_id AND m.sender_id <> $1
                   AND m.deleted_at IS NULL AND m.is_system = FALSE) AS unread,
               (SELECT COUNT(*)::int FROM messages m
                 WHERE m.group_id = g.id AND m.id > gm.last_read_id AND m.deleted_at IS NULL
                   AND $1 = ANY(m.mentions)) AS mention_unread,
               lm.id AS last_id, lm.created_at AS last_at, lm.is_system AS last_is_system,
               lm.sender_id AS last_sender_id, lu.name AS last_sender_name,
               CASE WHEN lm.message <> '' THEN lm.message
                    WHEN lm.attachment_type = 'image' THEN '📷 Photo'
                    WHEN lm.attachment_type = 'video' THEN '🎬 Video'
                    WHEN lm.attachment_type = 'audio' THEN '🎤 Voice message'
                    WHEN lm.attachment_type = 'file' THEN '📎 ' || lm.attachment_name
                    WHEN lm.attachment_type = 'gif' THEN '🎞️ GIF'
                    WHEN lm.attachment_type = 'sticker' THEN '🧸 Sticker'
                    WHEN lm.attachment_type = 'location' THEN '📍 Location'
                    ELSE '' END AS last_message
        FROM group_members gm
        JOIN chat_groups g ON g.id = gm.group_id
        LEFT JOIN LATERAL (
            SELECT * FROM messages m WHERE m.group_id = g.id AND m.deleted_at IS NULL
              AND (m.expires_at IS NULL OR m.expires_at > NOW()) ORDER BY m.id DESC LIMIT 1
        ) lm ON TRUE
        LEFT JOIN users lu ON lu.id = lm.sender_id
        WHERE gm.user_id = $1
        ORDER BY COALESCE(lm.id, 0) DESC
    `, [req.userId]);
    res.status(200).json({ groups: rows });
}));

// Group Member List + settings
app.get('/api/groups/:id', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const g = id && await groupAccess(id, req.userId);
    if (!g) return res.status(404).json({ message: 'Group not found.' });
    const { rows } = await db.query(`
        SELECT u.id, u.name, u.avatar, gm.role, gm.joined_at
        FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1
        ORDER BY (gm.role = 'admin') DESC, u.name
    `, [id]);
    const friendIds = await friendIdsOf(req.userId);
    res.status(200).json({
        group: {
            id: g.id, name: g.name, description: g.description, photo: g.photo,
            created_by: g.created_by, created_at: g.created_at,
            add_permission: g.add_permission, edit_permission: g.edit_permission, send_permission: g.send_permission,
            my_role: g.role, muted: g.muted
        },
        // online shudhu friend der dekhano hoy (gopaniyota)
        members: await (async () => {
            const priv = (await db.query('SELECT id, hide_online, avatar_visibility FROM users WHERE id = ANY($1::int[])', [rows.map(r => r.id)])).rows;
            const pv = Object.fromEntries(priv.map(p => [p.id, p]));
            return rows.map(r => {
                const self = r.id === req.userId, fr = friendIds.includes(r.id), p = pv[r.id] || {};
                return {
                    ...r,
                    avatar: (!self && !fr && p.avatar_visibility === 'friends') ? null : r.avatar,
                    online: (self || (fr && !p.hide_online)) ? onlineUsers.has(r.id) : null
                };
            });
        })()
    });
}));

// Group Message History (pagination soho)
app.get('/api/groups/:id/messages', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || !(await groupAccess(id, req.userId))) return res.status(404).json({ message: 'Group not found.' });
    const data = await fetchConversation('m.group_id = $1', [id], req.userId, req.query);
    // Seen by: amar message gulo koto jon porechhe (jara read receipts bondho rakhe na)
    const { rows: mem } = await db.query(`
        SELECT gm.user_id, gm.last_read_id, u.read_receipts
        FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1
    `, [id]);
    const meRow = mem.find(r => r.user_id === req.userId);
    const readers = mem.filter(r => r.user_id !== req.userId && r.read_receipts);
    data.messages.forEach(m => {
        if (m.sender_id === req.userId && !m.is_system) {
            m.seen_count = meRow && meRow.read_receipts ? readers.filter(r => r.last_read_id >= m.id).length : null;
            m.member_count = mem.length - 1;
        }
    });
    await hideAvatars(data.messages, req.userId);
    res.status(200).json(data);
}));

// group khulle / dekhle porha hoyeche
app.post('/api/groups/:id/read', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await db.query(`
        UPDATE group_members SET last_read_id = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE group_id = $1)
        WHERE group_id = $1 AND user_id = $2
    `, [id, req.userId]);
    res.status(200).json({ ok: true });
    // onnora "Seen by" update pabe (read receipts bondho thakle na)
    try {
        const me = (await db.query('SELECT read_receipts FROM users WHERE id = $1', [req.userId])).rows[0];
        if (me && me.read_receipts) emitMany((await groupMemberIds(id)).filter(x => x !== req.userId), 'group:read', { group_id: id, user_id: req.userId });
    } catch (e) {}
}));

// Group Name / Description
app.post('/api/groups/:id/update', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const g = id && await groupAccess(id, req.userId);
    if (!g) return res.status(404).json({ message: 'Group not found.' });
    if (!allowed(g, 'edit_permission')) return res.status(403).json({ message: 'Only admins can change group info.' });

    const name = typeof req.body.name === 'string' ? req.body.name.trim() : g.name;
    const description = typeof req.body.description === 'string' ? req.body.description.trim().slice(0, 500) : g.description;
    if (!name || name.length > 100) return res.status(400).json({ message: 'Group name is required (max 100 characters).' });

    await db.query('UPDATE chat_groups SET name = $1, description = $2 WHERE id = $3', [name, description || null, id]);
    if (name !== g.name) await systemMessage(id, req.userId, 'changed the group name to "' + name + '"');
    else if ((description || null) !== (g.description || null)) await systemMessage(id, req.userId, 'changed the group description');
    emitMany(await groupMemberIds(id), 'groups:changed', { group_id: id });
    res.status(200).json({ ok: true });
}));

// Group Photo (Cloudinary). Khali pathale muche jay
app.post('/api/groups/:id/photo', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const g = id && await groupAccess(id, req.userId);
    if (!g) return res.status(404).json({ message: 'Group not found.' });
    if (!allowed(g, 'edit_permission')) return res.status(403).json({ message: 'Only admins can change the group photo.' });

    if (!req.body.url) {
        await db.query('UPDATE chat_groups SET photo = NULL, photo_public_id = NULL WHERE id = $1', [id]);
        if (g.photo_public_id) cloudDestroy(g.photo_public_id, 'image');
        await systemMessage(id, req.userId, 'removed the group photo');
    } else {
        const att = cleanAttachment({ type: 'image', url: req.body.url, public_id: req.body.public_id }, req.userId);
        if (!att) return res.status(400).json({ message: 'Invalid image.' });
        await db.query('UPDATE chat_groups SET photo = $1, photo_public_id = $2 WHERE id = $3', [att.url, att.publicId, id]);
        if (g.photo_public_id && g.photo_public_id !== att.publicId) cloudDestroy(g.photo_public_id, 'image');
        await systemMessage(id, req.userId, 'changed the group photo');
    }
    emitMany(await groupMemberIds(id), 'groups:changed', { group_id: id });
    res.status(200).json({ ok: true });
}));

// Add Members (setting onujayi admin ba sobai)
app.post('/api/groups/:id/members/add', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const g = id && await groupAccess(id, req.userId);
    if (!g) return res.status(404).json({ message: 'Group not found.' });
    if (!allowed(g, 'add_permission')) return res.status(403).json({ message: 'Only admins can add members.' });

    const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
    const toAdd = await addableUsers(req.userId, id, ids);
    if (!toAdd.length) return res.status(400).json({ message: 'Choose friends who are not in the group yet.' });
    const current = await groupMemberIds(id);
    if (current.length + toAdd.length > MAX_GROUP_MEMBERS) return res.status(400).json({ message: `A group can have at most ${MAX_GROUP_MEMBERS} members.` });

    await db.query("INSERT INTO group_members (group_id, user_id, role) SELECT $1, unnest($2::int[]), 'member' ON CONFLICT DO NOTHING", [id, toAdd]);
    await systemMessage(id, req.userId, 'added ' + (await userNames(toAdd)).join(', '));
    emitMany([...current, ...toAdd], 'groups:changed', { group_id: id });
    res.status(200).json({ ok: true, added: toAdd.length });
}));

// Remove Members (shudhu admin; age admin role tule nite hobe)
app.post('/api/groups/:id/members/remove', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = parseInt(req.body.user_id, 10);
    const g = id && await groupAccess(id, req.userId);
    if (!g) return res.status(404).json({ message: 'Group not found.' });
    if (g.role !== 'admin') return res.status(403).json({ message: 'Only admins can remove members.' });
    if (!target || target === req.userId) return res.status(400).json({ message: 'Use "Leave group" to leave.' });

    const t = await db.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [id, target]);
    if (!t.rows.length) return res.status(404).json({ message: 'This person is not in the group.' });
    if (t.rows[0].role === 'admin') return res.status(400).json({ message: 'Remove their admin role first.' });

    const before = await groupMemberIds(id);
    const name = (await userNames([target]))[0] || 'a member';
    await systemMessage(id, req.userId, 'removed ' + name);           // she-o dekhuk ke tule dilo
    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [id, target]);
    emitMany(before, 'groups:changed', { group_id: id, removed: target });
    res.status(200).json({ ok: true });
}));

// Group Admin / Multiple Admins: admin banano ba admin theke soriye member kora
app.post('/api/groups/:id/admins', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = parseInt(req.body.user_id, 10);
    const makeAdmin = !!req.body.admin;
    const g = id && await groupAccess(id, req.userId);
    if (!g) return res.status(404).json({ message: 'Group not found.' });
    if (g.role !== 'admin') return res.status(403).json({ message: 'Only admins can change admins.' });
    if (!makeAdmin && target === g.created_by) return res.status(400).json({ message: 'The group creator is always an admin.' });

    const r = await db.query('UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3', [makeAdmin ? 'admin' : 'member', id, target]);
    if (!r.rowCount) return res.status(404).json({ message: 'This person is not in the group.' });
    // anto ekjon admin thakbei
    const admins = await db.query("SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = $1 AND role = 'admin'", [id]);
    if (!admins.rows[0].n) {
        await db.query("UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND user_id = $2", [id, target]);
        return res.status(400).json({ message: 'A group needs at least one admin.' });
    }
    const name = (await userNames([target]))[0] || 'a member';
    await systemMessage(id, req.userId, makeAdmin ? 'made ' + name + ' an admin' : 'removed ' + name + ' as admin');
    emitMany(await groupMemberIds(id), 'groups:changed', { group_id: id });
    res.status(200).json({ ok: true });
}));

// Group Admin Permissions: ke add korte parbe, ke info bodlate parbe, ke message dite parbe
app.post('/api/groups/:id/settings', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const g = id && await groupAccess(id, req.userId);
    if (!g) return res.status(404).json({ message: 'Group not found.' });
    if (g.role !== 'admin') return res.status(403).json({ message: 'Only admins can change group settings.' });

    const pick = (key) => PERMISSION_VALUES.includes(req.body[key]) ? req.body[key] : g[key];
    const next = { add_permission: pick('add_permission'), edit_permission: pick('edit_permission'), send_permission: pick('send_permission') };
    await db.query(
        'UPDATE chat_groups SET add_permission = $1, edit_permission = $2, send_permission = $3 WHERE id = $4',
        [next.add_permission, next.edit_permission, next.send_permission, id]
    );
    if (next.send_permission !== g.send_permission) {
        await systemMessage(id, req.userId, next.send_permission === 'admins' ? 'allowed only admins to send messages' : 'allowed all members to send messages');
    }
    emitMany(await groupMemberIds(id), 'groups:changed', { group_id: id });
    res.status(200).json({ ok: true });
}));

// Group Notifications: nijer jonno mute / unmute
app.post('/api/groups/:id/mute', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await db.query('UPDATE group_members SET muted = $1 WHERE group_id = $2 AND user_id = $3', [!!req.body.muted, id, req.userId]);
    if (!r.rowCount) return res.status(404).json({ message: 'Group not found.' });
    emitToUser(req.userId, 'groups:changed', { group_id: id });
    res.status(200).json({ ok: true });
}));

// Leave Group: shesh admin chole gele shobcheye purono member admin hoy; keu na thakle group muche jay
app.post('/api/groups/:id/leave', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const g = id && await groupAccess(id, req.userId);
    if (!g) return res.status(404).json({ message: 'Group not found.' });

    await systemMessage(id, req.userId, 'left the group');
    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [id, req.userId]);
    emitToUser(req.userId, 'groups:changed', { group_id: id, removed: req.userId });

    const left = await groupMemberIds(id);
    if (!left.length) {
        await db.query('DELETE FROM chat_groups WHERE id = $1', [id]);
        if (g.photo_public_id) cloudDestroy(g.photo_public_id, 'image');
        return res.status(200).json({ ok: true });
    }
    const admins = await db.query("SELECT 1 FROM group_members WHERE group_id = $1 AND role = 'admin' LIMIT 1", [id]);
    if (!admins.rows.length) {
        const oldest = await db.query('SELECT user_id FROM group_members WHERE group_id = $1 ORDER BY joined_at, user_id LIMIT 1', [id]);
        await db.query("UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND user_id = $2", [id, oldest.rows[0].user_id]);
        await systemMessage(id, oldest.rows[0].user_id, 'is now an admin');
    }
    emitMany(left, 'groups:changed', { group_id: id });
    res.status(200).json({ ok: true });
}));

// ==========================================
// 6. Server Listen (ALWAYS AT THE VERY BOTTOM)
// ==========================================
const PORT = process.env.PORT || 3000;
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} already in use! Age purono "node server.js" bondho koro (Ctrl + C).`);
    else console.error('Server error:', err);
    process.exit(1);
});

// age database thik ache kina dekho, tarpor server chalu
setupDatabase()
    .then(() => {
        console.log('Connected to PostgreSQL database');
        seedDemo().catch(e => console.error('demo seed failed:', e.message));
        server.listen(PORT, () => console.log(`Server is running on port ${PORT} (with realtime)`));
    })
    .catch((err) => {
        console.error('Database setup failed:', err.message);
        console.error('DATABASE_URL thik ache kina, ar Aiven e service "Running" kina dekho.');
        process.exit(1);
    });