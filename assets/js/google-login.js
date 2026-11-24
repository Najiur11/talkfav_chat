/* =====================================================
   Google Login (login + register page)
   - amader nijer design er Google button (Facebook / Telegram er moto) thake
   - click korle Google er popup -> Google "access token" dey
   - server Google ke diye jachai kore -> amader login token
   ===================================================== */
(function () {
    const gBtn = document.querySelector('.social-btn[aria-label="Google"]');
    if (!gBtn) return;

    // Facebook / Telegram ekhono chalu na
    document.querySelectorAll('.social-btn[aria-label="Facebook"], .social-btn[aria-label="Telegram"]').forEach(b => {
        b.addEventListener('click', () => alert(b.getAttribute('aria-label') + ' login is coming soon. Please use Google or email.'));
    });

    let tokenClient = null;
    let busy = false;

    async function finishLogin(accessToken) {
        try {
            const r = await fetch('/api/auth/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: accessToken })
            });
            const result = await r.json();
            if (!r.ok) { alert(result.message || 'Google sign-in failed.'); return; }
            localStorage.setItem('user', JSON.stringify(result.user));
            window.location.href = 'dashboard.html';
        } catch (err) {
            console.error(err);
            alert('Server connection failed. Please try again.');
        } finally {
            busy = false;
            gBtn.classList.remove('loading');
        }
    }

    gBtn.title = 'Continue with Google';
    gBtn.addEventListener('click', () => {
        if (!tokenClient) { alert('Google login is not available right now. Please use email and password.'); return; }
        if (busy) return;
        busy = true;
        gBtn.classList.add('loading');
        tokenClient.requestAccessToken();                 // Google er popup khule
    });

    fetch('/api/config').then(r => r.json()).then(cfg => {
        if (!cfg || !cfg.googleClientId) return;          // server e Google setup nai
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.defer = true;
        s.onload = () => {
            if (!window.google || !google.accounts || !google.accounts.oauth2) return;
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: cfg.googleClientId,
                scope: 'openid email profile',            // shudhu nam, email, chhobi
                callback: (resp) => {
                    if (resp && resp.access_token) finishLogin(resp.access_token);
                    else { busy = false; gBtn.classList.remove('loading'); }
                },
                error_callback: () => { busy = false; gBtn.classList.remove('loading'); }   // popup bondho korle
            });
        };
        document.head.appendChild(s);
    }).catch(() => {});
})();
