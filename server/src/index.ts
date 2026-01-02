import express from 'express';
import cors from 'cors';
import path from 'path';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const app = express();
const PORT = process.env.PORT || 4000;

const DOWNLOAD_ROOT = path.join(__dirname, '..', 'downloads');
const YTDLP_PATH = path.join(__dirname, '..', 'bin', 'yt-dlp.exe');
const FFMPEG_BIN_DIR = path.join(__dirname, '..', 'bin', 'ffmpeg', 'bin');

// Metadata interface for video information
interface VideoMetadata {
  title?: string;
  uploader?: string;
  channel?: string;
  upload_date?: string; // YYYYMMDD format
  duration?: number; // seconds
  thumbnail?: string;
  description?: string;
  webpage_url?: string;
  playlist_title?: string;
}

// WebSocket progress message interface
interface ProgressMessage {
  type: 'start' | 'progress' | 'success' | 'error' | 'complete';
  sessionId: string;
  current?: number;
  total?: number;
  videoUrl?: string;
  fileName?: string;
  downloadUrl?: string;
  error?: string;
  successful?: number;
  failed?: number;
}

// Store WebSocket connections by session ID
const wsConnections = new Map<string, WebSocket>();

// Check if FFmpeg is available in PATH at startup
function checkFFmpegAvailability(): boolean {
  try {
    // On Windows, try both 'ffmpeg' and 'ffmpeg.exe'
    execSync('ffmpeg -version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

// Extract metadata from YouTube video using yt-dlp
async function extractMetadata(url: string): Promise<VideoMetadata | null> {
  return new Promise((resolve) => {
    console.log(`[METADATA] Extracting metadata for: ${url}`);
    
    const metadataArgs = [
      url,
      '--newline',
      '--ignore-config',
      '--no-download',
      '--print', '{"title":%(title)j,"uploader":%(uploader)j,"channel":%(channel)j,"upload_date":%(upload_date)j,"duration":%(duration)j,"thumbnail":%(thumbnail)j,"description":%(description)j,"webpage_url":%(webpage_url)j,"playlist_title":%(playlist_title)j}'
    ];

    const currentPath = process.env.PATH || '';
    const ffmpegPath = fs.existsSync(FFMPEG_BIN_DIR) ? FFMPEG_BIN_DIR : '';
    const updatedPath = ffmpegPath ? `${ffmpegPath};${currentPath}` : currentPath;

    const metadataProcess = spawn(YTDLP_PATH, metadataArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: updatedPath
      }
    });

    let stdoutData = '';
    let stderrData = '';

    metadataProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    metadataProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    metadataProcess.on('error', (err) => {
      console.log(`[METADATA] Failed to start metadata extraction: ${err.message}`);
      resolve(null);
    });

    metadataProcess.on('close', (code) => {
      if (code !== 0) {
        console.log(`[METADATA] Metadata extraction failed with code ${code}`);
        console.log(`[METADATA] stderr: ${stderrData.slice(-500)}`);
        resolve(null);
        return;
      }

      try {
        // Parse JSON output from yt-dlp
        let metadataJson = stdoutData.trim();
        if (!metadataJson) {
          console.log(`[METADATA] No metadata output received`);
          resolve(null);
          return;
        }

        // Replace NA placeholders with null for valid JSON
        // Handle both :NA} and :NA, patterns (yt-dlp outputs NA for missing fields)
        metadataJson = metadataJson.replace(/:\s*NA([,}])/g, ':null$1');

        const metadata: VideoMetadata = JSON.parse(metadataJson);
        resolve(metadata);
      } catch (error) {
        console.log(`[METADATA] Failed to parse metadata JSON: ${error}`);
        console.log(`[METADATA] Raw output: ${stdoutData.slice(-500)}`);
        resolve(null);
      }
    });

    // Set timeout for metadata extraction (30 seconds)
    setTimeout(() => {
      if (metadataProcess.killed === false) {
        metadataProcess.kill('SIGTERM');
        console.log(`[METADATA] Metadata extraction timeout`);
        resolve(null);
      }
    }, 30000);
  });
}

