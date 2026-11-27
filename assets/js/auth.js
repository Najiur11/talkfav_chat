/* =====================================================
   TalkFav — Login + Register er sob kaj
   (theme, password dekha, Caps Lock, bhul dekhano, button animation,
    "Welcome back", somoy onujayi shubhechha, Remember me)
   ===================================================== */
(function () {
    const $ = (id) => document.getElementById(id);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---------- Remember me ----------
    // Tik na dile: browser bondho korle logout. Ekta "session cookie" (browser bondho hole muche jay) diye bujhi
    function markSession(remember) {
        document.cookie = 'tf_alive=1; path=/; SameSite=Lax';
        if (remember) localStorage.removeItem('tf_temp');
        else localStorage.setItem('tf_temp', '1');
    }
    // ei device e shesh je login korechhe (porer bar "Welcome back" er jonno)
    function rememberAccount(user) {
        try {
            const avatar = user.avatar && user.avatar.length < 150000 ? user.avatar : null;
            localStorage.setItem('tf_last', JSON.stringify({ name: user.name, email: user.email, avatar }));
        } catch (e) {}
    }
    function finishLogin(user, remember) {
        localStorage.setItem('user', JSON.stringify(user));
        markSession(remember);
        rememberAccount(user);
    }
    // Google login (google-login.js) o eta use kore
    window.TalkFavAuth = {
        finishLogin: (user) => finishLogin(user, $('remember') ? $('remember').checked : true),
        twoFactor: (ticket) => showTwoFactor(ticket, $('remember') ? $('remember').checked : true)
    };

    // ---------- 2-step verification (login er dwitiyo dhap) ----------
    function showTwoFactor(ticket, remember) {
        const card = $('authCard');
        const loginForm = $('loginForm');
        if (loginForm) loginForm.hidden = true;
        card.querySelectorAll('.divider, .social-row, .signup-text, .not-you').forEach(x => { x.hidden = true; });
        const title = $('cardTitle'), sub = $('formSub');
        if (title) title.innerHTML = 'Two-step <span class="gradient-text">verification</span>';
        if (sub) sub.textContent = 'Open your authenticator app and enter the 6-digit code for TalkFav.';
        const av = $('avatarIn');
        if (av) av.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>';

        let form = $('twoFaForm');
        if (!form) {
            form = document.createElement('form');
            form.id = 'twoFaForm';
            form.noValidate = true;
            form.innerHTML = `
              <div class="form-alert" id="tfAlert" role="alert" hidden></div>
              <div class="input-group">
                <div class="field">
                  <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>
                  <input type="text" id="tfCode" placeholder=" " inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="code-input">
                  <label class="float-label" for="tfCode">6-digit code</label>
                </div>
                <span class="field-error" id="tfCodeError" aria-live="polite"></span>
              </div>
              <button type="submit" class="btn-submit"><span class="label">Verify</span><span class="spinner" aria-hidden="true"></span><svg class="done" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg></button>
              <p class="signup-text tf-links"><button type="button" class="link-like" id="tfBackupToggle">Use a backup code instead</button><br><a href="index.html">Back to login</a></p>`;
            card.appendChild(form);
            let backupMode = false;
            $('tfBackupToggle').addEventListener('click', () => {
                backupMode = !backupMode;
                const inp = $('tfCode');
                inp.value = '';
                inp.maxLength = backupMode ? 11 : 6;
                inp.inputMode = backupMode ? 'text' : 'numeric';
                form.querySelector('.float-label').textContent = backupMode ? 'Backup code (like ab12c-34d56)' : '6-digit code';
                $('tfBackupToggle').textContent = backupMode ? 'Use the code from my app' : 'Use a backup code instead';
                inp.focus();
            });
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const code = $('tfCode').value.trim();
                setError('tfCode', '');
                if (!code) { setError('tfCode', 'Please enter the code.'); shake(); return; }
                const btn = form.querySelector('.btn-submit');
                btnState(btn, 'loading');
                try {
                    const r = await postJSON('/api/auth/2fa', { ticket: form.dataset.ticket, code });
                    if (!r.ok || !r.user) {
                        btnState(btn, null);
                        if (r.expired) { $('tfAlert').hidden = false; $('tfAlert').className = 'form-alert error'; $('tfAlert').textContent = r.message; setTimeout(() => location.reload(), 1800); return; }
                        setError('tfCode', r.message || 'Wrong code.');
                        $('tfCode').select();
                        shake();
                        return;
                    }
                    finishLogin(r.user, form.dataset.remember === '1');
                    btnState(btn, 'success');
                    if (r.backup_left !== null && r.backup_left !== undefined && r.backup_left <= 3) {
                        alert('You have ' + r.backup_left + ' backup codes left. Make new ones in Settings → Privacy & security.');
                    }
                    setTimeout(() => { location.href = 'dashboard.html'; }, reduce ? 0 : 700);
                } catch (err) { btnState(btn, null); setError('tfCode', 'Could not reach the server. Try again.'); shake(); }
            });
        }
        form.dataset.ticket = ticket;
        form.dataset.remember = remember ? '1' : '0';
        form.hidden = false;
        setTimeout(() => $('tfCode').focus(), 50);
    }

    // aage thekei login kora thakle sorasori dashboard
    try {
        const u = JSON.parse(localStorage.getItem('user') || 'null');
        const temp = localStorage.getItem('tf_temp') === '1' && !/(^|;\s*)tf_alive=1/.test(document.cookie);
        if (u && u.token && !temp && $('loginForm')) { location.replace('dashboard.html'); return; }
    } catch (e) {}

    // ---------- theme (dark / light) ----------
    const moon = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
    const sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
    const paintTheme = () => { $('theme-icon').innerHTML = document.documentElement.getAttribute('data-theme') === 'dark' ? sun : moon; };
    paintTheme();
    $('theme-toggle').addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        paintTheme();
    });

    // ---------- somoy onujayi shubhechha ----------
    const h = new Date().getHours();
    const greet = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    if ($('greet')) $('greet').textContent = greet;

    // ---------- password dekha / lukano ----------
    document.querySelectorAll('.eye-btn').forEach(btn => {
        const input = btn.parentElement.querySelector('input');
        btn.addEventListener('click', () => {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            btn.querySelector('.eye-open').hidden = show;
            btn.querySelector('.eye-closed').hidden = !show;
            btn.setAttribute('aria-pressed', String(show));
            btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            input.focus();
        });
    });

    // ---------- Caps Lock sotorkota ----------
    const pw = $('password');
    if (pw) {
        const hint = pw.closest('.input-group').querySelector('.caps-hint');
        const check = (e) => { if (e.getModifierState) hint.hidden = !e.getModifierState('CapsLock'); };
        pw.addEventListener('keydown', check);
        pw.addEventListener('keyup', check);
        pw.addEventListener('blur', () => { hint.hidden = true; });
    }

    // ---------- bhul dekhano ----------
    function setError(id, msg) {
        const input = $(id);
        const err = $(id + 'Error');
        if (input) input.closest('.field') && input.closest('.field').classList.toggle('invalid', !!msg);
        if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
        if (err) err.textContent = msg || '';
    }
    function showAlert(msg, ok) {
        const a = $('formAlert');
        if (!a) return;
        a.hidden = !msg;
        a.className = 'form-alert ' + (ok ? 'ok' : 'error');
        a.textContent = msg || '';
    }
    function shake() {
        const card = $('authCard');
        if (reduce || !card) return;
        card.classList.remove('shake');
        void card.offsetWidth;                    // abar animation chalate
        card.classList.add('shake');
    }
    document.querySelectorAll('.field input').forEach(inp => {
        inp.addEventListener('input', () => { if (inp.closest('.field').classList.contains('invalid')) setError(inp.id, ''); });
    });
    const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

    // ---------- button: loading -> ✓ ----------
    function btnState(btn, state) {
        btn.classList.remove('loading', 'success');
        if (state) btn.classList.add(state);
        btn.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
    }

    async function postJSON(url, body) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let data = {};
        try { data = await r.json(); } catch (e) {}
        return { ok: r.ok, status: r.status, ...data };
    }

    // =====================================================
    // LOGIN
    // =====================================================
    const loginForm = $('loginForm');
    if (loginForm) {
        // "Welcome back": ei device e aage keu login korle tar chhobi, nam, email
        try {
            const params = new URLSearchParams(location.search);
            const fromRegister = params.get('email');
            const last = JSON.parse(localStorage.getItem('tf_last') || 'null');
            if (fromRegister) {
                $('email').value = fromRegister;
                showAlert('Your account is ready. Log in with your new password.', true);
                $('password').focus();
            } else if (last && last.email) {
                const first = String(last.name || '').split(' ')[0] || 'there';
                $('cardTitle').innerHTML = 'Welcome back, <span class="gradient-text"></span>';
                $('cardTitle').querySelector('span').textContent = first;
                $('formSub').textContent = 'Enter your password to continue';
                $('email').value = last.email;
                $('notYou').hidden = false;
                const av = $('avatarIn');
                if (last.avatar) { av.innerHTML = ''; const img = document.createElement('img'); img.src = last.avatar; img.alt = ''; av.appendChild(img); }
                else av.textContent = first.charAt(0).toUpperCase();
                setTimeout(() => $('password').focus(), 50);
            }
        } catch (e) {}

        // Demo account: ek click e dhuke dekha (password chhara)
        const demoBtn = $('demoBtn');
        if (demoBtn) demoBtn.addEventListener('click', async () => {
            demoBtn.disabled = true;
            try {
                const r = await postJSON('/api/auth/demo', {});
                if (!r.ok || !r.user) { showAlert(r.message || 'Demo is not available right now.'); demoBtn.disabled = false; return; }
                finishLogin(r.user, false);
                location.href = 'dashboard.html';
            } catch (e) { showAlert('Could not reach the server.'); demoBtn.disabled = false; }
        });
        if (new URLSearchParams(location.search).get('demo') === '1' && demoBtn) demoBtn.click();

        $('notYouBtn').addEventListener('click', () => {
            localStorage.removeItem('tf_last');
            location.href = 'index.html';
        });

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = $('email').value.trim();
            const password = $('password').value;
            const btn = loginForm.querySelector('.btn-submit');
            showAlert('');
            setError('email', ''); setError('password', '');
            let bad = false;
            if (!emailOk(email)) { setError('email', email ? 'Please enter a valid email address.' : 'Please enter your email.'); bad = true; }
            if (!password) { setError('password', 'Please enter your password.'); bad = true; }
            if (bad) { shake(); return; }

            btnState(btn, 'loading');
            try {
                const r = await postJSON('/api/login', { email, password });
                if (r.ok && r.need_2fa) { btnState(btn, null); showTwoFactor(r.ticket, $('remember').checked); return; }
                if (!r.ok || !r.user) {
                    btnState(btn, null);
                    if (r.field) setError(r.field, r.message);
                    else showAlert(r.message || 'Login failed. Please try again.');
                    if (r.field === 'password') { $('password').select(); }
                    shake();
                    return;
                }
                finishLogin(r.user, $('remember').checked);
                btnState(btn, 'success');
                setTimeout(() => { location.href = 'dashboard.html'; }, reduce ? 0 : 750);
            } catch (err) {
                btnState(btn, null);
                showAlert('Could not reach the server. Check your internet and try again.');
                shake();
            }
        });
    }

    // =====================================================
    // REGISTER
    // =====================================================
    const regForm = $('registerForm');
    if (regForm) {
        // password er shokti
        const meter = $('strength');
        const label = $('strengthLabel');
        $('password').addEventListener('input', () => {
            const v = $('password').value;
            meter.hidden = !v;
            let score = 0;
            if (v.length >= 6) score++;
            if (v.length >= 10) score++;
            if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
            if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) score++;
            if (v.length < 6) score = Math.min(score, 1) || 1;
            meter.dataset.score = String(score);
            label.textContent = ['', 'Weak', 'Fair', 'Good', 'Strong'][score];
        });

        // ghor theke ber holei jachai
        const rules = {
            name: (v) => !v ? 'Please enter your name.' : '',
            email: (v) => !v ? 'Please enter your email.' : (!emailOk(v) ? 'Please enter a valid email address.' : ''),
            country: (v) => !v ? 'Please enter your country.' : '',
            phone: (v) => !v ? 'Please enter your phone number.' : (!/^[+\d][\d\s()-]{5,29}$/.test(v) ? 'Please enter a valid phone number.' : ''),
            password: (v) => !v ? 'Please create a password.' : (v.length < 6 ? 'Password must be at least 6 characters.' : '')
        };
        Object.keys(rules).forEach(id => {
            $(id).addEventListener('blur', () => { const v = $(id).value.trim(); if (v) setError(id, rules[id](id === 'password' ? $(id).value : v)); });
        });
        $('terms').addEventListener('change', () => { if ($('terms').checked) $('termsError').textContent = ''; });

        regForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            showAlert('');
            const data = {
                name: $('name').value.trim(), email: $('email').value.trim(), country: $('country').value.trim(),
                phone: $('phone').value.trim(), password: $('password').value
            };
            let firstBad = null;
            Object.keys(rules).forEach(id => {
                const msg = rules[id](data[id]);
                setError(id, msg);
                if (msg && !firstBad) firstBad = id;
            });
            if (!$('terms').checked) { $('termsError').textContent = 'Please agree to the Terms & Conditions.'; firstBad = firstBad || 'terms'; }
            if (firstBad) { shake(); $(firstBad).focus(); return; }

            const btn = regForm.querySelector('.btn-submit');
            btnState(btn, 'loading');
            try {
                const r = await postJSON('/api/register', data);
                if (!r.ok) {
                    btnState(btn, null);
                    if (r.field && $(r.field)) { setError(r.field, r.message); $(r.field).focus(); }
                    else showAlert(r.message || 'Registration failed. Please try again.');
                    shake();
                    return;
                }
                btnState(btn, 'success');
                setTimeout(() => {
                    regForm.hidden = true;
                    $('authCard').classList.add('done');
                    $('successPanel').hidden = false;
                    $('goLogin').href = 'index.html?email=' + encodeURIComponent(data.email.toLowerCase());
                    $('goLogin').focus();
                }, reduce ? 0 : 700);
            } catch (err) {
                btnState(btn, null);
                showAlert('Could not reach the server. Check your internet and try again.');
                shake();
            }
        });
    }
})();