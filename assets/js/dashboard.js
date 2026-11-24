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
let sentRequests = [];          // ami je request pathiyechi (Cancel er jonno)
let friendStatusFilter = 'all'; // My Friends: all / online / offline
let groups = [];                // amar group gulo (unread, shesh message soho)
let groupInfo = null;           // khola group er details: { group, members }
let groupTyping = {};           // groupId -> { userId: timeout }
const PAGE_SIZE = 50;           // ekbare koyta message (server er sathe mil)
let hasMoreOlder = false;       // upore aro purono message ache kina
let loadingOlder = false;
let pinnedList = [];            // server theke pin kora message (purono holeo)
let chatSettings = {};          // 'u5' / 'g3' -> { pinned_at, archived, muted }
let showArchived = false;       // Chats e archive kora gulo dekhachhi kina
let mentionPicks = new Map();   // composer e @ diye bachha: nam -> user id

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

// ---------- Link: lekhar bhitor link clickable + preview card ----------
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,;:!?)\]}]/gi;

function linkHref(raw) { return /^https?:\/\//i.test(raw) ? raw : 'https://' + raw; }

// message er lekha: link gulo <a>, baki tuku emoji soho
function appendMessageText(parent, text) {
    text = text || '';
    let i = 0;
    for (const m of text.matchAll(URL_RE)) {
        if (m.index > i) appendRich(parent, text.slice(i, m.index));
        const a = document.createElement('a');
        a.className = 'msg-link';
        a.href = linkHref(m[0]);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = m[0];
        a.addEventListener('click', (e) => e.stopPropagation());
        parent.appendChild(a);
        i = m.index + m[0].length;
    }
    if (i < text.length) appendRich(parent, text.slice(i));
}

function firstLink(text) {
    const m = (text || '').match(URL_RE);
    return m ? linkHref(m[0]) : null;
}

const previewCache = new Map();         // url -> { data } (null = preview nai) | { pending: Promise }

function linkCard(p) {
    const card = el('a', 'link-card');
    card.href = p.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.addEventListener('click', (e) => e.stopPropagation());
    if (p.image) {
        const img = el('img', 'link-img');
        img.src = p.image;
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.remove();                  // chhobi na ashle shudhu lekha
        card.appendChild(img);
    }
    const body = el('span', 'link-body');
    if (p.site) body.appendChild(el('small', 'link-site', p.site));
    if (p.title) body.appendChild(el('strong', 'link-title', p.title));
    if (p.description) body.appendChild(el('span', 'link-desc', p.description));
    card.appendChild(body);
    return card;
}

// bubble e preview: cache e thakle sathe sathe, na thakle server theke ene boshabo
function attachLinkPreview(bubble, url, msgId) {
    const hit = previewCache.get(url);
    if (hit && 'data' in hit) {
        if (hit.data) bubble.insertBefore(linkCard(hit.data), bubble.querySelector('.time'));
        return;
    }
    let pending = hit && hit.pending;
    if (!pending) {
        pending = request('/api/link-preview?url=' + encodeURIComponent(url))
            .then(d => { const data = (d && d.preview) || null; previewCache.set(url, { data }); return data; })
            .catch(() => { previewCache.delete(url); return null; });
        previewCache.set(url, { pending });
    }
    pending.then(data => {
        if (!data) return;
        const box = $('messageContainer');
        const target = box.querySelector('.msg[data-id="' + msgId + '"]');
        if (!target || target.querySelector('.link-card')) return;
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
        target.insertBefore(linkCard(data), target.querySelector('.time'));
        if (nearBottom) box.scrollTop = box.scrollHeight;     // card ashle niche thako
    });
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
    setInterval(loadGroups, 15000);     // group (backup, socket na thakle)
    loadGroups();
    loadChatSettings();
    initPush();                         // aage permission dile app bondho thakleo notification

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && activeChat) { loadMessages(true); markActiveRead(); }
        if (!document.hidden) updateBadges();
    });

    // browser notification + sound: prothom click er por allow (browser rule)
    document.addEventListener('click', () => {
        try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
        try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
    }, { once: true });
}

async function logout() {
    // ei device e ar notification na (beshi deri hole opekkha kori na)
    try { await Promise.race([unsubscribePush(), new Promise(r => setTimeout(r, 1500))]); } catch (e) {}
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

        // je chat khola ache se ar friend na (remove / block) -> chat bondho
        if (activeChat && !activeChat.isGroup && !friends.some(f => f.id === activeChat.id)) closeChat();

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

        const sentData = await request(`/api/friend-request/sent/${currentUser.id}`);
        const nextSent = sentData.requests || [];
        const sentChanged = JSON.stringify(nextSent) !== JSON.stringify(sentRequests);
        sentRequests = nextSent;

        if ((changed || sentChanged) && activeTab === 'requests') renderPane();
        if ((changed || sentChanged) && activeTab === 'find' && searchTerm) {
            const box = $('searchResults');
            if (box) searchUsers(searchTerm, box);                     // Add/Requested button thik rakho
        }
    } catch (err) { console.error(err); }
}

// ---------- middle pane ----------
function renderPane() {
    const body = $('paneBody');
    body.innerHTML = '';
    redrawChats = null;

    if (activeTab === 'chats')    { $('paneTitle').textContent = 'Chats';           renderChats(body); }
    if (activeTab === 'calls')    { $('paneTitle').textContent = 'Calls';           if (typeof renderCallHistory === 'function') renderCallHistory(body); }
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

// ---- Chats (group + friend eksathe, pin / archive / mute soho) ----
function renderChats(body) {
    const row = el('div', 'search-row');
    const field = el('div', 'search-field');
    field.appendChild(searchIcon());
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Search chats...';
    input.value = friendFilter;
    field.appendChild(input);
    row.appendChild(field);
    const saved = el('button', 'icon-btn saved-btn', '⭐');
    saved.type = 'button';
    saved.title = 'Saved messages';
    saved.addEventListener('click', openSavedMessages);
    row.appendChild(saved);
    const newGroup = el('button', 'btn-pill new-group-btn', '＋ Group');
    newGroup.type = 'button';
    newGroup.title = 'Create a new group';
    newGroup.addEventListener('click', openCreateGroup);
    row.appendChild(newGroup);
    body.appendChild(row);

    const list = el('div');
    body.appendChild(list);

    const draw = () => {
        list.innerHTML = '';
        const q = friendFilter.toLowerCase();
        const all = [
            ...groups.map(g => ({ type: 'group', key: 'g' + g.id, g, name: g.name, unread: isActive({ isGroup: true, id: g.id }) ? 0 : (g.unread || 0), order: g.last_id || 0 })),
            ...friends.map(f => ({ type: 'friend', key: 'u' + f.id, f, name: f.name, email: f.email, unread: (unread[f.id] || {}).count || 0, order: (unread[f.id] || {}).last_id || 0 }))
        ].filter(r => r.name.toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q));

        const st = (r) => chatSettings[r.key] || {};
        const archivedRows = all.filter(r => st(r).archived);
        // pin agey (notun pin upore), tarpor unread, tarpor shesh message
        const rows = all.filter(r => !!st(r).archived === showArchived).sort((a, b) => {
            const pa = st(a).pinned_at ? new Date(st(a).pinned_at).getTime() : 0;
            const pb = st(b).pinned_at ? new Date(st(b).pinned_at).getTime() : 0;
            return (pb - pa) || (Math.sign(b.unread) - Math.sign(a.unread)) || (b.order - a.order) || a.name.localeCompare(b.name);
        });

        if (friends.length === 0 && groups.length === 0) {
            list.appendChild(emptyNote('No chats yet.', 'Find People', () => switchTab('find')));
            return;
        }

        // "Archived (3)" / "← Back to chats"
        if (showArchived || archivedRows.length) {
            const unreadArch = archivedRows.reduce((n, r) => n + r.unread, 0);
            const ar = el('button', 'item archive-row');
            ar.type = 'button';
            ar.appendChild(el('span', 'archive-icon', showArchived ? '←' : '🗄️'));
            ar.appendChild(el('strong', '', showArchived ? 'Back to chats' : 'Archived (' + archivedRows.length + ')'));
            if (!showArchived && unreadArch) ar.appendChild(el('b', 'badge muted', String(unreadArch)));
            ar.addEventListener('click', () => { showArchived = !showArchived; draw(); });
            list.appendChild(ar);
        }

        if (rows.length === 0) {
            list.appendChild(emptyNote(showArchived ? 'No archived chats.' : 'No chat matches your search.'));
            return;
        }

        rows.forEach(r => {
            const s0 = st(r);
            const isGroup = r.type === 'group';
            const muted = isGroup ? !!r.g.muted : !!s0.muted;
            const item = el('div', 'item chat-row' + (isActive(isGroup ? { isGroup: true, id: r.g.id } : r.f) ? ' active' : '') + (r.unread ? ' has-unread' : ''));
            item.tabIndex = 0;
            if (isGroup) {
                const g = r.g;
                const av = el('div', 'av-wrap');
                av.appendChild(makeAvatar(g.name, 'group-av', g.photo));
                av.appendChild(el('i', 'group-mark', '👥'));
                item.appendChild(av);
                const info = el('div', 'item-body');
                info.appendChild(el('strong', '', g.name));
                const typers = groupTypingNames(g.id);
                let sub;
                if (typers) sub = typers;
                else if (!g.last_id) sub = g.member_count + ' members';
                else if (g.last_is_system) sub = (g.last_sender_id === currentUser.id ? 'You' : (g.last_sender_name || '')) + ' ' + g.last_message;
                else sub = (g.last_sender_id === currentUser.id ? 'You' : (g.last_sender_name || '').split(' ')[0]) + ': ' + (g.last_message || '');
                info.appendChild(el('small', typers ? 'typing-now' : '', sub));
                item.appendChild(info);
                if (g.mention_unread && r.unread) item.appendChild(el('b', 'mention-badge', '@'));
                item.addEventListener('click', () => openGroup(g));
            } else {
                const f = r.f;
                const u = unread[f.id];
                item.appendChild(avatarWithStatus(f.name, f.avatar, f.id));
                const info = el('div', 'item-body');
                info.appendChild(el('strong', '', f.name));
                const typing = !!typingFrom[f.id];
                info.appendChild(el('small', typing ? 'typing-now' : '', typing ? 'typing...' : (u ? u.last_message : (f.email || ''))));
                item.appendChild(info);
                item.addEventListener('click', () => openChat(f));
            }
            item.addEventListener('keydown', (e) => { if (e.key === 'Enter') item.click(); });
            const flags = el('span', 'chat-flags');
            if (s0.pinned_at) flags.appendChild(el('span', '', '📌'));
            if (muted) flags.appendChild(el('span', '', '🔕'));
            if (flags.children.length) item.appendChild(flags);
            if (r.unread) item.appendChild(el('b', 'badge' + (muted ? ' muted' : ''), r.unread > 99 ? '99+' : String(r.unread)));

            // ⋯ : Pin / Archive / Mute
            const more = el('button', 'icon-btn chat-more', '⋯');
            more.type = 'button';
            more.title = 'Chat options';
            more.addEventListener('click', (e) => { e.stopPropagation(); openActionMenu(more, chatOptionItems(r)); });
            item.appendChild(more);
            item.addEventListener('contextmenu', (e) => { e.preventDefault(); openActionMenu(more, chatOptionItems(r)); });
            list.appendChild(item);
        });
    };

    input.addEventListener('input', () => { friendFilter = input.value.trim(); draw(); });
    draw();
    redrawChats = draw;
}

