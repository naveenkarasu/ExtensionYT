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

// Playlist video interface
interface PlaylistVideo {
  id: string;
  title: string;
  url: string;
  duration?: number;
  thumbnail?: string;
  uploader?: string;
  channel?: string;
}

// Formatted playlist video interface
interface FormattedPlaylistVideo {
  index: number;
  id: string;
  title: string;
  url: string;
  duration?: string; // Formatted as "MM:SS" or "HH:MM:SS"
  durationSeconds?: number;
  thumbnail?: string;
  uploader?: string;
  channel?: string;
}

// Helper function to format duration (seconds) to readable format
function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return 'Unknown';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}

// Helper function to format file size
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Estimate total size based on duration and average bitrates
function estimateTotalSize(totalDurationSeconds: number, format: 'audio' | 'video' = 'audio'): number {
  // Average bitrates (conservative estimates)
  const audioBitrateKbps = 192; // kbps for MP3
  const videoBitrateMbps = 5; // Mbps for MP4 (video + audio combined)
  
  if (format === 'audio') {
    // Size in bytes = (bitrate in kbps * duration in seconds * 1000) / 8
    return (audioBitrateKbps * totalDurationSeconds * 1000) / 8;
  } else {
    // Size in bytes = (bitrate in Mbps * duration in seconds * 1000000) / 8
    return (videoBitrateMbps * totalDurationSeconds * 1000000) / 8;
  }
}

// WebSocket progress message interface
interface ProgressMessage {
  type: 'start' | 'progress' | 'success' | 'error' | 'complete';
  sessionId: string;
  current?: number;
  total?: number;
  videoUrl?: string;
  videoTitle?: string;
  videoDuration?: string;
  fileName?: string;
  downloadUrl?: string;
  error?: string;
  playlistInfo?: {
    totalSongs: number;
    totalDuration: string;
  };
  successful?: number;
  failed?: number;
}

// Store WebSocket connections by session ID
const wsConnections = new Map<string, WebSocket>();

// Session tracking for cancellation
interface SessionData {
  cancelled: boolean;
  processes: Set<any>; // Child processes (yt-dlp spawns)
  files: Set<string>; // Downloaded file names
  startTime: number; // Session start timestamp
  expectedFilePatterns: Set<string>; // Expected filename patterns for in-progress downloads
}

const sessionData = new Map<string, SessionData>();

// Initialize or get session data
function getSessionData(sessionId: string): SessionData {
  if (!sessionData.has(sessionId)) {
    sessionData.set(sessionId, {
      cancelled: false,
      processes: new Set(),
      files: new Set(),
      startTime: Date.now(),
      expectedFilePatterns: new Set()
    });
  }
  return sessionData.get(sessionId)!;
}

