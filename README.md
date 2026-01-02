# YouTube Downloader Extension

A Chrome extension with a Node.js backend server for downloading YouTube videos and audio. Supports both single video downloads and batch playlist downloads with real-time progress updates via WebSocket.

## ⚠️ Important Disclaimer

**This project is for educational and learning purposes only.**

Downloading content from YouTube may violate YouTube's Terms of Service and copyright laws. This software is provided as-is for educational purposes to demonstrate:

- API integration with YouTube downloaders
- WebSocket real-time communication
- Node.js/Express server development
- Chrome extension development
- TypeScript development practices

**By using this software, you acknowledge that:**

- You are responsible for ensuring you have the legal right to download any content
- You will comply with YouTube's Terms of Service
- You will respect copyright laws and intellectual property rights
- The authors and contributors are not responsible for any misuse of this software

**Use at your own risk. The developers do not condone or encourage copyright infringement.**

## Features

- 🎵 Download YouTube videos as MP3 audio files
- 🎬 Download YouTube videos as MP4 video files
- 📋 Batch download entire playlists
- 📊 Real-time download progress via WebSocket
- 🎨 Automatic metadata extraction and embedding
- 🔄 API versioning support

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v18 or higher) - [Download](https://nodejs.org/)
- **npm** (comes with Node.js)
- **Git** - [Download](https://git-scm.com/)
- **FFmpeg** (optional but recommended for audio conversion) - [Download](https://ffmpeg.org/download.html)

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/naveenkarasu/ExtensionYT.git
cd ExtensionYT
```

### 2. Install Dependencies

Install dependencies for both the extension and server:

```bash
# Install extension dependencies
npm install

# Install server dependencies
cd server
npm install
cd ..
```

### 3. Setup yt-dlp

The server requires `yt-dlp.exe` to be placed in the `server/bin/` directory.

**Option A: Download manually**

1. Download `yt-dlp.exe` from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases)
2. Place it in `server/bin/yt-dlp.exe`

**Option B: Using PowerShell (Windows)**

```powershell
# Create bin directory if it doesn't exist
New-Item -ItemType Directory -Force -Path server\bin

# Download yt-dlp.exe
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile "server\bin\yt-dlp.exe"
```

### 4. Setup FFmpeg (Optional but Recommended)

FFmpeg is required for audio conversion to MP3 format. Without it, downloads will be in `.webm` format.

**Option A: Download and Extract**

1. Download FFmpeg from [FFmpeg downloads](https://ffmpeg.org/download.html)
2. Extract to `server/bin/ffmpeg/` (the `bin` folder inside should contain `ffmpeg.exe` and `ffprobe.exe`)
3. Final structure should be: `server/bin/ffmpeg/bin/ffmpeg.exe`

**Option B: Add to System PATH**
Alternatively, you can install FFmpeg system-wide and add it to your PATH environment variable.

## Running the Server

### Development Mode

```bash
cd server
npm run dev
```

The server will start on `http://localhost:4000` (or the port specified in the `PORT` environment variable).

### Production Mode

```bash
# Build the TypeScript code
cd server
npm run build

# Start the server
npm start
```

### Verify Server is Running

Visit `http://localhost:4000` in your browser to see the API documentation page.

## Building the Chrome Extension

### Development Build

```bash
npm run dev
```

This will start Vite in development mode and watch for changes.

### Production Build

```bash
npm run build
```

This will compile TypeScript and build the extension. The output will be in the `dist/` directory.

### Loading the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in the top right)
3. Click "Load unpacked"
4. Select the `dist` folder from this project

## API Documentation

### Base URL

```
http://localhost:4000
```

### Endpoints

#### Legacy Endpoint (Audio Only)

**POST** `/api/download`

Download YouTube video as MP3 audio.

**Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "quality": "192"
}
```

**Quality Options:** `"128"`, `"192"`, `"320"` (default: `"192"`)

**Response:**

```json
{
  "id": "session_id",
  "fileName": "Video Title.mp3",
  "downloadUrl": "/downloads/Video Title.mp3"
}
```

#### Versioned Endpoint (Audio & Video)

**POST** `/api/v1/download`

Download YouTube video as audio (MP3) or video (MP4).

**Request Body:**

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "format": "audio",
  "quality": "192"
}
```

**Parameters:**

- `url` (required): YouTube video URL
- `format` (required): `"audio"` for MP3 or `"video"` for MP4
- `quality` (optional): `"128"`, `"192"`, or `"320"` (for audio only, default: `"192"`)

**Response:**

```json
{
  "id": "session_id",
  "format": "audio",
  "fileName": "Video Title.mp3",
  "downloadUrl": "/downloads/Video Title.mp3"
}
```

#### Playlist Downloads

Both endpoints support playlist URLs. When a playlist is detected:

- A `sessionId` is returned
- Downloads are processed sequentially
- Progress updates are sent via WebSocket

**Response (Playlist):**

```json
{
  "type": "playlist",
  "sessionId": "unique_session_id",
  "message": "Batch download started. Connect to ws://localhost:4000/ws?sessionId=unique_session_id for progress updates"
}
```

#### WebSocket Progress Updates

Connect to `ws://localhost:4000/ws?sessionId=YOUR_SESSION_ID` to receive real-time progress updates:

```json
{
  "type": "progress",
  "videoIndex": 1,
  "totalVideos": 10,
  "videoTitle": "Video Title",
  "progress": 45.5,
  "status": "downloading"
}
```

**Message Types:**

- `connected`: WebSocket connection established
- `start`: Download started for a video
- `progress`: Download progress update
- `success`: Video downloaded successfully
- `error`: Download failed
- `complete`: All videos in playlist downloaded

### Health Check

**GET** `/health`

Returns server status.

## Usage Examples

### Download Audio (cURL)

```bash
curl -X POST http://localhost:4000/api/v1/download \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"https://www.youtube.com/watch?v=VIDEO_ID\", \"format\": \"audio\", \"quality\": \"192\"}"
```

### Download Video (cURL)

```bash
curl -X POST http://localhost:4000/api/v1/download \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"https://www.youtube.com/watch?v=VIDEO_ID\", \"format\": \"video\"}"
```

### Download Playlist (cURL)

```bash
curl -X POST http://localhost:4000/api/v1/download \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"https://www.youtube.com/playlist?list=PLAYLIST_ID\", \"format\": \"audio\", \"quality\": \"192\"}"
```

### Using PowerShell

```powershell
$body = @{
    url = "https://www.youtube.com/watch?v=VIDEO_ID"
    format = "audio"
    quality = "192"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:4000/api/v1/download" -Method Post -Body $body -ContentType "application/json"
```

## Project Structure

```
ExtensionYT/
├── server/                 # Backend server
│   ├── src/
│   │   └── index.ts       # Main server file
│   ├── bin/               # Binary files (yt-dlp.exe, ffmpeg)
│   ├── downloads/         # Downloaded files (gitignored)
│   └── package.json
├── src/                   # Chrome extension source
│   ├── scripts/           # Background and content scripts
│   ├── components/        # React components
│   └── pages/             # Extension pages
├── public/                # Extension assets
└── package.json           # Extension package.json
```

## Troubleshooting

### Server won't start

- Ensure Node.js is installed: `node --version`
- Check if port 4000 is already in use
- Verify all dependencies are installed: `cd server && npm install`

### Downloads fail with FFmpeg error

- Ensure FFmpeg is installed in `server/bin/ffmpeg/bin/`
- Or add FFmpeg to your system PATH
- Downloads will still work but will be in `.webm` format without FFmpeg

### yt-dlp not found

- Verify `yt-dlp.exe` exists in `server/bin/yt-dlp.exe`
- Download the latest version from GitHub releases

### Extension not loading

- Ensure you've built the extension: `npm run build`
- Load the `dist` folder, not the `src` folder
- Check Chrome's extension error page for details

## Environment Variables

- `PORT`: Server port (default: `4000`)

Example:

```bash
PORT=3000 npm run dev
```

## License

ISC

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Issues

If you encounter any issues, please report them on the [GitHub Issues page](https://github.com/naveenkarasu/ExtensionYT/issues).
