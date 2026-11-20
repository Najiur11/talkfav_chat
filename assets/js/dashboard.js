/* =====================================================
   Talkfav dashboard
   - sidebar tab: Chats / My Friends / Find People / Friend Requests / My Profile
   - unseen message count, notification (toast + sound + browser), seen ticks
   - realtime (Socket.IO): instant message, typing..., online green dot
   ===================================================== */

// Live Server (5500) e khulle server-er port 3000 e call jabe, nahole same server
const API = (location.port && location.port !== '3000') ? 'http://localhost:3000' : '';

const currentUser = JSON.parse(localStorage.getItem('user'));

// ---------- state ----------
let activeTab = 'chats';
let friends = [];
let pending = [];
let searchResults = [];
let searchTerm = '';
let friendFilter = '';
let activeChat = null;          // { id, name, email }
let lastMsgKey = null;
let pollTimer = null;
let unread = {};                // friendId -> { count, last_id, last_message }
let unreadReady = false;        // prothom load e notification dibo na
let lastNotified = {};          // friendId -> last notified message id
let friendsLoaded = false;
let redrawChats = null;         // chat list nijei abar draw korar function
let audioCtx = null;
let socket = null;              // Socket.IO connection (null hole polling diye cholbe)
let socketUp = false;
let online = new Set();         // je friend-ra ekhon online
let typingFrom = {};            // friendId -> timeout (se typing korche)
let myTypingTimer = null;
let lastTypingSent = 0;
let currentMsgs = [];           // khola chat er sob message (search / pin er jonno)

// reaction: database e shudhu key, screen e emoji
const REACTION_EMOJI = { love: '❤️', haha: '😂', like: '👍', wow: '😳', fire: '🔥' };

// ---------- 3D emoji (Microsoft Fluent Emoji 3D) ----------
// emoji -> ছবি: ❤️ = 2764-fe0f.webp. Version pin kora, tai hothat bodlabe na
const EMOJI_CDN = 'https://cdn.jsdelivr.net/npm/@lobehub/fluent-emoji-3d@1.1.0/assets/';
const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

function emojiUrl(emoji) {
    return EMOJI_CDN + [...emoji].map(c => c.codePointAt(0).toString(16)).join('-') + '.webp';
}

function emojiImg(emoji, extraClass) {
    const img = document.createElement('img');
    img.className = 'emo' + (extraClass ? ' ' + extraClass : '');
    img.src = emojiUrl(emoji);
    img.alt = emoji;                          // copy korle / chhobi na ashle emoji-i thake
    img.draggable = false;
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(document.createTextNode(emoji));   // chhobi na pele sadharon emoji
    return img;
}

// lekhar moddhe je emoji ache segulo 3D chhobi kore boshao
function appendRich(parent, text) {
    let i = 0;
    for (const m of (text || '').matchAll(EMOJI_RE)) {
        if (m.index > i) parent.appendChild(document.createTextNode(text.slice(i, m.index)));
        parent.appendChild(emojiImg(m[0]));
        i = m.index + m[0].length;
    }
    if (i < (text || '').length) parent.appendChild(document.createTextNode(text.slice(i)));
}

// shudhu 1-3 ta emoji thakle boro kore dekhabo (Messenger er moto)
function isEmojiOnly(text) {
    const t = (text || '').trim();
    if (!t) return false;
    const found = t.match(EMOJI_RE) || [];
    return found.length > 0 && found.length <= 3 && t.replace(EMOJI_RE, '').trim() === '';
}

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

const AVATAR_COLORS = [
    ['#2f7bff', '#7c5cff'], ['#16a34a', '#22c55e'], ['#ec1fc8', '#ff5ca8'],
    ['#a020f0', '#c084fc'], ['#f59e0b', '#fb923c'], ['#0ea5e9', '#22d3ee']
];

function makeAvatar(name, extraClass, photo) {
    const a = el('div', 'avatar' + (extraClass ? ' ' + extraClass : ''));
    setAvatar(a, name, photo);
    return a;
}

// avatar + online green dot (dot bahire thake, tai alada wrapper)
function avatarWithStatus(name, photo, userId) {
    const wrap = el('div', 'av-wrap');
    wrap.appendChild(makeAvatar(name, '', photo));
    const dot = el('i', 'status-dot');
    dot.hidden = !online.has(userId);
    wrap.appendChild(dot);
    return wrap;
}

// photo thakle photo, nahole nam-er prothom okkhor + rong
function setAvatar(node, name, photo) {
    node.textContent = '';
    node.style.background = '';
    if (photo) {
        const img = document.createElement('img');
        img.src = photo;
        img.alt = '';
        node.appendChild(img);
    } else {
        node.textContent = (name || '?').trim().charAt(0).toUpperCase();
        paintAvatar(node, name);
    }
}

function paintAvatar(node, name) {
    let sum = 0;
    for (const ch of (name || '')) sum += ch.charCodeAt(0);
    const [c1, c2] = AVATAR_COLORS[sum % AVATAR_COLORS.length];
    node.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
}

// sob API call e login token pathay. Token invalid hole abar login e pathay
let loggingOut = false;
async function authFetch(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, { Authorization: 'Bearer ' + currentUser.token });
    const res = await fetch(API + path, options);
    if (res.status === 401 && !loggingOut) {
        loggingOut = true;
        localStorage.removeItem('user');
        alert('Session expired. Please login again.');
        window.location.href = 'index.html';
    }
    return res;
}

async function request(path, options) {
    const res = await authFetch(path, options);
    return res.json();
}

function postJSON(path, body) {
    return request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

const searchIcon = () => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.innerHTML = '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9"/>';
    return s;
};

function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(d) {
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- start ----------
function init() {
    $('meName').textContent = currentUser.name;
    setAvatar($('meAvatar'), currentUser.name, currentUser.avatar);

    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('logoutBtn').addEventListener('click', logout);
    $('backBtn').addEventListener('click', () => $('app').classList.remove('chat-open'));
    $('sendMsgBtn').addEventListener('click', sendMessage);
    $('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
    $('messageInput').addEventListener('input', onTypingInput);
    setupChatExtras();      // search bar, pinned bar, emoji picker

    renderPane();
    loadFriends();
    loadPending();
    loadUnread();

    connectSocket();
    if (typeof setupCallUI === 'function') setupCallUI();

    // socket cholle onek kom (backup), na cholle 3 sec e check
    let tick = 0;
    setInterval(() => { tick++; if (!socketUp || tick % 10 === 0) loadUnread(); }, 3000);
    setInterval(loadPending, 10000);    // notun friend request (backup)
    setInterval(loadFriends, 15000);    // notun friend / photo

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && activeChat) { loadMessages(true); markRead(activeChat.id); }
        if (!document.hidden) updateBadges();
    });

    // browser notification + sound: prothom click er por allow (browser rule)
    document.addEventListener('click', () => {
        try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
        try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
    }, { once: true });
}

function logout() {
    localStorage.removeItem('user');
    window.location.href = 'index.html';
}

function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('app').classList.remove('chat-open');
    renderPane();
}

// ---------- data loading ----------
async function loadFriends() {
    try {
        const data = await request(`/api/friends/${currentUser.id}`);
        const seen = new Map();
        (data.friends || []).forEach(f => seen.set(f.id, f));
        const next = [...seen.values()];
        const changed = JSON.stringify(next) !== JSON.stringify(friends);
        friends = next;
        if (!changed && friendsLoaded) return;
        friendsLoaded = true;

        if (activeTab === 'chats' && redrawChats) redrawChats();
        else if (activeTab === 'friends') renderPane();
        else if (activeTab === 'find') { const box = $('searchResults'); if (box) drawSearchResults(box); }
    } catch (err) { console.error(err); }
}