// ---------- Pin / Archive / Mute chat ----------
async function loadChatSettings() {
    try {
        const data = await request('/api/chat-settings');
        const next = {};
        (data.settings || []).forEach(r => { next[r.chat_type + r.chat_id] = r; });
        chatSettings = next;
        updateBadges();
        if (activeTab === 'chats' && redrawChats) redrawChats();
    } catch (err) { console.error(err); }
}

function isChatMuted(type, id) {
    if (type === 'g') { const g = groups.find(x => x.id === id); return !!(g && g.muted); }
    return !!(chatSettings['u' + id] || {}).muted;
}

function chatOptionItems(r) {
    const type = r.type === 'group' ? 'g' : 'u';
    const id = r.type === 'group' ? r.g.id : r.f.id;
    const s0 = chatSettings[type + id] || {};
    const muted = isChatMuted(type, id);
    return [
        { label: s0.pinned_at ? '📍 Unpin chat' : '📌 Pin chat', action: () => setChatSetting(type, id, { pinned: !s0.pinned_at }) },
        { label: s0.archived ? '📤 Unarchive' : '🗄️ Archive', action: () => setChatSetting(type, id, { archived: !s0.archived }) },
        { label: muted ? '🔔 Unmute' : '🔕 Mute', action: () => setChatSetting(type, id, { muted: !muted }) }
    ];
}

async function setChatSetting(type, id, change) {
    try {
        const r = await postJSON('/api/chat-settings', Object.assign({ type, id }, change));
        if (!r.ok) { alert(r.message || 'Could not update chat.'); return; }
        if (change.muted !== undefined && type === 'g') {
            const g = groups.find(x => x.id === id);
            if (g) g.muted = change.muted;
        }
        await loadChatSettings();
        if (change.archived) showToast('Archived', 'Find it under "Archived" at the top of Chats.');
        else if (change.muted !== undefined) showToast('Notifications', change.muted ? 'Chat muted 🔕' : 'Chat unmuted 🔔');
    } catch (err) { console.error(err); }
}

// ---- My Friends ----
function renderFriends(body) {
    if (friends.length === 0) {
        body.appendChild(emptyNote('You have no friends yet.', 'Find People', () => switchTab('find')));
        return;
    }

    // Online / Offline filter
    const onCount = friends.filter(f => online.has(f.id)).length;
    const chips = el('div', 'filter-chips');
    [['all', 'All', friends.length], ['online', 'Online', onCount], ['offline', 'Offline', friends.length - onCount]].forEach(([key, label, n]) => {
        const c = el('button', 'chip' + (friendStatusFilter === key ? ' active' : ''), label + ' (' + n + ')');
        c.type = 'button';
        c.addEventListener('click', () => { friendStatusFilter = key; renderPane(); });
        chips.appendChild(c);
    });
    body.appendChild(chips);

    const shown = friends
        .filter(f => friendStatusFilter === 'all' || (friendStatusFilter === 'online') === online.has(f.id))
        .sort((a, b) => (online.has(b.id) - online.has(a.id)) || a.name.localeCompare(b.name));   // online agey

    if (!shown.length) {
        body.appendChild(emptyNote(friendStatusFilter === 'online' ? 'No friends online right now.' : 'Everyone is online!'));
        return;
    }

    shown.forEach(f => {
        const item = el('div', 'item');
        const av = avatarWithStatus(f.name, f.avatar, f.id);
        av.classList.add('clickable');
        av.addEventListener('click', () => openProfile(f.id));
        item.appendChild(av);
        const info = el('div', 'item-body clickable');
        info.appendChild(el('strong', '', f.name));
        const isOn = online.has(f.id);
        info.appendChild(el('small', isOn ? 'online-now' : '', isOn ? 'Online' : (lastSeenText(f.last_seen_at) || f.email || '')));
        info.addEventListener('click', () => openProfile(f.id));
        item.appendChild(info);

        const msg = el('button', 'btn-sm', 'Message');
        msg.type = 'button';
        msg.addEventListener('click', () => openChat(f));
        item.appendChild(msg);

        const more = el('button', 'icon-btn more-btn', '⋯');
        more.type = 'button';
        more.title = 'More';
        more.addEventListener('click', (e) => { e.stopPropagation(); openActionMenu(more, friendMenuItems(f, 'friend')); });
        item.appendChild(more);
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
        const av = makeAvatar(user.name, 'clickable', user.avatar);
        av.addEventListener('click', () => openProfile(user.id));
        item.appendChild(av);
        const info = el('div', 'item-body clickable');
        info.appendChild(el('strong', '', user.name));
        info.appendChild(el('small', '', user.email));
        info.addEventListener('click', () => openProfile(user.id));
        item.appendChild(info);

        // server bole dey amader somporko: friend / sent / received / none
        const rel = user.relation || (friends.some(f => f.id === user.id) ? 'friend' : 'none');
        if (rel === 'friend') {
            item.appendChild(el('span', 'tag', 'Friend'));
        } else if (rel === 'sent') {
            const c = el('button', 'btn-sm ghost', 'Requested ✕');
            c.type = 'button';
            c.title = 'Cancel request';
            c.addEventListener('click', () => cancelRequest(user.id, c));
            item.appendChild(c);
        } else if (rel === 'received') {
            const a = el('button', 'btn-sm green', 'Accept');
            a.type = 'button';
            a.addEventListener('click', () => acceptRequest(user.request_id, a));
            item.appendChild(a);
        } else {
            const add = el('button', 'btn-sm', 'Add Friend');
            add.type = 'button';
            add.addEventListener('click', () => sendRequest(user.id, add));
            item.appendChild(add);
        }
        container.appendChild(item);
    });
}

// friend request er por search / profile abar draw (button er obostha bodlabe)
function refreshAfterFriendAction() {
    loadPending();
    loadFriends();
    const box = $('searchResults');
    if (activeTab === 'find' && box && searchTerm) searchUsers(searchTerm, box);
}

async function sendRequest(receiverId, btn) {
    try {
        if (btn) btn.disabled = true;
        const res = await authFetch('/api/friend-request/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ receiver_id: receiverId })
        });
        const result = await res.json();
        if (!res.ok) {
            if (btn) btn.disabled = false;
            alert(result.message || 'Failed to send request');
            return false;
        }
        refreshAfterFriendAction();
        return true;
    } catch (err) { if (btn) btn.disabled = false; console.error(err); return false; }
}

async function cancelRequest(receiverId, btn) {
    try {
        if (btn) btn.disabled = true;
        const r = await postJSON('/api/friend-request/cancel', { receiver_id: receiverId });
        if (!r.ok) { if (btn) btn.disabled = false; alert(r.message || 'Could not cancel.'); return false; }
        refreshAfterFriendAction();
        return true;
    } catch (err) { if (btn) btn.disabled = false; console.error(err); return false; }
}

async function rejectRequest(senderId, btn) {
    try {
        if (btn) btn.disabled = true;
        const r = await postJSON('/api/friend-request/decline', { sender_id: senderId });
        if (!r.ok) { if (btn) btn.disabled = false; alert(r.message || 'Could not reject.'); return false; }
        refreshAfterFriendAction();
        return true;
    } catch (err) { if (btn) btn.disabled = false; console.error(err); return false; }
}

// ---- Friend Requests ----
function renderRequests(body) {
    if (pending.length === 0 && sentRequests.length === 0) {
        body.appendChild(emptyNote('No pending requests.', 'Find People', () => switchTab('find')));
        return;
    }

    // je request gulo amar kache esheche: Accept / Reject
    if (pending.length) {
        body.appendChild(el('div', 'count-note', 'Received (' + pending.length + ')'));
        pending.forEach(r => {
            const item = el('div', 'item');
            const av = makeAvatar(r.name, 'clickable', r.avatar);
            av.addEventListener('click', () => openProfile(r.sender_id));
            item.appendChild(av);
            const info = el('div', 'item-body clickable');
            info.appendChild(el('strong', '', r.name));
            info.appendChild(el('small', '', r.email || ''));
            info.addEventListener('click', () => openProfile(r.sender_id));
            item.appendChild(info);

            const accept = el('button', 'btn-sm green', 'Accept');
            accept.type = 'button';
            accept.addEventListener('click', () => acceptRequest(r.request_id, accept));
            item.appendChild(accept);
            const reject = el('button', 'btn-sm ghost', 'Reject');
            reject.type = 'button';
            reject.addEventListener('click', () => rejectRequest(r.sender_id, reject));
            item.appendChild(reject);
            body.appendChild(item);
        });
    }

    // ami je request pathiyechi: Cancel
    if (sentRequests.length) {
        body.appendChild(el('div', 'count-note', 'Sent (' + sentRequests.length + ')'));
        sentRequests.forEach(r => {
            const item = el('div', 'item');
            const av = makeAvatar(r.name, 'clickable', r.avatar);
            av.addEventListener('click', () => openProfile(r.receiver_id));
            item.appendChild(av);
            const info = el('div', 'item-body clickable');
            info.appendChild(el('strong', '', r.name));
            info.appendChild(el('small', '', 'Waiting for reply'));
            info.addEventListener('click', () => openProfile(r.receiver_id));
            item.appendChild(info);
            const cancel = el('button', 'btn-sm ghost', 'Cancel');
            cancel.type = 'button';
            cancel.addEventListener('click', () => cancelRequest(r.receiver_id, cancel));
            item.appendChild(cancel);
            body.appendChild(item);
        });
    }
}

async function acceptRequest(requestId, btn) {
    try {
        if (btn) btn.disabled = true;
        const r = await postJSON('/api/friend-request/accept', { request_id: requestId });
        if (r.message && /not allowed/i.test(r.message)) { alert('This request is no longer available.'); }
        await loadPending();
        await loadFriends();
        renderPane();
        return true;
    } catch (err) { if (btn) btn.disabled = false; console.error(err); return false; }
}

// ---- My Profile ----
function renderProfile(body) {
    const card = el('div', 'profile-card');

    // ---- Cover photo ----
    const cover = el('div', 'cover-box');
    paintCover(cover, currentUser.cover);
    const coverFile = el('input');
    coverFile.type = 'file';
    coverFile.accept = 'image/*';
    coverFile.hidden = true;
    coverFile.addEventListener('change', () => { if (coverFile.files[0]) uploadCover(coverFile.files[0], cover); coverFile.value = ''; });
    const coverBtn = el('button', 'cover-btn', currentUser.cover ? '📷 Change cover' : '📷 Add cover');
    coverBtn.type = 'button';
    coverBtn.addEventListener('click', () => coverFile.click());
    cover.appendChild(coverBtn);
    if (currentUser.cover) {
        const rmCover = el('button', 'cover-btn cover-rm', '✕');
        rmCover.type = 'button';
        rmCover.title = 'Remove cover';
        rmCover.addEventListener('click', removeCover);
        cover.appendChild(rmCover);
    }
    cover.appendChild(coverFile);
    card.appendChild(cover);
    syncMyCover();

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

    // ---- Push notification ----
    const pushBtn = el('button', 'btn-install', '🔔 Notifications: checking...');
    pushBtn.type = 'button';
    card.appendChild(pushBtn);
    refreshPushButton(pushBtn);

    // ---- Install app (PWA) ----
    if (window.TalkFavPWA) {
        const st = window.TalkFavPWA.state();
        const ib = el('button', 'btn-install', st.installed ? '✅ TalkFav app is installed' : '📲 Install TalkFav app');
        ib.type = 'button';
        ib.disabled = st.installed;
        ib.addEventListener('click', () => window.TalkFavPWA.install());
        card.appendChild(ib);
    }

    const out = el('button', 'btn-logout', 'Log Out');
    out.type = 'button';
    out.addEventListener('click', logout);
    card.appendChild(out);
    body.appendChild(card);

    // Block kora manush (Unblock)
    const blockedBox = el('div', 'blocked-box');
    blockedBox.appendChild(el('div', 'count-note', 'Blocked users'));
    const list = el('div');
    list.appendChild(el('small', 'muted-note', 'Loading...'));
    blockedBox.appendChild(list);
    body.appendChild(blockedBox);
    loadBlocked(list);
}

