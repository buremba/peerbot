import { useCallback, useEffect, useState } from 'react';
import './app.css';

interface ActivityEntry {
  id: string;
  timestamp: number;
  type: string;
  message: string;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

function getActivityIcon(type: string): string {
  switch (type) {
    case 'auth':
      return '\uD83D\uDD11';
    case 'sync_started':
      return '\uD83D\uDE80';
    case 'sync_completed':
      return '\u2705';
    case 'sync_failed':
      return '\u274C';
    case 'permission':
      return '\uD83D\uDD12';
    default:
      return '\uD83D\uDCCB';
  }
}

export function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loginError, setLoginError] = useState('');
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);

  const loadActivityLog = useCallback(async () => {
    try {
      const result = await chrome.storage.local.get('activityLog');
      setActivityLog(result.activityLog || []);
    } catch (error) {
      console.error('[Owletto] Failed to load activity log:', error);
    }
  }, []);

  const checkAuthStatus = useCallback(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });
      setIsLoggedIn(response?.isLoggedIn ?? false);
    } catch (error) {
      console.error('[Owletto] Failed to check auth status:', error);
      setIsLoggedIn(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      await checkAuthStatus();
      await loadActivityLog();
    };
    init();
  }, [checkAuthStatus, loadActivityLog]);

  const handleLogin = async () => {
    setLoginError('');
    setIsLoading(true);

    try {
      const response = await chrome.runtime.sendMessage({ type: 'LOGIN' });
      if (response?.success) {
        setIsLoggedIn(true);
        await loadActivityLog();
      } else {
        setLoginError(response?.error || 'Login failed');
      }
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    setIsLoading(true);
    try {
      await chrome.runtime.sendMessage({ type: 'LOGOUT' });
      setIsLoggedIn(false);
      setActivityLog([]);
    } catch (error) {
      console.error('[Owletto] Logout failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePollNow = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'POLL_NOW' });
      await loadActivityLog();
    } catch (error) {
      console.error('[Owletto] Poll failed:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="container">
        <div className="loading">
          <div className="spinner" />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="container">
        <div className="login-section">
          <button type="button" className="btn-primary" onClick={handleLogin}>
            Sign in to Owletto
          </button>
          {loginError && <p className="error">{loginError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="logged-in">
        <div className="status-bar">
          <span className="status connected">Connected</span>
          <button type="button" className="btn-secondary" onClick={handleLogout}>
            Sign out
          </button>
        </div>

        <div className="actions">
          <button type="button" className="btn-primary" onClick={handlePollNow}>
            Check for jobs now
          </button>
        </div>

        <div className="activity-section">
          <h2>Activity Log</h2>
          {activityLog.length === 0 ? (
            <p className="empty">No activity yet</p>
          ) : (
            <ul className="activity-log">
              {activityLog.map((entry) => (
                <li key={entry.id} className="activity-entry">
                  <span className="icon">{getActivityIcon(entry.type)}</span>
                  <span className="message">{entry.message}</span>
                  <span className="time">{formatTime(entry.timestamp)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