async function loadPending() {
    try {
        const data = await request(`/api/friend-request/pending/${currentUser.id}`);
        const next = data.requests || [];
        const changed = JSON.stringify(next) !== JSON.stringify(pending);
        pending = next;

        const badge = $('reqBadge');
        badge.textContent = pending.length;
        badge.hidden = pending.length === 0;

        if (changed && activeTab === 'requests') renderPane();
    } catch (err) { console.error(err); }
}

// ---------- middle pane ----------
function renderPane() {
    const body = $('paneBody');
    body.innerHTML = '';
    redrawChats = null;

    if (activeTab === 'chats')    { $('paneTitle').textContent = 'Chats';           renderChats(body); }
    if (activeTab === 'friends')  { $('paneTitle').textContent = 'My Friends';      renderFriends(body); }
    if (activeTab === 'find')     { $('paneTitle').textContent = 'Find People';     renderFind(body); }
    if (activeTab === 'requests') { $('paneTitle').textContent = 'Friend Requests'; renderRequests(body); }
    if (activeTab === 'profile')  { $('paneTitle').textContent = 'My Profile';      renderProfile(body); }
}

function emptyNote(text, buttonText, onClick) {
    const box = el('div', 'empty-note', text);
    if (buttonText) {
        box.appendChild(document.createElement('br'));
        const b = el('button', 'btn-pill', buttonText);
        b.type = 'button';
        b.addEventListener('click', onClick);
        box.appendChild(b);
    }
    return box;
}

// ---- Chats (friends list) ----
function renderChats(body) {
    const row = el('div', 'search-row');
    const field = el('div', 'search-field');
    field.appendChild(searchIcon());
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Search friends...';
    input.value = friendFilter;
    field.appendChild(input);
    row.appendChild(field);
    body.appendChild(row);

    const list = el('div');
    body.appendChild(list);

    const draw = () => {
        list.innerHTML = '';
        const q = friendFilter.toLowerCase();
        const shown = friends
            .filter(f => f.name.toLowerCase().includes(q) || (f.email || '').toLowerCase().includes(q))
            .sort((a, b) => ((unread[b.id] || {}).count || 0) - ((unread[a.id] || {}).count || 0));   // unseen agey

        if (friends.length === 0) {
            list.appendChild(emptyNote('No friends yet.', 'Find People', () => switchTab('find')));
            return;
        }
        if (shown.length === 0) {
            list.appendChild(emptyNote('No friend matches your search.'));
            return;
        }

        shown.forEach(f => {
            const u = unread[f.id];
            const item = el('button', 'item' + (activeChat && activeChat.id === f.id ? ' active' : '') + (u ? ' has-unread' : ''));
            item.type = 'button';
            item.appendChild(avatarWithStatus(f.name, f.avatar, f.id));
            const info = el('div', 'item-body');
            info.appendChild(el('strong', '', f.name));
            const typing = !!typingFrom[f.id];
            info.appendChild(el('small', typing ? 'typing-now' : '', typing ? 'typing...' : (u ? u.last_message : (f.email || ''))));
            item.appendChild(info);
            if (u) item.appendChild(el('b', 'badge', u.count > 99 ? '99+' : String(u.count)));
            item.addEventListener('click', () => openChat(f));
            list.appendChild(item);
        });
    };

    input.addEventListener('input', () => { friendFilter = input.value.trim(); draw(); });
    draw();
    redrawChats = draw;
}

// ---- My Friends ----
function renderFriends(body) {
    if (friends.length === 0) {
        body.appendChild(emptyNote('You have no friends yet.', 'Find People', () => switchTab('find')));
        return;
    }

    body.appendChild(el('div', 'count-note', friends.length + (friends.length === 1 ? ' friend' : ' friends')));

    friends.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(f => {
        const item = el('div', 'item');
        item.appendChild(avatarWithStatus(f.name, f.avatar, f.id));
        const info = el('div', 'item-body');
        info.appendChild(el('strong', '', f.name));
        info.appendChild(el('small', online.has(f.id) ? 'online-now' : '', online.has(f.id) ? 'Online' : (f.country ? f.email + ' · ' + f.country : (f.email || ''))));
        item.appendChild(info);

        const msg = el('button', 'btn-sm', 'Message');
        msg.type = 'button';
        msg.addEventListener('click', () => openChat(f));
        item.appendChild(msg);
        body.appendChild(item);
    });
}

// ---- Find People ----
function renderFind(body) {
    const row = el('div', 'search-row');
    const field = el('div', 'search-field');
    field.appendChild(searchIcon());
    const input = el('input');
    input.type = 'text';
    input.id = 'searchQuery';
    input.placeholder = 'Search by name or email...';
    input.value = searchTerm;
    field.appendChild(input);
    row.appendChild(field);
    const btn = el('button', 'btn-pill', 'Search');
    btn.id = 'searchBtn';
    btn.type = 'button';
    row.appendChild(btn);
    body.appendChild(row);

    const results = el('div');
    results.id = 'searchResults';
    body.appendChild(results);

    drawSearchResults(results);

    const run = () => searchUsers(input.value.trim(), results);
    btn.addEventListener('click', run);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
}

async function searchUsers(query, results) {
    searchTerm = query;
    if (!query) { searchResults = []; drawSearchResults(results); return; }

    try {
        const data = await request(`/api/users/search?query=${encodeURIComponent(query)}&currentUserId=${currentUser.id}`);
        searchResults = data.users || [];
        drawSearchResults(results, true);
    } catch (err) { console.error(err); }
}

function drawSearchResults(container, searched) {
    container.innerHTML = '';
    if (searchResults.length === 0) {
        if (searched) container.appendChild(emptyNote('No users found.'));
        return;
    }

    searchResults.forEach(user => {
        const item = el('div', 'item');
        item.appendChild(makeAvatar(user.name, '', user.avatar));
        const info = el('div', 'item-body');
        info.appendChild(el('strong', '', user.name));
        info.appendChild(el('small', '', user.email));
        item.appendChild(info);

        if (friends.some(f => f.id === user.id)) {
            item.appendChild(el('span', 'tag', 'Friend'));
        } else {
            const add = el('button', 'btn-sm', 'Add Friend');
            add.type = 'button';
            add.addEventListener('click', () => sendRequest(user.id, add));
            item.appendChild(add);
        }
        container.appendChild(item);
    });
}

async function sendRequest(receiverId, btn) {
    try {
        btn.disabled = true;
        const res = await authFetch('/api/friend-request/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender_id: currentUser.id, receiver_id: receiverId })
        });
        const result = await res.json();
        if (res.ok) {
            btn.textContent = 'Sent ✓';
        } else {
            btn.disabled = false;
            alert(result.message || 'Failed to send request');
        }
    } catch (err) { btn.disabled = false; console.error(err); }
}

// ---- Friend Requests ----
function renderRequests(body) {
    if (pending.length === 0) {
        body.appendChild(emptyNote('No pending requests.'));
        return;
    }

    pending.forEach(r => {
        const item = el('div', 'item');
        item.appendChild(makeAvatar(r.name, '', r.avatar));
        const info = el('div', 'item-body');
        info.appendChild(el('strong', '', r.name));
        info.appendChild(el('small', '', r.email || ''));
        item.appendChild(info);

        const accept = el('button', 'btn-sm green', 'Accept');
        accept.type = 'button';
        accept.addEventListener('click', () => acceptRequest(r.request_id, accept));
        item.appendChild(accept);
        body.appendChild(item);
    });
}

async function acceptRequest(requestId, btn) {
    try {
        btn.disabled = true;
        await postJSON('/api/friend-request/accept', { request_id: requestId });
        await loadPending();
        await loadFriends();
        renderPane();
    } catch (err) { btn.disabled = false; console.error(err); }
}

