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

// socket er code callback style e lekha, tai ei duita wrapper
function getFriendIds(userId, cb) { friendIdsOf(userId).then(cb, () => cb([])); }
function areFriends(a, b, cb) { isFriend(a, b).then(cb, () => cb(false)); }

function emitToUser(userId, event, payload) {
    io.to('user:' + userId).emit(event, payload);
}

// ---------- audio/video call (shudhu signaling; audio/video browser to browser) ----------
const activeCalls = new Map();      // userId -> call { caller, callee, accepted, timer }

function finishCall(call, reason) {
    clearTimeout(call.timer);
    activeCalls.delete(call.caller);
    activeCalls.delete(call.callee);
    emitToUser(call.caller, 'call:ended', { from: call.callee, reason });
    emitToUser(call.callee, 'call:ended', { from: call.caller, reason });
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
            if (!onlineUsers.has(to)) return socket.emit('call:unavailable', { to, reason: 'offline' });
            if (activeCalls.has(to)) return socket.emit('call:unavailable', { to, reason: 'busy' });
            if (activeCalls.has(userId)) return socket.emit('call:unavailable', { to, reason: 'busy-self' });

            const call = { caller: userId, callee: to, accepted: false, timer: null };
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
        const dropped = activeCalls.get(userId);
        if (dropped) finishCall(dropped, 'disconnected');
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

    // file pathanor jonno notun column (age theke table thakleo jog hobe)
    const attachmentColumns = [
        'attachment_url TEXT', 'attachment_type VARCHAR(10)', 'attachment_name TEXT',
        'attachment_size INT', 'attachment_mime VARCHAR(100)', 'attachment_public_id TEXT',
        'attachment_duration REAL'
    ];
    for (const col of attachmentColumns) {
        await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS ' + col);
    }

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
    const { rows } = await db.query(`
        SELECT id, name, email, country, phone, avatar FROM users
        WHERE (name ILIKE $1 OR email ILIKE $1) AND id <> $2
        ORDER BY name LIMIT 30
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
        SELECT DISTINCT u.id, u.name, u.email, u.country, u.phone, u.avatar
        FROM users u
        JOIN friend_requests fr ON (u.id = fr.sender_id OR u.id = fr.receiver_id)
        WHERE (fr.sender_id = $1 OR fr.receiver_id = $1)
          AND fr.status = 'accepted'
          AND u.id <> $1
    `, [req.userId]);
    res.status(200).json({ friends: rows });
}));

// ==========================================
// 5. MESSAGING ROUTES
// ==========================================
app.post('/api/messages/send', handle(async (req, res) => {
    const sender_id = req.userId;
    const receiver_id = parseInt(req.body.receiver_id, 10);
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    let reply_to_id = parseInt(req.body.reply_to_id, 10) || null;
    const att = req.body.attachment ? cleanAttachment(req.body.attachment, sender_id) : null;
    if (req.body.attachment && !att) return res.status(400).json({ message: 'Invalid file.' });
    // lekha othoba file - je kono ekta thaktei hobe
    if (!receiver_id || (!message && !att) || message.length > 5000) return res.status(400).json({ message: 'Invalid message.' });

    // shudhu friend ke message pathano jabe
    if (!(await isFriend(sender_id, receiver_id))) {
        return res.status(403).json({ message: 'You can only message your friends.' });
    }

    // reply: je message e reply, seta ei duijoner conversation er hote hobe
    if (reply_to_id) {
        const check = await db.query(`
            SELECT 1 FROM messages WHERE id = $1
              AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2))
        `, [reply_to_id, sender_id, receiver_id]);
        if (!check.rows.length) reply_to_id = null;
    }

    const { rows } = await db.query(`
        INSERT INTO messages (sender_id, receiver_id, message, reply_to_id,
            attachment_url, attachment_type, attachment_name, attachment_size,
            attachment_mime, attachment_public_id, attachment_duration)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
    `, [sender_id, receiver_id, message, reply_to_id,
        att && att.url, att && att.type, att && att.name, att && att.size,
        att && att.mime, att && att.publicId, att && att.duration]);
    const payload = { id: rows[0].id, sender_id, receiver_id };
    emitToUser(receiver_id, 'message:new', payload);     // jar kache gelo
    emitToUser(sender_id, 'message:new', payload);       // nijer onno tab
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

app.get('/api/messages/:user1/:user2', handle(async (req, res) => {
    const { user1, user2 } = req.params;
    if (!sameUser(req, res, user1)) return;
    const other = parseInt(user2, 10);
    if (!other) return res.status(400).json({ message: 'Invalid user.' });

    // "Delete for me" kora message bad + reply hole mul message er choto preview
    const { rows: messages } = await db.query(`
        SELECT m.*,
               r.message    AS reply_message,
               r.sender_id  AS reply_sender_id,
               r.deleted_at AS reply_deleted_at,
               r.attachment_type AS reply_attachment_type,
               r.attachment_name AS reply_attachment_name
        FROM messages m
        LEFT JOIN message_hidden h ON h.message_id = m.id AND h.user_id = $1
        LEFT JOIN messages r ON r.id = m.reply_to_id
        WHERE ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1))
          AND h.message_id IS NULL
        ORDER BY m.id ASC
    `, [req.userId, other]);
    if (!messages.length) return res.status(200).json({ messages: [] });

    // ei message gulor sob reaction ek query te ene protita message e jure dao
    const ids = messages.map(m => m.id);
    const { rows: reactions } = await db.query(
        'SELECT message_id, user_id, reaction FROM message_reactions WHERE message_id = ANY($1::int[])',
        [ids]
    );
    const byMsg = {};
    reactions.forEach(r => { (byMsg[r.message_id] = byMsg[r.message_id] || []).push({ user_id: r.user_id, reaction: r.reaction }); });
    messages.forEach(m => { m.reactions = byMsg[m.id] || []; });
    res.status(200).json({ messages });
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

    const found = await db.query(`
        SELECT receiver_id, attachment_public_id, attachment_type FROM messages
        WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
    `, [message_id, req.userId]);
    if (!found.rows.length) return res.status(404).json({ message: 'Message not found.' });
    const old = found.rows[0];

    // lekha + file muche felo, row ta rakho (soft delete)
    await db.query(`
        UPDATE messages SET message = '', deleted_at = NOW(), pinned_at = NULL, pinned_by = NULL,
            attachment_url = NULL, attachment_type = NULL, attachment_name = NULL, attachment_size = NULL,
            attachment_mime = NULL, attachment_public_id = NULL, attachment_duration = NULL
        WHERE id = $1
    `, [message_id]);
    await db.query('DELETE FROM message_reactions WHERE message_id = $1', [message_id]);

    // file ta forward kore onno kotha-o thakte pare - shudhu keu ar na use korle Cloudinary theke muchbo
    if (old.attachment_public_id) {
        const still = await db.query('SELECT 1 FROM messages WHERE attachment_public_id = $1 LIMIT 1', [old.attachment_public_id]);
        if (!still.rows.length) cloudDestroy(old.attachment_public_id, old.attachment_type);
    }

    emitToUser(old.receiver_id, 'message:changed', { id: message_id });
    emitToUser(req.userId, 'message:changed', { id: message_id });
    res.status(200).json({ ok: true, message: 'Message unsent.' });
}));

// Delete for me: shudhu nijer screen theke lukano
app.post('/api/messages/delete-for-me', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    if (!message_id) return res.status(400).json({ message: 'message_id is required' });

    // shudhu nijer conversation er message hide kora jabe. Age theke thakle kichu korbe na
    await db.query(`
        INSERT INTO message_hidden (user_id, message_id)
        SELECT $1::int, id FROM messages WHERE id = $2 AND (sender_id = $1 OR receiver_id = $1)
        ON CONFLICT DO NOTHING
    `, [req.userId, message_id]);
    emitToUser(req.userId, 'message:changed', { id: message_id });   // nijer onno tab
    res.status(200).json({ ok: true, message: 'Deleted for you.' });
}));

// Edit: shudhu nijer pathano, unsend na kora message
app.post('/api/messages/edit', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message_id || !message || message.length > 5000) return res.status(400).json({ message: 'Invalid message.' });

    const { rows } = await db.query(`
        UPDATE messages SET message = $1, edited_at = NOW()
        WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
        RETURNING receiver_id
    `, [message, message_id, req.userId]);
    if (!rows.length) return res.status(404).json({ message: 'Message not found.' });

    emitToUser(rows[0].receiver_id, 'message:changed', { id: message_id });
    emitToUser(req.userId, 'message:changed', { id: message_id });
    res.status(200).json({ ok: true, message: 'Message edited.' });
}));

