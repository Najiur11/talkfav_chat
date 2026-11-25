/* =====================================================
   Forgot Password (login page): email e 6 sonkhar code -> notun password
   ===================================================== */
(function () {
    const link = [...document.querySelectorAll('a')].find(a => /forgot password/i.test(a.textContent));
    if (!link) return;

    const css = document.createElement('style');
    css.textContent = `
      .fp-overlay{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;padding:16px;background:rgba(4,38,28,.5);backdrop-filter:blur(6px)}
      .fp-box{width:min(400px,100%);display:flex;flex-direction:column;gap:10px;padding:24px;border-radius:24px;background:#fff;color:#10261E;font-family:'DM Sans',system-ui,sans-serif;
        box-shadow:0 20px 50px rgba(0,0,0,.35);font-family:inherit}
      [data-theme="dark"] .fp-box{background:#0B3024;color:#E4F5EC;border:1px solid rgba(255,255,255,.14)}
      .fp-box h3{margin:0;font:800 22px/1.2 'Bricolage Grotesque',system-ui,sans-serif}
      .fp-box p{margin:0;font-size:14px;opacity:.8}
      .fp-box input{height:50px;padding:0 16px;border-radius:14px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font:inherit;font-size:15px}
      .fp-box .fp-code{letter-spacing:6px;text-align:center;font-size:20px;font-weight:700}
      .fp-row{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
      .fp-row button{border:none;border-radius:12px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer}
      .fp-go{background:linear-gradient(120deg,#0E8F5B,#12B07A 45%,#0D9C94);color:#fff;box-shadow:0 10px 24px -10px rgba(18,176,122,.8)}
      .fp-cancel{background:rgba(127,127,127,.18);color:inherit}
      .fp-msg{font-size:13px;min-height:18px}
      .fp-msg.err{color:#ef4444}.fp-msg.ok{color:#16a34a}`;
    document.head.appendChild(css);

    async function post(path, body) {
        const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let d = {};
        try { d = await r.json(); } catch (e) {}
        return { ok: r.ok, ...d };
    }

    function open() {
        const ov = document.createElement('div');
        ov.className = 'fp-overlay';
        ov.innerHTML = `
          <div class="fp-box" role="dialog" aria-label="Reset password">
            <h3>🔑 Reset your password</h3>
            <p class="fp-step1">Enter your account email. We'll send you a 6-digit code.</p>
            <input class="fp-email" type="email" placeholder="Email address" autocomplete="email">
            <div class="fp-step2" hidden style="display:none;flex-direction:column;gap:10px">
              <p>Check your email (and spam folder) for the code.</p>
              <input class="fp-code" type="text" inputmode="numeric" maxlength="6" placeholder="••••••">
              <input class="fp-pass" type="password" placeholder="New password (at least 6 characters)" autocomplete="new-password">
            </div>
            <div class="fp-msg"></div>
            <div class="fp-row">
              <button type="button" class="fp-cancel">Cancel</button>
              <button type="button" class="fp-go">Send code</button>
            </div>
          </div>`;
        document.body.appendChild(ov);
        const $ = (c) => ov.querySelector(c);
        const msg = (t, ok) => { $('.fp-msg').textContent = t; $('.fp-msg').className = 'fp-msg ' + (ok ? 'ok' : 'err'); };
        const close = () => ov.remove();
        const prefill = document.querySelector('input[type="email"]');
        if (prefill && prefill.value) $('.fp-email').value = prefill.value;
        let step = 1;
        $('.fp-cancel').addEventListener('click', close);
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        $('.fp-go').addEventListener('click', async () => {
            const go = $('.fp-go');
            const email = $('.fp-email').value.trim();
            if (!/^\S+@\S+\.\S+$/.test(email)) { msg('Please enter a valid email.'); return; }
            go.disabled = true;
            try {
                if (step === 1) {
                    const r = await post('/api/auth/forgot', { email });
                    if (!r.ok) { msg(r.message || 'Could not send the code.'); return; }
                    msg(r.message, true);
                    step = 2;
                    $('.fp-email').readOnly = true;
                    $('.fp-step2').style.display = 'flex';
                    go.textContent = 'Reset password';
                    $('.fp-code').focus();
                } else {
                    const code = $('.fp-code').value.trim();
                    const password = $('.fp-pass').value;
                    if (!/^\d{6}$/.test(code)) { msg('Enter the 6-digit code from the email.'); return; }
                    if (password.length < 6) { msg('New password must be at least 6 characters.'); return; }
                    const r = await post('/api/auth/reset', { email, code, password });
                    if (!r.ok) { msg(r.message || 'Could not reset password.'); return; }
                    msg(r.message, true);
                    const pw = document.querySelector('input[type="password"]');
                    if (pw) pw.value = '';
                    setTimeout(close, 1800);
                }
            } catch (e) { msg('Server connection failed. Please try again.'); }
            finally { go.disabled = false; }
        });
        $('.fp-email').focus();
    }

    link.addEventListener('click', (e) => { e.preventDefault(); open(); });
})();