// ---- My Profile ----
function renderProfile(body) {
    const card = el('div', 'profile-card');

    // ---- photo + camera button ----
    const wrap = el('div', 'avatar-edit');
    wrap.appendChild(makeAvatar(currentUser.name, 'xl', currentUser.avatar));

    const cam = el('button', 'cam-btn');
    cam.type = 'button';
    cam.title = 'Change photo';
    cam.setAttribute('aria-label', 'Change photo');
    cam.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>';
    wrap.appendChild(cam);

    const file = el('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;
    wrap.appendChild(file);

    cam.addEventListener('click', () => file.click());
    file.addEventListener('change', () => { if (file.files[0]) uploadPhoto(file.files[0]); });
    card.appendChild(wrap);

    card.appendChild(el('h3', '', currentUser.name));

    if (currentUser.avatar) {
        const rm = el('button', 'link-btn', 'Remove photo');
        rm.type = 'button';
        rm.addEventListener('click', () => savePhoto(''));
        card.appendChild(rm);
    }

    const rows = el('div', 'info-rows');
    [['Email', currentUser.email], ['Country', currentUser.country || 'N/A'], ['Phone', currentUser.phone || 'N/A']].forEach(([k, v]) => {
        const r = el('div', 'info-row');
        r.appendChild(el('span', '', k));
        r.appendChild(el('b', '', v));
        rows.appendChild(r);
    });
    card.appendChild(rows);

    const out = el('button', 'btn-logout', 'Log Out');
    out.type = 'button';
    out.addEventListener('click', logout);
    card.appendChild(out);
    body.appendChild(card);
}

// ---- profile photo upload ----
// Photo browser-e-i chhoto (192x192 square) kore neya hoy, tai phone-er boro photo-o cholbe
function resizeToJpeg(file, size) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const side = Math.min(img.width, img.height);
            const sx = (img.width - side) / 2;
            const sy = (img.height - side) / 2;
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, size, size);
            ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not an image')); };
        img.src = url;
    });
}

async function uploadPhoto(file) {
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
    try {
        const dataUrl = await resizeToJpeg(file, 192);
        await savePhoto(dataUrl);
    } catch (err) {
        console.error(err);
        alert('Could not read this photo. Please try another one.');
    }
}

async function savePhoto(dataUrl) {
    try {
        const res = await authFetch('/api/users/avatar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: currentUser.id, avatar: dataUrl })
        });
        const result = await res.json();
        if (!res.ok) { alert(result.message || 'Could not save photo'); return; }

        currentUser.avatar = result.avatar;                       // null hole muche gese
        localStorage.setItem('user', JSON.stringify(currentUser));
        setAvatar($('meAvatar'), currentUser.name, currentUser.avatar);
        if (activeTab === 'profile') renderPane();
    } catch (err) {
        console.error(err);
        alert('Server connection failed. Please try again.');
    }
}

// ---------- chat ----------
function openChat(friend) {
    if (activeChat && activeChat.id !== friend.id) sendTyping(false);   // ager chat e typing bondho
    activeChat = friend;
    lastMsgKey = null;

    $('chatEmpty').hidden = true;
    $('chatSection').hidden = false;
    $('app').classList.add('chat-open');

    $('chatTitle').textContent = friend.name;
    setAvatar($('chatAvatar'), friend.name, friend.avatar);
    refreshChatHead();

    $('messageContainer').innerHTML = '';
    if (activeTab === 'chats') renderPane();       // highlight active friend

    markRead(friend.id);
    loadMessages(true);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!socketUp) loadMessages(false); }, 3000);   // socket na thakle auto-refresh
    if (composeMode) cancelCompose();               // onno chat e reply/edit cholbe na
    closeSearch();
    stopRecording(true);                            // onno chat e gele recording batil
    pinIndex = 0;
    currentMsgs = [];
    $('messageInput').focus();
}

// ---------- message menu (⋮) ----------
let msgMenu = null;
let menuOpenedAt = 0;

function closeMsgMenu() {
    if (msgMenu) { msgMenu.remove(); msgMenu = null; }
}

function openMsgMenu(msg, anchor) {
    closeMsgMenu();
    menuOpenedAt = Date.now();
    const isMe = msg.sender_id === currentUser.id;

    // kon kon option dekhabo (nijer message hole Edit/Unsend o)
    let items;
    if (msg.deleted_at) {
        // unsend kora message e shudhu "Delete for me"
        items = [{ label: '🗑️ Delete for me', action: () => deleteForMe(msg), danger: true }];
    } else {
        items = [
            { label: '↩️ Reply',   action: () => startReply(msg) },
            { label: '➡️ Forward', action: () => openForward(msg) },
            { label: '📋 Copy',    action: () => navigator.clipboard && navigator.clipboard.writeText(msg.message || msg.attachment_url || '') },
            { label: msg.pinned_at ? '📍 Unpin' : '📌 Pin', action: () => togglePin(msg) }
        ];
        if (isMe) {
            if (msg.message) items.push({ label: '✏️ Edit',   action: () => startEdit(msg) });   // shudhu lekha edit hoy
            items.push({ label: '🚫 Unsend', action: () => unsendMessage(msg), danger: true });
        }
        items.push({ label: '🗑️ Delete for me', action: () => deleteForMe(msg), danger: true });
    }

    msgMenu = el('div', 'msg-menu');

    // upore 5 ta reaction (unsend kora message e na)
    if (!msg.deleted_at) {
        const mine = (msg.reactions || []).find(r => r.user_id === currentUser.id);
        const row = el('div', 'react-row');
        Object.entries(REACTION_EMOJI).forEach(([key, emoji]) => {
            const b = el('button', 'react-pick' + (mine && mine.reaction === key ? ' active' : ''));
            b.appendChild(emojiImg(emoji));
            b.type = 'button';
            b.title = key;
            b.addEventListener('click', (e) => { e.stopPropagation(); closeMsgMenu(); reactTo(msg, key); });
            row.appendChild(b);
        });
        msgMenu.appendChild(row);
    }

    items.forEach(item => {
        const b = el('button', 'msg-menu-item' + (item.danger ? ' danger' : ''), item.label);
        b.type = 'button';
        b.addEventListener('click', (e) => { e.stopPropagation(); closeMsgMenu(); item.action(); });
        msgMenu.appendChild(b);
    });
    document.body.appendChild(msgMenu);

    // menu ke anchor er pashe boshao, screen er baire jete dibo na
    const r = anchor.getBoundingClientRect();
    const m = msgMenu.getBoundingClientRect();
    let top = r.bottom + 4;
    if (top + m.height > window.innerHeight - 8) top = r.top - m.height - 4;   // niche jayga na thakle upore
    let left = isMe ? r.right - m.width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8));
    msgMenu.style.top = top + 'px';
    msgMenu.style.left = left + 'px';
}

// bahire click ba Esc chaple menu bondho
document.addEventListener('click', () => { if (Date.now() - menuOpenedAt > 400) closeMsgMenu(); });
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMsgMenu();
    closeForward();
    closeEmojiPanel();
    if ($('lightbox')) { closeLightbox(); return; }
    if (recorder && recorder.state === 'recording') { stopRecording(true); return; }
    if (composeMode) cancelCompose();
    else if (searchOpen) closeSearch();
});

// protita message bubble e ⋮ button + mobile e chepe dhora
function attachMsgMenu(bubble, msg) {
    const btn = el('button', 'msg-more', '⋮');
    btn.type = 'button';
    btn.title = 'More';
    btn.addEventListener('click', (e) => { e.stopPropagation(); openMsgMenu(msg, btn); });
    bubble.appendChild(btn);

    let pressTimer = null;
    const cancel = () => { clearTimeout(pressTimer); pressTimer = null; };
    bubble.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => { pressTimer = null; openMsgMenu(msg, bubble); }, 500);
    }, { passive: true });
    bubble.addEventListener('touchend', cancel);
    bubble.addEventListener('touchmove', cancel);
}

// ---------- Unsend / Delete for me ----------
async function unsendMessage(msg) {
    if (!confirm('Unsend this message for everyone?')) return;
    try {
        const r = await postJSON('/api/messages/unsend', { message_id: msg.id });
        if (!r.ok) return alert(r.message || 'Could not unsend.');
        loadMessages(false);
        loadUnread();
    } catch (err) { console.error(err); }
}