async function loadBlocked(list) {
    try {
        const data = await request('/api/users/blocked');
        list.innerHTML = '';
        const users = data.users || [];
        if (!users.length) { list.appendChild(el('small', 'muted-note', "You haven't blocked anyone.")); return; }
        users.forEach(u => {
            const item = el('div', 'item');
            item.appendChild(makeAvatar(u.name, '', u.avatar));
            const info = el('div', 'item-body');
            info.appendChild(el('strong', '', u.name));
            info.appendChild(el('small', '', 'Blocked'));
            item.appendChild(info);
            const ub = el('button', 'btn-sm ghost', 'Unblock');
            ub.type = 'button';
            ub.addEventListener('click', async () => {
                if (await unblockUser(u)) loadBlocked(list);
            });
            item.appendChild(ub);
            list.appendChild(item);
        });
    } catch (err) { console.error(err); }
}

// ---------- Cover photo ----------
function paintCover(box, url) {
    box.classList.toggle('has-cover', !!url);
    box.style.backgroundImage = url ? 'url("' + cldUrl(url, 'c_fill,w_900,h_300,q_auto,f_auto') + '")' : '';
}

// purono login e cover chhilo na, tai ekbar server theke niye ashi
let coverSynced = false;
async function syncMyCover() {
    if (coverSynced) return;
    coverSynced = true;
    try {
        const data = await request('/api/users/' + currentUser.id + '/profile');
        const c = (data.user && data.user.cover) || null;
        if (c !== (currentUser.cover || null)) {
            currentUser.cover = c;
            localStorage.setItem('user', JSON.stringify(currentUser));
            if (activeTab === 'profile') renderPane();
        }
    } catch (e) {}
}

async function uploadCover(file, box) {
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
    if (file.size > UPLOAD_LIMIT_MB.image * 1024 * 1024) { alert('Cover photo is too large. Max ' + UPLOAD_LIMIT_MB.image + ' MB.'); return; }
    const label = el('div', 'cover-progress', 'Uploading 0%');
    box.appendChild(label);
    try {
        const sig = await postJSON('/api/upload/sign', { kind: 'image', size: file.size, name: file.name });
        if (!sig.ok) throw new Error(sig.message || 'Upload not allowed');
        const form = new FormData();
        form.append('file', file);
        Object.entries(sig.fields).forEach(([k, v]) => form.append(k, v));
        const fakeItem = { setProgress(p) { label.textContent = p < 100 ? 'Uploading ' + p + '%' : 'Saving...'; } };
        const result = await xhrUpload(sig.uploadUrl, form, fakeItem);
        const r = await postJSON('/api/users/cover', { url: result.secure_url, public_id: result.public_id });
        if (!r.ok) throw new Error(r.message || 'Could not save cover');
        currentUser.cover = r.cover;
        localStorage.setItem('user', JSON.stringify(currentUser));
        if (activeTab === 'profile') renderPane();
    } catch (err) {
        console.error(err);
        label.remove();
        alert('Could not upload cover: ' + err.message);
    }
}

async function removeCover() {
    if (!confirm('Remove your cover photo?')) return;
    try {
        const r = await postJSON('/api/users/cover', {});
        if (!r.ok) { alert(r.message || 'Could not remove cover.'); return; }
        currentUser.cover = null;
        localStorage.setItem('user', JSON.stringify(currentUser));
        if (activeTab === 'profile') renderPane();
    } catch (err) { console.error(err); }
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
// group id ar user id eki songkhya hote pare, tai "g5" / "u5" diye alada kori
function chatKey(c) { return c ? (c.isGroup ? 'g' : 'u') + c.id : ''; }
function isActive(c) { return !!activeChat && chatKey(activeChat) === chatKey(c); }
function isGroupChat() { return !!(activeChat && activeChat.isGroup); }
// message kothay jabe: friend ke na group e
function chatTarget() { return isGroupChat() ? { group_id: activeChat.id } : { receiver_id: activeChat.id }; }

function openChat(friend) {
    if (activeChat && !isActive(friend)) sendTyping(false);   // ager chat e typing bondho
    activeChat = friend;
    lastMsgKey = null;
    const isGroup = !!friend.isGroup;
    if (!isGroup) groupInfo = null;

    $('chatEmpty').hidden = true;
    $('chatSection').hidden = false;
    $('app').classList.add('chat-open');

    $('chatTitle').textContent = friend.name;
    setAvatar($('chatAvatar'), friend.name, isGroup ? friend.photo : friend.avatar);
    // group e call nai
    $('audioCallBtn').hidden = isGroup;
    $('videoCallBtn').hidden = isGroup;
    applyComposerPermission();
    refreshChatHead();

    $('messageContainer').innerHTML = '';
    if (activeTab === 'chats') renderPane();       // highlight active chat

    // notun chat: age purono chat er message muche, tarpor shesh 50 ta load
    currentMsgs = [];
    hasMoreOlder = false;
    pinnedList = [];
    markActiveRead();
    loadMessages(true);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!socketUp) loadMessages(false); }, 3000);   // socket na thakle auto-refresh
    if (composeMode) cancelCompose();               // onno chat e reply/edit cholbe na
    closeSearch();
    stopRecording(true);                            // onno chat e gele recording batil
    pinIndex = 0;
    if (isGroup) loadGroupInfo(friend.id);
    $('messageInput').focus();
}

function openGroup(g) {
    groupInfo = null;
    openChat({ isGroup: true, id: g.id, name: g.name, photo: g.photo, member_count: g.member_count });
}

// khola chat "porha hoyeche"
function markActiveRead() {
    if (!activeChat) return;
    if (activeChat.isGroup) markGroupRead(activeChat.id);
    else markRead(activeChat.id);
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
            { label: msg.pinned_at ? '📍 Unpin' : '📌 Pin', action: () => togglePin(msg) },
            { label: msg.saved ? '☆ Unsave' : '⭐ Save', action: () => toggleSave(msg) }
        ];
        if (isMe) {
            if (msg.message && !msg.poll) items.push({ label: '✏️ Edit',   action: () => startEdit(msg) });   // shudhu lekha edit hoy
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
    if ($('modalOverlay')) { closeModal(); return; }
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
    if (isGroupChat()) return groupMemberName(id);
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
    q.appendChild(el('strong', '', msg.reply_sender_id === currentUser.id ? 'You' : (msg.reply_sender_name || senderName(msg.reply_sender_id))));
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

// preview e click korle mul message e scroll + ektu jholok.
// message ta purono hole (ekhono load hoy ni) age upore load kore ani
async function jumpToMessage(id, quiet) {
    await ensureLoaded(id);
    const target = document.querySelector('#messageContainer .msg[data-id="' + id + '"]');
    if (!target) return false;                 // "Delete for me" kora thakle pawa jabe na
    target.scrollIntoView({ behavior: quiet ? 'auto' : 'smooth', block: 'center' });
    if (!quiet) {
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1200);
    }
    return true;
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
    const pinned = pinnedList;                  // server theke, notun pin agey (purono message holeo)
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
let searchIds = [];             // server theke: puro history te mil thaka message er id
let searchPos = -1;
let searchTimer = null;
let searchReq = 0;

function openSearch() {
    searchOpen = true;
    $('searchBar').hidden = false;
    $('msgSearchInput').focus();
}

function closeSearch() {
    if (!$('searchBar')) return;
    searchOpen = false;
    searchQ = '';
    searchIds = [];
    searchPos = -1;
    clearTimeout(searchTimer);
    $('msgSearchInput').value = '';
    $('searchBar').hidden = true;
    applySearch();
}

function onSearchInput(value) {
    searchQ = value.trim();
    applySearch();                                  // load kora message e sathe sathe highlight
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runServerSearch, 350); // tarpor puro history te khoja
}

// puro conversation e khoje (purono, load na kora message o)
async function runServerSearch() {
    const q = searchQ;
    const my = ++searchReq;
    if (!q || !activeChat) { searchIds = []; searchPos = -1; updateSearchUI(); return; }
    const params = activeChat.isGroup ? { group: activeChat.id, q } : { user: activeChat.id, q };
    try {
        const data = await request('/api/messages/search?' + new URLSearchParams(params));
        if (my !== searchReq) return;               // ar o notun khoja chole esheche
        searchIds = data.ids || [];
        searchPos = searchIds.length - 1;           // shobcheye notun mil theke shuru
        goToSearchHit();
    } catch (err) { console.error(err); }
}

async function goToSearchHit() {
    updateSearchUI();
    const id = searchIds[searchPos];
    if (!id) return;
    await jumpToMessage(id, true);
    markSearchCurrent();
}

function markSearchCurrent() {
    const box = $('messageContainer');
    box.querySelectorAll('.msg.search-current').forEach(b => b.classList.remove('search-current'));
    const id = searchIds[searchPos];
    const cur = id && box.querySelector('.msg[data-id="' + id + '"]');
    if (cur) cur.classList.add('search-current');
}

// mil thaka lekha <mark> diye highlight (shudhu screen e ja ache)
function applySearch() {
    const box = $('messageContainer');
    const q = searchQ.toLowerCase();
    box.querySelectorAll('.msg-text').forEach(span => {
        const raw = span.dataset.raw || '';
        const lower = raw.toLowerCase();
        const hit = q && lower.includes(q);
        if (!hit && !span.querySelector('mark')) return;            // kichu bodlanor nai
        span.textContent = '';                                      // purono highlight muche felo
        if (!hit) { appendMessageText(span, raw); return; }
        let i = 0, at;
        while ((at = lower.indexOf(q, i)) !== -1) {
            appendRich(span, raw.slice(i, at));
            const mk = el('mark');
            appendRich(mk, raw.slice(at, at + q.length));
            span.appendChild(mk);
            i = at + q.length;
        }
        appendRich(span, raw.slice(i));
    });
    markSearchCurrent();
}

function updateSearchUI() {
    const count = $('msgSearchCount');
    if (!count) return;
    count.textContent = searchIds.length ? (searchPos + 1) + '/' + searchIds.length : (searchQ ? '0' : '');
}

function moveSearch(dir) {
    if (!searchIds.length) return;
    searchPos = (searchPos + dir + searchIds.length) % searchIds.length;
    goToSearchHit();
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
    // upore scroll korle purono message
    box.addEventListener('scroll', () => { if (box.scrollTop < 150) loadOlder(); }, { passive: true });

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
    si.addEventListener('input', () => onSearchInput(si.value));
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

    // header e ⋯ (Profile / Remove / Block / Report), ar nam-chhobi te click = profile
    const hmore = el('button', 'icon-btn more-btn', '⋯');
    hmore.type = 'button';
    hmore.title = 'More';
    hmore.setAttribute('aria-label', 'More options');
    hmore.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!activeChat) return;
        if (activeChat.isGroup) openActionMenu(hmore, groupMenuItems());
        else openActionMenu(hmore, friendMenuItems(activeChat, 'friend').concat(chatOptionItems({ type: 'friend', f: activeChat })));
    });
    actions.appendChild(hmore);
    ['chatTitle', 'chatAvatar'].forEach(id => {
        const n = $(id);
        n.classList.add('clickable');
        n.title = 'View profile';
        n.addEventListener('click', () => {
            if (!activeChat) return;
            if (activeChat.isGroup) openGroupInfo(activeChat.id);
            else openProfile(activeChat.id);
        });
    });

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
// PUSH NOTIFICATION (app bondho thakleo)
// =====================================================
let appConfig = null;
async function getConfig() {
    if (appConfig) return appConfig;
    try { appConfig = await (await fetch(API + '/api/config')).json(); } catch (e) { appConfig = {}; }
    return appConfig;
}