// Sanitize filename for Windows filesystem
function sanitizeFilename(title: string, maxLength: number = 200): string {
  // Remove or replace invalid characters for Windows filenames
  // Invalid: < > : " / \ | ? *
  let sanitized = title
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  // Limit length to avoid filesystem issues
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength).trim();
  }
  
  // Ensure filename is not empty
  if (!sanitized) {
    sanitized = 'untitled';
  }
  
  return sanitized;
}

// Log extracted metadata in structured format
function logMetadata(metadata: VideoMetadata): void {
  console.log(`[METADATA] Title: ${metadata.title || 'N/A'}`);
  console.log(`[METADATA] Artist: ${metadata.uploader || 'N/A'}`);
  console.log(`[METADATA] Channel: ${metadata.channel || 'N/A'}`);
  
  // Determine album (playlist title or channel)
  const album = metadata.playlist_title || metadata.channel || 'N/A';
  console.log(`[METADATA] Album: ${album}`);
  
  // Extract year from upload_date (YYYYMMDD format)
  let year = 'N/A';
  if (metadata.upload_date && metadata.upload_date.length >= 4) {
    year = metadata.upload_date.substring(0, 4);
  }
  console.log(`[METADATA] Year: ${year}`);
  
  // Format duration
  if (metadata.duration) {
    const minutes = Math.floor(metadata.duration / 60);
    const seconds = metadata.duration % 60;
    console.log(`[METADATA] Duration: ${metadata.duration} seconds (${minutes}:${seconds.toString().padStart(2, '0')})`);
  } else {
    console.log(`[METADATA] Duration: N/A`);
  }
  
  console.log(`[METADATA] Thumbnail URL: ${metadata.thumbnail || 'N/A'}`);
  
  // Show first 100 characters of description
  if (metadata.description) {
    const descPreview = metadata.description.length > 100 
      ? metadata.description.substring(0, 100) + '...'
      : metadata.description;
    console.log(`[METADATA] Description: ${descPreview}`);
  } else {
    console.log(`[METADATA] Description: N/A`);
  }
  
  console.log(`[METADATA] Video URL: ${metadata.webpage_url || 'N/A'}`);
  console.log(`[METADATA] Extraction successful ✓`);
}

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_ROOT)) {
  fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });
}