async function deleteForMe(msg) {
    if (!confirm('Delete this message for you? The other person will still see it.')) return;
    try {
        const r = await postJSON('/api/messages/delete-for-me', { message_id: msg.id });
        if (!r.ok) return alert(r.message || 'Could not delete.');
        loadMessages(false);
    } catch (err) { console.error(err); }
}

// ---------- Reply / Edit (message likhar jaygar upore bar) ----------
let composeMode = null;          // { type: 'reply' | 'edit', msg }

function senderName(id) {
    if (id === currentUser.id) return 'You';
    return activeChat && activeChat.id === id ? activeChat.name : 'Friend';
}

function shortText(t, n) {
    t = t || '';
    return t.length > n ? t.slice(0, n) + '…' : t;
}

function showComposeBar() {
    let bar = $('composeBar');
    if (!bar) {
        bar = el('div', 'compose-bar');
        bar.id = 'composeBar';
        const composer = document.querySelector('.composer');
        composer.parentNode.insertBefore(bar, composer);
    }
    bar.innerHTML = '';
    if (!composeMode) { bar.hidden = true; return; }
    bar.hidden = false;

    const { type, msg } = composeMode;
    const info = el('div', 'compose-info');
    info.appendChild(el('strong', '', type === 'edit' ? '✏️ Editing message' : '↩️ Replying to ' + senderName(msg.sender_id)));
    info.appendChild(el('span', '', shortText(previewText(msg), 80)));
    bar.appendChild(info);

    const x = el('button', 'compose-close', '✕');
    x.type = 'button';
    x.title = 'Cancel';
    x.addEventListener('click', cancelCompose);
    bar.appendChild(x);
}

function startReply(msg) {
    if (composeMode && composeMode.type === 'edit') $('messageInput').value = '';
    composeMode = { type: 'reply', msg };
    showComposeBar();
    $('messageInput').focus();
}

function startEdit(msg) {
    composeMode = { type: 'edit', msg };
    showComposeBar();
    const input = $('messageInput');
    input.value = msg.message;
    input.focus();
}

function cancelCompose() {
    const wasEdit = composeMode && composeMode.type === 'edit';
    composeMode = null;
    showComposeBar();
    if (wasEdit) $('messageInput').value = '';
}

// reply kora message er upore mul message er choto preview
function replyQuote(msg) {
    const q = el('div', 'reply-quote');
    q.appendChild(el('strong', '', senderName(msg.reply_sender_id)));
    let text;
    if (msg.reply_message === null || msg.reply_message === undefined) text = 'Message not available';
    else if (msg.reply_deleted_at) text = '🚫 Message unsent';
    else if (!msg.reply_message && msg.reply_attachment_type) text = attachLabel(msg.reply_attachment_type, msg.reply_attachment_name);
    else text = shortText(msg.reply_message, 90);
    const qs = el('span');
    appendRich(qs, text);
    q.appendChild(qs);
    q.addEventListener('click', (e) => { e.stopPropagation(); jumpToMessage(msg.reply_to_id); });
    return q;
}

// preview e click korle mul message e scroll + ektu jholok
function jumpToMessage(id) {
    const target = document.querySelector('#messageContainer .msg[data-id="' + id + '"]');
    if (!target) return;                       // "Delete for me" kora thakle pawa jabe na
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
}

// ---------- Forward (ek sathe koyekjon friend) ----------
function closeForward() {
    const o = $('fwdOverlay');
    if (o) o.remove();
}

function openForward(msg) {
    closeForward();
    const chosen = new Set();

    const overlay = el('div', 'fwd-overlay');
    overlay.id = 'fwdOverlay';
    const box = el('div', 'fwd-box');
    box.appendChild(el('h3', '', 'Forward message'));
    box.appendChild(el('p', 'fwd-preview', shortText(previewText(msg), 120)));

    const send = el('button', 'btn-sm', 'Send');
    send.type = 'button';
    send.disabled = true;
    const updateSend = () => {
        send.disabled = chosen.size === 0;
        send.textContent = chosen.size ? 'Send (' + chosen.size + ')' : 'Send';
    };

    const list = el('div', 'fwd-list');
    if (friends.length === 0) list.appendChild(el('p', 'fwd-empty', 'No friends yet.'));
    friends.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(f => {
        const row = el('label', 'fwd-row');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
            if (cb.checked) chosen.add(f.id); else chosen.delete(f.id);
            updateSend();
        });
        row.appendChild(cb);
        row.appendChild(makeAvatar(f.name, '', f.avatar));
        row.appendChild(el('span', '', f.name));
        list.appendChild(row);
    });
    box.appendChild(list);

    const cancel = el('button', 'btn-sm ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeForward);

    send.addEventListener('click', async () => {
        send.disabled = true;
        send.textContent = 'Sending...';
        try {
            const r = await postJSON('/api/messages/forward', { message_id: msg.id, friend_ids: [...chosen] });
            if (!r.ok) { alert(r.message || 'Could not forward.'); updateSend(); return; }
            closeForward();
            showToast('Forwarded', 'Sent to ' + r.count + (r.count === 1 ? ' friend' : ' friends'));
            loadMessages(false);
        } catch (err) { console.error(err); updateSend(); }
    });

    const actions = el('div', 'fwd-actions');
    actions.appendChild(cancel);
    actions.appendChild(send);
    box.appendChild(actions);

    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeForward(); });
    document.body.appendChild(overlay);
}

// ---------- Reaction / Pin ----------
async function reactTo(msg, reaction) {
    try {
        const r = await postJSON('/api/messages/react', { message_id: msg.id, reaction });
        if (!r.ok) return alert(r.message || 'Could not react.');
        loadMessages(false);
    } catch (err) { console.error(err); }
}

async function togglePin(msg) {
    try {
        const r = await postJSON('/api/messages/pin', { message_id: msg.id, pin: !msg.pinned_at });
        if (!r.ok) return alert(r.message || 'Could not pin.');
        pinIndex = 0;
        loadMessages(false);
    } catch (err) { console.error(err); }
}

// bubble er niche reaction gulo: ❤️ 2  👍 1
function reactionPills(msg) {
    const groups = {};
    (msg.reactions || []).forEach(r => { (groups[r.reaction] = groups[r.reaction] || []).push(r.user_id); });
    const wrap = el('div', 'reactions');
    Object.keys(REACTION_EMOJI).forEach(key => {
        const users = groups[key];
        if (!users) return;
        const mine = users.includes(currentUser.id);
        const pill = el('button', 'react-pill' + (mine ? ' mine' : ''));
        pill.appendChild(emojiImg(REACTION_EMOJI[key]));
        if (users.length > 1) pill.appendChild(document.createTextNode(' ' + users.length));
        pill.type = 'button';
        pill.title = users.map(id => senderName(id)).join(', ');
        pill.addEventListener('click', (e) => { e.stopPropagation(); reactTo(msg, key); });
        wrap.appendChild(pill);
    });
    return wrap;
}

// ---------- Pinned bar (chat er upore) ----------
let pinIndex = 0;

function renderPinnedBar() {
    const bar = $('pinnedBar');
    if (!bar) return;
    const pinned = currentMsgs
        .filter(m => m.pinned_at && !m.deleted_at)
        .sort((a, b) => new Date(b.pinned_at) - new Date(a.pinned_at));     // notun pin agey
    bar.innerHTML = '';
    if (!pinned.length) { bar.hidden = true; return; }
    bar.hidden = false;
    if (pinIndex >= pinned.length) pinIndex = 0;

    const m = pinned[pinIndex];
    const info = el('div', 'pinned-info');
    info.appendChild(el('strong', '', '📌 Pinned' + (pinned.length > 1 ? ' (' + (pinIndex + 1) + '/' + pinned.length + ')' : '')));
    const ps = el('span');
    appendRich(ps, shortText(previewText(m), 90));
    info.appendChild(ps);
    bar.appendChild(info);
    bar.title = pinned.length > 1 ? 'Click to see message, then next pin' : 'Click to see message';
    bar.onclick = () => {
        jumpToMessage(m.id);
        if (pinned.length > 1) { pinIndex = (pinIndex + 1) % pinned.length; renderPinnedBar(); }
    };
}

