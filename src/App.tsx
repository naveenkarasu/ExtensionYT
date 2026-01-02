import { useState, useEffect } from 'react';
import './App.css';

const BACKEND_URL = 'http://localhost:4000';

function App() {
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState<'128' | '192' | '320'>('192');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline'>('checking');

  // Check server health on mount
  useEffect(() => {
    const checkServer = async () => {
      try {
        console.log('[Extension] Checking server health...');
        const response = await fetch(`${BACKEND_URL}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000) // 3 second timeout
        });
        
        if (response.ok) {
          const data = await response.json();
          console.log('[Extension] Server is online:', data);
          setServerStatus('online');
        } else {
          console.warn('[Extension] Server health check failed:', response.status);
          setServerStatus('offline');
        }
      } catch (err) {
        console.error('[Extension] Server health check error:', err);
        setServerStatus('offline');
      }
    };

    checkServer();
  }, []);

  const handleDownload = async () => {
    setError(null);
    setMessage(null);

    const trimmed = url.trim();
    if (!trimmed) {
      setError('Please enter a YouTube URL.');
      return;
    }

    setIsLoading(true);
    
    // Log start of request
    console.log('[Extension] Starting download request...', { url: trimmed, quality });
    setMessage('Connecting to server...');

    try {
      const requestUrl = `${BACKEND_URL}/api/download`;
      console.log('[Extension] Making request to:', requestUrl);
      console.log('[Extension] Request body:', { url: trimmed, quality });

      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: trimmed, quality })
      });

      console.log('[Extension] Response status:', response.status, response.statusText);
      console.log('[Extension] Response headers:', Object.fromEntries(response.headers.entries()));

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Extension] Error response body:', errorText);
        
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || `Request failed with status ${response.status}` };
        }
        
        throw new Error(errorData.error || `Request failed with status ${response.status}`);
      }

      const data: { downloadUrl: string; fileName: string } = await response.json();
      console.log('[Extension] Success response:', data);
      
      const absoluteUrl = `${BACKEND_URL}${data.downloadUrl}`;
      console.log('[Extension] Absolute download URL:', absoluteUrl);

      setMessage('File ready, starting download...');

      // If running inside the extension, use chrome.downloads API; otherwise, just open the URL.
      if (typeof chrome !== 'undefined' && chrome.downloads) {
        console.log('[Extension] Using chrome.downloads API');
        chrome.downloads.download(
          {
            url: absoluteUrl,
            filename: data.fileName,
            saveAs: false
          },
          (downloadId?: number) => {
            if (chrome.runtime.lastError) {
              console.error('[Extension] chrome.downloads error:', chrome.runtime.lastError);
              setError(`Download started, but Chrome error: ${chrome.runtime.lastError.message}`);
            } else {
              console.log('[Extension] Download started with id:', downloadId);
              setMessage(`Download started! (ID: ${downloadId})`);
            }
          }
        );
      } else {
        console.log('[Extension] Chrome API not available, opening in new tab');
        window.open(absoluteUrl, '_blank');
        setMessage('Download opened in new tab.');
      }
    } catch (err) {
      console.error('[Extension] Error caught:', err);
      
      // More detailed error messages
      if (err instanceof TypeError && err.message.includes('fetch')) {
        setError(`Cannot connect to server at ${BACKEND_URL}. Make sure the backend server is running on port 4000.`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(`Unexpected error: ${String(err)}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-root">
      <h1 className="app-title">YouTube MP3 Downloader</h1>
      <label className="field">
        <span className="field-label">YouTube URL</span>
        <input
          type="text"
          className="field-input"
          placeholder="https://www.youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field-label">Quality</span>
        <select
          className="field-select"
          value={quality}
          onChange={(e) => setQuality(e.target.value as '128' | '192' | '320')}
        >
          <option value="128">128 kbps</option>
          <option value="192">192 kbps</option>
          <option value="320">320 kbps</option>
        </select>
      </label>

      <button
        className="primary-button"
        onClick={handleDownload}
        disabled={isLoading}
      >
        {isLoading ? 'Downloading…' : 'Download MP3'}
      </button>

      {error && <div className="alert alert-error">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}
      
      {/* Server Status Indicator */}
      <div className="server-status" style={{ 
        marginTop: '10px', 
        padding: '8px', 
        borderRadius: '4px',
        backgroundColor: serverStatus === 'online' ? '#d4edda' : serverStatus === 'offline' ? '#f8d7da' : '#fff3cd',
        color: serverStatus === 'online' ? '#155724' : serverStatus === 'offline' ? '#721c24' : '#856404',
        fontSize: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
      }}>
        <span style={{ 
          width: '8px', 
          height: '8px', 
          borderRadius: '50%',
          backgroundColor: serverStatus === 'online' ? '#28a745' : serverStatus === 'offline' ? '#dc3545' : '#ffc107',
          display: 'inline-block'
        }}></span>
        <span>
          {serverStatus === 'checking' && 'Checking server...'}
          {serverStatus === 'online' && `Server online at ${BACKEND_URL}`}
          {serverStatus === 'offline' && `Server offline - Make sure backend is running on port 4000`}
        </span>
      </div>
      
      <p className="hint" style={{ marginTop: '8px', fontSize: '11px', color: '#666' }}>
        💡 Tip: Open DevTools (Right-click popup → Inspect) to see detailed console logs
      </p>
    </div>
  );
}

export default App;