function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlB64ToUint8Array(base64) {
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// browser theke "subscription" niye server e pathai
async function subscribePush(askPermission) {
    if (!pushSupported()) return 'unsupported';
    const cfg = await getConfig();
    if (!cfg.vapidPublicKey) return 'off';
    let perm = Notification.permission;
    if (perm === 'default' && askPermission) perm = await Notification.requestPermission();
    if (perm !== 'granted') return perm;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(cfg.vapidPublicKey) });
    await postJSON('/api/push/subscribe', { subscription: sub.toJSON() });
    return 'granted';
}

async function unsubscribePush() {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
        await postJSON('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
    }
}

// age permission dile chupchap chalu kori (notun device / login er por)
function initPush() {
    if (pushSupported() && Notification.permission === 'granted') subscribePush(false).catch(console.error);
}

async function refreshPushButton(btn) {
    const setLabel = (text, disabled) => { btn.textContent = text; btn.disabled = !!disabled; };
    if (!pushSupported()) {
        const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        setLabel(ios ? '🔔 Notifications: install the app first (Share → Add to Home Screen)' : '🔔 Notifications not supported in this browser', true);
        return;
    }
    const cfg = await getConfig();
    if (!cfg.vapidPublicKey) { setLabel('🔔 Notifications are not set up on the server yet', true); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const on = Notification.permission === 'granted' && !!sub;
    if (Notification.permission === 'denied') { setLabel('🔕 Notifications blocked (allow them in browser settings)', true); return; }
    setLabel(on ? '🔔 Notifications: ON (tap to turn off)' : '🔕 Notifications: OFF (tap to turn on)');
    btn.onclick = async () => {
        btn.disabled = true;
        try {
            if (on) await unsubscribePush();
            else {
                const r = await subscribePush(true);
                if (r !== 'granted') alert(r === 'denied' ? 'Notifications are blocked. Allow them in your browser settings.' : 'Could not turn on notifications.');
            }
        } catch (err) { console.error(err); alert('Could not change notifications.'); }
        refreshPushButton(btn);
    };
}

// =====================================================
// @MENTION (group e)
// =====================================================
let mentionBox = null;

function setupMentions(input) {
    mentionBox = el('div', 'mention-box');
    mentionBox.hidden = true;
    document.body.appendChild(mentionBox);
    input.addEventListener('input', () => updateMentionBox(input));
    input.addEventListener('keydown', (e) => {
        if (mentionBox.hidden) return;
        const items = [...mentionBox.querySelectorAll('.mention-item')];
        let idx = items.findIndex(i => i.classList.contains('sel'));
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items.forEach((it, i) => it.classList.toggle('sel', i === idx));
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (idx >= 0) { e.preventDefault(); e.stopImmediatePropagation(); items[idx].click(); }
        } else if (e.key === 'Escape') {
            mentionBox.hidden = true;
        }
    }, true);
    input.addEventListener('blur', () => setTimeout(() => { if (mentionBox) mentionBox.hidden = true; }, 200));
}

// cursor er age "@kichu" thakle member der list
function updateMentionBox(input) {
    if (!isGroupChat() || !groupInfo) { mentionBox.hidden = true; return; }
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/(?:^|\s)@([^\s@]{0,30})$/);
    if (!m) { mentionBox.hidden = true; return; }
    const q = m[1].toLowerCase();
    const list = groupInfo.members.filter(x => x.id !== currentUser.id && x.name.toLowerCase().includes(q)).slice(0, 8);
    if (!list.length) { mentionBox.hidden = true; return; }
    mentionBox.innerHTML = '';
    list.forEach((mem, i) => {
        const it = el('button', 'mention-item' + (i === 0 ? ' sel' : ''));
        it.type = 'button';
        it.appendChild(makeAvatar(mem.name, 'tiny', mem.avatar));
        it.appendChild(el('span', '', mem.name));
        it.addEventListener('mousedown', (e) => e.preventDefault());       // input er focus thakuk
        it.addEventListener('click', () => {
            const start = before.length - m[1].length - 1;                   // '@' er jayga
            const after = input.value.slice(input.selectionStart);
            input.value = input.value.slice(0, start) + '@' + mem.name + ' ' + after;
            const pos = start + mem.name.length + 2;
            input.setSelectionRange(pos, pos);
            mentionPicks.set(mem.name, mem.id);
            mentionBox.hidden = true;
            input.focus();
        });
        mentionBox.appendChild(it);
    });
    const r = input.getBoundingClientRect();
    mentionBox.hidden = false;
    mentionBox.style.left = r.left + 'px';
    mentionBox.style.width = Math.min(320, r.width) + 'px';
    mentionBox.style.top = (r.top - mentionBox.offsetHeight - 8) + 'px';
}

// pathanor age: lekhay ekhono je "@Nam" gulo ache tader id
function collectMentions(text) {
    if (!isGroupChat()) return [];
    const ids = new Set();
    mentionPicks.forEach((id, name) => { if (text.includes('@' + name)) ids.add(id); });
    // haate likhle-o (pura nam) dhori
    if (groupInfo) groupInfo.members.forEach(mem => { if (mem.id !== currentUser.id && text.includes('@' + mem.name)) ids.add(mem.id); });
    return [...ids];
}

// "@Nam" gulo rongin (je message e mention ache)
function highlightMentions(span, msg) {
    const names = (msg.mentions || []).map(id => id === currentUser.id ? (currentUser.name) : groupMemberName(id)).filter(n => n && n !== 'Member' && n !== 'You');
    if (!names.length) return;
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
        let text = node.nodeValue;
        const frag = document.createDocumentFragment();
        let changed = false;
        while (true) {
            let best = -1, bestName = '';
            names.forEach(n => { const i = text.indexOf('@' + n); if (i !== -1 && (best === -1 || i < best)) { best = i; bestName = n; } });
            if (best === -1) break;
            changed = true;
            if (best > 0) frag.appendChild(document.createTextNode(text.slice(0, best)));
            frag.appendChild(el('span', 'mention' + (bestName === currentUser.name ? ' me' : ''), '@' + bestName));
            text = text.slice(best + bestName.length + 1);
        }
        if (!changed) return;
        if (text) frag.appendChild(document.createTextNode(text));
        node.parentNode.replaceChild(frag, node);
    });
}

// =====================================================
// POLL
// =====================================================
function openCreatePoll(groupId) {
    const box = openModal('Create poll');
    const form = el('div', 'group-form');
    const q = el('input', 'picker-search');
    q.type = 'text';
    q.placeholder = 'Ask a question...';
    q.maxLength = 300;
    form.appendChild(q);
    form.appendChild(el('div', 'count-note', 'Options'));
    const opts = el('div', 'poll-opts');
    form.appendChild(opts);
    const addOpt = (val) => {
        if (opts.children.length >= 10) return;
        const row = el('div', 'poll-opt-row');
        const inp = el('input', 'picker-search');
        inp.type = 'text';
        inp.placeholder = 'Option ' + (opts.children.length + 1);
        inp.maxLength = 100;
        inp.value = val || '';
        row.appendChild(inp);
        const x = el('button', 'icon-btn', '✕');
        x.type = 'button';
        x.title = 'Remove option';
        x.addEventListener('click', () => { if (opts.children.length > 2) row.remove(); });
        row.appendChild(x);
        opts.appendChild(row);
    };
    addOpt(); addOpt();
    const more = el('button', 'btn-sm ghost', '＋ Add option');
    more.type = 'button';
    more.addEventListener('click', () => addOpt());
    form.appendChild(more);
    const multiRow = el('label', 'fwd-row');
    const multi = el('input');
    multi.type = 'checkbox';
    multiRow.appendChild(multi);
    multiRow.appendChild(el('span', '', 'Allow multiple answers'));
    form.appendChild(multiRow);

    const actions = el('div', 'fwd-actions');
    const cancel = el('button', 'btn-sm ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    const create = el('button', 'btn-sm', 'Send poll');
    create.type = 'button';
    create.addEventListener('click', async () => {
        const options = [...opts.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
        if (!q.value.trim()) { alert('Please write a question.'); return; }
        if (new Set(options).size < 2) { alert('Please add at least 2 different options.'); return; }
        create.disabled = true;
        try {
            const r = await postJSON('/api/polls', { group_id: groupId, question: q.value.trim(), options, multiple: multi.checked });
            if (!r.ok) { alert(r.message || 'Could not create poll.'); create.disabled = false; return; }
            closeModal();
            loadMessages(true);
        } catch (err) { console.error(err); create.disabled = false; }
    });
    actions.appendChild(cancel);
    actions.appendChild(create);
    form.appendChild(actions);
    box.appendChild(form);
    q.focus();
}

function renderPoll(msg) {
    const p = msg.poll;
    const card = el('div', 'poll-card');
    card.appendChild(el('div', 'poll-q', '📊 ' + p.question));
    card.appendChild(el('small', 'poll-sub', p.closed ? 'Poll closed' : (p.multiple ? 'Select one or more' : 'Select one')));
    const max = Math.max(1, ...p.counts);
    const total = p.counts.reduce((a, b) => a + b, 0);
    p.options.forEach((opt, i) => {
        const mine = p.mine.includes(i);
        const row = el('button', 'poll-opt' + (mine ? ' mine' : '') + (p.counts[i] === max && total ? ' top' : ''));
        row.type = 'button';
        row.disabled = p.closed;
        const pct = total ? Math.round(p.counts[i] / Math.max(1, p.voters) * 100) : 0;
        const bar = el('i', 'poll-bar');
        bar.style.width = (total ? Math.round(p.counts[i] / Math.max(1, p.voters) * 100) : 0) + '%';
        row.appendChild(bar);
        row.appendChild(el('span', 'poll-check', mine ? '✔' : ''));
        row.appendChild(el('span', 'poll-text', opt));
        row.appendChild(el('span', 'poll-count', p.counts[i] + (total ? ' · ' + pct + '%' : '')));
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            let next;
            if (p.multiple) next = mine ? p.mine.filter(x => x !== i) : p.mine.concat(i);
            else next = mine ? [] : [i];
            votePoll(p.id, next);
        });
        card.appendChild(row);
    });
    const foot = el('div', 'poll-foot');
    foot.appendChild(el('small', '', p.voters + (p.voters === 1 ? ' vote' : ' votes')));
    const canClose = !p.closed && (p.created_by === currentUser.id || (groupInfo && groupInfo.group.my_role === 'admin'));
    if (canClose) {
        const c = el('button', 'poll-close', 'Close poll');
        c.type = 'button';
        c.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('Close this poll? No one will be able to vote after this.')) return;
            const r = await postJSON('/api/polls/' + p.id + '/close', {});
            if (!r.ok) alert(r.message || 'Could not close poll.'); else loadMessages(false);
        });
        foot.appendChild(c);
    }
    card.appendChild(foot);
    return card;
}

