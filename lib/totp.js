// TOTP (RFC 6238): Google / Microsoft Authenticator er 6 sonkhar code
// Kono baire package chhara, shudhu Node er crypto
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}
function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, value = 0; const out = [];
    for (const ch of clean) {
        value = (value << 5) | B32.indexOf(ch); bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}
function totpAt(secret, counter) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
    const off = h[h.length - 1] & 15;
    return String((h.readUInt32BE(off) & 0x7fffffff) % 1000000).padStart(6, '0');
}
// ager/porer 30 sec o mane (phone er ghori ektu age-pichhe thakle)
function verifyTotp(secret, code) {
    const c = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(c)) return false;
    const now = Math.floor(Date.now() / 30000);
    for (let w = -1; w <= 1; w++) {
        const a = Buffer.from(totpAt(secret, now + w)), b = Buffer.from(c);
        if (crypto.timingSafeEqual(a, b)) return true;
    }
    return false;
}

module.exports = { base32Encode, base32Decode, totpAt, verifyTotp };