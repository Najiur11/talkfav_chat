const currentUser = JSON.parse(localStorage.getItem('user'));

if (!currentUser) {
    alert('Please login first!');
    window.location.href = 'index.html';
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('welcomeUser').textContent = `Welcome, ${currentUser.name}`;
    document.getElementById('userEmail').textContent = currentUser.email;
    document.getElementById('userCountry').textContent = currentUser.country || 'N/A';
    
    loadFriends();
    loadPendingRequests();
});

// 1. Load Friends List
async function loadFriends() {
    try {
        const res = await fetch(`http://localhost:3000/api/friends/${currentUser.id}`);
        const data = await res.json();
        const container = document.getElementById('friendsList');
        container.innerHTML = '';

        if (data.friends.length === 0) {
            container.innerHTML = '<p>No friends yet.</p>';
            return;
        }

        data.friends.forEach(friend => {
            const div = document.createElement('div');
            div.className = 'row-item';
            div.innerHTML = `<span>${friend.name}</span><button class="btn btn-chat" onclick="openChat(${friend.id}, '${friend.name}')">Chat</button>`;
            container.appendChild(div);
        });
    } catch (err) { console.error(err); }
}

// 2. Search Users & Send Request
document.getElementById('searchBtn').addEventListener('click', async () => {
    const query = document.getElementById('searchQuery').value.trim();
    if (!query) return;

    try {
        const res = await fetch(`http://localhost:3000/api/users/search?query=${query}&currentUserId=${currentUser.id}`);
        const data = await res.json();
        const resultsDiv = document.getElementById('searchResults');
        resultsDiv.innerHTML = '';

        if (data.users.length === 0) {
            resultsDiv.innerHTML = '<p>No users found.</p>';
            return;
        }

        data.users.forEach(user => {
            const div = document.createElement('div');
            div.className = 'row-item';
            div.innerHTML = `<span>${user.name} (${user.email})</span><button class="btn btn-add" onclick="sendRequest(${user.id})">Add Friend</button>`;
            resultsDiv.appendChild(div);
        });
    } catch (err) { console.error(err); }
});

async function sendRequest(receiverId) {
    try {
        const res = await fetch('http://localhost:3000/api/friend-request/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender_id: currentUser.id, receiver_id: receiverId })
        });
        const result = await res.json();
        alert(result.message);
    } catch (err) { console.error(err); }
}

// 3. Pending Requests & Accept
async function loadPendingRequests() {
    try {
        const res = await fetch(`http://localhost:3000/api/friend-request/pending/${currentUser.id}`);
        const data = await res.json();
        const container = document.getElementById('pendingRequests');
        container.innerHTML = '';

        if (data.requests.length === 0) {
            container.innerHTML = '<p>No pending requests.</p>';
            return;
        }

        data.requests.forEach(req => {
            const div = document.createElement('div');
            div.className = 'row-item';
            div.innerHTML = `<span>${req.name}</span><button class="btn btn-accept" onclick="acceptRequest(${req.request_id})">Accept</button>`;
            container.appendChild(div);
        });
    } catch (err) { console.error(err); }
}

async function acceptRequest(requestId) {
    try {
        await fetch('http://localhost:3000/api/friend-request/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request_id: requestId })
        });
        alert('Friend request accepted!');
        loadPendingRequests();
        loadFriends();
    } catch (err) { console.error(err); }
}

// 4. Chat System
let activeChatUserId = null;

function openChat(friendId, friendName) {
    activeChatUserId = friendId;
    document.getElementById('chatSection').style.display = 'block';
    document.getElementById('chatTitle').textContent = `Chat with ${friendName}`;
    loadMessages();
}

async function loadMessages() {
    if (!activeChatUserId) return;
    try {
        const res = await fetch(`http://localhost:3000/api/messages/${currentUser.id}/${activeChatUserId}`);
        const data = await res.json();
        const container = document.getElementById('messageContainer');
        container.innerHTML = '';

        data.messages.forEach(msg => {
            const isMe = msg.sender_id === currentUser.id;
            const bubble = document.createElement('div');
            bubble.className = 'msg ' + (isMe ? 'me' : 'them');
            bubble.textContent = msg.message;
            container.appendChild(bubble);
        });
        container.scrollTop = container.scrollHeight;
    } catch (err) { console.error(err); }
}

document.getElementById('sendMsgBtn').addEventListener('click', async () => {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message || !activeChatUserId) return;

    try {
        await fetch('http://localhost:3000/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender_id: currentUser.id, receiver_id: activeChatUserId, message })
        });
        input.value = '';
        loadMessages();
    } catch (err) { console.error(err); }
});

// Logout
document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('user');
    window.location.href = 'index.html';
});