/* =====================================================
   Audio / Video call (WebRTC)
   - call ধরা/কাটার সংকেত (signaling) যায় Socket.IO দিয়ে
   - audio/video নিজে যায় ব্রাউজার থেকে ব্রাউজারে (server দিয়ে না)
   - dashboard.js এর আগে load হয়; dashboard.js এর socket/friends/currentUser ব্যবহার করে
   ===================================================== */

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const RING_TIMEOUT_MS = 40000;

// callState = null (call নেই) অথবা:
// { state: 'calling' | 'incoming' | 'connecting' | 'active', peerId, peerName, video,
//   pc, localStream, pendingCandidates, ringTimer, tickTimer, lostTimer, startedAt }
let callState = null;
let ringInterval = null;

const callEl = (id) => document.getElementById(id);

// ---------- ছোট helper ----------
function callSupported() {
    return typeof RTCPeerConnection === 'function' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
}

function friendById(id) {
    return friends.find(f => f.id === id) || { id: id, name: 'Unknown', avatar: null };
}

// ---------- start: dashboard.js এর init() থেকে ডাকা হয় ----------
function setupCallUI() {
    const audioBtn = callEl('audioCallBtn');
    const videoBtn = callEl('videoCallBtn');
    if (!audioBtn || !videoBtn) return;

    audioBtn.addEventListener('click', () => { if (activeChat) startCall(activeChat, false); });
    videoBtn.addEventListener('click', () => { if (activeChat) startCall(activeChat, true); });

    callEl('callEndBtn').addEventListener('click', () => endCall(true));
    callEl('callAcceptBtn').addEventListener('click', acceptCall);
    callEl('callMuteBtn').addEventListener('click', toggleMic);
    callEl('callCamBtn').addEventListener('click', toggleCam);

    window.addEventListener('beforeunload', () => { if (callState && socket) endCall(true, true); });
}

// ---------- socket event: dashboard.js এর connectSocket() থেকে ডাকা হয় ----------
function initCalls() {
    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:signal', onSignal);
    socket.on('call:ended', onEnded);
    socket.on('call:unavailable', onUnavailable);
    socket.on('call:handled', () => {                  // onno tab e dhora hoyeche
        if (callState && callState.state === 'incoming') cleanupCall();
    });
}

// ---------- call করা ----------
async function startCall(friend, video) {
    if (callState) return;
    if (!socket || !socketUp) { alert('Realtime connection is not ready yet. Please wait a moment and try again.'); return; }
    if (!callSupported()) {
        alert('Calls need a secure page. Open the site with https:// or http://localhost:3000.');
        return;
    }

    const stream = await getMedia(video);
    if (!stream) return;
    if (callState) { stream.getTracks().forEach(t => t.stop()); return; }   // media newar somoy onno call chole elo

    callState = newCall('calling', friend.id, friend.name, video, stream);
    showCallUI(friend);
    setStatus('Calling...');
    startRing('out');
    socket.emit('call:invite', { to: friend.id, video });

    callState.ringTimer = setTimeout(() => endCall(true, false, 'No answer'), RING_TIMEOUT_MS);
}

function onUnavailable(d) {
    if (!callState || callState.peerId !== d.to) return;
    const msg = d.reason === 'offline' ? 'User is offline' : 'User is busy on another call';
    cleanupCall();
    showToast('Call', msg, null);
}

// ---------- call আসা ----------
function onIncoming(d) {
    if (callState) return;      // server আগেই busy ধরে, তবু safety
    const friend = friendById(d.from);

    callState = newCall('incoming', d.from, friend.name, !!d.video, null);
    showCallUI(friend);
    setStatus(d.video ? 'Incoming video call...' : 'Incoming audio call...');
    startRing('in');

    try {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(friend.name, { body: d.video ? 'Incoming video call' : 'Incoming audio call' });
            n.onclick = () => { window.focus(); n.close(); };
        }
    } catch (e) {}
}

