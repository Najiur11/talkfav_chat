// API tests: asol server chalu kore (test database e) HTTP diye porikkha
// Lage: DATABASE_URL_TEST (CI te GitHub Actions nijei Postgres dey)
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const { totpAt } = require('../lib/totp');

const DB = process.env.DATABASE_URL_TEST;
const PORT = 3999;
const BASE = 'http://localhost:' + PORT;
let server;

async function api(p, { body, token, headers } = {}) {
    const r = await fetch(BASE + p, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual'
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    return { status: r.status, headers: r.headers, ...data };
}
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
async function newUser(name) {
    const email = name.toLowerCase().replace(/\s/g, '') + '.' + uniq() + '@test.dev';
    const reg = await api('/api/register', { body: { name, email, phone: '+8801711000000', country: 'BD', password: 'secret123' } });
    assert.equal(reg.status, 201, reg.message);
    const login = await api('/api/login', { body: { email, password: 'secret123' }, headers: { 'X-Forwarded-For': '10.9.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) } });
    assert.ok(login.user, login.message);
    return { ...login.user, email };
}

test('TalkFav API', { skip: !DB && 'DATABASE_URL_TEST is not set' }, async (t) => {
    // ---- server chalu ----
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), JWT_SECRET: 'test-secret', DB_SSL: 'false', ADMIN_EMAILS: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start:\n' + log)), 30000);
        const onData = (d) => { log += d; if (log.includes('Server is running')) { clearTimeout(timer); resolve(); } };
        server.stdout.on('data', onData);
        server.stderr.on('data', onData);
        server.on('exit', (code) => reject(new Error('server exited ' + code + '\n' + log)));
    });
    t.after(() => server.kill());

    await t.test('security headers are set and private files are hidden', async () => {
        const r = await fetch(BASE + '/');
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('x-frame-options'), 'DENY');
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(r.headers.get('x-powered-by'), null);
        for (const f of ['/server.js', '/.env', '/package.json']) assert.equal((await fetch(BASE + f)).status, 404, f);
    });

    await t.test('protected API needs a login', async () => {
        assert.equal((await api('/api/users/me')).status, 401);
        assert.equal((await api('/api/users/me', { token: 'not.a.token' })).status, 401);
    });

    let A, B, C;
    await t.test('register validates input and blocks duplicates', async () => {
        const bad = await api('/api/register', { body: { name: 'X', email: 'not-an-email', phone: '+8801700000000', password: 'secret123' } });
        assert.equal(bad.status, 400);
        assert.equal(bad.field, 'email');
        const short = await api('/api/register', { body: { name: 'X', email: uniq() + '@test.dev', phone: '+8801700000000', password: '123' } });
        assert.equal(short.field, 'password');
        A = await newUser('Alice Test');
        B = await newUser('Bob Test');
        C = await newUser('Carol Test');
        const dup = await api('/api/register', { body: { name: 'Again', email: A.email.toUpperCase(), phone: '+8801700000000', password: 'secret123' } });
        assert.equal(dup.status, 400);
    });

    await t.test('login rejects a wrong password', async () => {
        const r = await api('/api/login', { body: { email: A.email, password: 'wrong-pass' } });
        assert.equal(r.status, 400);
        assert.equal(r.field, 'password');
    });

    await t.test('every new user gets a unique @username', async () => {
        const me = await api('/api/users/me', { token: A.token });
        assert.match(me.user.username, /^[a-z0-9_.]{3,20}$/);
        const set = await api('/api/users/profile', { token: B.token, body: { name: 'Bob Test', phone: '', country: '', username: me.user.username } });
        assert.equal(set.status, 400, 'username should be taken');
    });

    await t.test('friend request -> accept -> chat', async () => {
        const send = await api('/api/friend-request/send', { token: A.token, body: { receiver_id: B.id } });
        assert.ok(send.status < 300, send.message);
        const again = await api('/api/friend-request/send', { token: A.token, body: { receiver_id: B.id } });
        assert.equal(again.status, 409);
        const pending = await api('/api/friend-request/pending/' + B.id, { token: B.token });
        const req = (pending.requests || []).find(r => r.sender_id === A.id) || {};
        const acc = await api('/api/friend-request/accept', { token: B.token, body: { request_id: req.request_id } });
        assert.ok(acc.status < 300, acc.message);

        for (let i = 1; i <= 3; i++) {
            const m = await api('/api/messages/send', { token: A.token, body: { receiver_id: B.id, message: 'hello ' + i } });
            assert.equal(m.status, 200, m.message);
        }
        const hist = await api(`/api/messages/${B.id}/${A.id}?limit=2`, { token: B.token });
        assert.equal(hist.messages.length, 2);
        assert.equal(hist.has_more, true);
        assert.equal(hist.messages[1].message, 'hello 3');
    });

    await t.test('a user cannot read someone else\u2019s chat', async () => {
        const r = await api(`/api/messages/${A.id}/${B.id}?limit=5`, { token: C.token });
        assert.equal(r.status, 403);
        const send = await api('/api/messages/send', { token: C.token, body: { receiver_id: A.id, message: 'spam' } });
        assert.equal(send.status, 403, 'only friends can message');
    });

    await t.test('groups: members can talk, outsiders cannot see', async () => {
        const g = await api('/api/groups', { token: A.token, body: { name: 'Test group', member_ids: [B.id] } });
        assert.ok(g.group_id, g.message);
        const m = await api('/api/messages/send', { token: B.token, body: { group_id: g.group_id, message: 'hi group' } });
        assert.equal(m.status, 200);
        assert.equal((await api('/api/groups/' + g.group_id + '/messages?limit=5', { token: C.token })).status, 404);
    });

    await t.test('link preview refuses internal addresses (SSRF)', async () => {
        const local = await api('/api/link-preview?url=' + encodeURIComponent('http://localhost:' + PORT + '/api/users/me'), { token: A.token });
        assert.equal(local.preview, null);
        const meta = await api('/api/link-preview?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data'), { token: A.token });
        assert.equal(meta.preview, null);
        assert.equal((await api('/api/link-preview?url=ftp://example.com', { token: A.token })).status, 400);
    });

    await t.test('too many wrong logins are blocked', async () => {
        let last;
        for (let i = 0; i < 11; i++) last = await api('/api/login', { body: { email: C.email, password: 'nope' + i }, headers: { 'X-Forwarded-For': '10.200.0.1' } });
        assert.equal(last.status, 429);
    });

    await t.test('two-step verification protects the login', async () => {
        const setup = await api('/api/2fa/setup', { token: B.token, body: {} });
        assert.ok(setup.secret);
        const now = Math.floor(Date.now() / 30000);
        const en = await api('/api/2fa/enable', { token: B.token, body: { code: totpAt(setup.secret, now) } });
        assert.equal(en.backup_codes.length, 8);
        const login = await api('/api/login', { body: { email: B.email, password: 'secret123' }, headers: { 'X-Forwarded-For': '10.201.0.1' } });
        assert.equal(login.need_2fa, true);
        assert.equal(login.user, undefined, 'no token before the code');
        assert.equal((await api('/api/auth/2fa', { body: { ticket: login.ticket, code: '000000' } })).status, 400);
        const ok = await api('/api/auth/2fa', { body: { ticket: login.ticket, code: totpAt(setup.secret, Math.floor(Date.now() / 30000)) } });
        assert.ok(ok.user && ok.user.token);
    });

    await t.test('demo account works and is limited', async () => {
        const d = await api('/api/auth/demo', { body: {} });
        assert.ok(d.user, d.message);
        const friends = await api('/api/friends/' + d.user.id, { token: d.user.token });
        assert.ok(friends.friends.length >= 2);
        assert.equal((await api('/api/users/delete', { token: d.user.token, body: { confirm: 'DELETE' } })).status, 403);
        assert.equal((await api('/api/friend-request/send', { token: d.user.token, body: { receiver_id: A.id } })).status, 403);
    });
});