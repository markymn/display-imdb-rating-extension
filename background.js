/**
 * Background Service Worker
 * Routes API calls through Cloudflare Worker proxy
 */

// ============================================
// PROXY CONFIGURATION
// ============================================

const WORKER_URL = 'https://imdb-ratings-proxy.markymn-dev.workers.dev';

// Debug mode - disable for production
const DEBUG = false;

/**
 * Debug logging helper
 */
const log = (...args) => {
    if (DEBUG) {
        console.log('[Background]', ...args);
    }
};

const logError = (...args) => {
    console.error('[Background ERROR]', ...args);
};

// ============================================
// MESSAGE HANDLING
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('Received message:', message.type);

    switch (message.type) {
        case 'BATCH_LOOKUP':
            handleBatchLookup(message, sendResponse);
            return true;

        default:
            sendResponse({ error: 'Unknown message type' });
            return false;
    }
});

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
            let errorDetail = '';
            try {
                errorDetail = await response.text();
            } catch (e) {
                errorDetail = response.statusText;
            }
            throw new Error(`Worker Error ${response.status}: ${errorDetail || response.statusText}`);
        }

        const data = await response.json();

        if (!data || !data.results) {
            logError('Worker returned invalid JSON/missing results:', data);
            throw new Error('Worker returned invalid response data');
        }

        log(`Worker returned ${data.results.length} results.`);
        sendResponse({ success: true, results: data.results });

    } catch (error) {
        logError('Batch lookup failed:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// ============================================
// INITIALIZATION
// ============================================

log('Service worker initialized');
log('Worker URL:', WORKER_URL);