async function votePoll(pollId, options) {
    try {
        const r = await postJSON('/api/polls/' + pollId + '/vote', { options });
        if (!r.ok) { alert(r.message || 'Could not vote.'); return; }
        loadMessages(false);
    } catch (err) { console.error(err); }
}

// =====================================================
// SAVED MESSAGES
// =====================================================
async function toggleSave(msg) {
    try {
        const r = await postJSON('/api/messages/save', { message_id: msg.id, save: !msg.saved });
        if (!r.ok) { alert(r.message || 'Could not save.'); return; }
        showToast('Saved messages', msg.saved ? 'Removed from saved' : 'Saved ⭐ (find it with ⭐ in Chats)');
        loadMessages(false);
    } catch (err) { console.error(err); }
}

async function openSavedMessages() {
    const box = openModal('⭐ Saved messages');
    const body = el('div', 'saved-list');
    body.appendChild(el('p', 'muted-note', 'Loading...'));
    box.appendChild(body);
    let data;
    try { data = await request('/api/messages/saved'); } catch (e) { data = {}; }
    if (!$('modalOverlay')) return;
    body.innerHTML = '';
    const list = data.saved || [];
    if (!list.length) { body.appendChild(el('p', 'muted-note', 'No saved messages yet. Open a message menu (⋮) and tap "⭐ Save".')); return; }
    list.forEach(m => {
        const row = el('button', 'saved-item');
        row.type = 'button';
        const where = m.group_id ? '👥 ' + (m.group_name || 'Group') : (friends.find(f => f.id === m.peer_id) || { name: 'Chat' }).name;
        const top = el('div', 'saved-top');
        top.appendChild(makeAvatar(m.sender_name, 'tiny', m.sender_avatar));
        top.appendChild(el('strong', '', m.sender_id === currentUser.id ? 'You' : m.sender_name));
        top.appendChild(el('small', '', '· ' + where + ' · ' + dayLabel(new Date(m.created_at))));
        row.appendChild(top);
        const text = el('div', 'saved-text');
        appendRich(text, shortText(m.message || attachLabel(m.attachment_type, m.attachment_name), 160));
        row.appendChild(text);
        row.addEventListener('click', async () => {
            closeModal();
            if (m.group_id) {
                const g = groups.find(x => x.id === m.group_id);
                if (!g) return;
                switchTab('chats');
                openGroup(g);
            } else {
                const f = friends.find(x => x.id === m.peer_id);
                if (!f) { alert('This chat is not available anymore.'); return; }
                switchTab('chats');
                openChat(f);
            }
            await new Promise(r => setTimeout(r, 600));
            jumpToMessage(m.id);
        });
        body.appendChild(row);
    });
}

// =====================================================
// GROUP CHAT
// =====================================================
async function loadGroups() {
    try {
        const data = await request('/api/groups');
        const next = data.groups || [];
        const changed = JSON.stringify(next) !== JSON.stringify(groups);
        groups = next;
        if (!changed) return;

        if (activeChat && activeChat.isGroup) {
            const g = groups.find(x => x.id === activeChat.id);
            if (!g) {                                                    // remove kora hoyeche / leave
                closeChat();
                showToast('Group', 'You are no longer in this group.');
            } else {
                activeChat.name = g.name;
                activeChat.photo = g.photo;
                activeChat.member_count = g.member_count;
                $('chatTitle').textContent = g.name;
                setAvatar($('chatAvatar'), g.name, g.photo);
                refreshChatHead();
            }
        }
        updateBadges();
        if (activeTab === 'chats' && redrawChats) redrawChats();
    } catch (err) { console.error(err); }
}

async function loadGroupInfo(groupId) {
    try {
        const data = await request('/api/groups/' + groupId);
        if (!activeChat || !activeChat.isGroup || activeChat.id !== groupId) return;
        if (!data.group) return;
        groupInfo = data;
        refreshChatHead();
        applyComposerPermission();
    } catch (err) { console.error(err); }
}

function groupMemberName(id) {
    if (id === currentUser.id) return 'You';
    const m = groupInfo && groupInfo.members.find(x => x.id === id);
    if (m) return m.name;
    const msg = currentMsgs.find(x => x.sender_id === id && x.sender_name);
    return msg ? msg.sender_name : 'Member';
}

function markGroupRead(groupId) {
    const g = groups.find(x => x.id === groupId);
    if (g && g.unread) {
        g.unread = 0;
        updateBadges();
        if (activeTab === 'chats' && redrawChats) redrawChats();
    }
    postJSON('/api/groups/' + groupId + '/read', {}).catch(console.error);
}

// "shudhu admin message dite parbe" setting thakle lekhar jayga bondho
function applyComposerPermission() {
    const input = $('messageInput');
    const g = groupInfo && groupInfo.group;
    const locked = !!(isGroupChat() && g && g.send_permission === 'admins' && g.my_role !== 'admin');
    input.disabled = locked;
    input.placeholder = locked ? 'Only admins can send messages' : (isGroupChat() ? 'Type a message... (@ to mention)' : 'Type a message...');
    const pb = document.querySelector('.poll-btn');
    if (pb) pb.hidden = !isGroupChat();
    document.querySelector('.composer').classList.toggle('locked', locked);
}

// ---------- typing in group ----------
function onGroupTyping(d) {
    const map = groupTyping[d.group_id] || (groupTyping[d.group_id] = {});
    clearTimeout(map[d.from]);
    if (d.typing) map[d.from] = setTimeout(() => { delete map[d.from]; refreshTypingUI(); }, 4000);
    else delete map[d.from];
    refreshTypingUI();
}

function groupTypingNames(groupId) {
    const ids = Object.keys(groupTyping[groupId] || {}).map(Number);
    if (!ids.length) return '';
    const names = ids.map(id => {
        if (activeChat && activeChat.isGroup && activeChat.id === groupId) return groupMemberName(id).split(' ')[0];
        const f = friends.find(x => x.id === id);
        return f ? f.name.split(' ')[0] : 'Someone';
    });
    return names.length === 1 ? names[0] + ' is typing...' : names.length + ' people are typing...';
}

function notifyGroup(g, mentioned) {
    const who = (g.last_sender_name || '').split(' ')[0];
    const preview = (who ? who + ': ' : '') + (g.last_message || '');
    const short = preview.length > 70 ? preview.slice(0, 70) + '…' : preview;
    const open = () => { window.focus(); openGroup(g); };
    showToast((mentioned ? '@ You were mentioned · ' : '👥 ') + g.name, short, open);
    beep();
    try {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(g.name, { body: short, tag: 'talkfav-group-' + g.id });
            n.onclick = () => { open(); n.close(); };
        }
    } catch (e) {}
}

// ---------- header ⋯ menu ----------
function groupMenuItems() {
    const g = groups.find(x => x.id === activeChat.id);
    return [
        { label: 'ℹ️ Group info', action: () => openGroupInfo(activeChat.id) },
        { label: g && g.muted ? '🔔 Unmute notifications' : '🔕 Mute notifications', action: () => setGroupMute(activeChat.id, !(g && g.muted)) },
        { label: '📊 Create poll', action: () => openCreatePoll(activeChat.id) },
        { label: '🚪 Leave group', action: () => leaveGroup(activeChat.id), danger: true }
    ];
}

async function setGroupMute(groupId, muted) {
    try {
        const r = await postJSON('/api/groups/' + groupId + '/mute', { muted });
        if (!r.ok) { alert(r.message || 'Could not change notifications.'); return false; }
        const g = groups.find(x => x.id === groupId);
        if (g) g.muted = muted;
        updateBadges();
        if (activeTab === 'chats' && redrawChats) redrawChats();
        showToast('Notifications', muted ? 'Group muted 🔕' : 'Group unmuted 🔔');
        return true;
    } catch (err) { console.error(err); return false; }
}

async function leaveGroup(groupId) {
    const g = groups.find(x => x.id === groupId);
    if (!confirm('Leave "' + (g ? g.name : 'this group') + '"? You won\u2019t get its messages anymore.')) return;
    try {
        const r = await postJSON('/api/groups/' + groupId + '/leave', {});
        if (!r.ok) { alert(r.message || 'Could not leave the group.'); return; }
        closeModal();
        if (activeChat && activeChat.isGroup && activeChat.id === groupId) closeChat();
        loadGroups();
    } catch (err) { console.error(err); }
}

// ---------- friend bachhar list (create / add members) ----------
function friendPicker(container, excludeIds, onChange) {
    const chosen = new Set();
    const search = el('input', 'picker-search');
    search.type = 'text';
    search.placeholder = 'Search friends...';
    container.appendChild(search);
    const list = el('div', 'fwd-list picker-list');
    container.appendChild(list);
    const draw = () => {
        list.innerHTML = '';
        const q = search.value.trim().toLowerCase();
        const shown = friends.filter(f => !excludeIds.includes(f.id) && f.name.toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (!shown.length) { list.appendChild(el('p', 'fwd-empty', friends.length ? 'No friends to show.' : 'Add some friends first.')); return; }
        shown.forEach(f => {
            const row = el('label', 'fwd-row');
            const cb = el('input');
            cb.type = 'checkbox';
            cb.checked = chosen.has(f.id);
            cb.addEventListener('change', () => { if (cb.checked) chosen.add(f.id); else chosen.delete(f.id); onChange(chosen); });
            row.appendChild(cb);
            row.appendChild(makeAvatar(f.name, '', f.avatar));
            row.appendChild(el('span', '', f.name));
            list.appendChild(row);
        });
    };
    search.addEventListener('input', draw);
    draw();
    return chosen;
}

// ---------- Create Group ----------
function openCreateGroup() {
    const box = openModal('New group');
    const form = el('div', 'group-form');
    const name = el('input', 'picker-search');
    name.type = 'text';
    name.placeholder = 'Group name';
    name.maxLength = 100;
    const desc = el('textarea', 'report-details');
    desc.placeholder = 'Description (optional)';
    desc.maxLength = 500;
    form.appendChild(name);
    form.appendChild(desc);
    form.appendChild(el('div', 'count-note', 'Add members'));

    const create = el('button', 'btn-sm', 'Create');
    create.type = 'button';
    create.disabled = true;
    const update = (set) => {
        create.disabled = !name.value.trim() || set.size === 0;
        create.textContent = set.size ? 'Create (' + (set.size + 1) + ' members)' : 'Create';
    };
    const chosen = friendPicker(form, [], update);
    name.addEventListener('input', () => update(chosen));

    const actions = el('div', 'fwd-actions');
    const cancel = el('button', 'btn-sm ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    create.addEventListener('click', async () => {
        create.disabled = true;
        try {
            const r = await postJSON('/api/groups', { name: name.value.trim(), description: desc.value.trim(), member_ids: [...chosen] });
            if (!r.ok) { alert(r.message || 'Could not create group.'); update(chosen); return; }
            closeModal();
            await loadGroups();
            const g = groups.find(x => x.id === r.group_id);
            if (g) { switchTab('chats'); openGroup(g); }
        } catch (err) { console.error(err); update(chosen); }
    });
    actions.appendChild(cancel);
    actions.appendChild(create);
    form.appendChild(actions);
    box.appendChild(form);
    name.focus();
}

