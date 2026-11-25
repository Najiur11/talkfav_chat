/* =====================================================
   Audio / Video call (WebRTC)
   - call ধরা/কাটার সংকেত (signaling) যায় Socket.IO দিয়ে
   - audio/video নিজে যায় ব্রাউজার থেকে ব্রাউজারে (server দিয়ে না)
   - dashboard.js এর আগে load হয়; dashboard.js এর socket/friends/currentUser ব্যবহার করে
   - নতুন: Speaker, Screen Share, Call History, Missed Calls, Quality, Reconnect,
           Picture-in-Picture / ছোট উইন্ডো, অন্য পেজে থাকলেও Notification
   ===================================================== */

// STUN/TURN: server theke ane (Cloudflare TURN thakle mobile data teo call jure)
const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
let iceCache = { servers: null, turn: false, at: 0 };

async function getIceServers() {
    // credential 6 ghonta valid; 1 ghonta por por notun ani
    if (iceCache.servers && Date.now() - iceCache.at < 60 * 60 * 1000) return iceCache.servers;
    try {
        const data = await request('/api/ice-servers');
        if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
            iceCache = { servers: data.iceServers, turn: !!data.turn, at: Date.now() };
            return iceCache.servers;
        }
    } catch (e) { console.error('ice servers', e); }
    return FALLBACK_ICE;
}
const RING_TIMEOUT_MS = 40000;
const RECONNECT_GIVE_UP_MS = 20000;          // eto khon reconnect na hole call shesh

// callState = null (call নেই) অথবা:
// { state: 'calling' | 'incoming' | 'connecting' | 'active', peerId, peerName, video, isCaller,
//   pc, localStream, screenTrack, pendingCandidates, ringTimer, tickTimer, lostTimer,
//   qualityTimer, reconnecting, startedAt }
let callState = null;
let ringInterval = null;
let titleFlashTimer = null;
let callHistory = [];
let missedCalls = 0;

const callEl = (id) => document.getElementById(id);
const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// ---------- ছোট helper ----------
function callSupported() {
    return typeof RTCPeerConnection === 'function' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
}

