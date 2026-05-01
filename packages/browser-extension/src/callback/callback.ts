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
  container.replaceChildren();
  if (success) {
    const heading = document.createElement('p');
    heading.style.color = '#4CAF50';
    heading.style.fontSize = '18px';
    heading.textContent = '✓ Signed in successfully!';
    const body = document.createElement('p');
    body.textContent = 'This tab will close automatically...';
    container.append(heading, body);
  } else {
    const heading = document.createElement('p');
    heading.style.color = '#f44336';
    heading.style.fontSize = '18px';
    heading.textContent = '✗ Sign in failed';
    const body = document.createElement('p');
    body.textContent = error || errorDescription || 'Unknown error';
    container.append(heading, body);
  }
}
