// Unit tests: database chhara, choto choto function
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { base32Encode, base32Decode, totpAt, verifyTotp } = require('../lib/totp');
const { isPrivateIp, validUsername } = require('../lib/net-safety');

test('base32 encode/decode round trip', () => {
    const buf = crypto.randomBytes(20);
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
});

test('TOTP matches the RFC 6238 test vector', () => {
    // RFC 6238 secret "12345678901234567890", time 59s -> counter 1 -> 287082 (last 6 digits of 94287082)
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(totpAt(secret, 1), '287082');
});

test('verifyTotp accepts the current code and rejects wrong ones', () => {
    const secret = base32Encode(crypto.randomBytes(20));
    const now = Math.floor(Date.now() / 30000);
    assert.equal(verifyTotp(secret, totpAt(secret, now)), true);
    assert.equal(verifyTotp(secret, totpAt(secret, now - 1)), true);   // phone er ghori ektu pichone
    assert.equal(verifyTotp(secret, totpAt(secret, now + 5)), false);
    assert.equal(verifyTotp(secret, 'abcdef'), false);
    assert.equal(verifyTotp(secret, ''), false);
});

test('isPrivateIp blocks local and internal addresses (SSRF)', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
        assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
        assert.equal(isPrivateIp(ip), false, ip);
    }
});

test('validUsername follows the rules', () => {
    for (const ok of ['abc', 'nadia.demo', 'user_01', 'a1b2c3d4e5f6g7h8i9j0']) assert.equal(validUsername(ok), true, ok);
    for (const bad of ['ab', '.abc', 'abc.', 'a..b', 'ABC', 'with space', 'a'.repeat(21), '']) assert.equal(validUsername(bad), false, bad);
});