function canShareScreen() {
    return !isMobileDevice && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function canNativePip() {
    return !!(document.pictureInPictureEnabled && HTMLVideoElement.prototype.requestPictureInPicture);
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

    callEl('callEndBtn').addEventListener('click', (e) => { e.stopPropagation(); endCall(true); });
    callEl('callAcceptBtn').addEventListener('click', (e) => { e.stopPropagation(); acceptCall(); });
    callEl('callMuteBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMic(); });
    callEl('callCamBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleCam(); });
    if (callEl('callSpeakerBtn')) callEl('callSpeakerBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleSpeaker(); });
    if (callEl('callScreenBtn')) callEl('callScreenBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleScreen(); });
    if (callEl('callPipBtn')) callEl('callPipBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePip(); });
    if (callEl('callMinBtn')) callEl('callMinBtn').addEventListener('click', (e) => { e.stopPropagation(); setMini(true); });

    // chhoto window e click korle abar boro
    callEl('callOverlay').addEventListener('click', () => {
        if (callEl('callOverlay').classList.contains('mini')) setMini(false);
    });

    window.addEventListener('beforeunload', () => { if (callState && socket) endCall(true, true); });
    loadCallHistory();
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
    socket.on('calls:changed', loadCallHistory);
    socket.on('call:missed', onMissed);
    // socket abar jure gele (internet firlo) cholti call ta reconnect er cheshta
    socket.on('connect', () => { if (callState && callState.state === 'active') restartIce(); });
}

// ---------- call করা ----------
async function startCall(friend, video) {
    if (callState || !friend || friend.isGroup) return;     // group e call nai
    if (!socket || !socketUp) { alert('Realtime connection is not ready yet. Please wait a moment and try again.'); return; }
    if (!callSupported()) {
        alert('Calls need a secure page. Open the site with https:// or http://localhost:3000.');
        return;
    }

    getIceServers();                                  // age theke ene rakhi (call dhorle deri hobe na)
    const stream = await getMedia(video);
    if (!stream) return;
    if (callState) { stream.getTracks().forEach(t => t.stop()); return; }   // media newar somoy onno call chole elo

    callState = newCall('calling', friend.id, friend.name, video, stream, true);
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

    callState = newCall('incoming', d.from, friend.name, !!d.video, null, false);
    getIceServers();                                  // dhorar age-i TURN credential ready
    showCallUI(friend);
    setMini(false);
    setStatus(d.video ? 'Incoming video call...' : 'Incoming audio call...');
    startRing('in');
    flashTitle('📞 ' + friend.name + ' is calling');
    try { if (navigator.vibrate) navigator.vibrate([500, 300, 500, 300, 500]); } catch (e) {}

    // অন্য tab / minimize থাকলে browser notification
    try {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(friend.name, {
                body: d.video ? '📹 Incoming video call' : '📞 Incoming audio call',
                tag: 'talkfav-call',
                requireInteraction: true
            });
            n.onclick = () => { window.focus(); n.close(); };
            callState.notification = n;
        }
    } catch (e) {}
}

async function acceptCall() {
    if (!callState || callState.state !== 'incoming') return;
    const wantVideo = callState.video;
    stopRing();
    const stream = await getMedia(wantVideo);
    if (!callState || callState.state !== 'incoming') {      // media নেওয়ার সময় call কেটে গেছে
        if (stream) stream.getTracks().forEach(t => t.stop());
        return;
    }
    if (!stream) { endCall(true); return; }                  // permission না দিলে reject

    callState.localStream = stream;
    callState.state = 'connecting';
    setStatus('Connecting...');
    showLocalVideo();
    callState.iceServers = await getIceServers();
    if (!callState) return;
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
    callState.iceServers = await getIceServers();
    if (!callState) return;
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
    const pc = new RTCPeerConnection({ iceServers: callState.iceServers || iceCache.servers || FALLBACK_ICE });
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
            if (callState.reconnecting) { callState.reconnecting = false; showToast(callState.peerName, 'Reconnected ✓', null); }
            if (callState.state !== 'active') markActive();
        } else if (st === 'disconnected' || st === 'failed') {
            startReconnect(st === 'failed');
        }
    };
}

// ---------- Reconnect: internet bichchhinno hole ----------
function startReconnect(now) {
    if (!callState || callState.state !== 'active') {
        if (callState && now) endCall(true, false, 'Connection failed');
        return;
    }
    if (!callState.reconnecting) {
        callState.reconnecting = true;
        setStatus('Reconnecting...');
        clearTimeout(callState.lostTimer);
        callState.lostTimer = setTimeout(() => endCall(true, false, 'Connection lost'), RECONNECT_GIVE_UP_MS);
    }
    // "disconnected" onek somoy nijei thik hoy, tai 2 sec opekkha; "failed" hole sathe sathe
    setTimeout(() => { if (callState && callState.reconnecting) restartIce(); }, now ? 0 : 2000);
}

// ICE restart: notun network rasta khuje ber kora. Shudhu caller offer pathay (dui pash theke eksathe na)
async function restartIce() {
    if (!callState || !callState.pc || !callState.isCaller) return;
    try {
        if (callState.pc.restartIce) callState.pc.restartIce();
        const offer = await callState.pc.createOffer({ iceRestart: true });
        await callState.pc.setLocalDescription(offer);
        sendSignal({ type: 'offer', sdp: offer.sdp });
    } catch (err) { console.error('ICE restart failed', err); }
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
    clearInterval(callState.qualityTimer);
    stopRing();
    stopTitleFlash();
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) {}
    try { if (callState.notification) callState.notification.close(); } catch (e) {}
    if (callState.screenTrack) callState.screenTrack.stop();
    if (callState.pc) { callState.pc.onicecandidate = null; callState.pc.ontrack = null; callState.pc.onconnectionstatechange = null; callState.pc.close(); }
    if (callState.localStream) callState.localStream.getTracks().forEach(t => t.stop());
    callState = null;

    try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch (e) {}
    const rv = callEl('remoteVideo'); rv.srcObject = null; rv.muted = false;
    const lv = callEl('localVideo'); lv.srcObject = null; lv.classList.remove('screen');
    callEl('callOverlay').hidden = true;
    callEl('callOverlay').className = 'call-overlay';
    if (callEl('callQuality')) callEl('callQuality').hidden = true;
}

// ---------- mic / camera / speaker ----------
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

// Speaker: opor pasher awaj bondho/chalu (mobile browser earpiece/loudspeaker bodlate dey na)
function toggleSpeaker() {
    if (!callState) return;
    const rv = callEl('remoteVideo');
    rv.muted = !rv.muted;
    callEl('callSpeakerBtn').classList.toggle('off', rv.muted);
    callEl('callSpeakerBtn').title = rv.muted ? 'Speaker off (tap to turn on)' : 'Speaker on';
}

// ---------- Screen Sharing (computer browser e, video call er moddhe) ----------
async function toggleScreen() {
    if (!callState || callState.state !== 'active' || !callState.pc) return;
    if (callState.screenTrack) { stopScreen(); return; }
    if (!callState.video) { showToast('Screen share', 'Start a video call to share your screen.', null); return; }

    let display;
    try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (e) { return; }                           // user batil korechhe
    if (!callState) { display.getTracks().forEach(t => t.stop()); return; }

    const track = display.getVideoTracks()[0];
    const sender = callState.pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) { track.stop(); return; }
    await sender.replaceTrack(track);                 // camera r jaygay screen pathao (notun connection lage na)
    callState.screenTrack = track;
    track.onended = stopScreen;                       // browser er "Stop sharing" button
    const lv = callEl('localVideo');
    lv.srcObject = display;
    lv.classList.add('screen');
    callEl('callScreenBtn').classList.add('on');
}

async function stopScreen() {
    if (!callState || !callState.screenTrack) return;
    const cam = callState.localStream.getVideoTracks()[0];
    const sender = callState.pc && callState.pc.getSenders().find(s => s.track && s.track.kind === 'video');
    try { if (sender && cam) await sender.replaceTrack(cam); } catch (e) { console.error(e); }
    callState.screenTrack.stop();
    callState.screenTrack = null;
    const lv = callEl('localVideo');
    lv.srcObject = callState.localStream;
    lv.classList.remove('screen');
    callEl('callScreenBtn').classList.remove('on');
}

// ---------- Picture-in-Picture / chhoto window ----------
async function togglePip() {
    if (!callState) return;
    const rv = callEl('remoteVideo');
    if (canNativePip() && callState.video && rv.srcObject) {
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else await rv.requestPictureInPicture();          // browser er nijer bhasoman window
            return;
        } catch (e) { console.error(e); }
    }
    setMini(true);                                            // na parle app er bhitor chhoto window
}