// ---------- Message search (khola chat er moddhe) ----------
let searchOpen = false;
let searchQ = '';
let searchHits = [];
let searchPos = -1;

function openSearch() {
    searchOpen = true;
    $('searchBar').hidden = false;
    $('msgSearchInput').focus();
}

function closeSearch() {
    if (!$('searchBar')) return;
    searchOpen = false;
    searchQ = '';
    $('msgSearchInput').value = '';
    $('searchBar').hidden = true;
    applySearch(false);
}

// mil thaka lekha <mark> diye highlight
function applySearch(jump) {
    const box = $('messageContainer');
    box.querySelectorAll('.msg.search-current').forEach(b => b.classList.remove('search-current'));
    searchHits = [];
    const q = searchQ.toLowerCase();

    box.querySelectorAll('.msg-text').forEach(span => {
        const raw = span.dataset.raw || '';
        const lower = raw.toLowerCase();
        const hit = q && lower.includes(q);
        if (!hit && !span.querySelector('mark')) return;            // kichu bodlanor nai
        span.textContent = '';                                      // purono highlight muche felo
        if (!hit) { appendRich(span, raw); return; }
        let i = 0, at;
        while ((at = lower.indexOf(q, i)) !== -1) {
            appendRich(span, raw.slice(i, at));
            const mk = el('mark');
            appendRich(mk, raw.slice(at, at + q.length));
            span.appendChild(mk);
            i = at + q.length;
        }
        appendRich(span, raw.slice(i));
        searchHits.push(span.closest('.msg'));
    });

    if (jump) searchPos = searchHits.length - 1;                    // shobcheye notun mil theke shuru
    else searchPos = Math.min(searchPos, searchHits.length - 1);
    updateSearchUI(jump);
}

function updateSearchUI(scroll) {
    const count = $('msgSearchCount');
    if (!count) return;
    count.textContent = searchHits.length ? (searchPos + 1) + '/' + searchHits.length : (searchQ ? '0' : '');
    const cur = searchHits[searchPos];
    if (!cur) return;
    cur.classList.add('search-current');
    if (scroll) cur.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function moveSearch(dir) {
    if (!searchHits.length) return;
    if (searchHits[searchPos]) searchHits[searchPos].classList.remove('search-current');
    searchPos = (searchPos + dir + searchHits.length) % searchHits.length;
    updateSearchUI(true);
}

// ---------- Emoji picker ----------
const EMOJIS = ('😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😜 🤪 😎 🤩 🥳 😏 😒 😔 ' +
    '😢 😭 😤 😡 🤯 😳 🥺 😱 🤔 🤗 🤭 😴 🙄 😬 🤝 👍 👎 👏 🙌 🙏 💪 👋 ✌️ 👌 ' +
    '❤️ 🧡 💛 💚 💙 💜 🖤 💔 💯 🔥 ✨ 🎉 🎂 🌹 ☕ 🍕 ⚽ 🏏 🌙 ⭐').split(' ');

function closeEmojiPanel() {
    const p = $('emojiPanel');
    if (p) p.hidden = true;
}

function toggleEmojiPanel(btn) {
    const panel = $('emojiPanel');
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = panel.offsetWidth, h = panel.offsetHeight;
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    panel.style.top = Math.max(8, r.top - h - 8) + 'px';
}

// cursor jekhane, emoji sekhane boshbe
function insertEmoji(emoji) {
    const input = $('messageInput');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    const pos = start + emoji.length;
    input.focus();
    input.setSelectionRange(pos, pos);
    onTypingInput();
}

// ---------- page load e ekbar: search bar, pinned bar, emoji button ----------
function setupChatExtras() {
    const box = $('messageContainer');

    // search bar
    const sb = el('div', 'search-bar');
    sb.id = 'searchBar';
    sb.hidden = true;
    const si = el('input');
    si.id = 'msgSearchInput';
    si.type = 'text';
    si.placeholder = 'Search in this chat...';
    si.autocomplete = 'off';
    const cnt = el('span', 'search-count');
    cnt.id = 'msgSearchCount';
    const up = el('button', 'icon-btn', '↑'); up.type = 'button'; up.title = 'Older';
    const down = el('button', 'icon-btn', '↓'); down.type = 'button'; down.title = 'Newer';
    const x = el('button', 'icon-btn', '✕'); x.type = 'button'; x.title = 'Close';
    si.addEventListener('input', () => { searchQ = si.value.trim(); applySearch(true); });
    si.addEventListener('keydown', (e) => { if (e.key === 'Enter') moveSearch(e.shiftKey ? 1 : -1); });
    up.addEventListener('click', () => moveSearch(-1));
    down.addEventListener('click', () => moveSearch(1));
    x.addEventListener('click', closeSearch);
    [si, cnt, up, down, x].forEach(n => sb.appendChild(n));
    box.parentNode.insertBefore(sb, box);

    // pinned bar
    const pb = el('div', 'pinned-bar');
    pb.id = 'pinnedBar';
    pb.hidden = true;
    box.parentNode.insertBefore(pb, box);

    // header e 🔍 button (call button er age)
    const actions = document.querySelector('.chat-actions');
    const sbtn = el('button', 'icon-btn');
    sbtn.type = 'button';
    sbtn.title = 'Search messages';
    sbtn.setAttribute('aria-label', 'Search messages');
    sbtn.appendChild(searchIcon());
    sbtn.addEventListener('click', () => (searchOpen ? closeSearch() : openSearch()));
    actions.insertBefore(sbtn, actions.firstChild);

    // composer e 😊 button + emoji panel
    const composer = document.querySelector('.composer');
    const ebtn = el('button', 'emoji-btn');
    ebtn.appendChild(emojiImg('😊'));
    ebtn.type = 'button';
    ebtn.title = 'Emoji';
    ebtn.setAttribute('aria-label', 'Emoji');
    ebtn.addEventListener('click', (e) => { e.stopPropagation(); toggleEmojiPanel(ebtn); });
    composer.insertBefore(ebtn, composer.firstChild);

    const panel = el('div', 'emoji-panel');
    panel.id = 'emojiPanel';
    panel.hidden = true;
    EMOJIS.forEach(emoji => {
        const b = el('button', 'emoji-item');
        b.appendChild(emojiImg(emoji));
        b.title = emoji;
        b.type = 'button';
        b.addEventListener('click', () => insertEmoji(emoji));
        panel.appendChild(b);
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(panel);
    document.addEventListener('click', closeEmojiPanel);

    setupFileSharing();     // 📎 🎤 drag & drop, upload progress
}

// =====================================================
// FILE SHARING: chhobi, video, voice, PDF, document
// =====================================================
const UPLOAD_LIMIT_MB = { image: 10, video: 50, audio: 10, file: 10 };   // server er sathe mil rekhe
const KIND_NAME = { image: 'photos', video: 'videos', audio: 'audio', file: 'files' };

function fileKind(file) {
    const t = file.type || '';
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('video/')) return 'video';
    if (t.startsWith('audio/')) return 'audio';
    return 'file';
}

function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function fileIcon(name) {
    const ext = ((name || '').match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    if (ext === 'pdf') return '📕';
    if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return '📘';
    if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return '📗';
    if (['ppt', 'pptx', 'odp'].includes(ext)) return '📙';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
    if (['txt', 'md'].includes(ext)) return '📄';
    return '📎';
}

function attachLabel(type, name) {
    if (type === 'image') return '📷 Photo';
    if (type === 'video') return '🎬 Video';
    if (type === 'audio') return (name || '').startsWith('voice-') ? '🎤 Voice message' : '🎵 Audio';
    if (type === 'file') return '📎 ' + (name || 'File');
    return '';
}

// lekha thakle lekha, nahole file er nam (reply / pin / forward preview er jonno)
function previewText(m) {
    return m.message || attachLabel(m.attachment_type, m.attachment_name);
}

// Cloudinary URL e "/upload/" er pore transformation boshano jay: choto kora, format bodlano
function cldUrl(url, transform, ext) {
    let u = transform ? url.replace('/upload/', '/upload/' + transform + '/') : url;
    if (ext) u = u.replace(/\.[a-z0-9]+$/i, '') + '.' + ext;
    return u;
}

// download link: chhobi/video/audio te fl_attachment = browser khulbe na, sorasori save korbe
function downloadUrl(msg) {
    if (msg.attachment_type === 'file') return msg.attachment_url;
    return cldUrl(msg.attachment_url, 'fl_attachment');
}

function renderAttachment(msg) {
    const type = msg.attachment_type;
    const wrap = el('div', 'att');

    if (type === 'image') {
        const img = el('img', 'att-img');
        img.src = cldUrl(msg.attachment_url, 'c_limit,w_600,q_auto,f_auto');    // choto, druto load
        img.alt = msg.attachment_name || 'Photo';
        img.loading = 'lazy';
        img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(msg); });
        wrap.appendChild(img);
    } else if (type === 'video') {
        const v = document.createElement('video');
        v.className = 'att-video';
        v.controls = true;
        v.preload = 'metadata';
        v.playsInline = true;
        v.src = cldUrl(msg.attachment_url, 'q_auto', 'mp4');                  // sob phone e chole
        v.poster = cldUrl(msg.attachment_url, 'so_0,c_limit,w_600', 'jpg');
        wrap.appendChild(v);
    } else if (type === 'audio') {
        const box = el('div', 'att-audio');
        box.appendChild(el('span', 'att-audio-icon', (msg.attachment_name || '').startsWith('voice-') ? '🎤' : '🎵'));
        const a = document.createElement('audio');
        a.controls = true;
        a.preload = 'none';
        a.src = cldUrl(msg.attachment_url, null, 'mp3');                      // iPhone o bajate pare
        box.appendChild(a);
        wrap.appendChild(box);
    } else {
        const card = el('a', 'att-file');
        card.href = msg.attachment_url;
        card.target = '_blank';
        card.rel = 'noopener';
        card.appendChild(el('span', 'att-file-icon', fileIcon(msg.attachment_name)));
        const info = el('span', 'att-file-info');
        info.appendChild(el('strong', '', msg.attachment_name || 'File'));
        info.appendChild(el('small', '', fmtSize(msg.attachment_size) + ' · Tap to open'));
        card.appendChild(info);
        card.addEventListener('click', (e) => e.stopPropagation());
        wrap.appendChild(card);
    }

    // sob file e ⬇ Download
    const meta = el('div', 'att-meta');
    const parts = [];
    if (type === 'audio' && msg.attachment_duration) parts.push(fmtDuration(msg.attachment_duration));
    if (type !== 'file' && msg.attachment_size) parts.push(fmtSize(msg.attachment_size));
    meta.appendChild(el('span', '', parts.join(' · ')));
    const dl = el('a', 'att-dl', '⬇ Download');
    dl.href = downloadUrl(msg);
    dl.target = '_blank';
    dl.rel = 'noopener';
    dl.addEventListener('click', (e) => e.stopPropagation());
    meta.appendChild(dl);
    wrap.appendChild(meta);
    return wrap;
}

// ---------- Image Preview (boro kore dekha) ----------
function closeLightbox() {
    const lb = $('lightbox');
    if (lb) lb.remove();
}

function openLightbox(msg) {
    closeLightbox();
    const ov = el('div', 'lightbox');
    ov.id = 'lightbox';
    const bar = el('div', 'lb-bar');
    bar.appendChild(el('span', 'lb-name', msg.attachment_name || 'Photo'));
    const dl = el('a', 'lb-btn', '⬇ Download');
    dl.href = downloadUrl(msg);
    const x = el('button', 'lb-btn', '✕');
    x.type = 'button';
    x.title = 'Close';
    x.addEventListener('click', closeLightbox);
    bar.appendChild(dl);
    bar.appendChild(x);
    const img = el('img', 'lb-img');
    img.src = cldUrl(msg.attachment_url, 'q_auto,f_auto');
    img.alt = msg.attachment_name || 'Photo';
    ov.appendChild(bar);
    ov.appendChild(img);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeLightbox(); });
    document.body.appendChild(ov);
}

