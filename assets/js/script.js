const loginForm = document.getElementById('loginForm');
const thankYouMessage = document.getElementById('thankYouMessage');

loginForm.addEventListener('submit', function(event) {
    event.preventDefault(); 

   
    loginForm.style.display = 'none';

   
    thankYouMessage.style.display = 'block';
});