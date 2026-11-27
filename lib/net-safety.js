// SSRF suroksha: link preview jeno localhost / ghorer network / cloud metadata te na jay
const net = require('net');

function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    const low = ip.toLowerCase();
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));
    return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
}

// username er niyom (server ar test eki niyom use kore)
function validUsername(name) {
    return /^[a-z0-9_.]{3,20}$/.test(name || '') && !/^[._]|[._]$|\.\./.test(name);
}

module.exports = { isPrivateIp, validUsername };