// ---------- Upload (progress shoho) ----------
function addUploadItem(name) {
    const tray = $('uploadTray');
    tray.hidden = false;
    const row = el('div', 'up-item');
    const top = el('div', 'up-top');
    top.appendChild(el('span', 'up-name', shortText(name, 40)));
    const pct = el('span', 'up-pct', '0%');
    top.appendChild(pct);
    const x = el('button', 'up-cancel', '✕');
    x.type = 'button';
    x.title = 'Cancel';
    top.appendChild(x);
    const bar = el('div', 'up-bar');
    const fill = el('i');
    bar.appendChild(fill);
    row.appendChild(top);
    row.appendChild(bar);
    tray.appendChild(row);

    const item = {
        cancelled: false,
        abort: null,
        setProgress(p) { fill.style.width = p + '%'; pct.textContent = p < 100 ? p + '%' : 'Sending...'; },
        done() { row.remove(); if (!tray.children.length) tray.hidden = true; },
        fail(msg) { row.classList.add('failed'); pct.textContent = 'Failed'; row.title = msg; }
    };
    x.addEventListener('click', () => {
        item.cancelled = true;
        if (item.abort) item.abort();
        item.done();
    });
    return item;
}

function xhrUpload(url, form, item) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) item.setProgress(Math.round(e.loaded / e.total * 100)); };
        xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText); } catch (e) {}
            if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) resolve(data);
            else reject(new Error((data.error && data.error.message) || 'Upload failed'));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.onabort = () => reject(new Error('cancelled'));
        item.abort = () => xhr.abort();
        xhr.send(form);
    });
}

async function uploadAndSend(file, extra) {
    if (!activeChat) return;
    const kind = fileKind(file);
    const limit = UPLOAD_LIMIT_MB[kind];
    if (file.size > limit * 1024 * 1024) {
        alert('"' + file.name + '" is too large (' + fmtSize(file.size) + '). Max ' + limit + ' MB for ' + KIND_NAME[kind] + '.');
        return;
    }
    const toId = activeChat.id;                     // upload cholar somoy chat bodlaleo thik manush pabe
    const item = addUploadItem(file.name);
    try {
        // 1) server theke onumoti-potro (signature)
        const sig = await postJSON('/api/upload/sign', { kind, size: file.size, name: file.name });
        if (!sig.ok) throw new Error(sig.message || 'Upload not allowed');
        if (item.cancelled) return;

        // 2) browser theke sorasori Cloudinary te
        const form = new FormData();
        form.append('file', file);
        Object.entries(sig.fields).forEach(([k, v]) => form.append(k, v));
        const result = await xhrUpload(sig.uploadUrl, form, item);

        // 3) message hisebe pathao
        const attachment = {
            url: result.secure_url,
            public_id: result.public_id,
            type: kind,
            name: file.name,
            size: result.bytes || file.size,
            mime: file.type,
            duration: (extra && extra.duration) || result.duration || null
        };
        const r = await postJSON('/api/messages/send', { receiver_id: toId, message: '', attachment });
        if (!r.ok) throw new Error(r.message || 'Could not send file');
        item.done();
        if (activeChat && activeChat.id === toId) loadMessages(true);
    } catch (err) {
        if (item.cancelled || err.message === 'cancelled') return;
        console.error(err);
        item.fail(err.message);
        alert('Could not send "' + file.name + '": ' + err.message);
    }
}

// ekadhik file ek ek kore (je kromey bachhe sei kromey jabe)
async function handleFiles(list) {
    const files = [...(list || [])].slice(0, 10);
    if (!files.length) return;
    if (!activeChat) { alert('Open a chat first.'); return; }
    if ((list.length || 0) > 10) alert('You can send up to 10 files at a time.');
    for (const f of files) await uploadAndSend(f);
}