// ---------- Add Members ----------
function openAddMembers(groupId, memberIds) {
    const box = openModal('Add members');
    const form = el('div', 'group-form');
    const add = el('button', 'btn-sm', 'Add');
    add.type = 'button';
    add.disabled = true;
    const chosen = friendPicker(form, memberIds, (set) => {
        add.disabled = set.size === 0;
        add.textContent = set.size ? 'Add (' + set.size + ')' : 'Add';
    });
    const actions = el('div', 'fwd-actions');
    const cancel = el('button', 'btn-sm ghost', 'Back');
    cancel.type = 'button';
    cancel.addEventListener('click', () => openGroupInfo(groupId));
    add.addEventListener('click', async () => {
        add.disabled = true;
        try {
            const r = await postJSON('/api/groups/' + groupId + '/members/add', { user_ids: [...chosen] });
            if (!r.ok) { alert(r.message || 'Could not add members.'); add.disabled = false; return; }
            openGroupInfo(groupId);
        } catch (err) { console.error(err); add.disabled = false; }
    });
    actions.appendChild(cancel);
    actions.appendChild(add);
    form.appendChild(actions);
    box.appendChild(form);
}

// chhobi Cloudinary te tule URL ferot (group photo)
async function uploadImageFile(file, label) {
    if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
    if (file.size > UPLOAD_LIMIT_MB.image * 1024 * 1024) throw new Error('Image is too large. Max ' + UPLOAD_LIMIT_MB.image + ' MB.');
    const sig = await postJSON('/api/upload/sign', { kind: 'image', size: file.size, name: file.name });
    if (!sig.ok) throw new Error(sig.message || 'Upload not allowed');
    const form = new FormData();
    form.append('file', file);
    Object.entries(sig.fields).forEach(([k, v]) => form.append(k, v));
    const item = { setProgress(p) { if (label) label.textContent = p < 100 ? 'Uploading ' + p + '%' : 'Saving...'; } };
    return xhrUpload(sig.uploadUrl, form, item);
}

// ---------- Group Info (photo, nam, member, admin, setting) ----------
async function openGroupInfo(groupId) {
    const box = openModal('Group info');
    const body = el('div', 'profile-view group-info');
    body.appendChild(el('p', 'muted-note', 'Loading...'));
    box.appendChild(body);
    let data;
    try { data = await request('/api/groups/' + groupId); } catch (e) { data = {}; }
    if (!$('modalOverlay')) return;
    body.innerHTML = '';
    if (!data.group) { body.appendChild(el('p', 'muted-note', data.message || 'Group not found.')); return; }
    const g = data.group;
    const members = data.members || [];
    const isAdmin = g.my_role === 'admin';
    const canEdit = isAdmin || g.edit_permission === 'all';
    const canAdd = isAdmin || g.add_permission === 'all';
    if (activeChat && activeChat.isGroup && activeChat.id === groupId) { groupInfo = data; applyComposerPermission(); refreshChatHead(); }

    // ---- photo + nam ----
    const top = el('div', 'pv-top');
    const photoWrap = el('div', 'avatar-edit');
    photoWrap.appendChild(makeAvatar(g.name, 'xl', g.photo));
    if (canEdit) {
        const file = el('input');
        file.type = 'file';
        file.accept = 'image/*';
        file.hidden = true;
        const cam = el('button', 'cam-btn', '📷');
        cam.type = 'button';
        cam.title = 'Change group photo';
        cam.addEventListener('click', () => file.click());
        const prog = el('small', 'muted-note');
        file.addEventListener('change', async () => {
            if (!file.files[0]) return;
            try {
                const result = await uploadImageFile(file.files[0], prog);
                const r = await postJSON('/api/groups/' + groupId + '/photo', { url: result.secure_url, public_id: result.public_id });
                if (!r.ok) throw new Error(r.message || 'Could not save photo');
                openGroupInfo(groupId);
            } catch (err) { alert(err.message); prog.textContent = ''; }
        });
        photoWrap.appendChild(cam);
        photoWrap.appendChild(file);
        top.appendChild(photoWrap);
        top.appendChild(prog);
    } else {
        top.appendChild(photoWrap);
    }
    top.appendChild(el('h3', '', g.name));
    top.appendChild(el('small', 'muted-note', members.length + ' members'));
    if (g.description) top.appendChild(el('p', 'group-desc', g.description));
    body.appendChild(top);

    const actionsTop = el('div', 'pv-actions');
    if (canEdit) {
        const edit = el('button', 'btn-sm ghost', '✏️ Edit name & description');
        edit.type = 'button';
        edit.addEventListener('click', () => openEditGroup(g));
        actionsTop.appendChild(edit);
        if (g.photo) {
            const rmp = el('button', 'btn-sm ghost', 'Remove photo');
            rmp.type = 'button';
            rmp.addEventListener('click', async () => {
                if (!confirm('Remove the group photo?')) return;
                const r = await postJSON('/api/groups/' + groupId + '/photo', {});
                if (!r.ok) alert(r.message || 'Could not remove photo.'); else openGroupInfo(groupId);
            });
            actionsTop.appendChild(rmp);
        }
    }
    if (actionsTop.children.length) body.appendChild(actionsTop);

    // ---- notification ----
    const muteRow = el('label', 'fwd-row setting-row');
    const mute = el('input');
    mute.type = 'checkbox';
    mute.checked = !!g.muted;
    mute.addEventListener('change', () => setGroupMute(groupId, mute.checked));
    muteRow.appendChild(mute);
    muteRow.appendChild(el('span', '', '🔕 Mute notifications from this group'));
    body.appendChild(muteRow);

    // ---- member list ----
    const head = el('div', 'members-head');
    head.appendChild(el('div', 'count-note', 'Members (' + members.length + ')'));
    if (canAdd) {
        const addBtn = el('button', 'btn-sm', '＋ Add members');
        addBtn.type = 'button';
        addBtn.addEventListener('click', () => openAddMembers(groupId, members.map(m => m.id)));
        head.appendChild(addBtn);
    }
    body.appendChild(head);
    const list = el('div', 'member-list');
    members.forEach(m => {
        const row = el('div', 'item member-row');
        const wrap = el('div', 'av-wrap clickable');
        wrap.appendChild(makeAvatar(m.name, '', m.avatar));
        if (m.online !== null) { const dot = el('i', 'status-dot'); dot.hidden = !m.online; wrap.appendChild(dot); }
        if (m.id !== currentUser.id) wrap.addEventListener('click', () => openProfile(m.id));
        row.appendChild(wrap);
        const info = el('div', 'item-body');
        info.appendChild(el('strong', '', m.id === currentUser.id ? m.name + ' (You)' : m.name));
        info.appendChild(el('small', '', m.id === g.created_by ? 'Group creator' : (m.role === 'admin' ? 'Admin' : 'Member')));
        row.appendChild(info);
        if (m.role === 'admin') row.appendChild(el('span', 'tag admin-tag', 'Admin'));

        // admin der jonno: admin banano / soriye dewa / group theke ber kora
        if (isAdmin && m.id !== currentUser.id) {
            const items = [];
            if (m.role === 'admin') {
                if (m.id !== g.created_by) items.push({ label: '⬇️ Remove as admin', action: () => setGroupAdmin(groupId, m, false) });
            } else {
                items.push({ label: '⭐ Make admin', action: () => setGroupAdmin(groupId, m, true) });
                items.push({ label: '➖ Remove from group', action: () => removeGroupMember(groupId, m), danger: true });
            }
            if (items.length) {
                const more = el('button', 'icon-btn more-btn', '⋯');
                more.type = 'button';
                more.addEventListener('click', (e) => { e.stopPropagation(); openActionMenu(more, items); });
                row.appendChild(more);
            }
        }
        list.appendChild(row);
    });
    body.appendChild(list);

    // ---- Group Admin Permissions (shudhu admin) ----
    if (isAdmin) {
        const set = el('div', 'group-settings');
        set.appendChild(el('div', 'count-note', '⚙️ Admin settings'));
        const opt = (key, label) => {
            const row = el('div', 'setting-line');
            row.appendChild(el('span', '', label));
            const sel = el('select', 'setting-select');
            [['admins', 'Only admins'], ['all', 'All members']].forEach(([v, t]) => {
                const o = el('option', '', t);
                o.value = v;
                if (g[key] === v) o.selected = true;
                sel.appendChild(o);
            });
            sel.addEventListener('change', async () => {
                const r = await postJSON('/api/groups/' + groupId + '/settings', { [key]: sel.value });
                if (!r.ok) { alert(r.message || 'Could not save.'); sel.value = g[key]; return; }
                g[key] = sel.value;
                showToast('Settings', 'Saved ✓');
            });
            row.appendChild(sel);
            set.appendChild(row);
        };
        opt('add_permission', 'Who can add members');
        opt('edit_permission', 'Who can edit group info');
        opt('send_permission', 'Who can send messages');
        body.appendChild(set);
    }

    // ---- Leave ----
    const leave = el('button', 'btn-sm danger leave-btn', '🚪 Leave group');
    leave.type = 'button';
    leave.addEventListener('click', () => leaveGroup(groupId));
    body.appendChild(leave);
}

function openEditGroup(g) {
    const box = openModal('Edit group');
    const form = el('div', 'group-form');
    const name = el('input', 'picker-search');
    name.type = 'text';
    name.value = g.name;
    name.maxLength = 100;
    const desc = el('textarea', 'report-details');
    desc.value = g.description || '';
    desc.placeholder = 'Description (optional)';
    desc.maxLength = 500;
    form.appendChild(name);
    form.appendChild(desc);
    const actions = el('div', 'fwd-actions');
    const back = el('button', 'btn-sm ghost', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => openGroupInfo(g.id));
    const save = el('button', 'btn-sm', 'Save');
    save.type = 'button';
    save.addEventListener('click', async () => {
        if (!name.value.trim()) { alert('Group name is required.'); return; }
        save.disabled = true;
        const r = await postJSON('/api/groups/' + g.id + '/update', { name: name.value.trim(), description: desc.value.trim() });
        if (!r.ok) { alert(r.message || 'Could not save.'); save.disabled = false; return; }
        openGroupInfo(g.id);
    });
    actions.appendChild(back);
    actions.appendChild(save);
    form.appendChild(actions);
    box.appendChild(form);
}

async function setGroupAdmin(groupId, member, makeAdmin) {
    if (!confirm(makeAdmin ? 'Make ' + member.name + ' an admin?' : 'Remove ' + member.name + ' as admin?')) return;
    const r = await postJSON('/api/groups/' + groupId + '/admins', { user_id: member.id, admin: makeAdmin });
    if (!r.ok) alert(r.message || 'Could not change admin.');
    openGroupInfo(groupId);
}

async function removeGroupMember(groupId, member) {
    if (!confirm('Remove ' + member.name + ' from the group?')) return;
    const r = await postJSON('/api/groups/' + groupId + '/members/remove', { user_id: member.id });
    if (!r.ok) alert(r.message || 'Could not remove member.');
    openGroupInfo(groupId);
}

// =====================================================
// FRIEND SYSTEM: profile, remove, block, report, last seen
// =====================================================

// "Last seen 5 min ago"
function lastSeenText(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const sec = (Date.now() - d.getTime()) / 1000;
    if (sec < 60) return 'Last seen just now';
    if (sec < 3600) return 'Last seen ' + Math.floor(sec / 60) + ' min ago';
    if (sec < 86400) return 'Last seen ' + Math.floor(sec / 3600) + ' h ago';
    if (sec < 2 * 86400) return 'Last seen yesterday';
    return 'Last seen ' + d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

// choto menu (message er ⋯ menu er moto dekhte)
function openActionMenu(anchor, items) {
    closeMsgMenu();
    menuOpenedAt = Date.now();
    msgMenu = el('div', 'msg-menu');
    items.forEach(item => {
        const b = el('button', 'msg-menu-item' + (item.danger ? ' danger' : ''), item.label);
        b.type = 'button';
        b.addEventListener('click', (e) => { e.stopPropagation(); closeMsgMenu(); item.action(); });
        msgMenu.appendChild(b);
    });
    document.body.appendChild(msgMenu);
    const r = anchor.getBoundingClientRect();
    const m = msgMenu.getBoundingClientRect();
    let top = r.bottom + 4;
    if (top + m.height > window.innerHeight - 8) top = r.top - m.height - 4;
    const left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8));
    msgMenu.style.top = top + 'px';
    msgMenu.style.left = left + 'px';
}