function setMini(on) {
    const o = callEl('callOverlay');
    if (!callState && on) return;
    o.classList.toggle('mini', !!on);
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
function newCall(state, peerId, peerName, video, stream, isCaller) {
    return { state, peerId, peerName, video, isCaller: !!isCaller, pc: null, localStream: stream, screenTrack: null, iceServers: null,
             pendingCandidates: [], ringTimer: null, tickTimer: null, lostTimer: null, qualityTimer: null,
             reconnecting: false, startedAt: 0, lastStats: null, notification: null };
}

function showCallUI(friend) {
    const o = callEl('callOverlay');
    o.hidden = false;
    o.className = 'call-overlay st-' + callState.state + (callState.video ? ' is-video' : ' is-audio');
    setAvatar(callEl('callAvatar'), friend.name, friend.avatar);
    callEl('callName').textContent = friend.name;
    callEl('callMuteBtn').classList.remove('off');
    callEl('callCamBtn').classList.remove('off');
    if (callEl('callSpeakerBtn')) callEl('callSpeakerBtn').classList.remove('off');
    if (callEl('callScreenBtn')) callEl('callScreenBtn').classList.remove('on');
    showLocalVideo();
}

function showLocalVideo() {
    const lv = callEl('localVideo');
    if (callState && callState.video && callState.localStream) {
        if (!callState.screenTrack) lv.srcObject = callState.localStream;
        lv.hidden = false;
        lv.play().catch(() => {});
    } else {
        lv.hidden = true;
    }
    if (callState) {
        const st = callState.state;
        const inCall = st === 'connecting' || st === 'active';
        callEl('callMuteBtn').hidden = st === 'incoming';
        callEl('callCamBtn').hidden = st === 'incoming' || !callState.video;
        callEl('callAcceptBtn').hidden = st !== 'incoming';
        if (callEl('callSpeakerBtn')) callEl('callSpeakerBtn').hidden = !inCall;
        if (callEl('callScreenBtn')) callEl('callScreenBtn').hidden = !(st === 'active' && callState.video && canShareScreen());
        if (callEl('callPipBtn')) callEl('callPipBtn').hidden = !(st === 'active' && callState.video);
        if (callEl('callMinBtn')) callEl('callMinBtn').hidden = st === 'incoming';
        const o = callEl('callOverlay');
        o.classList.remove('st-calling', 'st-incoming', 'st-connecting', 'st-active');
        o.classList.add('st-' + st);
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
        if (callState.reconnecting) { setStatus('Reconnecting...'); return; }
        const sec = Math.floor((Date.now() - callState.startedAt) / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        setStatus(mm + ':' + ss);
    };
    tick();
    callState.tickTimer = setInterval(tick, 1000);
    callState.qualityTimer = setInterval(checkQuality, 2000);
    checkQuality();
}

// ---------- Call Quality Indicator ----------
// RTT (signal jete-ashte koto ms) ar packet loss (koto data hariye gelo) dekhe Good / Fair / Poor
async function checkQuality() {
    if (!callState || !callState.pc) return;
    let stats;
    try { stats = await callState.pc.getStats(); } catch (e) { return; }
    if (!callState) return;
    let rtt = null, lost = 0, recv = 0, pairLocal = null;
    stats.forEach(r => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
            if (rtt === null || r.nominated) { rtt = r.currentRoundTripTime * 1000; pairLocal = r.localCandidateId; }
        }
        if (r.type === 'inbound-rtp') { lost += r.packetsLost || 0; recv += r.packetsReceived || 0; }
    });
    // call sorasori (Direct) jachhe na TURN diye (Relay)
    let route = '';
    if (pairLocal && stats.get) {
        const lc = stats.get(pairLocal);
        if (lc) route = lc.candidateType === 'relay' ? 'Relay (TURN)' : 'Direct';
    }
    const prev = callState.lastStats || { lost: 0, recv: 0 };
    const dLost = Math.max(0, lost - prev.lost);
    const dRecv = Math.max(0, recv - prev.recv);
    callState.lastStats = { lost, recv };
    const lossPct = dLost + dRecv > 0 ? (dLost / (dLost + dRecv)) * 100 : 0;

    let level = 'good';
    if (callState.reconnecting || (rtt !== null && rtt > 400) || lossPct > 8) level = 'poor';
    else if ((rtt !== null && rtt > 200) || lossPct > 2) level = 'fair';

    const q = callEl('callQuality');
    if (!q) return;
    q.hidden = false;
    q.className = 'call-quality q-' + level;
    q.querySelector('b').textContent = level === 'good' ? 'Good' : level === 'fair' ? 'Fair' : 'Poor';
    q.title = 'Connection: ' + (rtt !== null ? Math.round(rtt) + ' ms' : '?') + ', loss ' + lossPct.toFixed(1) + '%' + (route ? ' · ' + route : '');
    q.classList.toggle('relay', route === 'Relay (TURN)');
}