// Simple request logging middleware
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode}`);
  });
  next();
});

app.use(express.json());

// For now, allow all origins (fine for local learning)
app.use(
  cors({
    origin: '*'
  })
);

// Serve downloaded files statically
app.use('/downloads', express.static(DOWNLOAD_ROOT));

// Download single video - reusable function for both single and batch downloads
// Download single video - audio only (legacy function, kept for backward compatibility)
async function downloadSingleVideo(
  videoUrl: string, 
  quality: string = '192',
  sessionId?: string
): Promise<{ success: boolean; fileName?: string; downloadUrl?: string; error?: string }> {
  return downloadVideoOrAudio(videoUrl, quality, 'audio', sessionId);
}

// Download video or audio - supports both formats (versioned API)
async function downloadVideoOrAudio(
  videoUrl: string, 
  quality: string = '192',
  format: 'audio' | 'video' = 'audio',
  sessionId?: string
): Promise<{ success: boolean; fileName?: string; downloadUrl?: string; error?: string }> {
  return new Promise(async (resolve) => {
    const audioQuality = quality === '320' || quality === '192' || quality === '128' ? quality : '192';
    const id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const safeId = id.replace(/[^a-zA-Z0-9-_]/g, '');

    // Extract metadata before starting download
    let metadata: VideoMetadata | null = null;
    try {
      metadata = await extractMetadata(videoUrl);
      if (metadata && sessionId) {
        logMetadata(metadata);
      }
    } catch (error) {
      // Continue even if metadata extraction fails
    }

    // Determine filename: use title from metadata if available, otherwise use safeId
    let fileName: string;
    if (metadata && metadata.title) {
      const sanitizedTitle = sanitizeFilename(metadata.title);
      fileName = sanitizedTitle;
    } else {
      fileName = safeId;
    }

    // Create output template
    const outputTemplate = path.join(DOWNLOAD_ROOT, `${fileName}.%(ext)s`);

    const args = [
      videoUrl,
      '--newline',
      '--ignore-config',
      '--no-playlist',
    ];

    // Add format-specific arguments
    if (format === 'audio') {
      args.push(
        '-f', 'bestaudio/worst',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', audioQuality,
        '--embed-thumbnail'
      );
    } else {
      // Video download
      args.push(
        '-f', 'bestvideo+bestaudio/best',  // Best video+audio or best available
        '--merge-output-format', 'mp4'     // Merge into MP4
      );
    }

    args.push(
      '-o', outputTemplate,
      '--output-na-placeholder', 'NA',
      '--progress',
      '--retries', '3',
      '--fragment-retries', '3',
      '--extractor-retries', '3',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--referer', 'https://www.youtube.com/',
      '--add-header', 'Accept-Language:en-US,en;q=0.9'
    );

    const currentPath = process.env.PATH || '';
    const ffmpegPath = fs.existsSync(FFMPEG_BIN_DIR) ? FFMPEG_BIN_DIR : '';
    const updatedPath = ffmpegPath ? `${ffmpegPath};${currentPath}` : currentPath;
    
    const yt = spawn(YTDLP_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: updatedPath
      }
    });
    
    let stdoutData = '';
    let stderrData = '';
    let downloadComplete = false;

    // Longer timeout for video downloads (20 minutes)
    const timeoutDuration = format === 'video' ? 20 * 60 * 1000 : 10 * 60 * 1000;
    const timeout = setTimeout(() => {
      if (!downloadComplete) {
        yt.kill('SIGTERM');
        resolve({ success: false, error: 'Download timeout' });
      }
    }, timeoutDuration);

    yt.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    yt.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    yt.on('error', (err) => {
      clearTimeout(timeout);
      downloadComplete = true;
      resolve({ success: false, error: `Failed to start yt-dlp: ${err.message}` });
    });

    yt.on('close', (code, signal) => {
      if (downloadComplete) return;
      downloadComplete = true;
      clearTimeout(timeout);

      if (code !== 0) {
        // Check for FFmpeg error
        if (stderrData.includes('ffprobe and ffmpeg not found') || stderrData.includes('ffmpeg not found')) {
          if (format === 'audio') {
            const webmFile = `${fileName}.webm`;
            const webmPath = path.join(DOWNLOAD_ROOT, webmFile);
            if (fs.existsSync(webmPath)) {
              resolve({ success: true, fileName: webmFile, downloadUrl: `/downloads/${webmFile}` });
              return;
            }
          }
        }
        resolve({ success: false, error: `yt-dlp failed with code ${code}` });
        return;
      }

      // Wait for file system and check for file
      setTimeout(() => {
        const expectedExtension = format === 'audio' ? 'mp3' : 'mp4';
        const expectedFileName = `${fileName}.${expectedExtension}`;
        const filePath = path.join(DOWNLOAD_ROOT, expectedFileName);

        if (fs.existsSync(filePath)) {
          resolve({ success: true, fileName: expectedFileName, downloadUrl: `/downloads/${expectedFileName}` });
          return;
        }

        // Try to find any matching file
        const audioExtensions = ['.mp3', '.m4a', '.opus', '.webm'];
        const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov'];
        const allowedExtensions = format === 'audio' ? audioExtensions : videoExtensions;
        
        const files = fs.readdirSync(DOWNLOAD_ROOT).filter(f => {
          const matchesName = f.startsWith(fileName) || f.startsWith(safeId);
          const matchesExtension = allowedExtensions.some(ext => f.endsWith(ext));
          return matchesName && !f.endsWith('.mhtml') && matchesExtension;
        });
        
        if (files.length > 0) {
          resolve({ success: true, fileName: files[0], downloadUrl: `/downloads/${files[0]}` });
        } else {
          resolve({ success: false, error: 'Output file not found after download' });
        }
      }, 1000);
    });
  });
}

// Process batch download for playlist
async function processBatchDownload(playlistUrl: string, sessionId: string, quality: string = '192'): Promise<void> {
  try {
    // Extract all video URLs from playlist
    const videoUrls = await extractPlaylistVideos(playlistUrl);
    const total = videoUrls.length;

    if (total === 0) {
      sendWebSocketMessage(sessionId, {
        type: 'error',
        sessionId,
        error: 'No videos found in playlist'
      });
      return;
    }

    // Send start message
    sendWebSocketMessage(sessionId, {
      type: 'start',
      sessionId,
      total
    });

    let successful = 0;
    let failed = 0;

    // Process each video sequentially
    for (let i = 0; i < videoUrls.length; i++) {
      const videoUrl = videoUrls[i];
      const current = i + 1;

      // Send progress message
      sendWebSocketMessage(sessionId, {
        type: 'progress',
        sessionId,
        current,
        total,
        videoUrl,
        fileName: undefined,
        downloadUrl: undefined
      });

      // Download the video
      const result = await downloadSingleVideo(videoUrl, quality, sessionId);

      if (result.success) {
        successful++;
        sendWebSocketMessage(sessionId, {
          type: 'success',
          sessionId,
          current,
          total,
          videoUrl,
          fileName: result.fileName,
          downloadUrl: result.downloadUrl
        });
      } else {
        failed++;
        sendWebSocketMessage(sessionId, {
          type: 'error',
          sessionId,
          current,
          total,
          videoUrl,
          error: result.error || 'Download failed'
        });
      }
    }

    // Send completion message
    sendWebSocketMessage(sessionId, {
      type: 'complete',
      sessionId,
      total,
      successful,
      failed
    });
  } catch (error) {
    sendWebSocketMessage(sessionId, {
      type: 'error',
      sessionId,
      error: `Batch download failed: ${error instanceof Error ? error.message : String(error)}`
    });
  }
}

app.post('/api/download', async (req, res) => {
  console.log(`[${new Date().toISOString()}] /api/download - Body:`, req.body);
  
  const { url, quality } = req.body as { url?: string; quality?: string };

  if (!url || typeof url !== 'string') {
    console.log(`[ERROR] Missing or invalid URL in body`);
    return res.status(400).json({ error: 'Missing or invalid "url" in body' });
  }

  // Basic validation: must look like a YouTube URL
  if (!url.startsWith('http')) {
    console.log(`[ERROR] URL doesn't start with http: ${url}`);
    return res.status(400).json({ error: 'Invalid URL' });
  }
  
  console.log(`[INFO] Valid request received for URL: ${url}, Quality: ${quality || 'default (192)'}`);

  // Check if URL is a playlist
  const urlObj = new URL(url);
  const playlistId = urlObj.searchParams.get('list');
  const isPlaylistUrl = url.includes('/playlist') || (playlistId !== null && playlistId !== '');
  
  // If it's a playlist, start batch download
  if (isPlaylistUrl) {
    console.log(`[INFO] Playlist URL detected, starting batch download`);
    
    try {
      // Generate session ID for WebSocket connection
      const sessionId = generateSessionId();
      
      // Start batch download process (async, don't block response)
      processBatchDownload(url, sessionId, quality || '192').catch(error => {
        console.error(`[BATCH] Batch download error: ${error}`);
      });
      
      // Return immediately with session ID
      return res.json({
        type: 'playlist',
        sessionId,
        message: `Batch download started. Connect to ws://localhost:${PORT}/ws?sessionId=${sessionId} for progress updates`
      });
    } catch (error) {
      console.error(`[BATCH] Failed to start batch download: ${error}`);
      return res.status(500).json({ 
        error: 'Failed to start batch download', 
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Single video download - use existing logic
  const id = Date.now().toString();
  const safeId = id.replace(/[^a-zA-Z0-9-_]/g, '');

  const audioQuality = quality === '320' || quality === '192' || quality === '128' ? quality : '192';

  // Check if URL has list parameter but we want single video
  const videoId = urlObj.searchParams.get('v');
  const hasListParam = urlObj.searchParams.has('list');
  
  // If it's a playlist URL with video ID, extract just the video
  const downloadUrl = videoId && hasListParam 
    ? `https://www.youtube.com/watch?v=${videoId}`
    : url;

  if (hasListParam && videoId) {
    console.log(`[INFO] Playlist URL with video ID detected, extracting single video: ${videoId}`);
  }

  // Use the refactored download function for single videos
  console.log(`[${new Date().toISOString()}] Starting single video download: ${downloadUrl}`);
  const result = await downloadSingleVideo(downloadUrl, audioQuality);
  
  if (result.success) {
    return res.json({
      id: safeId,
      fileName: result.fileName,
      downloadUrl: result.downloadUrl
    });
  } else {
    return res.status(500).json({
      error: result.error || 'Download failed',
      details: { url: downloadUrl }
    });
  }
});

// API v1 - Versioned endpoint supporting both audio and video downloads
app.post('/api/v1/download', async (req, res) => {
  console.log(`[${new Date().toISOString()}] /api/v1/download - Body:`, req.body);
  
  const { url, quality, format = 'audio' } = req.body as { 
    url?: string; 
    quality?: string; 
    format?: 'audio' | 'video' 
  };

  if (!url || typeof url !== 'string') {
    console.log(`[ERROR] Missing or invalid URL in body`);
    return res.status(400).json({ error: 'Missing or invalid "url" in body' });
  }

  // Basic validation: must look like a YouTube URL
  if (!url.startsWith('http')) {
    console.log(`[ERROR] URL doesn't start with http: ${url}`);
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Validate format parameter
  if (format !== 'audio' && format !== 'video') {
    return res.status(400).json({ error: 'Invalid format. Must be "audio" or "video"' });
  }
  
  console.log(`[INFO] Valid v1 request received for URL: ${url}, Format: ${format}, Quality: ${quality || 'default'}`);

  // Check if URL is a playlist
  const urlObj = new URL(url);
  const playlistId = urlObj.searchParams.get('list');
  const isPlaylistUrl = url.includes('/playlist') || (playlistId !== null && playlistId !== '');
  
  // If it's a playlist, start batch download (currently only supports audio)
  if (isPlaylistUrl) {
    if (format === 'video') {
      return res.status(400).json({ 
        error: 'Video playlist downloads are not yet supported. Use format: "audio" for playlists.' 
      });
    }
    
    console.log(`[INFO] Playlist URL detected, starting batch download`);
    
    try {
      const sessionId = generateSessionId();
      processBatchDownload(url, sessionId, quality || '192').catch(error => {
        console.error(`[BATCH] Batch download error: ${error}`);
      });
      
      return res.json({
        type: 'playlist',
        sessionId,
        message: `Batch download started. Connect to ws://localhost:${PORT}/ws?sessionId=${sessionId} for progress updates`
      });
    } catch (error) {
      console.error(`[BATCH] Failed to start batch download: ${error}`);
      return res.status(500).json({ 
        error: 'Failed to start batch download', 
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Single video/audio download
  const id = Date.now().toString();
  const safeId = id.replace(/[^a-zA-Z0-9-_]/g, '');

  const audioQuality = quality === '320' || quality === '192' || quality === '128' ? quality : '192';

  // Check if URL has list parameter but we want single video
  const videoId = urlObj.searchParams.get('v');
  const hasListParam = urlObj.searchParams.has('list');
  
  const downloadUrl = videoId && hasListParam 
    ? `https://www.youtube.com/watch?v=${videoId}`
    : url;

  if (hasListParam && videoId) {
    console.log(`[INFO] Playlist URL with video ID detected, extracting single ${format}: ${videoId}`);
  }

  console.log(`[${new Date().toISOString()}] Starting ${format} download: ${downloadUrl}`);
  const result = await downloadVideoOrAudio(downloadUrl, audioQuality, format);
  
  if (result.success) {
    return res.json({
      id: safeId,
      format,
      fileName: result.fileName,
      downloadUrl: result.downloadUrl
    });
  } else {
    return res.status(500).json({
      error: result.error || 'Download failed',
      details: { url: downloadUrl, format }
    });
  }
});

// Root endpoint - API info page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>YouTube MP3 Downloader API</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
        code { background: #e0e0e0; padding: 2px 6px; border-radius: 3px; }
        .method { color: #28a745; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>🎵 YouTube MP3 Downloader API</h1>
      <p>Backend server for Chrome extension</p>
      
      <div class="endpoint">
        <span class="method">GET</span> <code>/health</code>
        <p>Health check endpoint</p>
        <a href="/health">Try it</a>
      </div>
      
      <div class="endpoint">
        <span class="method">GET</span> <code>/test</code>
        <p>Test endpoint</p>
        <a href="/test">Try it</a>
      </div>
      
      <div class="endpoint">
        <span class="method">POST</span> <code>/api/download</code>
        <p>Download YouTube video as MP3 (Legacy endpoint - audio only)</p>
        <p><strong>Body:</strong> <code>{"url": "https://www.youtube.com/watch?v=...", "quality": "192"}</code></p>
      </div>
      
      <div class="endpoint">
        <span class="method">POST</span> <code>/api/v1/download</code>
        <p>Download YouTube video as audio or video (Versioned API)</p>
        <p><strong>Body:</strong> <code>{"url": "https://www.youtube.com/watch?v=...", "format": "audio"|"video", "quality": "192"}</code></p>
        <p><strong>Format:</strong> <code>"audio"</code> for MP3, <code>"video"</code> for MP4</p>
      </div>
    </body>
    </html>
  `);
});

// Health check endpoint
app.get('/health', (req, res) => {
  console.log(`[${new Date().toISOString()}] Health check requested`);
  res.json({ status: 'ok', timestamp: new Date().toISOString(), server: 'running' });
});

// Test endpoint - simple echo
app.get('/test', (req, res) => {
   console.log(`[${new Date().toISOString()}] Test endpoint requested`);
  res.json({ message: 'Server is working!', timestamp: new Date().toISOString() });
});

// Debug endpoint - check FFmpeg and PATH
app.get('/debug/ffmpeg', (req, res) => {
  const pathEnv = process.env.PATH || '';
  const ffmpegInPath = checkFFmpegAvailability();
  
  // Try to find ffmpeg.exe in PATH
  const pathDirs = pathEnv.split(path.delimiter);
  const ffmpegPaths: string[] = [];
  pathDirs.forEach(dir => {
    const ffmpegPath = path.join(dir, 'ffmpeg.exe');
    if (fs.existsSync(ffmpegPath)) {
      ffmpegPaths.push(ffmpegPath);
    }
  });
  
  res.json({
    ffmpegAvailable: ffmpegInPath,
    pathEnv: pathEnv.split(path.delimiter),
    ffmpegFoundIn: ffmpegPaths,
    pathDelimiter: path.delimiter
  });
});

// Extract playlist video URLs using yt-dlp
async function extractPlaylistVideos(playlistUrl: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    console.log(`[PLAYLIST] Extracting videos from playlist: ${playlistUrl}`);
    
    const playlistArgs = [
      playlistUrl,
      '--flat-playlist',
      '--print', '%(id)s|%(url)s',
      '--no-warnings',
      '--ignore-config'
    ];

    const currentPath = process.env.PATH || '';
    const ffmpegPath = fs.existsSync(FFMPEG_BIN_DIR) ? FFMPEG_BIN_DIR : '';
    const updatedPath = ffmpegPath ? `${ffmpegPath};${currentPath}` : currentPath;

    const playlistProcess = spawn(YTDLP_PATH, playlistArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: updatedPath
      }
    });

    let stdoutData = '';
    let stderrData = '';

    playlistProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    playlistProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    playlistProcess.on('error', (err) => {
      console.log(`[PLAYLIST] Failed to start playlist extraction: ${err.message}`);
      reject(err);
    });

    playlistProcess.on('close', (code) => {
      if (code !== 0) {
        console.log(`[PLAYLIST] Playlist extraction failed with code ${code}`);
        console.log(`[PLAYLIST] stderr: ${stderrData.slice(-500)}`);
        reject(new Error(`Playlist extraction failed: ${stderrData.slice(-500)}`));
        return;
      }

      try {
        // Parse output: each line is "videoId|videoUrl"
        const lines = stdoutData.trim().split('\n').filter(line => line.trim());
        const videoUrls: string[] = [];
        
        for (const line of lines) {
          const parts = line.split('|');
          if (parts.length >= 2) {
            const videoUrl = parts[1].trim();
            if (videoUrl && videoUrl.startsWith('http')) {
              videoUrls.push(videoUrl);
            } else {
              // If URL is missing, construct it from video ID
              const videoId = parts[0].trim();
              if (videoId) {
                videoUrls.push(`https://www.youtube.com/watch?v=${videoId}`);
              }
            }
          } else if (parts.length === 1 && parts[0].trim()) {
            // Only video ID provided
            const videoId = parts[0].trim();
            videoUrls.push(`https://www.youtube.com/watch?v=${videoId}`);
          }
        }

        console.log(`[PLAYLIST] Extracted ${videoUrls.length} videos from playlist`);
        resolve(videoUrls);
      } catch (error) {
        console.log(`[PLAYLIST] Failed to parse playlist output: ${error}`);
        reject(error);
      }
    });

    // Set timeout for playlist extraction (60 seconds)
    setTimeout(() => {
      if (playlistProcess.killed === false) {
        playlistProcess.kill('SIGTERM');
        console.log(`[PLAYLIST] Playlist extraction timeout`);
        reject(new Error('Playlist extraction timeout'));
      }
    }, 60000);
  });
}