// ---------- Voice Message ----------
let recorder = null;
let recChunks = [];
let recStart = 0;
let recTimer = null;
let recStream = null;
let recCancelled = false;
const REC_MAX_SEC = 120;                            // 2 minit porjonto

function showRecordingBar(on) {
    $('recBar').hidden = !on;
    document.querySelector('.composer').classList.toggle('is-recording', on);
    clearInterval(recTimer);
    if (on) {
        const t = $('recTime');
        t.textContent = '0:00';
        recTimer = setInterval(() => {
            const sec = (Date.now() - recStart) / 1000;
            t.textContent = fmtDuration(sec);
            if (sec >= REC_MAX_SEC) stopRecording(false);
        }, 250);
    }
}

async function startRecording() {
    if (!activeChat) return;
    if (recorder && recorder.state === 'recording') return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { alert('Voice recording is not supported in this browser.'); return; }
    try {
        recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        alert('Microphone permission is needed to record a voice message.');
        return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    recorder = new MediaRecorder(recStream, type ? { mimeType: type } : undefined);
    recChunks = [];
    recCancelled = false;
    const toChat = activeChat.id;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
        recStream.getTracks().forEach(t => t.stop());               // mic bondho (lal biduti chole jabe)
        const secs = Math.round((Date.now() - recStart) / 1000);
        showRecordingBar(false);
        if (recCancelled || secs < 1 || !recChunks.length) return;
        if (!activeChat || activeChat.id !== toChat) return;         // onno chat e chole gele pathabo na
        const mime = (recorder.mimeType || type || 'audio/webm').split(';')[0];
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        const file = new File(recChunks, 'voice-' + Date.now() + '.' + ext, { type: mime });
        uploadAndSend(file, { duration: secs });
    };
    recorder.start();
    recStart = Date.now();
    showRecordingBar(true);
}

function stopRecording(cancel) {
    if (!recorder || recorder.state === 'inactive') return;
    recCancelled = !!cancel;
    recorder.stop();
}

// ---------- Drag & Drop + Paste ----------
function setupDropAndPaste() {
    const chat = $('chatSection');
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    chat.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; chat.classList.add('drag-over'); });
    chat.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    chat.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) chat.classList.remove('drag-over'); });
    chat.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        chat.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
    });
    // screenshot copy kore Ctrl+V dileo chole jabe
    $('messageInput').addEventListener('paste', (e) => {
        const files = e.clipboardData && e.clipboardData.files;
        if (files && files.length) { e.preventDefault(); handleFiles(files); }
    });
}