function friendMenuItems(user, relation) {
    const items = [{ label: '👤 View profile', action: () => openProfile(user.id) }];
    if (relation === 'friend') items.push({ label: '➖ Remove friend', action: () => removeFriend(user) });
    items.push({ label: '🚫 Block', action: () => blockUser(user), danger: true });
    items.push({ label: '⚠️ Report', action: () => openReport(user), danger: true });
    return items;
}

// chat bondho kore khali screen e ferot (remove / block hole)
function closeChat() {
    sendTyping(false);
    stopRecording(true);
    if (composeMode) cancelCompose();
    closeSearch();
    activeChat = null;
    groupInfo = null;
    applyComposerPermission();
    lastMsgKey = null;
    currentMsgs = [];
    pinnedList = [];
    hasMoreOlder = false;
    clearInterval(pollTimer);
    $('messageContainer').innerHTML = '';
    $('chatSection').hidden = true;
    $('chatEmpty').hidden = false;
    $('app').classList.remove('chat-open');
    renderPinnedBar();
    if (activeTab === 'chats' && redrawChats) redrawChats();
}

async function removeFriend(user) {
    if (!confirm('Remove ' + user.name + ' from your friends? Your old messages will stay, but you won\u2019t be able to message or call until you\u2019re friends again.')) return false;
    try {
        const r = await postJSON('/api/friends/unfriend', { friend_id: user.id });
        if (!r.ok) { alert(r.message || 'Could not remove friend.'); return false; }
        if (activeChat && activeChat.id === user.id) closeChat();
        refreshAfterFriendAction();
        return true;
    } catch (err) { console.error(err); return false; }
}

async function blockUser(user) {
    if (!confirm('Block ' + user.name + '?\n\nThey won\u2019t be able to message you, call you, send you a friend request or find you in search. They will also be removed from your friends.')) return false;
    try {
        const r = await postJSON('/api/users/block', { user_id: user.id });
        if (!r.ok) { alert(r.message || 'Could not block.'); return false; }
        if (activeChat && activeChat.id === user.id) closeChat();
        closeModal();
        refreshAfterFriendAction();
        showToast('Blocked', user.name + ' has been blocked.');
        return true;
    } catch (err) { console.error(err); return false; }
}

async function unblockUser(user) {
    if (!confirm('Unblock ' + user.name + '? You\u2019ll need to send a new friend request to chat again.')) return false;
    try {
        const r = await postJSON('/api/users/unblock', { user_id: user.id });
        if (!r.ok) { alert(r.message || 'Could not unblock.'); return false; }
        showToast('Unblocked', user.name + ' has been unblocked.');
        return true;
    } catch (err) { console.error(err); return false; }
}

// ---------- popup (profile / report) ----------
function closeModal() {
    const m = $('modalOverlay');
    if (m) m.remove();
}

function openModal(title) {
    closeModal();
    closeMsgMenu();
    const overlay = el('div', 'fwd-overlay');
    overlay.id = 'modalOverlay';
    const box = el('div', 'fwd-box modal-box');
    const head = el('div', 'modal-head');
    head.appendChild(el('h3', '', title));
    const x = el('button', 'icon-btn', '✕');
    x.type = 'button';
    x.title = 'Close';
    x.addEventListener('click', closeModal);
    head.appendChild(x);
    box.appendChild(head);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    return box;
}

// ---------- User Profile View ----------
async function openProfile(userId) {
    const box = openModal('Profile');
    const body = el('div', 'profile-view');
    body.appendChild(el('p', 'muted-note', 'Loading...'));
    box.appendChild(body);
    try {
        const data = await request('/api/users/' + userId + '/profile');
        if (!$('modalOverlay')) return;                                  // already bondho kore diyeche
        body.innerHTML = '';
        if (!data.user) { body.appendChild(el('p', 'muted-note', data.message || 'User not found.')); return; }
        const u = data.user;
        const rel = data.relation;

        const coverBox = el('div', 'cover-box pv-cover');
        paintCover(coverBox, u.cover);
        body.appendChild(coverBox);

        const top = el('div', 'pv-top');
        top.appendChild(makeAvatar(u.name, 'xl', u.avatar));
        top.appendChild(el('h3', '', u.name));
        let status = '';
        if (rel === 'friend') status = u.online ? 'Online' : (lastSeenText(u.last_seen_at) || 'Offline');
        else if (rel === 'blocked') status = 'Blocked';
        if (status) top.appendChild(el('small', u.online && rel === 'friend' ? 'online-now' : 'muted-note', status));
        body.appendChild(top);

        const rows = el('div', 'info-rows');
        const addRow = (k, v) => { if (!v) return; const r = el('div', 'info-row'); r.appendChild(el('span', '', k)); r.appendChild(el('b', '', v)); rows.appendChild(r); };
        addRow('Email', u.email);
        addRow('Country', u.country);
        addRow('Member since', u.created_at ? new Date(u.created_at).toLocaleDateString([], { month: 'long', year: 'numeric' }) : '');
        body.appendChild(rows);

        // Mutual Friends
        if (rel !== 'self') {
            const mf = data.mutual || [];
            const mbox = el('div', 'mutual-box');
            mbox.appendChild(el('div', 'count-note', mf.length ? mf.length + ' mutual friend' + (mf.length > 1 ? 's' : '') : 'No mutual friends'));
            if (mf.length) {
                const strip = el('div', 'mutual-list');
                mf.slice(0, 12).forEach(m => {
                    const chip = el('div', 'mutual-chip');
                    chip.appendChild(makeAvatar(m.name, '', m.avatar));
                    chip.appendChild(el('span', '', m.name.split(' ')[0]));
                    chip.title = m.name;
                    strip.appendChild(chip);
                });
                mbox.appendChild(strip);
            }
            body.appendChild(mbox);
        }

        // somporko onujayi button
        const actions = el('div', 'pv-actions');
        const btn = (label, cls, fn) => { const b = el('button', 'btn-sm ' + cls, label); b.type = 'button'; b.addEventListener('click', () => fn(b)); actions.appendChild(b); return b; };
        const reopen = (ok) => { if (ok) openProfile(userId); };
        const userObj = { id: u.id, name: u.name };
        if (rel === 'friend') {
            btn('💬 Message', '', () => { const f = friends.find(x => x.id === u.id); closeModal(); if (f) openChat(f); });
            btn('Remove friend', 'ghost', async () => { if (await removeFriend(userObj)) reopen(true); });
        } else if (rel === 'sent') {
            btn('Cancel request', 'ghost', async (b) => reopen(await cancelRequest(u.id, b)));
        } else if (rel === 'received') {
            btn('Accept', 'green', async (b) => reopen(await acceptRequest(data.request_id, b)));
            btn('Reject', 'ghost', async (b) => reopen(await rejectRequest(u.id, b)));
        } else if (rel === 'none') {
            btn('Add Friend', '', async (b) => reopen(await sendRequest(u.id, b)));
        }
        if (rel === 'blocked') {
            btn('Unblock', 'ghost', async () => reopen(await unblockUser(userObj)));
        } else if (rel !== 'self') {
            btn('Block', 'danger', () => blockUser(userObj));
            btn('Report', 'danger', () => openReport(userObj));
        }
        if (actions.children.length) body.appendChild(actions);
    } catch (err) {
        console.error(err);
        body.innerHTML = '';
        body.appendChild(el('p', 'muted-note', 'Could not load profile.'));
    }
}

// ---------- Report User ----------
function openReport(user) {
    const box = openModal('Report ' + user.name);
    const form = el('div', 'report-form');
    form.appendChild(el('p', 'muted-note', 'Why are you reporting this user? Reports are private.'));
    const reasons = [['spam', 'Spam or scam'], ['harassment', 'Harassment or bullying'], ['fake', 'Fake account'], ['inappropriate', 'Inappropriate content'], ['other', 'Something else']];
    let chosen = '';
    const send = el('button', 'btn-sm danger', 'Send report');
    send.type = 'button';
    send.disabled = true;
    reasons.forEach(([key, label]) => {
        const row = el('label', 'fwd-row');
        const r = el('input');
        r.type = 'radio';
        r.name = 'reportReason';
        r.addEventListener('change', () => { chosen = key; send.disabled = false; });
        row.appendChild(r);
        row.appendChild(el('span', '', label));
        form.appendChild(row);
    });
    const details = el('textarea', 'report-details');
    details.placeholder = 'More details (optional)';
    details.maxLength = 1000;
    form.appendChild(details);
    const alsoRow = el('label', 'fwd-row');
    const also = el('input');
    also.type = 'checkbox';
    alsoRow.appendChild(also);
    alsoRow.appendChild(el('span', '', 'Also block ' + user.name));
    form.appendChild(alsoRow);

    const actions = el('div', 'fwd-actions');
    const cancel = el('button', 'btn-sm ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    send.addEventListener('click', async () => {
        send.disabled = true;
        try {
            const r = await postJSON('/api/users/report', { user_id: user.id, reason: chosen, details: details.value });
            if (!r.ok) { alert(r.message || 'Could not send report.'); send.disabled = false; return; }
            closeModal();
            showToast('Report sent', 'Thanks for letting us know.');
            if (also.checked) {
                const b = await postJSON('/api/users/block', { user_id: user.id });
                if (b.ok) {
                    if (activeChat && activeChat.id === user.id) closeChat();
                    refreshAfterFriendAction();
                }
            }
        } catch (err) { console.error(err); send.disabled = false; }
    });
    actions.appendChild(cancel);
    actions.appendChild(send);
    form.appendChild(actions);
    box.appendChild(form);
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
    const target = chatTarget();                    // upload cholar somoy chat bodlaleo thik jaygay jabe
    const targetKey = chatKey(activeChat);
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
        const r = await postJSON('/api/messages/send', Object.assign({ message: '', attachment }, target));
        if (!r.ok) throw new Error(r.message || 'Could not send file');
        item.done();
        if (activeChat && chatKey(activeChat) === targetKey) loadMessages(true);
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
    const toChat = chatKey(activeChat);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
        recStream.getTracks().forEach(t => t.stop());               // mic bondho (lal biduti chole jabe)
        const secs = Math.round((Date.now() - recStart) / 1000);
        showRecordingBar(false);
        if (recCancelled || secs < 1 || !recChunks.length) return;
        if (!activeChat || chatKey(activeChat) !== toChat) return;   // onno chat e chole gele pathabo na
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

    // 📊 poll (shudhu group e dekhabe)
    const pollBtn = el('button', 'tool-btn poll-btn', '📊');
    pollBtn.type = 'button';
    pollBtn.title = 'Create a poll';
    pollBtn.setAttribute('aria-label', 'Create poll');
    pollBtn.hidden = true;
    pollBtn.addEventListener('click', () => { if (isGroupChat()) openCreatePoll(activeChat.id); });
    composer.insertBefore(pollBtn, input);

    setupMentions(input);

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