// ---------- ringtone (WebAudio, কোনো ফাইল লাগে না) ----------
function ringTone(freq, start, dur, vol) {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const t0 = audioCtx.currentTime + start;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol || 0.18, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + dur + 0.05);
    } catch (e) {}
}

// Incoming Call Sound: mobile phone er moto dui-surer ring
function startRing(kind) {
    stopRing();
    const play = () => {
        if (kind === 'in') {
            [0, 0.45].forEach(off => {
                ringTone(784, off, 0.18, 0.25); ringTone(988, off + 0.2, 0.18, 0.25);
            });
            ringTone(1175, 0.95, 0.35, 0.22);
        } else {
            ringTone(440, 0, 0.9, 0.12); ringTone(480, 0, 0.9, 0.08);      // outgoing "tuuut"
        }
    };
    play();
    ringInterval = setInterval(play, kind === 'in' ? 2000 : 3500);
}

function stopRing() {
    clearInterval(ringInterval);
    ringInterval = null;
}

// tab er nam e jholok (onno tab e thakleo chokhe porbe)
function flashTitle(text) {
    stopTitleFlash();
    const original = document.title;
    let on = false;
    titleFlashTimer = setInterval(() => { on = !on; document.title = on ? text : original; }, 1000);
    titleFlashTimer.original = original;
}

