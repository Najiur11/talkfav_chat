/* =====================================================
   TalkFav Landing: chhoto kaj gulo
   ===================================================== */
(function () {
    document.documentElement.classList.add('js');     // JS chalu: scroll animation er jonno
    var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Remember me: tik na diye login korle, browser bondho kore khulle logout
    try {
        if (localStorage.getItem('tf_temp') === '1' && !/(^|;\s*)tf_alive=1/.test(document.cookie)) {
            localStorage.removeItem('user'); localStorage.removeItem('tf_temp');
        }
    } catch (e) {}

    // ---------- login kora thakle "Open TalkFav", na thakle "Log in / Create account" ----------
    var member = false;
    try { member = !!JSON.parse(localStorage.getItem('user') || 'null'); } catch (e) {}
    document.querySelectorAll(member ? '[data-guest]' : '[data-member]').forEach(function (el) { el.hidden = true; });
    document.querySelectorAll(member ? '[data-member]' : '[data-guest]').forEach(function (el) { el.hidden = false; });

    var year = document.getElementById('year');
    if (year) year.textContent = new Date().getFullYear();

    // ---------- dark / light (app er sathe eki setting) ----------
    var moon = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
    var sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
    var icon = document.getElementById('themeIcon');
    function paintIcon() { icon.innerHTML = document.documentElement.getAttribute('data-theme') === 'dark' ? sun : moon; }
    paintIcon();
    document.getElementById('themeBtn').addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        paintIcon();
        updateNav();
    });

    // ---------- nav: hero er upore kach, hero periye gele page er rong ----------
    var nav = document.getElementById('nav');
    var hero = document.getElementById('hero');
    function updateNav() {
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        // dark: hero periye gele; light: ektu scroll korlei (gaarho chat panel er upore lekha jate porha jay)
        var past = dark ? hero.getBoundingClientRect().bottom < 80 : scrollY > 10;
        nav.classList.toggle('solid', past);
        nav.classList.toggle('on-dark', !past && dark);       // light mode e hero sada, tai lekha gaarho
    }
    addEventListener('scroll', updateNav, { passive: true });
    addEventListener('resize', updateNav);
    updateNav();

    // ---------- phone er menu ----------
    var menuBtn = document.getElementById('menuBtn');
    var menu = document.getElementById('mobileMenu');
    function setMenu(open) {
        menu.hidden = !open;
        menuBtn.setAttribute('aria-expanded', String(open));
        menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        if (open) nav.classList.add('solid'), nav.classList.remove('on-dark'); else updateNav();
    }
    menuBtn.addEventListener('click', function () { setMenu(menu.hidden); });
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) { setMenu(false); menuBtn.focus(); } });
    matchMedia('(min-width: 861px)').addEventListener('change', function (m) { if (m.matches) setMenu(false); });

    // ---------- hero chat: page khule ekbar bubble gulo ashe ----------
    requestAnimationFrame(function () { document.getElementById('chatStage').classList.add('play'); });

    // ---------- scroll e bhese otha + feature card jibonto ----------
    var items = document.querySelectorAll('[data-reveal]');
    if (reduce || !('IntersectionObserver' in window)) {
        items.forEach(function (el) { el.classList.add('in'); });
    } else {
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                if (!en.isIntersecting) return;
                en.target.classList.add('in');
                io.unobserve(en.target);
                // privacy card: "online" switch ta ekbar nijei chalu hoy
                if (en.target.classList.contains('t-privacy')) {
                    var sw = en.target.querySelector('.switch.off');
                    if (sw) setTimeout(function () { sw.classList.remove('off'); }, 1100);
                }
            });
        }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
        items.forEach(function (el) { io.observe(el); });
    }

    // ---------- hero te mouse er sathe noram alo (shudhu computer) ----------
    if (!reduce && matchMedia('(hover: hover) and (pointer: fine)').matches) {
        var raf = 0, mx = 0, my = 0;
        hero.addEventListener('pointermove', function (e) {
            var r = hero.getBoundingClientRect();
            mx = e.clientX - r.left; my = e.clientY - r.top;
            if (!raf) raf = requestAnimationFrame(function () {
                hero.style.setProperty('--mx', mx + 'px');
                hero.style.setProperty('--my', my + 'px');
                raf = 0;
            });
            hero.classList.add('mouse-on');
        });
        hero.addEventListener('pointerleave', function () { hero.classList.remove('mouse-on'); });
    }

    // ---------- Install button ----------
    var installBtn = document.getElementById('installBtn');
    if (installBtn) installBtn.addEventListener('click', function () {
        if (window.TalkFavPWA) window.TalkFavPWA.install();
        else alert('Open your browser menu and choose "Install app" or "Add to Home screen".');
    });
})();
