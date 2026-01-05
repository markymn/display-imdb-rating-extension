/**
 * Background Service Worker
 * Routes API calls through Cloudflare Worker proxy
 */

// ============================================
// PROXY CONFIGURATION
// ============================================

const WORKER_URL = 'https://imdb-ratings-proxy.markymn-dev.workers.dev';

// Debug mode
const DEBUG = false;

/**
 * Debug logging helper
 */
const log = (...args) => {
    if (DEBUG) {
        console.log('[Background]', ...args);
    }
};

// ============================================
// MESSAGE HANDLING
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('Received message:', message.type);

    switch (message.type) {
        case 'BATCH_LOOKUP':
            handleBatchLookup(message, sendResponse);
            return true; // Keep channel open for async response

        default:
            sendResponse({ error: 'Unknown message type' });
            return false;
    }
});

/**
 * Handle batch lookup via Cloudflare Worker
 */
async function handleBatchLookup(message, sendResponse) {
    try {
        const { movies } = message;

        if (!movies || !Array.isArray(movies)) {
            throw new Error('Invalid movies payload');
        }

        log(`Sending batch of ${movies.length} movies to Worker...`);

        const response = await fetch(`${WORKER_URL}/batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ movies })
        });

        if (!response.ok) {
            throw new Error(`Worker Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        // Worker returns { results: [...] }
        sendResponse({ success: true, results: data.results });

    } catch (error) {
        console.error('[Background] Batch lookup error:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// ============================================
// INITIALIZATION
// ============================================

log('Service worker initialized');
log('Worker URL:', WORKER_URL);