function convoUrl(params) {
    const base = activeChat.isGroup ? `/api/groups/${activeChat.id}/messages` : `/api/messages/${currentUser.id}/${activeChat.id}`;
    return base + '?' + new URLSearchParams(params);
}

// protita message er "chhap": notun, seen, edit, unsend, pin, reaction - je kono bodlale key bodlabe
function messagesKey(msgs) {
    return msgs.map(m => [m.id, m.is_read, m.deleted_at ? 1 : 0, m.edited_at || '', m.pinned_at || '', m.saved ? 1 : 0,
        m.poll ? m.poll.counts.join(',') + (m.poll.closed ? 'c' : '') + m.poll.mine.join('') : '',
        (m.reactions || []).map(r => r.user_id + r.reaction).join(',')].join('/')).join('|');
}

// prothombar: shesh 50 ta. Porer bar: ja load kora ache (oldest theke) shudhu tar notun obostha
async function loadMessages(force) {
    if (!activeChat) return;
    const key0 = chatKey(activeChat);
    const first = currentMsgs.length === 0;
    const params = first ? { limit: PAGE_SIZE } : { from: currentMsgs[0].id };

    try {
        const data = await request(convoUrl(params));
        if (!activeChat || chatKey(activeChat) !== key0) return;    // user switched chat meanwhile
        if (!data.messages) return;                                 // error / group theke ber hoye gechhi
        if (first) hasMoreOlder = !!data.has_more;

        const msgs = data.messages;
        const pinKey = JSON.stringify(data.pinned || []);
        const key = messagesKey(msgs) + '#' + pinKey;
        if (!force && key === lastMsgKey) return;                   // nothing new
        lastMsgKey = key;
        currentMsgs = msgs;
        pinnedList = data.pinned || [];
        renderPinnedBar();
        renderMessages(force ? 'bottom' : 'auto');
    } catch (err) { console.error(err); }
}

// upore scroll korle ager 50 ta
async function loadOlder() {
    if (!activeChat || loadingOlder || !hasMoreOlder || !currentMsgs.length) return false;
    loadingOlder = true;
    const key0 = chatKey(activeChat);
    const loader = $('messageContainer').querySelector('.older-loader');
    if (loader) loader.textContent = 'Loading older messages...';
    try {
        const data = await request(convoUrl({ before: currentMsgs[0].id, limit: PAGE_SIZE }));
        if (!activeChat || chatKey(activeChat) !== key0 || !data.messages) return false;
        hasMoreOlder = !!data.has_more;
        currentMsgs = data.messages.concat(currentMsgs);
        lastMsgKey = messagesKey(currentMsgs) + '#' + JSON.stringify(pinnedList);
        renderMessages('keep');                                     // je message dekhchhilen sekhanei thakbe
        return true;
    } catch (err) { console.error(err); return false; }
    finally { loadingOlder = false; }
}

// id wala message ta load na thakle upore load korte thaki (reply / pin / search e jump er jonno)
async function ensureLoaded(id) {
    let tries = 0;
    while (activeChat && currentMsgs.length && id < currentMsgs[0].id && hasMoreOlder && tries < 60) {
        tries++;
        if (loadingOlder) { await new Promise(r => setTimeout(r, 150)); continue; }
        if (!(await loadOlder())) break;
    }
}

// mode: 'bottom' = niche jao, 'auto' = niche thakle niche, 'keep' = upore notun ashleo eki jaygay thako
function renderMessages(mode) {
    const box = $('messageContainer');
    const msgs = currentMsgs;
    const oldHeight = box.scrollHeight;
    const oldTop = box.scrollTop;
    const nearBottom = oldHeight - oldTop - box.clientHeight < 80;
    box.innerHTML = '';

    if (msgs.length === 0) {
        box.appendChild(el('div', 'no-msg', 'No messages yet. Say hi 👋'));
        return;
    }

    // shobar upore: aro purono ache (scroll / button) na hole shuru
    if (hasMoreOlder) {
        const more = el('button', 'older-loader', '⬆ Load older messages');
        more.type = 'button';
        more.addEventListener('click', loadOlder);
        box.appendChild(more);
    } else {
        box.appendChild(el('div', 'convo-start', activeChat && activeChat.isGroup ? '👥 This is the beginning of the group' : '👋 This is the beginning of your conversation'));
    }

    let lastDay = '';
    let lastSender = null;
    const inGroup = !!(activeChat && activeChat.isGroup);
    msgs.forEach(msg => {
        const when = new Date(msg.created_at);
        const day = when.toDateString();
        if (day !== lastDay) {
            box.appendChild(el('div', 'day-chip', dayLabel(when)));
            lastDay = day;
            lastSender = null;
        }
        const isMe = msg.sender_id === currentUser.id;

        // group: "Rahim added Karim" - majhe chhoto lekha
        if (msg.is_system) {
            box.appendChild(el('div', 'sys-msg', (isMe ? 'You' : (msg.sender_name || 'Someone')) + ' ' + msg.message));
            lastSender = null;
            return;
        }
        // group: onner message er upore nam (por por eki manush hole ekbar)
        if (inGroup && !isMe && lastSender !== msg.sender_id) {
            const label = el('div', 'sender-label');
            label.appendChild(makeAvatar(msg.sender_name || '?', 'tiny', msg.sender_avatar));
            label.appendChild(el('span', '', msg.sender_name || 'Member'));
            label.addEventListener('click', () => openProfile(msg.sender_id));
            box.appendChild(label);
        }
        lastSender = msg.sender_id;
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
                if (msg.poll) {
                    bubble.classList.add('has-poll');
                    bubble.appendChild(renderPoll(msg));
                } else {
                    appendMessageText(text, msg.message);
                    if (msg.mentions && msg.mentions.length) highlightMentions(text, msg);
                    if (!msg.attachment_url && isEmojiOnly(msg.message)) bubble.classList.add('emoji-only');
                    bubble.appendChild(text);
                }
                if ((msg.mentions || []).includes(currentUser.id)) bubble.classList.add('mentions-me');
            }
        }
        const edited = msg.edited_at && !msg.deleted_at ? 'edited · ' : '';
        const pinMark = (msg.saved && !msg.deleted_at ? '⭐ ' : '') + (msg.pinned_at && !msg.deleted_at ? '📌 ' : '');
        const time = el('span', 'time', isNaN(when) ? '' : pinMark + edited + fmtTime(when));
        if (isMe && !inGroup) time.appendChild(el('i', 'tick' + (msg.is_read ? ' seen' : ''), msg.is_read ? ' ✓✓' : ' ✓'));
        bubble.appendChild(time);
        // lekhay link thakle preview card (time er upore)
        const link = !msg.deleted_at && !msg.attachment_url && firstLink(msg.message);
        if (link) { bubble.classList.add('has-link'); attachLinkPreview(bubble, link, msg.id); }
        if (!msg.deleted_at && msg.reactions && msg.reactions.length) {
            bubble.classList.add('has-react');
            bubble.appendChild(reactionPills(msg));
        }
        attachMsgMenu(bubble, msg);
        box.appendChild(bubble);
    });

    if (mode === 'bottom' || (mode === 'auto' && nearBottom)) box.scrollTop = box.scrollHeight;
    else if (mode === 'keep') box.scrollTop = box.scrollHeight - oldHeight + oldTop;   // upore jog holo, chokher message sore jabe na
    else box.scrollTop = oldTop;
    if (searchQ) applySearch();                                     // notun message ashleo highlight thakbe
    // screen bhorar moto message na thakle (scroll hoy na) aro purono ene dao
    if (hasMoreOlder && box.scrollHeight <= box.clientHeight + 10) setTimeout(loadOlder, 0);
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

        const body = Object.assign({ message }, chatTarget());
        const mentionIds = collectMentions(message);
        if (mentionIds.length) body.mention_ids = mentionIds;
        if (composeMode && composeMode.type === 'reply') body.reply_to_id = composeMode.msg.id;

        const result = await postJSON('/api/messages/send', body);
        if (!result.ok) { alert(result.message || 'Message could not be sent.'); return; }
        input.value = '';
        mentionPicks.clear();
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
        loadUnread(); loadPending(); loadFriends(); loadGroups();
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
        if (!d.online) {
            clearTyping(d.user_id);
            const f = friends.find(x => x.id === d.user_id);
            if (f) f.last_seen_at = new Date().toISOString();          // "Last seen just now"
        }
        refreshPresenceUI();
    });

    socket.on('message:new', () => {
        loadUnread();                                   // unseen count + notification
        if (activeChat) loadMessages(false);            // khola chat e sathe sathe dekhabe
    });

    // unsend / delete hole: unseen count + khola chat abar draw
    socket.on('message:changed', (d) => {
        if (d && d.group_id) loadGroups(); else loadUnread();
        if (activeChat) loadMessages(false);
    });

    // group e notun message
    socket.on('group:message', (d) => {
        const open = activeChat && activeChat.isGroup && activeChat.id === d.group_id;
        if (open) {
            loadMessages(false);
            if (!document.hidden) markGroupRead(d.group_id);
        }
        loadGroups().then(() => {
            if (d.sender_id === currentUser.id || d.system || (open && !document.hidden)) return;
            const g = groups.find(x => x.id === d.group_id);
            const mentionedMe = (d.mentions || []).includes(currentUser.id);
            if (g && (mentionedMe || !g.muted)) notifyGroup(g, mentionedMe);
        });
    });

    socket.on('chat-settings:changed', loadChatSettings);

    // group er nam / member / setting bodlale
    socket.on('groups:changed', (d) => {
        loadGroups();
        if (activeChat && activeChat.isGroup && d && activeChat.id === d.group_id) {
            loadGroupInfo(d.group_id);
            loadMessages(false);
        }
    });

    socket.on('messages:read', (d) => {
        if (activeChat && !activeChat.isGroup && activeChat.id === d.reader_id) loadMessages(false);    // ✓ -> ✓✓
    });

    socket.on('typing', (d) => {
        if (d.group_id) { onGroupTyping(d); return; }
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
    if (activeChat.isGroup) {
        const typers = groupTypingNames(activeChat.id);
        const count = groupInfo ? groupInfo.members.length : activeChat.member_count;
        sub.textContent = typers || (count ? count + ' members' : 'Group');
        sub.className = typers ? 'typing-now' : '';
        $('chatDot').hidden = true;
        return;
    }
    const typing = !!typingFrom[activeChat.id];
    const isOn = online.has(activeChat.id);
    const fresh = friends.find(f => f.id === activeChat.id) || activeChat;     // notun last_seen
    sub.textContent = typing ? 'typing...' : (isOn ? 'Online' : (lastSeenText(fresh.last_seen_at) || fresh.email || ''));
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
    socket.emit('typing', activeChat.isGroup ? { group_id: activeChat.id, typing: on } : { to: activeChat.id, typing: on });
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
        const chatOpenNow = (id) => activeChat && !activeChat.isGroup && activeChat.id === id && !document.hidden;
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
            if (unreadReady && u.last_id > prev && !isChatMuted('u', u.sender_id)) notifyNew(u);
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
    // mute / archive kora chat er unread mot songkhyay dhori na
    const skip = (key) => { const x = chatSettings[key] || {}; return x.archived || x.muted; };
    const total = Object.entries(unread).reduce((n, [id, u]) => n + (skip('u' + id) ? 0 : u.count), 0) +
        groups.reduce((n, g) => n + (isActive({ isGroup: true, id: g.id }) || g.muted || skip('g' + g.id) ? 0 : (g.unread || 0)), 0);
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
