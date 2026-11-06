document.addEventListener('DOMContentLoaded', () => {

    // ==========================================
    // ১. ডার্ক মোড টগল করার লজিক (সকল পেজের জন্য)
    // ==========================================
    const themeToggleBtn = document.getElementById('theme-toggle');
    const themeIcon = document.getElementById('theme-icon');

    if (themeToggleBtn && themeIcon) {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        themeIcon.textContent = savedTheme === 'dark' ? '☀️' : '🌙';

        themeToggleBtn.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            themeIcon.textContent = newTheme === 'dark' ? '☀️' : '🌙';
        });
    }

    // ==========================================
    // ২. পাসওয়ার্ড Show/Hide Toggle Logic (রেজিস্টার ও লগইন পেজের জন্য)
    // ==========================================
    const togglePassword = document.getElementById('toggle-password') || document.getElementById('togglePassword');
    const passwordInput = document.getElementById('password') || document.getElementById('loginPassword');

    if (togglePassword && passwordInput) {
        togglePassword.addEventListener('click', () => {
            const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
            passwordInput.setAttribute('type', type);
            togglePassword.textContent = type === 'password' ? '👁️' : '🙈';
        });
    }

    // ==========================================
    // ৩. রেজিস্ট্রেশন পেজ লজিক (`register.html`)
    // ==========================================
    const registerForm = document.getElementById('registerForm');
    const registerThankYou = document.getElementById('registerThankYou');

    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault(); 

            const nameEl = document.getElementById('name');
            const emailEl = document.getElementById('email');
            const countryEl = document.getElementById('country');
            const phoneEl = document.getElementById('phone');
            const termsCheckbox = document.getElementById('terms');

            const name = nameEl ? nameEl.value.trim() : '';
            const email = emailEl ? emailEl.value.trim() : '';
            const country = countryEl ? countryEl.value.trim() : '';
            const phone = phoneEl ? phoneEl.value.trim() : '';
            const password = passwordInput ? passwordInput.value : '';

            // Check Terms & Conditions checkbox if exists
            if (termsCheckbox && !termsCheckbox.checked) {
                alert('অনুগ্রহ করে Terms & Conditions এ সম্মতি দিন!');
                return;
            }

            const userData = { name, email, country, phone, password };

            try {
                // Fixed: Using relative path for cross-device compatibility
                const response = await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(userData)
                });

                const result = await response.json();

                if (response.ok) {
                    alert(result.message || 'Registration Successful!');
                    
                    if (registerThankYou) {
                        registerForm.style.display = 'none';
                        registerThankYou.style.display = 'block';
                    } else {
                        window.location.href = 'login.html';
                    }
                } else {
                    alert(result.message || 'Registration failed!');
                }
            } catch (error) {
                console.error('Registration Error:', error);
                alert('Server connection failed. Make sure your server is running!');
            }
        });
    }

    // ==========================================
    // ৪. লগইন পেজ লজিক (API কল ও ড্যাশবোর্ড রিডাইরেক্ট)
    // ==========================================
    const loginForm = document.getElementById('loginForm');

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const emailEl = document.getElementById('loginEmail') || document.getElementById('email');
            const passwordEl = document.getElementById('loginPassword') || document.getElementById('password');

            const loginData = {
                email: emailEl ? emailEl.value.trim() : '',
                password: passwordEl ? passwordEl.value : ''
            };

            try {
                // Fixed: Using relative path for cross-device compatibility
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(loginData)
                });

                const result = await response.json();

                if (response.ok) {
                    alert(result.message || 'Login Successful!');

                    // Save user data in Local Storage
                    localStorage.setItem('user', JSON.stringify(result.user));

                    // Redirect to dashboard
                    window.location.href = 'dashboard.html';
                } else {
                    alert(result.message || 'Login failed!');
                }
            } catch (error) {
                console.error('Login error:', error);
                alert('Server connection failed. Make sure your server is running!');
            }
        });
    }

});