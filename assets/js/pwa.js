
/* =====================================================
   PWA: TalkFav ke phone / computer e "app" hisebe install
   - service worker chalu kore (druto load + offline page)
   - "Install TalkFav" button dekhay (Android/Chrome e sorasori, iPhone e niyom bole dey)
   - sob page e (login, register, dashboard) kaj kore
   ===================================================== */

(function () {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker failed:', err));
        });
    }

    let deferredPrompt = null;
    const DISMISS_KEY = 'talkfav-install-dismissed';
    const listeners = [];
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    function state() {
        return { installed: isStandalone(), canPrompt: !!deferredPrompt, ios: isIOS && !isStandalone() };
    }

    function notify() {
        listeners.forEach(fn => { try { fn(state()); } catch (e) {} });
        updatePill();
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        notify();
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        notify();
    });

    function showIOSHelp() {
        alert('Install TalkFav on iPhone / iPad:\n\n1. Open this page in Safari\n2. Tap the Share button (square with arrow) at the bottom\n3. Choose "Add to Home Screen"\n4. Tap "Add"');
    }

    async function install() {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const choice = await deferredPrompt.userChoice;
            deferredPrompt = null;
            notify();
            return choice.outcome === 'accepted';
        }

        if (isIOS) {
            showIOSHelp();
            return false;
        }

        alert('To install TalkFav: open your browser menu (⋮) and choose "Install app" or "Add to Home screen".');
        return false;
    }

    // ---------- niche bhasoman "Install TalkFav" ----------
    let pill = null;

    function buildPill() {
        const style = document.createElement('style');
        style.textContent = `
          .tf-install{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1500;display:flex;align-items:center;gap:10px;
            max-width:calc(100vw - 24px);padding:8px 8px 8px 10px;border-radius:18px;background:#fff;color:#0f172a;
            box-shadow:0 12px 32px rgba(15,23,42,.25);font:14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif}
          .tf-install[hidden]{display:none}
          .tf-install img{width:36px;height:36px;border-radius:10px}
          .tf-install span{display:flex;flex-direction:column}
          .tf-install small{color:#64748b;font-size:12px}
          .tf-install .tf-go{border:none;border-radius:14px;padding:8px 14px;background:#7c5cff;color:#fff;font-weight:700;cursor:pointer}
          .tf-install .tf-x{border:none;background:none;color:#64748b;font-size:16px;cursor:pointer;padding:4px 6px}
          [data-theme="dark"] .tf-install{background:#16213a;color:#e2e8f0}
          @media (max-width:900px){.tf-install{bottom:80px}}`;
        document.head.appendChild(style);

        pill = document.createElement('div');
        pill.className = 'tf-install';
        pill.innerHTML = '<img src="/assets/icons/icon-192.png" alt=""><span><b>Install TalkFav</b><small>Use it like an app on your device</small></span>' +
            '<button type="button" class="tf-go">Install</button><button type="button" class="tf-x" aria-label="Close">✕</button>';

        pill.querySelector('.tf-go').addEventListener('click', install);

        pill.querySelector('.tf-x').addEventListener('click', () => {
            try {
                localStorage.setItem(DISMISS_KEY, '1');
            } catch (e) {}
            pill.hidden = true;
        });

        document.body.appendChild(pill);
    }

    function updatePill() {
        if (!document.body) return;

        const st = state();
        let dismissed = false;

        try {
            dismissed = !!localStorage.getItem(DISMISS_KEY);
        } catch (e) {}

        const show = !st.installed && (st.canPrompt || st.ios) && !dismissed;

        if (!show) {
            if (pill) pill.hidden = true;
            return;
        }

        if (!pill) buildPill();
        pill.hidden = false;
    }

    document.addEventListener('DOMContentLoaded', updatePill);

    // dashboard er "My Profile" theke-o install kora jay
    window.TalkFavPWA = {
        install,
        state,
        onChange(fn) {
            listeners.push(fn);
            fn(state());
        }
    };
})();