// Send WebSocket message to client
function sendWebSocketMessage(sessionId: string, message: ProgressMessage): void {
  const ws = wsConnections.get(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.log(`[WS] Failed to send message to session ${sessionId}: ${error}`);
    }
  }
}

// Generate unique session ID
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Check FFmpeg availability at startup
const ffmpegAvailable = checkFFmpegAvailability();

// Create HTTP server for Express and WebSocket
const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  
  if (!sessionId) {
    console.log(`[WS] Connection rejected: missing sessionId`);
    ws.close(1008, 'Missing sessionId parameter');
    return;
  }

  console.log(`[WS] Client connected with sessionId: ${sessionId}`);
  wsConnections.set(sessionId, ws);

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${sessionId}`);
    wsConnections.delete(sessionId);
  });

  ws.on('error', (error) => {
    console.log(`[WS] Error for session ${sessionId}: ${error}`);
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    sessionId,
    message: 'Connected to download progress stream'
  }));
});

server.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Backend server listening on http://localhost:${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`🧪 Test endpoint: http://localhost:${PORT}/test`);
  console.log(`📥 Download endpoints:`);
  console.log(`   - Legacy (audio): POST http://localhost:${PORT}/api/download`);
  console.log(`   - v1 (audio/video): POST http://localhost:${PORT}/api/v1/download`);
  console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`${'='.repeat(60)}\n`);
});


