const loginForm = document.getElementById('loginForm');
const thankYouMessage = document.getElementById('thankYouMessage');

loginForm.addEventListener('submit', function(event) {
    event.preventDefault(); // Eta page reload ba onno page-e jawa bondho rakbe

    // Form hide kore dibe
    loginForm.style.display = 'none';

    // Thank you message show korabe
    thankYouMessage.style.display = 'block';
});