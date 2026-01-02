// Content script that runs on YouTube, Dailymotion, Udemy, HiAnime, etc.
console.log('Video Downloader content script loaded');

// Example: Listen for page changes and detect video elements
const detectVideos = () => {
  // Add your video detection logic here
  console.log('Detecting videos on page...');
};

// Run on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', detectVideos);
} else {
  detectVideos();
}

