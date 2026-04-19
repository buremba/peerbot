import { useEffect, useState } from 'react';
import './popup.css';

export function Popup() {
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    const init = async () => {
      // Check auth status
      const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });
      setIsLoggedIn(response?.isLoggedIn ?? false);

      // Get current tab info
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        setCurrentUrl(tab.url);
      }
    };
    init();
  }, []);

  const openSidebar = () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEBAR' });
    window.close();
  };

  return (
    <div className="popup">
      {currentUrl ? (
        <div className="platform-detected">
          <p>Capture data from this page</p>
        </div>
      ) : (
        <div className="no-platform">
          <p>Navigate to a page to get started</p>
        </div>
      )}

      <div className="actions">
        <button type="button" onClick={openSidebar}>
          {isLoggedIn ? 'Open Dashboard' : 'Sign In'}
        </button>
      </div>

      <footer>
        <button type="button" className="link-button" onClick={openSidebar}>
          Manage sources
        </button>
      </footer>
    </div>
  );
}
