const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);                       // express + socket.io ek-i server e
const io = new Server(server, { cors: { origin: '*' } });

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ==========================================
// Frontend: shudhu assets folder ar 3 ta page public
// (age puro folder public chhilo, tai server.js / package.json o je keu dekhte parto)
// ==========================================
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const sendPage = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get('/', sendPage('index.html'));
app.get('/index.html', sendPage('index.html'));
app.get('/register.html', sendPage('register.html'));
app.get('/dashboard.html', sendPage('dashboard.html'));

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

function signToken(userId) {
    const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 })).toString('base64url');
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
    }).catch(err => console.error('call log failed:', err.message));
}

io.on('connection', (socket) => {
    // login token chhara socket connect hobe na
    const userId = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!userId) { socket.disconnect(true); return; }

    socket.data.userId = userId;
    socket.join('user:' + userId);

    const count = (onlineUsers.get(userId) || 0) + 1;
    onlineUsers.set(userId, count);

    // nijer online friend der list pathao + friend der bolo "ami online"
    const sendPresence = () => getFriendIds(userId, (friendIds) => {
        socket.emit('presence:list', friendIds.filter(id => onlineUsers.has(id)));
    });
    sendPresence();
    if (count === 1) {
        getFriendIds(userId, (friendIds) => {
            friendIds.forEach(id => emitToUser(id, 'presence', { user_id: userId, online: true }));
        });
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
    console.log('All tables ready!');
}

// ==========================================
// Login check: register/login chhara sob /api e token lagbe
// ==========================================
app.use('/api', (req, res, next) => {
    if (req.path === '/register' || req.path === '/login') return next();
    const header = req.headers.authorization || '';
    const userId = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!userId) return res.status(401).json({ message: 'Please login again.' });
    req.userId = userId;
    next();
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
        if (!res.headersSent) res.status(500).json({ message: 'Server error. Please try again.' });
    }
};

// ==========================================
// 1. User Registration Route
// ==========================================
app.post('/api/register', handle(async (req, res) => {
    const { name, email, country, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
        return res.status(400).json({ message: 'Please fill in all required fields.' });
    }

    const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rows.length) return res.status(400).json({ message: 'Email is already registered!' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query(
        'INSERT INTO users (name, email, country, phone, password) VALUES ($1, $2, $3, $4, $5)',
        [name, email, country || null, phone, hashedPassword]
    );
    res.status(201).json({ message: 'User registered successfully!' });
}));

// ==========================================
// 2. User Login Route
// ==========================================
app.post('/api/login', handle(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required!' });

    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!rows.length) return res.status(400).json({ message: 'User not found! Please register first.' });

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid password!' });

    res.status(200).json({
        message: 'Login successful!',
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            country: user.country,
            phone: user.phone,
            avatar: user.avatar || null,
            cover: user.cover || null,
            token: signToken(user.id)
        }
    });
}));