async function acceptCall() {
    if (!callState || callState.state !== 'incoming') return;
    const wantVideo = callState.video;
    const stream = await getMedia(wantVideo);
    if (!callState || callState.state !== 'incoming') {      // media নেওয়ার সময় call কেটে গেছে
        if (stream) stream.getTracks().forEach(t => t.stop());
        return;
    }
    if (!stream) { endCall(true); return; }                  // permission না দিলে reject

    stopRing();
    callState.localStream = stream;
    callState.state = 'connecting';
    setStatus('Connecting...');
    showLocalVideo();
    createPeer();
    socket.emit('call:accept', {});
}

// caller: অপর পাশ ধরেছে -> offer পাঠাও
async function onAccepted() {
    if (!callState || callState.state !== 'calling') return;
    clearTimeout(callState.ringTimer);
    stopRing();
    callState.state = 'connecting';
    setStatus('Connecting...');
    showLocalVideo();
    createPeer();

    try {
        const offer = await callState.pc.createOffer();
        await callState.pc.setLocalDescription(offer);
        sendSignal({ type: 'offer', sdp: offer.sdp });
    } catch (err) {
        console.error(err);
        endCall(true, false, 'Could not start the call');
    }
}

// ---------- WebRTC ----------
function createPeer() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    callState.pc = pc;

    callState.localStream.getTracks().forEach(t => pc.addTrack(t, callState.localStream));

    pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate }); };

    pc.ontrack = (e) => {
        const v = callEl('remoteVideo');
        if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
        v.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
        if (!callState || callState.pc !== pc) return;
        const st = pc.connectionState;
        if (st === 'connected') {
            clearTimeout(callState.lostTimer);
            if (callState.state !== 'active') markActive();
        } else if (st === 'disconnected') {
            setStatus('Reconnecting...');
            clearTimeout(callState.lostTimer);
            callState.lostTimer = setTimeout(() => endCall(true, false, 'Connection lost'), 10000);
        } else if (st === 'failed') {
            endCall(true, false, 'Connection failed');
        }
    };
}

async function onSignal(msg) {
    if (!callState || !callState.pc || msg.from !== callState.peerId) return;
    const pc = callState.pc;
    const data = msg.data;

    try {
        if (data.type === 'offer') {
            await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
            await flushCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal({ type: 'answer', sdp: answer.sdp });
        } else if (data.type === 'answer') {
            await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
            await flushCandidates();
        } else if (data.candidate) {
            if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
            else callState.pendingCandidates.push(data.candidate);      // remote description আসার আগে এলে জমিয়ে রাখো
        }
    } catch (err) { console.error('signal error', err); }
}

async function flushCandidates() {
    const list = callState.pendingCandidates.splice(0);
    for (const c of list) { try { await callState.pc.addIceCandidate(c); } catch (e) { console.error(e); } }
}

function sendSignal(data) {
    if (socket) socket.emit('call:signal', { to: callState && callState.peerId, data });
}

// ---------- call শেষ ----------
// emit = অপর পাশকে জানাবে কি না, silent = page বন্ধ হওয়ার সময় (UI ছোঁবে না)
function endCall(emit, silent, message) {
    if (!callState) return;
    const st = callState.state;
    if (emit && socket) {
        if (st === 'calling') socket.emit('call:cancel', {});
        else if (st === 'incoming') socket.emit('call:reject', {});
        else socket.emit('call:end', {});
    }
    const name = callState.peerName;
    cleanupCall();
    if (!silent && message) showToast(name, message, null);
}

function onEnded(d) {
    if (!callState) return;
    const name = callState.peerName;
    const text = ({
        rejected: 'Call declined',
        cancelled: 'Missed call',
        noanswer: 'No answer',
        disconnected: 'Call ended (connection lost)',
        ended: 'Call ended'
    })[d.reason] || 'Call ended';
    cleanupCall();
    showToast(name, text, null);
}

