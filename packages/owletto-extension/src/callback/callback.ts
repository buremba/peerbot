/**
 * OAuth callback handler
 * Parses the redirect URL and sends auth result to service worker
 */

// Parse URL parameters
const params = new URLSearchParams(window.location.search);
const success = params.get('success') === 'true';
const error = params.get('error');
const errorDescription = params.get('error_description');
const userId = params.get('user_id');
const sessionToken = params.get('session_token');

// Send message to service worker
chrome.runtime.sendMessage({
  type: 'AUTH_CALLBACK',
  success,
  error: error || errorDescription,
  userId,
  sessionToken,
});

// Update UI based on result
const container = document.querySelector('.container');
if (container) {
  if (success) {
    container.innerHTML = `
      <p style="color: #4CAF50; font-size: 18px;">✓ Signed in successfully!</p>
      <p>This tab will close automatically...</p>
    `;
  } else {
    container.innerHTML = `
      <p style="color: #f44336; font-size: 18px;">✗ Sign in failed</p>
      <p>${error || errorDescription || 'Unknown error'}</p>
    `;
  }
}