function stopTitleFlash() {
    if (!titleFlashTimer) return;
    clearInterval(titleFlashTimer);
    if (typeof updateBadges === 'function') updateBadges();       // asol title ferot
    titleFlashTimer = null;
}

// =====================================================
// Call History + Missed Calls (Calls tab)
// =====================================================
async function loadCallHistory() {
    try {
        const data = await request('/api/calls');
        callHistory = data.calls || [];
        missedCalls = activeTab === 'calls' ? 0 : (data.missed || 0);
        updateCallBadge();
        if (activeTab === 'calls') { renderPane(); if (data.missed) markCallsSeen(); }
    } catch (err) { console.error(err); }
}

function updateCallBadge() {
    const b = callEl('callBadge');
    if (!b) return;
    b.textContent = missedCalls > 99 ? '99+' : missedCalls;
    b.hidden = missedCalls === 0;
}

function markCallsSeen() {
    missedCalls = 0;
    updateCallBadge();
    postJSON('/api/calls/seen', {}).catch(console.error);
}

// missed call: toast + notification + badge
function onMissed(d) {
    const f = friendById(d.from);
    showToast('Missed call', 'from ' + f.name, () => { if (typeof switchTab === 'function') switchTab('calls'); });
    try {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const n = new Notification('Missed call', { body: 'from ' + f.name, tag: 'talkfav-missed' });
            n.onclick = () => { window.focus(); n.close(); };
        }
    } catch (e) {}
}

function callDurationText(c) {
    if (!c.answered_at || !c.ended_at) return '';
    const sec = Math.max(0, Math.round((new Date(c.ended_at) - new Date(c.answered_at)) / 1000));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? m + ' min ' + s + ' sec' : s + ' sec';
}

function callWhenText(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return '';
    return dayLabel(d) + ', ' + fmtTime(d);
}

// dashboard.js er renderPane() theke
function renderCallHistory(body) {
    if (missedCalls) markCallsSeen();
    if (!callHistory.length) {
        body.appendChild(emptyNote('No calls yet. Open a chat and tap the call button to call a friend.'));
        return;
    }
    callHistory.forEach(c => {
        const missed = c.status === 'missed' && !c.outgoing;
        const item = el('div', 'item call-row' + (missed ? ' missed' : ''));
        const av = makeAvatar(c.peer_name, 'clickable', c.peer_avatar);
        av.addEventListener('click', () => { if (typeof openProfile === 'function') openProfile(c.peer_id); });
        item.appendChild(av);

        const info = el('div', 'item-body');
        info.appendChild(el('strong', '', c.peer_name));
        let label;
        if (c.status === 'answered') label = (c.outgoing ? '↗ Outgoing' : '↙ Incoming') + ' · ' + callDurationText(c);
        else if (c.status === 'rejected') label = c.outgoing ? '↗ Declined' : '↙ You declined';
        else label = c.outgoing ? '↗ No answer' : '↙ Missed call';
        const line = el('small', 'call-line' + (missed ? ' missed-text' : ''));
        line.appendChild(typeof icon === 'function' ? icon(c.video ? 'video' : 'call') : document.createTextNode(''));
        line.appendChild(document.createTextNode(label));
        info.appendChild(line);
        info.appendChild(el('small', 'call-when', callWhenText(c.started_at)));
        item.appendChild(info);

        // abar call (shudhu friend hole)
        const friend = friends.find(f => f.id === c.peer_id);
        if (friend) {
            const a = iconBtn('icon-btn call-back', 'call', 'Audio call');
            a.addEventListener('click', () => { if (typeof openChat === 'function') openChat(friend); startCall(friend, false); });
            const v = iconBtn('icon-btn call-back', 'video', 'Video call');
            v.addEventListener('click', () => { if (typeof openChat === 'function') openChat(friend); startCall(friend, true); });
            item.appendChild(a);
            item.appendChild(v);
        }
        body.appendChild(item);
    });
}