function cleanupCall() {
    if (!callState) return;
    clearTimeout(callState.ringTimer);
    clearTimeout(callState.lostTimer);
    clearInterval(callState.tickTimer);
    stopRing();
    if (callState.pc) { callState.pc.onicecandidate = null; callState.pc.ontrack = null; callState.pc.onconnectionstatechange = null; callState.pc.close(); }
    if (callState.localStream) callState.localStream.getTracks().forEach(t => t.stop());
    callState = null;

    const rv = callEl('remoteVideo'); rv.srcObject = null;
    const lv = callEl('localVideo'); lv.srcObject = null;
    callEl('callOverlay').hidden = true;
    callEl('callOverlay').className = 'call-overlay';
}

// ---------- mic / camera ----------
function toggleMic() {
    if (!callState || !callState.localStream) return;
    const track = callState.localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    callEl('callMuteBtn').classList.toggle('off', !track.enabled);
}

function toggleCam() {
    if (!callState || !callState.localStream) return;
    const track = callState.localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    callEl('callCamBtn').classList.toggle('off', !track.enabled);
}

async function getMedia(video) {
    try {
        return await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
        });
    } catch (err) {
        console.error(err);
        alert(video ? 'Could not access camera/microphone. Please allow permission and try again.'
                    : 'Could not access the microphone. Please allow permission and try again.');
        return null;
    }
}

// ---------- UI ----------
function newCall(state, peerId, peerName, video, stream) {
    return { state, peerId, peerName, video, pc: null, localStream: stream, pendingCandidates: [],
             ringTimer: null, tickTimer: null, lostTimer: null, startedAt: 0 };
}

function showCallUI(friend) {
    const o = callEl('callOverlay');
    o.hidden = false;
    o.className = 'call-overlay st-' + callState.state + (callState.video ? ' is-video' : ' is-audio');
    setAvatar(callEl('callAvatar'), friend.name, friend.avatar);
    callEl('callName').textContent = friend.name;

    callEl('callAcceptBtn').hidden = callState.state !== 'incoming';
    callEl('callMuteBtn').hidden = callState.state === 'incoming';
    callEl('callCamBtn').hidden = callState.state === 'incoming' || !callState.video;
    callEl('callMuteBtn').classList.remove('off');
    callEl('callCamBtn').classList.remove('off');
    showLocalVideo();
}

function showLocalVideo() {
    const lv = callEl('localVideo');
    if (callState && callState.video && callState.localStream) {
        lv.srcObject = callState.localStream;
        lv.hidden = false;
        lv.play().catch(() => {});
    } else {
        lv.hidden = true;
    }
    if (callState) {
        callEl('callMuteBtn').hidden = callState.state === 'incoming';
        callEl('callCamBtn').hidden = callState.state === 'incoming' || !callState.video;
        callEl('callAcceptBtn').hidden = callState.state !== 'incoming';
        const o = callEl('callOverlay');
        o.classList.remove('st-calling', 'st-incoming', 'st-connecting', 'st-active');
        o.classList.add('st-' + callState.state);
    }
}

function setStatus(text) {
    callEl('callStatus').textContent = text;
}

function markActive() {
    callState.state = 'active';
    callState.startedAt = Date.now();
    showLocalVideo();
    const tick = () => {
        if (!callState) return;
        const sec = Math.floor((Date.now() - callState.startedAt) / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        setStatus(mm + ':' + ss);
    };
    tick();
    callState.tickTimer = setInterval(tick, 1000);
}

// ---------- ringtone (WebAudio, কোনো ফাইল লাগে না) ----------
function ringTone(freq, start, dur) {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const t0 = audioCtx.currentTime + start;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + dur + 0.05);
    } catch (e) {}
}

function startRing(kind) {
    stopRing();
    const play = () => {
        if (kind === 'in') { ringTone(880, 0, 0.25); ringTone(660, 0.3, 0.25); ringTone(880, 0.6, 0.25); }
        else { ringTone(440, 0, 0.8); }
    };
    play();
    ringInterval = setInterval(play, kind === 'in' ? 2200 : 3000);
}

function stopRing() {
    clearInterval(ringInterval);
    ringInterval = null;
}