// Cancel a download session
function cancelSession(sessionId: string): void {
  const data = getSessionData(sessionId);
  data.cancelled = true;
  
  console.log(`[CANCEL] Cancelling session ${sessionId}`);
  console.log(`[CANCEL] Killing ${data.processes.size} active process(es)`);
  console.log(`[CANCEL] Deleting ${data.files.size} file(s)`);
  
  // Kill all active processes
  data.processes.forEach((process) => {
    try {
      if (process && !process.killed) {
        process.kill('SIGTERM');
        console.log(`[CANCEL] Killed process ${process.pid}`);
      }
    } catch (error) {
      console.error(`[CANCEL] Error killing process: ${error}`);
    }
  });
  
  // Delete all downloaded files (registered files)
  let deletedCount = 0;
  data.files.forEach((fileName) => {
    try {
      const filePath = path.join(DOWNLOAD_ROOT, fileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedCount++;
        console.log(`[CANCEL] Deleted file: ${fileName}`);
      }
    } catch (error) {
      console.error(`[CANCEL] Error deleting file ${fileName}: ${error}`);
    }
  });
  
  // Also find and delete any in-progress files that match expected patterns
  // This handles files that were created but not yet registered
  try {
    const allFiles = fs.readdirSync(DOWNLOAD_ROOT);
    const sessionStartTime = data.startTime;
    const now = Date.now();
    const maxFileAge = 5 * 60 * 1000; // 5 minutes - files created during this session
    
    allFiles.forEach((fileName) => {
      // Skip if already deleted
      if (data.files.has(fileName)) {
        return;
      }
      
      // Check if file matches any expected pattern
      let matchesPattern = false;
      const fileNameWithoutExt = fileName.replace(/\.[^.]+$/, ''); // Remove extension
      data.expectedFilePatterns.forEach((pattern) => {
        // Check if filename starts with pattern or pattern is contained in filename
        if (fileNameWithoutExt.startsWith(pattern) || 
            fileNameWithoutExt.includes(pattern) || 
            pattern.includes(fileNameWithoutExt.substring(0, Math.min(30, fileNameWithoutExt.length)))) {
          matchesPattern = true;
        }
      });
      
      // Also check files created/modified during the session timeframe
      try {
        const filePath = path.join(DOWNLOAD_ROOT, fileName);
        const stats = fs.statSync(filePath);
        const fileAge = now - stats.mtime.getTime();
        const wasCreatedDuringSession = fileAge < maxFileAge && stats.mtime.getTime() >= sessionStartTime;
        
        // Delete if it matches pattern OR was created during session
        if (matchesPattern || wasCreatedDuringSession) {
          // Only delete media files (not system files)
          const mediaExtensions = ['.mp3', '.mp4', '.webm', '.m4a', '.opus', '.mkv', '.avi', '.mov'];
          const isMediaFile = mediaExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
          
          if (isMediaFile) {
            fs.unlinkSync(filePath);
            deletedCount++;
            console.log(`[CANCEL] Deleted in-progress file: ${fileName}`);
          }
        }
      } catch (error) {
        // Ignore errors for individual files
      }
    });
  } catch (error) {
    console.error(`[CANCEL] Error scanning for in-progress files: ${error}`);
  }
  
  // Send cancellation message via WebSocket
  sendWebSocketMessage(sessionId, {
    type: 'error',
    sessionId,
    error: 'Download cancelled by user'
  });
  
  // Clean up session data after a delay
  setTimeout(() => {
    sessionData.delete(sessionId);
  }, 5000);
  
  console.log(`[CANCEL] Session ${sessionId} cancelled. Deleted ${deletedCount} file(s)`);
}

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
async function extractMetadata(url: string, sessionId?: string): Promise<VideoMetadata | null> {
  return new Promise((resolve) => {
    // Check if cancelled before starting metadata extraction
    if (sessionId) {
      const data = getSessionData(sessionId);
      if (data.cancelled) {
        console.log(`[METADATA] Metadata extraction cancelled for: ${url}`);
        resolve(null);
        return;
      }
    }
    
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
    
    // Register metadata process with session if sessionId provided
    if (sessionId) {
      const data = getSessionData(sessionId);
      data.processes.add(metadataProcess);
      
      // Check again if cancelled after registering
      if (data.cancelled) {
        metadataProcess.kill('SIGTERM');
        resolve(null);
        return;
      }
    }

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
      // Unregister process from session
      if (sessionId) {
        const data = getSessionData(sessionId);
        data.processes.delete(metadataProcess);
        
        // Check if cancelled during metadata extraction
        if (data.cancelled) {
          console.log(`[METADATA] Metadata extraction cancelled for: ${url}`);
          resolve(null);
          return;
        }
      }
      
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

    // Set timeout for metadata extraction (45 seconds - increased for slower connections)
    // Note: This timeout is non-critical - download will proceed even if metadata extraction fails
    const metadataTimeout = setTimeout(() => {
      if (metadataProcess.killed === false) {
        metadataProcess.kill('SIGTERM');
        console.log(`[METADATA] Metadata extraction timeout (non-critical - download will continue)`);
        resolve(null);
      }
    }, 45000);
    
    // Check for cancellation periodically during metadata extraction
    const cancellationCheck = setInterval(() => {
      if (sessionId) {
        const data = getSessionData(sessionId);
        if (data.cancelled) {
          clearInterval(cancellationCheck);
          clearTimeout(metadataTimeout);
          if (metadataProcess.killed === false) {
            metadataProcess.kill('SIGTERM');
          }
          resolve(null);
        }
      }
    }, 1000); // Check every second
    
    // Clean up interval when process closes
    metadataProcess.on('close', () => {
      clearInterval(cancellationCheck);
      clearTimeout(metadataTimeout);
    });
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

// Cleanup function to delete old files from downloads folder
// This prevents the server from storing duplicate copies indefinitely
function cleanupOldFiles(maxAgeMinutes: number = 60): void {
  try {
    const files = fs.readdirSync(DOWNLOAD_ROOT);
    const now = Date.now();
    let deletedCount = 0;
    let totalFreed = 0;

    files.forEach((file) => {
      const filePath = path.join(DOWNLOAD_ROOT, file);
      try {
        const stats = fs.statSync(filePath);
        const ageMinutes = (now - stats.mtime.getTime()) / (1000 * 60);
        
        if (ageMinutes > maxAgeMinutes) {
          const fileSize = stats.size;
          fs.unlinkSync(filePath);
          deletedCount++;
          totalFreed += fileSize;
          console.log(`[CLEANUP] Deleted old file: ${file} (${formatFileSize(fileSize)}, ${Math.round(ageMinutes)} minutes old)`);
        }
      } catch (err) {
        // Ignore errors for individual files (might be deleted by another process)
        console.log(`[CLEANUP] Could not process file ${file}: ${err}`);
      }
    });

    if (deletedCount > 0) {
      console.log(`[CLEANUP] Cleaned up ${deletedCount} file(s), freed ${formatFileSize(totalFreed)}`);
    }
  } catch (error) {
    console.error(`[CLEANUP] Error during cleanup: ${error}`);
  }
}

// Run cleanup every 5 minutes to remove files older than 10 minutes
// This gives Chrome plenty of time to download but prevents indefinite storage
// Files are deleted based on their modification time (when they were created/downloaded)
setInterval(() => {
  cleanupOldFiles(10); // Delete files older than 10 minutes
}, 5 * 60 * 1000); // Run every 5 minutes

// Run initial cleanup on server start
cleanupOldFiles(10);

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

// Industry-standard download endpoint using query parameter
// This approach is used by AWS S3, Google Cloud Storage, and most file hosting services
// Format: /download?file=encoded_filename
app.get('/download', (req, res) => {
  try {
    const filename = req.query.file as string;
    
    if (!filename) {
      return res.status(400).json({ error: 'Missing file parameter' });
    }
    
    // Decode the filename
    const decodedFilename = decodeURIComponent(filename);
    const filePath = path.join(DOWNLOAD_ROOT, decodedFilename);
    
    // Security check: prevent directory traversal attacks
    const resolvedPath = path.resolve(filePath);
    const resolvedRoot = path.resolve(DOWNLOAD_ROOT);
    
    if (!resolvedPath.startsWith(resolvedRoot)) {
      console.error(`[DOWNLOAD] Security violation: ${resolvedPath} is outside ${resolvedRoot}`);
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.log(`[DOWNLOAD] File not found: ${filePath}`);
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Get file stats
    const stats = fs.statSync(filePath);
    const fileExtension = path.extname(decodedFilename).toLowerCase();
    
    // Set appropriate Content-Type
    const contentTypeMap: { [key: string]: string } = {
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.m4a': 'audio/mp4',
      '.opus': 'audio/opus'
    };
    
    const contentType = contentTypeMap[fileExtension] || 'application/octet-stream';
    
    // Set proper headers for download
    // Use RFC 5987 format for filename with special characters
    const basename = path.basename(decodedFilename);
    // For Content-Disposition, use both simple and extended format for maximum compatibility
    // Simple format for basic filenames, extended format (RFC 5987) for special characters
    const simpleFilename = basename.replace(/[^\x20-\x7E]/g, '_'); // ASCII only for simple format
    const extendedFilename = encodeURIComponent(basename);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${simpleFilename}"; filename*=UTF-8''${extendedFilename}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type, Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Accept-Ranges', 'bytes');
    
    // Support HTTP range requests for resumable downloads (Chrome uses this)
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunkSize = (end - start) + 1;
      
      res.status(206); // Partial Content
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
      res.setHeader('Content-Length', chunkSize);
      
      const fileStream = fs.createReadStream(filePath, { start, end });
      fileStream.pipe(res);
    } else {
      // Send the entire file
      res.sendFile(filePath);
    }
  } catch (error) {
    console.error(`[DOWNLOAD] Error serving file: ${error}`);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

// Serve files statically as fallback (for direct access via /downloads/filename)
app.use('/downloads', express.static(DOWNLOAD_ROOT, {
  setHeaders: (res, filePath) => {
    const basename = path.basename(filePath);
    const simpleFilename = basename.replace(/[^\x20-\x7E]/g, '_');
    const extendedFilename = encodeURIComponent(basename);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Disposition', `attachment; filename="${simpleFilename}"; filename*=UTF-8''${extendedFilename}`);
    res.setHeader('Accept-Ranges', 'bytes');
  }
}));

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

    // Check if cancelled before metadata extraction
    if (sessionId) {
      const data = getSessionData(sessionId);
      if (data.cancelled) {
        resolve({ success: false, error: 'Download cancelled' });
        return;
      }
    }
    
    // Extract metadata before starting download
    let metadata: VideoMetadata | null = null;
    try {
      metadata = await extractMetadata(videoUrl, sessionId);
      
      // Check again if cancelled after metadata extraction
      if (sessionId) {
        const data = getSessionData(sessionId);
        if (data.cancelled) {
          resolve({ success: false, error: 'Download cancelled' });
          return;
        }
      }
      
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
    
    // Register expected filename pattern with session for cleanup
    if (sessionId) {
      const data = getSessionData(sessionId);
      // Store a pattern that can match the file (first 30 chars of filename)
      // This helps find in-progress files even if they're not fully registered
      const pattern = fileName.substring(0, Math.min(30, fileName.length));
      data.expectedFilePatterns.add(pattern);
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
    
    // Register process with session if sessionId provided
    if (sessionId) {
      const data = getSessionData(sessionId);
      data.processes.add(yt);
      
      // Check if session is already cancelled
      if (data.cancelled) {
        yt.kill('SIGTERM');
        resolve({ success: false, error: 'Download cancelled' });
        return;
      }
    }
    
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
      
      // Unregister process from session
      if (sessionId) {
        const data = getSessionData(sessionId);
        data.processes.delete(yt);
        
        // Check if cancelled during download
        if (data.cancelled) {
          resolve({ success: false, error: 'Download cancelled' });
          return;
        }
      }

      if (code !== 0) {
        // Check for FFmpeg error
        if (stderrData.includes('ffprobe and ffmpeg not found') || stderrData.includes('ffmpeg not found')) {
          if (format === 'audio') {
            const webmFile = `${fileName}.webm`;
            const webmPath = path.join(DOWNLOAD_ROOT, webmFile);
            if (fs.existsSync(webmPath)) {
              const encodedWebmFile = encodeURIComponent(webmFile);
              resolve({ success: true, fileName: webmFile, downloadUrl: `/download?file=${encodedWebmFile}` });
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
          // Register file with session
          if (sessionId) {
            const data = getSessionData(sessionId);
            // Check if cancelled before registering file
            if (data.cancelled) {
              fs.unlinkSync(filePath);
              resolve({ success: false, error: 'Download cancelled' });
              return;
            }
            data.files.add(expectedFileName);
          }
          
          // Use query parameter approach (industry standard)
          const encodedFileName = encodeURIComponent(expectedFileName);
          resolve({ success: true, fileName: expectedFileName, downloadUrl: `/download?file=${encodedFileName}` });
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
          const foundFile = files[0];
          
          // Register file with session
          if (sessionId) {
            const data = getSessionData(sessionId);
            // Check if cancelled before registering file
            if (data.cancelled) {
              const filePath = path.join(DOWNLOAD_ROOT, foundFile);
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
              resolve({ success: false, error: 'Download cancelled' });
              return;
            }
            data.files.add(foundFile);
          }
          
          // Use query parameter approach (industry standard)
          const encodedFileName = encodeURIComponent(foundFile);
          resolve({ success: true, fileName: foundFile, downloadUrl: `/download?file=${encodedFileName}` });
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
    // Initialize session data
    getSessionData(sessionId);
    
    // Extract all videos with metadata from playlist
    const videos = await extractPlaylistDetails(playlistUrl);
    const total = videos.length;

    if (total === 0) {
      sendWebSocketMessage(sessionId, {
        type: 'error',
        sessionId,
        error: 'No videos found in playlist'
      });
      return;
    }
    
    // Check if cancelled before starting
    const data = getSessionData(sessionId);
    if (data.cancelled) {
      sendWebSocketMessage(sessionId, {
        type: 'error',
        sessionId,
        error: 'Download cancelled'
      });
      return;
    }

    // Calculate total duration for playlist info
    const totalDuration = videos.reduce((sum, video) => sum + (video.duration || 0), 0);

    // Send start message with playlist info
    sendWebSocketMessage(sessionId, {
      type: 'start',
      sessionId,
      total,
      playlistInfo: {
        totalSongs: total,
        totalDuration: formatDuration(totalDuration)
      }
    });

    let successful = 0;
    let failed = 0;

    // Process each video sequentially
    for (let i = 0; i < videos.length; i++) {
      // Check if cancelled before each download
      const data = getSessionData(sessionId);
      if (data.cancelled) {
        console.log(`[BATCH] Download cancelled at video ${i + 1}/${total}`);
        sendWebSocketMessage(sessionId, {
          type: 'error',
          sessionId,
          error: 'Download cancelled by user'
        });
        return;
      }
      
      const video = videos[i];
      const current = i + 1;

      // Send progress message with song title and duration
      sendWebSocketMessage(sessionId, {
        type: 'progress',
        sessionId,
        current,
        total,
        videoUrl: video.url,
        videoTitle: video.title,
        videoDuration: formatDuration(video.duration),
        fileName: undefined,
        downloadUrl: undefined
      });

      // Download the video
      const result = await downloadSingleVideo(video.url, quality, sessionId);
      
      // Check if cancelled after download
      if (data.cancelled) {
        console.log(`[BATCH] Download cancelled after video ${current}/${total}`);
        return;
      }

      if (result.success) {
        successful++;
        sendWebSocketMessage(sessionId, {
          type: 'success',
          sessionId,
          current,
          total,
          videoUrl: video.url,
          videoTitle: video.title,
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
          videoUrl: video.url,
          videoTitle: video.title,
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
  // Treat as playlist if URL explicitly contains '/playlist' OR has 'list' parameter
  // If 'list' parameter exists, always download the entire playlist (even if 'v' parameter is also present)
  const urlObj = new URL(url);
  const playlistId = urlObj.searchParams.get('list');
  
  // Treat as playlist if:
  // 1. URL contains '/playlist' explicitly, OR
  // 2. URL has 'list' parameter (regardless of whether 'v' parameter exists)
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

  // For single video downloads, use the original URL
  const downloadUrl = url;

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

// Cancel download endpoint
app.post('/api/v1/cancel', (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid sessionId' });
  }
  
  console.log(`[CANCEL] Cancel request received for session: ${sessionId}`);
  cancelSession(sessionId);
  
  return res.json({
    success: true,
    message: 'Download cancelled',
    sessionId
  });
});

// API v1 - Get playlist details (list all videos in playlist)
app.get('/api/v1/playlist', async (req, res) => {
  console.log(`[${new Date().toISOString()}] /api/v1/playlist - Query:`, req.query);
  console.log(`[${new Date().toISOString()}] /api/v1/playlist - Raw query string:`, req.url);
  
  let url = req.query.url as string | undefined;

  // Handle URL encoding issues - if URL contains & characters, they get split into separate query params
  // Check if we have additional YouTube-specific params that should be part of the URL
  const queryParams = req.query;
  const youtubeParams = ['v', 'list', 'start_radio', 'index', 't'];
  const additionalParams: string[] = [];
  
  // Collect any YouTube params that are separate query params (indicating URL was split)
  for (const [key, value] of Object.entries(queryParams)) {
    if (youtubeParams.includes(key) && key !== 'url') {
      additionalParams.push(`${key}=${encodeURIComponent(value as string)}`);
    }
  }
  
  // If we have additional params and the URL doesn't already contain them, reconstruct
  if (url && additionalParams.length > 0) {
    // Check if URL already has these params
    const urlObj = new URL(url);
    const hasAllParams = additionalParams.every(param => {
      const [key] = param.split('=');
      return urlObj.searchParams.has(key);
    });
    
    if (!hasAllParams) {
      // Reconstruct URL with missing params
      const separator = url.includes('?') ? '&' : '?';
      url = url + separator + additionalParams.join('&');
      console.log(`[INFO] Reconstructed URL with missing params: ${url}`);
    }
  } else if (!url && queryParams.url) {
    // URL might be completely missing, try to reconstruct from all params
    url = queryParams.url as string;
    if (additionalParams.length > 0) {
      const separator = url.includes('?') ? '&' : '?';
      url = url + separator + additionalParams.join('&');
      console.log(`[INFO] Reconstructed URL from query params: ${url}`);
    }
  }

  if (!url || typeof url !== 'string') {
    console.log(`[ERROR] Missing or invalid URL in query`);
    return res.status(400).json({ error: 'Missing or invalid "url" query parameter' });
  }

  // Basic validation: must look like a YouTube URL
  if (!url.startsWith('http')) {
    console.log(`[ERROR] URL doesn't start with http: ${url}`);
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Check if URL is a playlist
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch (error) {
    console.log(`[ERROR] Failed to parse URL: ${url}`, error);
    return res.status(400).json({ error: 'Invalid URL format' });
  }
  
  const playlistId = urlObj.searchParams.get('list');
  const isPlaylistUrl = url.includes('/playlist') || (playlistId !== null && playlistId !== '');
  
  console.log(`[DEBUG] URL: ${url}`);
  console.log(`[DEBUG] Playlist ID from URL: ${playlistId}`);
  console.log(`[DEBUG] Is playlist URL: ${isPlaylistUrl}`);
  
  if (!isPlaylistUrl) {
    return res.status(400).json({ 
      error: 'URL is not a playlist. Please provide a YouTube playlist URL.',
      receivedUrl: url,
      playlistId: playlistId
    });
  }

  console.log(`[INFO] Extracting playlist details for: ${url}`);

  try {
    const videos = await extractPlaylistDetails(url);
    
    return res.json({
      success: true,
      playlistUrl: url,
      totalVideos: videos.length,
      videos: videos
    });
  } catch (error) {
    console.error(`[ERROR] Failed to extract playlist: ${error}`);
    return res.status(500).json({
      error: 'Failed to extract playlist',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// API v1 - Get playlist details (POST version - accepts URL in body)
app.post('/api/v1/playlist', async (req, res) => {
  console.log(`[${new Date().toISOString()}] /api/v1/playlist (POST) - Body:`, req.body);
  
  const { url } = req.body as { url?: string };

  if (!url || typeof url !== 'string') {
    console.log(`[ERROR] Missing or invalid URL in body`);
    return res.status(400).json({ error: 'Missing or invalid "url" in body' });
  }

  // Basic validation: must look like a YouTube URL
  if (!url.startsWith('http')) {
    console.log(`[ERROR] URL doesn't start with http: ${url}`);
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Check if URL is a playlist
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch (error) {
    console.log(`[ERROR] Failed to parse URL: ${url}`, error);
    return res.status(400).json({ error: 'Invalid URL format' });
  }
  
  const playlistId = urlObj.searchParams.get('list');
  const isPlaylistUrl = url.includes('/playlist') || (playlistId !== null && playlistId !== '');
  
  console.log(`[DEBUG] URL: ${url}`);
  console.log(`[DEBUG] Playlist ID from URL: ${playlistId}`);
  console.log(`[DEBUG] Is playlist URL: ${isPlaylistUrl}`);
  
  if (!isPlaylistUrl) {
    return res.status(400).json({ 
      error: 'URL is not a playlist. Please provide a YouTube playlist URL.',
      receivedUrl: url,
      playlistId: playlistId
    });
  }

  console.log(`[INFO] Extracting playlist details for: ${url}`);

  try {
    const videos = await extractPlaylistDetails(url);
    
    // Format videos with better readability
    const formattedVideos: FormattedPlaylistVideo[] = videos.map((video, index) => ({
      index: index + 1,
      id: video.id,
      title: video.title,
      url: video.url,
      duration: formatDuration(video.duration),
      durationSeconds: video.duration,
      thumbnail: video.thumbnail,
      uploader: video.uploader,
      channel: video.channel
    }));
    
    // Calculate totals
    const totalDuration = videos.reduce((sum, video) => sum + (video.duration || 0), 0);
    const totalDurationFormatted = formatDuration(totalDuration);
    
    // Estimate total sizes for audio and video
    const estimatedAudioSize = estimateTotalSize(totalDuration, 'audio');
    const estimatedVideoSize = estimateTotalSize(totalDuration, 'video');
    
    return res.json({
      success: true,
      playlist: {
        url: url,
        totalSongs: videos.length,
        totalDuration: {
          formatted: totalDurationFormatted,
          seconds: totalDuration
        },
        estimatedSize: {
          audio: {
            formatted: formatFileSize(estimatedAudioSize),
            bytes: estimatedAudioSize
          },
          video: {
            formatted: formatFileSize(estimatedVideoSize),
            bytes: estimatedVideoSize
          }
        }
      },
      songs: formattedVideos
    });
  } catch (error) {
    console.error(`[ERROR] Failed to extract playlist: ${error}`);
    return res.status(500).json({
      error: 'Failed to extract playlist',
      details: error instanceof Error ? error.message : String(error)
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
      
      <div class="endpoint">
        <span class="method">GET</span> <code>/api/v1/playlist</code>
        <p>List all videos in a YouTube playlist</p>
        <p><strong>Query:</strong> <code>?url=https://www.youtube.com/playlist?list=...</code></p>
        <p>Returns list of videos with metadata (title, duration, thumbnail, etc.)</p>
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

// Extract playlist videos with metadata
async function extractPlaylistDetails(playlistUrl: string): Promise<PlaylistVideo[]> {
  return new Promise((resolve, reject) => {
    console.log(`[PLAYLIST] Extracting playlist details: ${playlistUrl}`);
    
    const playlistArgs = [
      playlistUrl,
      '--flat-playlist',
      '--print', '%(id)s|%(title)s|%(duration)s|%(thumbnail)s|%(uploader)s|%(channel)s|%(url)s',
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
        const lines = stdoutData.trim().split('\n').filter(line => line.trim());
        const videos: PlaylistVideo[] = [];
        
        for (const line of lines) {
          const parts = line.split('|');
          if (parts.length >= 1) {
            const videoId = parts[0].trim();
            const title = (parts[1] || 'Unknown').trim();
            const duration = parts[2] ? parseFloat(parts[2].trim()) : undefined;
            const thumbnail = parts[3]?.trim() || undefined;
            const uploader = parts[4]?.trim() || undefined;
            const channel = parts[5]?.trim() || undefined;
            let url = parts[6]?.trim();
            
            // Construct URL if not provided
            if (!url || !url.startsWith('http')) {
              url = `https://www.youtube.com/watch?v=${videoId}`;
            }

            videos.push({
              id: videoId,
              title: title || 'Unknown Title',
              url,
              duration,
              thumbnail,
              uploader,
              channel
            });
          }
        }

        console.log(`[PLAYLIST] Extracted ${videos.length} videos with metadata`);
        resolve(videos);
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
    
    // If client disconnects during active download, check if we should cancel
    // (This handles the case where user closes extension or cancels)
    const data = sessionData.get(sessionId);
    if (data && (data.processes.size > 0 || data.files.size > 0)) {
      // Only auto-cancel if there are active processes or files
      // This prevents cancelling completed downloads
      console.log(`[WS] Client disconnected during active download, cancelling session ${sessionId}`);
      cancelSession(sessionId);
    }
  });
  
  // Handle cancel messages from client
  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'cancel') {
        console.log(`[WS] Cancel request received for session ${sessionId}`);
        cancelSession(sessionId);
      }
    } catch (error) {
      // Ignore parse errors
    }
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
  console.log(`📋 Playlist endpoint: GET http://localhost:${PORT}/api/v1/playlist?url=...`);
  console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`🧹 Auto-cleanup: Files older than 10 minutes are automatically deleted`);
  console.log(`   (This prevents duplicate storage - files are served to Chrome, then cleaned up)`);
  console.log(`${'='.repeat(60)}\n`);
});


