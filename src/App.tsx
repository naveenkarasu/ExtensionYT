import { useState, useEffect, useRef } from 'react';
import './App.css';

const BACKEND_URL = 'http://localhost:4000';
const WS_URL = 'ws://localhost:4000';

interface DownloadStatus {
  type: 'idle' | 'single' | 'playlist';
  status: 'idle' | 'processing' | 'downloading' | 'completed' | 'failed';
  current?: number;
  total?: number;
  videoTitle?: string;
  videoDuration?: string;
  fileName?: string;
  error?: string;
  playlistInfo?: {
    totalSongs: number;
    totalDuration: string;
  };
  successful?: number;
  failed?: number;
  sessionId?: string;
}

type AudioQuality = '128' | '192' | '320';
type VideoQuality = '360p' | '480p' | '720p' | '1080p' | 'best';

function App() {
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<'audio' | 'video'>('audio');
  const [audioQuality, setAudioQuality] = useState<AudioQuality>('192');
  const [videoQuality, setVideoQuality] = useState<VideoQuality>('720p');
  const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus>({ type: 'idle', status: 'idle' });
  const wsRef = useRef<WebSocket | null>(null);
  const [showNewDownload, setShowNewDownload] = useState(false);

  // Load persisted download status on mount
  useEffect(() => {
    const loadStatus = async () => {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        try {
          const result = await chrome.storage.local.get(['downloadStatus']);
          if (result.downloadStatus && result.downloadStatus.status !== 'idle') {
            setDownloadStatus(result.downloadStatus);
            // If there's an active session, reconnect to WebSocket
            if (result.downloadStatus.sessionId && result.downloadStatus.status !== 'completed' && result.downloadStatus.status !== 'failed') {
              connectWebSocket(result.downloadStatus.sessionId);
            }
          }
        } catch (err) {
          console.error('[Extension] Failed to load status:', err);
        }
      }
    };
    loadStatus();
  }, []);

  // Save download status to storage
  const saveStatus = async (status: DownloadStatus) => {
    setDownloadStatus(status);
    if (typeof chrome !== 'undefined' && chrome.storage) {
      try {
        await chrome.storage.local.set({ downloadStatus: status });
      } catch (err) {
        console.error('[Extension] Failed to save status:', err);
      }
    }
  };

  // Connect to WebSocket for playlist progress
  const connectWebSocket = (sessionId: string) => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const ws = new WebSocket(`${WS_URL}/ws?sessionId=${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[Extension] WebSocket connected');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('[Extension] WebSocket message:', message);

        if (message.type === 'start') {
          saveStatus({
            type: 'playlist',
            status: 'processing',
            total: message.total,
            playlistInfo: message.playlistInfo,
            sessionId: message.sessionId
          });
        } else if (message.type === 'progress') {
          saveStatus({
            type: 'playlist',
            status: 'downloading',
            current: message.current,
            total: message.total,
            videoTitle: message.videoTitle,
            videoDuration: message.videoDuration,
            sessionId: message.sessionId
          });
        } else if (message.type === 'success') {
          saveStatus({
            type: 'playlist',
            status: 'downloading',
            current: message.current,
            total: message.total,
            videoTitle: message.videoTitle,
            fileName: message.fileName,
            sessionId: message.sessionId
          });
        } else if (message.type === 'error') {
          saveStatus({
            type: 'playlist',
            status: 'downloading',
            current: message.current,
            total: message.total,
            videoTitle: message.videoTitle,
            error: message.error,
            sessionId: message.sessionId
          });
        } else if (message.type === 'complete') {
          saveStatus({
            type: 'playlist',
            status: 'completed',
            total: message.total,
            successful: message.successful,
            failed: message.failed,
            sessionId: message.sessionId
          });
          setShowNewDownload(true);
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
        } else if (message.type === 'cancelled' || (message.type === 'error' && message.error?.includes('cancelled'))) {
          saveStatus({
            type: downloadStatus.type,
            status: 'failed',
            error: 'Download cancelled',
            sessionId: message.sessionId
          });
          setShowNewDownload(true);
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
        }
      } catch (err) {
        console.error('[Extension] Failed to parse WebSocket message:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('[Extension] WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('[Extension] WebSocket closed');
      wsRef.current = null;
    };
  };

  // Check server health on mount
  useEffect(() => {
    const checkServer = async () => {
      try {
        console.log('[Extension] Checking server health...');
        const response = await fetch(`${BACKEND_URL}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000)
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

  // Listen to download progress if Chrome downloads API is available
  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.onChanged) {
      const handleDownloadChange = (downloadDelta: chrome.downloads.DownloadDelta) => {
        if (downloadDelta.state && downloadStatus.type === 'single') {
          if (downloadDelta.state.current === 'in_progress') {
            saveStatus({ ...downloadStatus, status: 'downloading' });
          } else if (downloadDelta.state.current === 'complete') {
            saveStatus({ ...downloadStatus, status: 'completed' });
            setShowNewDownload(true);
          } else if (downloadDelta.state.current === 'interrupted') {
            saveStatus({ ...downloadStatus, status: 'failed', error: 'Download was interrupted' });
            setShowNewDownload(true);
          }
        }
      };

      chrome.downloads.onChanged.addListener(handleDownloadChange);

      return () => {
        if (chrome.downloads && chrome.downloads.onChanged) {
          chrome.downloads.onChanged.removeListener(handleDownloadChange);
        }
      };
    }
  }, [downloadStatus.type]);

  const handleDownload = async () => {
    setShowNewDownload(false);
    saveStatus({ type: 'idle', status: 'processing' });

    const trimmed = url.trim();
    if (!trimmed) {
      saveStatus({ type: 'idle', status: 'failed', error: 'Please enter a YouTube URL.' });
      setShowNewDownload(true);
      return;
    }

    if (!trimmed.includes('youtube.com') && !trimmed.includes('youtu.be')) {
      saveStatus({ type: 'idle', status: 'failed', error: 'Please enter a valid YouTube URL.' });
      setShowNewDownload(true);
      return;
    }

    try {
      const requestUrl = `${BACKEND_URL}/api/v1/download`;
      console.log('[Extension] Making request to:', requestUrl);

      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: trimmed, format: format, quality: format === 'audio' ? audioQuality : videoQuality })
      });

      console.log('[Extension] Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || `Request failed with status ${response.status}` };
        }
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }

      const data: { 
        downloadUrl?: string; 
        fileName?: string; 
        format?: string;
        type?: string;
        sessionId?: string;
        message?: string;
      } = await response.json();
      console.log('[Extension] Success response:', data);
      
      // Check if this is a playlist response
      if (data.type === 'playlist' && data.sessionId) {
        saveStatus({
          type: 'playlist',
          status: 'processing',
          sessionId: data.sessionId
        });
        connectWebSocket(data.sessionId);
        return;
      }
      
      // Single video download
      if (!data.downloadUrl || !data.fileName) {
        throw new Error('Invalid response from server: missing download URL or filename');
      }

      let absoluteUrl: string;
      if (data.downloadUrl.startsWith('http://') || data.downloadUrl.startsWith('https://')) {
        absoluteUrl = data.downloadUrl;
      } else if (data.downloadUrl.startsWith('/')) {
        absoluteUrl = `${BACKEND_URL}${data.downloadUrl}`;
      } else {
        absoluteUrl = `${BACKEND_URL}/${data.downloadUrl}`;
      }

      try {
        new URL(absoluteUrl);
      } catch (urlError) {
        throw new Error(`Invalid download URL format: ${absoluteUrl}`);
      }

      saveStatus({
        type: 'single',
        status: 'processing',
        fileName: data.fileName
      });

      if (typeof chrome !== 'undefined' && chrome.downloads) {
        // Don't specify filename - let Chrome use the Content-Disposition header from server
        // This ensures the correct extension and filename are used
        // The server sets proper Content-Disposition header with filename
        
        // Ensure the URL is properly encoded
        const downloadUrl = absoluteUrl.includes('://') 
          ? absoluteUrl 
          : `${BACKEND_URL}${absoluteUrl.startsWith('/') ? '' : '/'}${absoluteUrl}`;
        
        console.log('[Extension] Starting download:', { url: downloadUrl, serverFileName: data.fileName });
        
        chrome.downloads.download(
          {
            url: downloadUrl,
            // Don't set filename - let server's Content-Disposition header determine it
            // This prevents extension conflicts and ensures correct file type
            saveAs: false,
            conflictAction: 'uniquify' // Auto-rename if file exists
          },
          (downloadId?: number) => {
            if (chrome.runtime.lastError) {
              console.error('[Extension] Download error:', chrome.runtime.lastError);
              saveStatus({
                type: 'single',
                status: 'failed',
                error: chrome.runtime.lastError.message
              });
              setShowNewDownload(true);
            } else {
              console.log('[Extension] Download started:', downloadId);
              saveStatus({
                type: 'single',
                status: 'downloading',
                fileName: data.fileName // Use server-provided filename
              });
            }
          }
        );
      } else {
        window.open(absoluteUrl, '_blank');
        saveStatus({
          type: 'single',
          status: 'completed',
          fileName: data.fileName
        });
        setShowNewDownload(true);
      }
    } catch (err) {
      console.error('[Extension] Error caught:', err);
      const errorMessage = err instanceof TypeError && err.message.includes('fetch')
        ? `Cannot connect to server at ${BACKEND_URL}. Make sure the backend server is running on port 4000.`
        : err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
      
      saveStatus({
        type: downloadStatus.type || 'idle',
        status: 'failed',
        error: errorMessage
      });
      setShowNewDownload(true);
    }
  };

  const handleCancelDownload = async () => {
    const sessionId = downloadStatus.sessionId;
    
    if (sessionId) {
      // Send cancel message via WebSocket if connected
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'cancel' }));
      }
      
      // Also call cancel endpoint
      try {
        await fetch(`${BACKEND_URL}/api/v1/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ sessionId })
        });
      } catch (err) {
        console.error('[Extension] Error cancelling download:', err);
      }
      
      // Close WebSocket connection
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    }
    
    // Reset UI
    handleNewDownload();
  };

  const handleNewDownload = () => {
    setUrl('');
    setShowNewDownload(false);
    saveStatus({ type: 'idle', status: 'idle' });
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.remove(['downloadStatus']);
    }
  };

  const renderDownloadStatus = () => {
    if (downloadStatus.status === 'idle') return null;

    if (downloadStatus.type === 'playlist') {
      return (
        <div className="download-status">
          <h3 style={{ margin: '0 0 10px 0', fontSize: '14px' }}>📋 Playlist Download</h3>
          
          {downloadStatus.status === 'processing' && (
            <div className="status-item">
              <div className="status-label">Status:</div>
              <div className="status-value">⏳ Processing playlist...</div>
            </div>
          )}

          {downloadStatus.status === 'downloading' && (
            <>
              {downloadStatus.total && (
                <div className="status-item">
                  <div className="status-label">Progress:</div>
                  <div className="status-value">
                    {downloadStatus.current || 0} / {downloadStatus.total} songs
                  </div>
                  {downloadStatus.total > 0 && (
                    <div className="progress-bar">
                      <div 
                        className="progress-fill" 
                        style={{ width: `${((downloadStatus.current || 0) / downloadStatus.total) * 100}%` }}
                      ></div>
                    </div>
                  )}
                </div>
              )}
              
              {downloadStatus.videoTitle && (
                <div className="status-item">
                  <div className="status-label">Current:</div>
                  <div className="status-value" style={{ fontSize: '12px' }}>
                    {downloadStatus.videoTitle}
                    {downloadStatus.videoDuration && ` (${downloadStatus.videoDuration})`}
                  </div>
                </div>
              )}

              {downloadStatus.error && (
                <div className="status-item">
                  <div className="status-label">Error:</div>
                  <div className="status-value" style={{ color: '#dc3545' }}>
                    {downloadStatus.error}
                  </div>
                </div>
              )}
            </>
          )}

          {downloadStatus.status === 'completed' && (
            <div className="status-item">
              <div className="status-label">Status:</div>
              <div className="status-value" style={{ color: '#28a745' }}>
                ✅ Completed! {downloadStatus.successful || 0} successful, {downloadStatus.failed || 0} failed
              </div>
            </div>
          )}

          {downloadStatus.status === 'failed' && (
            <div className="status-item">
              <div className="status-label">Status:</div>
              <div className="status-value" style={{ color: '#dc3545' }}>
                ❌ Failed: {downloadStatus.error || 'Unknown error'}
              </div>
            </div>
          )}
        </div>
      );
    }

    // Single video status
    return (
      <div className="download-status">
        <h3 style={{ margin: '0 0 10px 0', fontSize: '14px' }}>🎵 Single Video Download</h3>
        
        {downloadStatus.status === 'processing' && (
          <div className="status-item">
            <div className="status-label">Status:</div>
            <div className="status-value">⏳ Processing video...</div>
          </div>
        )}

        {downloadStatus.status === 'downloading' && (
          <div className="status-item">
            <div className="status-label">Status:</div>
            <div className="status-value">⬇️ Downloading: {downloadStatus.fileName}</div>
          </div>
        )}

        {downloadStatus.status === 'completed' && (
          <div className="status-item">
            <div className="status-label">Status:</div>
            <div className="status-value" style={{ color: '#28a745' }}>
              ✅ Download completed: {downloadStatus.fileName}
            </div>
          </div>
        )}

        {downloadStatus.status === 'failed' && (
          <div className="status-item">
            <div className="status-label">Status:</div>
            <div className="status-value" style={{ color: '#dc3545' }}>
              ❌ Failed: {downloadStatus.error || 'Unknown error'}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Show download form or status based on state
  const showForm = downloadStatus.status === 'idle' || showNewDownload;

  return (
    <div className="app-root">
      <h1 className="app-title">YouTube Downloader</h1>

      {showForm ? (
        <>
          <label className="field">
            <span className="field-label">YouTube URL</span>
            <input
              type="text"
              className="field-input"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={downloadStatus.status !== 'idle'}
            />
          </label>

          <label className="field">
            <span className="field-label">Download as</span>
            <select
              className="field-select"
              value={format}
              onChange={(e) => {
                const newFormat = e.target.value as 'audio' | 'video';
                setFormat(newFormat);
              }}
              disabled={downloadStatus.status !== 'idle'}
            >
              <option value="audio">🎵 Song (MP3)</option>
              <option value="video">🎬 Video (MP4)</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">Quality</span>
            {format === 'audio' ? (
              <select
                className="field-select"
                value={audioQuality}
                onChange={(e) => setAudioQuality(e.target.value as AudioQuality)}
                disabled={downloadStatus.status !== 'idle'}
              >
                <option value="128">128 kbps</option>
                <option value="192">192 kbps</option>
                <option value="320">320 kbps</option>
              </select>
            ) : (
              <select
                className="field-select"
                value={videoQuality}
                onChange={(e) => setVideoQuality(e.target.value as VideoQuality)}
                disabled={downloadStatus.status !== 'idle'}
              >
                <option value="360p">360p</option>
                <option value="480p">480p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="best">Best Available</option>
              </select>
            )}
          </label>

          <button
            className="primary-button"
            onClick={handleDownload}
            disabled={serverStatus !== 'online' || downloadStatus.status !== 'idle'}
          >
            {format === 'audio' ? 'Download MP3' : 'Download MP4'}
          </button>
        </>
      ) : (
        <>
          {renderDownloadStatus()}
          
          {(downloadStatus.status === 'completed' || downloadStatus.status === 'failed') && (
            <button
              className="primary-button"
              onClick={handleNewDownload}
              style={{ marginTop: '10px' }}
            >
              Download New Video/Playlist
            </button>
          )}
        </>
      )}

      {downloadStatus.status !== 'idle' && downloadStatus.status !== 'completed' && downloadStatus.status !== 'failed' && (
        <button
          className="primary-button"
          onClick={handleCancelDownload}
          style={{ marginTop: '10px', background: '#dc3545' }}
        >
          Cancel Download
        </button>
      )}

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
    </div>
  );
}

export default App;
