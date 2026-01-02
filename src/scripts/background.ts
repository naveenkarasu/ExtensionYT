// Background service worker for the extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('Video Downloader Extension installed');
});

// Handle messages from content scripts or popup
chrome.runtime.onMessage.addListener(
  (
    request: { action: string; url?: string },
    _sender: chrome.runtime.MessageSender,
    _sendResponse: (response?: unknown) => void
  ) => {
    if (request.action === 'download') {
      // Handle download logic here
      console.log('Download requested:', request.url);
    }
    return true;
  }
);