function setupFileSharing() {
    const composer = document.querySelector('.composer');
    const input = $('messageInput');

    // 📎 file bachhai
    const picker = el('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.hidden = true;
    picker.addEventListener('change', () => { handleFiles(picker.files); picker.value = ''; });
    composer.appendChild(picker);

    const attach = el('button', 'tool-btn', '📎');
    attach.type = 'button';
    attach.title = 'Send photo, video or file';
    attach.setAttribute('aria-label', 'Attach file');
    attach.addEventListener('click', () => picker.click());
    composer.insertBefore(attach, input);

    // 🎤 voice
    const mic = el('button', 'tool-btn mic-btn', '🎤');
    mic.type = 'button';
    mic.title = 'Record voice message';
    mic.setAttribute('aria-label', 'Record voice message');
    mic.addEventListener('click', startRecording);
    composer.insertBefore(mic, input.nextSibling);

    // recording cholar somoy: 🔴 0:12  ✕  ➤
    const rec = el('div', 'rec-bar');
    rec.id = 'recBar';
    rec.hidden = true;
    rec.appendChild(el('span', 'rec-dot'));
    const t = el('span', 'rec-time', '0:00');
    t.id = 'recTime';
    rec.appendChild(t);
    rec.appendChild(el('span', 'rec-label', 'Recording...'));
    const cancel = el('button', 'tool-btn', '✕');
    cancel.type = 'button';
    cancel.title = 'Cancel';
    cancel.addEventListener('click', () => stopRecording(true));
    const send = el('button', 'rec-send', '➤');
    send.type = 'button';
    send.title = 'Send voice message';
    send.addEventListener('click', () => stopRecording(false));
    rec.appendChild(cancel);
    rec.appendChild(send);
    composer.appendChild(rec);

    // upload progress dekhano jayga (composer er upore)
    const tray = el('div', 'upload-tray');
    tray.id = 'uploadTray';
    tray.hidden = true;
    composer.parentNode.insertBefore(tray, composer);

    setupDropAndPaste();
}

async function loadMessages(force) {
    if (!activeChat) return;
    const chatId = activeChat.id;

    try {
        const data = await request(`/api/messages/${currentUser.id}/${chatId}`);
        if (!activeChat || activeChat.id !== chatId) return;        // user switched chat meanwhile

        const msgs = data.messages || [];
        // protita message er "chhap": notun, seen, edit, unsend, pin, reaction - je kono bodlale key bodlabe
        const key = msgs.map(m => [m.id, m.is_read, m.deleted_at ? 1 : 0, m.edited_at || '', m.pinned_at || '',
            (m.reactions || []).map(r => r.user_id + r.reaction).join(',')].join('/')).join('|');
        if (!force && key === lastMsgKey) return;                   // nothing new
        lastMsgKey = key;
        currentMsgs = msgs;
        renderPinnedBar();

        const box = $('messageContainer');
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        box.innerHTML = '';

        if (msgs.length === 0) {
            box.appendChild(el('div', 'no-msg', 'No messages yet. Say hi 👋'));
            return;
        }

        let lastDay = '';
        msgs.forEach(msg => {
            const when = new Date(msg.created_at);
            const day = when.toDateString();
            if (day !== lastDay) {
                box.appendChild(el('div', 'day-chip', dayLabel(when)));
                lastDay = day;
            }
            const isMe = msg.sender_id === currentUser.id;
            const bubble = el('div', 'msg ' + (isMe ? 'me' : 'them') + (msg.deleted_at ? ' unsent' : ''));
            bubble.dataset.id = msg.id;
            if (msg.deleted_at) {
                bubble.appendChild(el('span', 'unsent-text', isMe ? '🚫 You unsent a message' : '🚫 This message was unsent'));
            } else {
                if (msg.is_forwarded) bubble.appendChild(el('div', 'fwd-label', '➡️ Forwarded'));
                if (msg.reply_to_id) bubble.appendChild(replyQuote(msg));
                if (msg.attachment_url) {
                    bubble.classList.add('has-att', 'att-' + msg.attachment_type);
                    bubble.appendChild(renderAttachment(msg));
                }
                if (msg.message) {
                    const text = el('span', 'msg-text');
                    text.dataset.raw = msg.message;                 // search er jonno asol lekha
                    appendRich(text, msg.message);
                    if (!msg.attachment_url && isEmojiOnly(msg.message)) bubble.classList.add('emoji-only');
                    bubble.appendChild(text);
                }
            }
            const edited = msg.edited_at && !msg.deleted_at ? 'edited · ' : '';
            const pinMark = msg.pinned_at && !msg.deleted_at ? '📌 ' : '';
            const time = el('span', 'time', isNaN(when) ? '' : pinMark + edited + fmtTime(when));
            if (isMe) time.appendChild(el('i', 'tick' + (msg.is_read ? ' seen' : ''), msg.is_read ? ' ✓✓' : ' ✓'));
            bubble.appendChild(time);
            if (!msg.deleted_at && msg.reactions && msg.reactions.length) {
                bubble.classList.add('has-react');
                bubble.appendChild(reactionPills(msg));
            }
            attachMsgMenu(bubble, msg);
            box.appendChild(bubble);
        });

        if (force || nearBottom) box.scrollTop = box.scrollHeight;
        if (searchQ) applySearch(false);                            // notun message ashleo highlight thakbe
    } catch (err) { console.error(err); }
}

async function sendMessage() {
    const input = $('messageInput');
    const message = input.value.trim();
    if (!message || !activeChat) return;

    try {
        // Edit mode: notun message na, purono ta bodlao
        if (composeMode && composeMode.type === 'edit') {
            const msg = composeMode.msg;
            if (message !== msg.message) {
                const r = await postJSON('/api/messages/edit', { message_id: msg.id, message });
                if (!r.ok) { alert(r.message || 'Could not edit.'); return; }
            }
            cancelCompose();
            loadMessages(false);
            return;
        }

        const body = { receiver_id: activeChat.id, message };
        if (composeMode && composeMode.type === 'reply') body.reply_to_id = composeMode.msg.id;

        const result = await postJSON('/api/messages/send', body);
        if (!result.ok) { alert(result.message || 'Message could not be sent.'); return; }
        input.value = '';
        cancelCompose();
        sendTyping(false);
        loadMessages(true);
    } catch (err) { console.error(err); }
}

// ---------- realtime (Socket.IO) ----------
function connectSocket() {
    // io undefined = socket.io script load hoy ni -> purono polling diye cholbe
    if (typeof io !== 'function') { console.warn('Socket.IO not loaded, using polling'); return; }

    socket = io(API || undefined, { auth: { token: currentUser.token } });
    if (typeof initCalls === 'function') initCalls();

    socket.on('connect', () => {
        socketUp = true;
        // disconnect thakar somoy ja miss hoyeche
        loadUnread(); loadPending(); loadFriends();
        if (activeChat) loadMessages(true);
    });

    socket.on('disconnect', () => {
        socketUp = false;
        online = new Set();
        typingFrom = {};
        refreshPresenceUI();
    });

    socket.on('presence:list', (ids) => { online = new Set(ids); refreshPresenceUI(); });
    socket.on('presence', (d) => {
        if (d.online) online.add(d.user_id); else online.delete(d.user_id);
        if (!d.online) clearTyping(d.user_id);
        refreshPresenceUI();
    });

    socket.on('message:new', () => {
        loadUnread();                                   // unseen count + notification
        if (activeChat) loadMessages(false);            // khola chat e sathe sathe dekhabe
    });

    // unsend / delete hole: unseen count + khola chat abar draw
    socket.on('message:changed', () => {
        loadUnread();
        if (activeChat) loadMessages(false);
    });

    socket.on('messages:read', (d) => {
        if (activeChat && activeChat.id === d.reader_id) loadMessages(false);    // ✓ -> ✓✓
    });

    socket.on('typing', (d) => {
        if (d.typing) {
            clearTimeout(typingFrom[d.from]);
            typingFrom[d.from] = setTimeout(() => clearTyping(d.from), 4000);   // backup: 4 sec por nijei bondho
        } else {
            clearTyping(d.from);
            return;
        }
        refreshTypingUI();
    });

    socket.on('requests:changed', loadPending);
    socket.on('friends:changed', () => { loadFriends(); loadPending(); if (socket) socket.emit('presence:request'); });
}

function clearTyping(friendId) {
    if (typingFrom[friendId] === undefined) return;
    clearTimeout(typingFrom[friendId]);
    delete typingFrom[friendId];
    refreshTypingUI();
}

// chat header: "typing..." > "Online" > email
function refreshChatHead() {
    if (!activeChat) return;
    const sub = $('chatSub');
    const typing = !!typingFrom[activeChat.id];
    const isOn = online.has(activeChat.id);
    sub.textContent = typing ? 'typing...' : (isOn ? 'Online' : (activeChat.email || ''));
    sub.className = typing ? 'typing-now' : (isOn ? 'online-now' : '');
    $('chatDot').hidden = !isOn;
}

function refreshTypingUI() {
    refreshChatHead();
    if (activeTab === 'chats' && redrawChats) redrawChats();
}

function refreshPresenceUI() {
    refreshChatHead();
    if (activeTab === 'chats' && redrawChats) redrawChats();
    else if (activeTab === 'friends') renderPane();
}

// nijer typing: shurute true, thamle 2 sec por false
function sendTyping(on) {
    if (!socket || !socketUp || !activeChat) return;
    clearTimeout(myTypingTimer);
    if (on) myTypingTimer = setTimeout(() => sendTyping(false), 2000);
    else lastTypingSent = 0;
    socket.emit('typing', { to: activeChat.id, typing: on });
}

function onTypingInput() {
    if (!$('messageInput').value.trim()) { sendTyping(false); return; }
    const now = Date.now();
    if (now - lastTypingSent > 1500) { lastTypingSent = now; sendTyping(true); }
    else {                                     // timer reset
        clearTimeout(myTypingTimer);
        myTypingTimer = setTimeout(() => sendTyping(false), 2000);
    }
}

// ---------- unseen count + notification ----------
async function loadUnread() {
    try {
        const data = await request(`/api/messages/unread/${currentUser.id}`);
        const list = data.unread || [];
        const chatOpenNow = (id) => activeChat && activeChat.id === id && !document.hidden;
        const next = {};

        list.forEach(u => {
            if (chatOpenNow(u.sender_id)) {          // jar chat khola ache take dekhano holo -> seen
                loadMessages(false);
                markRead(u.sender_id);
                lastNotified[u.sender_id] = Math.max(lastNotified[u.sender_id] || 0, u.last_id);
                return;
            }
            next[u.sender_id] = { count: u.count, last_id: u.last_id, last_message: u.last_message };

            const prev = lastNotified[u.sender_id] || 0;
            if (unreadReady && u.last_id > prev) notifyNew(u);
            lastNotified[u.sender_id] = Math.max(prev, u.last_id);
        });

        const changed = JSON.stringify(next) !== JSON.stringify(unread);
        unread = next;
        unreadReady = true;
        if (changed) {
            updateBadges();
            if (activeTab === 'chats' && redrawChats) redrawChats();
        }
    } catch (err) { console.error(err); }
}

function markRead(friendId) {
    if (unread[friendId]) {
        delete unread[friendId];
        updateBadges();
        if (activeTab === 'chats' && redrawChats) redrawChats();
    }
    postJSON('/api/messages/mark-read', { user_id: currentUser.id, friend_id: friendId }).catch(console.error);
}

function updateBadges() {
    const total = Object.values(unread).reduce((n, u) => n + u.count, 0);
    const badge = $('chatBadge');
    badge.textContent = total > 99 ? '99+' : total;
    badge.hidden = total === 0;
    document.title = (total > 0 ? '(' + total + ') ' : '') + 'Talkfav - Dashboard';
}

function notifyNew(u) {
    const friend = friends.find(f => f.id === u.sender_id);
    const name = friend ? friend.name : 'New message';
    const preview = (u.last_message || '').length > 70 ? u.last_message.slice(0, 70) + '…' : (u.last_message || '');
    const open = () => { window.focus(); if (friend) openChat(friend); };

    showToast(name, preview, open);
    beep();

    try {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(name, { body: preview });
            n.onclick = () => { open(); n.close(); };
        }
    } catch (e) {}
}

function showToast(title, text, onClick) {
    let box = $('toasts');
    if (!box) { box = el('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = el('button', 'toast');
    t.type = 'button';
    t.appendChild(el('strong', '', title));
    t.appendChild(el('span', '', text));
    t.addEventListener('click', () => { t.remove(); if (onClick) onClick(); });
    box.appendChild(t);
    setTimeout(() => t.remove(), 6000);
    while (box.children.length > 3) box.firstChild.remove();
}

function beep() {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const now = audioCtx.currentTime;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(now); o.stop(now + 0.3);
    } catch (e) {}
}

// ---------- run (file-er ekdom shesh-e thakte hobe) ----------
if (!currentUser || !currentUser.token) {
    localStorage.removeItem('user');
    alert('Please login first!');
    window.location.href = 'index.html';
} else {
    init();
}