// ==========================================
// 3. SEARCH USERS ROUTE
// ==========================================
app.get('/api/users/search', handle(async (req, res) => {
    const query = String(req.query.query || '').trim();
    if (!query) return res.status(200).json({ users: [] });
    // ILIKE = boro/choto hater okkhor er parthokko chhara khoje
    // relation: friend / sent (ami pathiyechi) / received (se pathiyechhe) / none
    // block kora (je kono dik theke) manush search e ashbe na
    const { rows } = await db.query(`
        SELECT u.id, u.name, u.email, u.country, u.avatar,
               CASE WHEN fr.status = 'accepted' THEN 'friend'
                    WHEN fr.status = 'pending' AND fr.sender_id = $2 THEN 'sent'
                    WHEN fr.status = 'pending' THEN 'received'
                    ELSE 'none' END AS relation,
               fr.id AS request_id
        FROM users u
        LEFT JOIN friend_requests fr
               ON (fr.sender_id = $2 AND fr.receiver_id = u.id) OR (fr.sender_id = u.id AND fr.receiver_id = $2)
        WHERE (u.name ILIKE $1 OR u.email ILIKE $1) AND u.id <> $2
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
        SELECT DISTINCT u.id, u.name, u.email, u.country, u.phone, u.avatar, u.last_seen_at
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

    const u = await db.query('SELECT id, name, email, country, avatar, cover, created_at, last_seen_at FROM users WHERE id = $1', [id]);
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
            avatar: user.avatar,
            cover: user.cover,
            created_at: user.created_at,
            email: close ? user.email : null,
            last_seen_at: relation === 'friend' ? user.last_seen_at : null,
            online: relation === 'friend' ? onlineUsers.has(user.id) : null
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
    const att = req.body.attachment ? cleanAttachment(req.body.attachment, sender_id) : null;
    if (req.body.attachment && !att) return res.status(400).json({ message: 'Invalid file.' });
    // lekha othoba file - je kono ekta thaktei hobe
    if ((!receiver_id && !group_id) || (!message && !att) || message.length > 5000) return res.status(400).json({ message: 'Invalid message.' });

    if (group_id) {
        // group: member hote hobe; "shudhu admin message dite parbe" setting thakle admin
        const g = await groupAccess(group_id, sender_id);
        if (!g) return res.status(403).json({ message: 'You are not a member of this group.' });
        if (g.send_permission === 'admins' && g.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can send messages in this group.' });
        }
    } else if (!(await isFriend(sender_id, receiver_id))) {
        // shudhu friend ke message pathano jabe
        return res.status(403).json({ message: 'You can only message your friends.' });
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
            attachment_mime, attachment_public_id, attachment_duration)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id
    `, [sender_id, receiver_id, group_id, message, reply_to_id,
        att && att.url, att && att.type, att && att.name, att && att.size,
        att && att.mime, att && att.publicId, att && att.duration]);

    if (group_id) {
        await db.query('UPDATE group_members SET last_read_id = $1 WHERE group_id = $2 AND user_id = $3', [rows[0].id, group_id, sender_id]);
        emitMany(await groupMemberIds(group_id), 'group:message', { group_id, id: rows[0].id, sender_id });
    } else {
        const payload = { id: rows[0].id, sender_id, receiver_id };
        emitToUser(receiver_id, 'message:new', payload);     // jar kache gelo
        emitToUser(sender_id, 'message:new', payload);       // nijer onno tab
    }
    res.status(200).json({ ok: true, message: 'Message sent!' });
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
                    ELSE '' END AS last_message
        FROM messages m
        JOIN (
            SELECT sender_id, COUNT(*)::int AS cnt, MAX(id) AS mx
            FROM messages
            WHERE receiver_id = $1 AND is_read = FALSE AND deleted_at IS NULL
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
               ru.name AS reply_sender_name
        FROM messages m
        JOIN users su ON su.id = m.sender_id
        LEFT JOIN message_hidden h ON h.message_id = m.id AND h.user_id = ${hiddenFor}
        LEFT JOIN messages r ON r.id = m.reply_to_id
        LEFT JOIN users ru ON ru.id = r.sender_id
        WHERE (${convoSql}) AND h.message_id IS NULL ${extra}
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
          AND m.is_system = FALSE AND m.message ILIKE ${like}
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
    emitToUser(friend_id, 'messages:read', { reader_id: req.userId });   // sender er ✓✓
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
               lm.id AS last_id, lm.created_at AS last_at, lm.is_system AS last_is_system,
               lm.sender_id AS last_sender_id, lu.name AS last_sender_name,
               CASE WHEN lm.message <> '' THEN lm.message
                    WHEN lm.attachment_type = 'image' THEN '📷 Photo'
                    WHEN lm.attachment_type = 'video' THEN '🎬 Video'
                    WHEN lm.attachment_type = 'audio' THEN '🎤 Voice message'
                    WHEN lm.attachment_type = 'file' THEN '📎 ' || lm.attachment_name
                    ELSE '' END AS last_message
        FROM group_members gm
        JOIN chat_groups g ON g.id = gm.group_id
        LEFT JOIN LATERAL (
            SELECT * FROM messages m WHERE m.group_id = g.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1
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
        members: rows.map(r => ({ ...r, online: (r.id === req.userId || friendIds.includes(r.id)) ? onlineUsers.has(r.id) : null }))
    });
}));

// Group Message History (pagination soho)
app.get('/api/groups/:id/messages', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || !(await groupAccess(id, req.userId))) return res.status(404).json({ message: 'Group not found.' });
    const data = await fetchConversation('m.group_id = $1', [id], req.userId, req.query);
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
        server.listen(PORT, () => console.log(`Server is running on port ${PORT} (with realtime)`));
    })
    .catch((err) => {
        console.error('Database setup failed:', err.message);
        console.error('DATABASE_URL thik ache kina, ar Aiven e service "Running" kina dekho.');
        process.exit(1);
    });