// Forward: ek message ek sathe koyekjon friend ke
app.post('/api/messages/forward', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    const ids = Array.isArray(req.body.friend_ids) ? req.body.friend_ids.map(Number).filter(Boolean) : [];
    if (!message_id || !ids.length || ids.length > 20) return res.status(400).json({ message: 'Choose 1 to 20 friends.' });

    // je message forward korbo seta amar conversation er, ar unsend kora na
    const { rows } = await db.query(`
        SELECT 1 FROM messages
        WHERE id = $1 AND deleted_at IS NULL AND (sender_id = $2 OR receiver_id = $2)
    `, [message_id, req.userId]);
    if (!rows.length) return res.status(404).json({ message: 'Message not found.' });

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
// 5c. REACTION / PIN
// ==========================================
const REACTIONS = ['love', 'haha', 'like', 'wow', 'fire'];

// message ta amar conversation er + unsend kora na hole, opor-pasher user er id dey
async function otherUserOfMessage(messageId, userId) {
    const { rows } = await db.query(`
        SELECT sender_id, receiver_id FROM messages
        WHERE id = $1 AND deleted_at IS NULL AND (sender_id = $2 OR receiver_id = $2)
    `, [messageId, userId]);
    if (!rows.length) return null;
    return rows[0].sender_id === userId ? rows[0].receiver_id : rows[0].sender_id;
}

// Reaction: notun dile boshao/bodlao, eki ta abar dile tule nao
app.post('/api/messages/react', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    const reaction = req.body.reaction;
    if (!message_id || !REACTIONS.includes(reaction)) return res.status(400).json({ message: 'Invalid reaction.' });

    const otherId = await otherUserOfMessage(message_id, req.userId);
    if (!otherId) return res.status(404).json({ message: 'Message not found.' });

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
    emitToUser(otherId, 'message:changed', { id: message_id });
    emitToUser(req.userId, 'message:changed', { id: message_id });
    res.status(200).json({ ok: true, removed: same });
}));

// Pin / Unpin: duijoner je keu korte parbe, duijon-i dekhbe
app.post('/api/messages/pin', handle(async (req, res) => {
    const message_id = parseInt(req.body.message_id, 10);
    const pin = !!req.body.pin;
    if (!message_id) return res.status(400).json({ message: 'message_id is required' });

    const otherId = await otherUserOfMessage(message_id, req.userId);
    if (!otherId) return res.status(404).json({ message: 'Message not found.' });

    if (pin) await db.query('UPDATE messages SET pinned_at = NOW(), pinned_by = $1 WHERE id = $2', [req.userId, message_id]);
    else await db.query('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1', [message_id]);

    emitToUser(otherId, 'message:changed', { id: message_id });
    emitToUser(req.userId, 'message:changed', { id: message_id });
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
