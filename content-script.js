/**
 * Content Script - IMDb Ratings on Prime Video
 * Detects movie thumbnails, extracts info, and fetches ratings via Cloudflare Worker
 */

(() => {
    'use strict';

    // ============================================
    // CONFIGURATION
    // ============================================

    const CONFIG = {
        DEBUG: true,
        DEBOUNCE_DELAY: 500,           // ms to wait before sending batch
        INTERSECTION_THRESHOLD: 0,      // Trigger as soon as it enters the margin
        ROOT_MARGIN: '300px 0px 300px 0px', // Pre-load ratings for rows near viewport
        PROCESSED_ATTR: 'data-imdb-processed',
        WORKER_URL: 'https://imdb-ratings-proxy.markymn-dev.workers.dev'
    };

    const log = (...args) => {
        if (CONFIG.DEBUG) console.log('[IMDb Prime]', ...args);
    };

    // ============================================
    // SELECTORS
    // ============================================
    const SELECTORS = {
        THUMBNAIL_CONTAINERS: [
            '[data-testid="top-hero-card"]',
            '[data-testid="single-item-carousel"]',
            '[data-testid="card"]',
            '.DVWebNode-detail-container',
            '.tst-title-card',
            '.av-hover-wrapper',
            '.pv-detail-container',
            '._2RtpkI',
            '[class*="TitleCard"]',
            '[class*="packshot"]',
            '[data-testid="super-carousel-card"]'
        ].join(', '),

        TITLE_ELEMENTS: [
            '[data-testid="card-title"]',
            '.av-het-title',
            '[class*="Title"]',
            '.tst-title-card-title',
            'img[alt]',
            '[aria-label]'
        ],

        LINK_ELEMENTS: [
            'a[href*="/detail/"]',
            'a[href*="/gp/video/detail/"]',
            'a[href*="/dp/"]'
        ],

        CAROUSEL_WRAPPERS: [
            '[data-testid="navigation-carousel-wrapper"]',
            '[data-testid="super-carousel-card"]',
            '.tst-ordered-collection'
        ].join(', ')
    };

    // ============================================
    // STATE
    // ============================================
    const state = {
        observer: null,
        intersectionObserver: null,
        processedItems: new Set(), // Track individual movie hrefs/IDs
        rowObservers: new Map(), // Map<RowElement, MutationObserver>
        sessionCache: new Map(), // Map<href, data> - Client side cache
        processingTimeout: null,
        currentThreshold: 0.0, // Current minimum rating filter threshold
    };

    // ============================================
    // EXCLUDED SELECTORS (items that should NOT be filtered)
    // ============================================
    const EXCLUDED_FROM_FILTER = '[data-testid="top-hero-card"], [data-testid="single-item-carousel"]';

    // ============================================
    // CORE LOGIC
    // ============================================

    /**
     * calculateBatchSize: Determines batch size based on items visible in a row
     */
    const calculateBatchSize = (row) => {
        // Enforce batch size 1 for specific hero types as requested
        if (row.matches('[data-testid="top-hero-card"], [data-testid="single-item-carousel"]')) {
            return 1;
        }

        const rowWidth = row.offsetWidth;
        const firstItem = row.querySelector(SELECTORS.THUMBNAIL_CONTAINERS);
        if (!firstItem) return 10; // Default fallback

        const itemWidth = firstItem.offsetWidth;
        if (itemWidth === 0) return 10;

        const visibleCount = Math.floor(rowWidth / itemWidth);
        return Math.max(visibleCount * 2, 4); // 2x visible items, minimum of 4
    };

    /**
     * processRowItems: Collects and batches new items in a row
     */
    const processRowItems = (row) => {
        const batchSize = calculateBatchSize(row);

        // Collect items to process: the row itself if it's a thumbnail, plus any matching children
        const items = [];
        if (row.matches(SELECTORS.THUMBNAIL_CONTAINERS)) {
            items.push(row);
        }

        // Use querySelectorAll to find all nested thumbnails, then filter out duplicates (only direct or relevant ones)
        // We use a Set to ensure we don't process the same element twice if row.matches(container)
        const allFound = Array.from(row.querySelectorAll(SELECTORS.THUMBNAIL_CONTAINERS));
        const uniqueItems = [row.matches(SELECTORS.THUMBNAIL_CONTAINERS) ? row : null, ...allFound]
            .filter((el, index, self) => el && self.indexOf(el) === index);

        let currentBatch = [];

        for (const item of uniqueItems) {
            if (item.hasAttribute(CONFIG.PROCESSED_ATTR)) continue;

            const info = extractInfo(item);
            if (!info || !info.href) continue;

            // Check if already processed globally
            if (state.processedItems.has(info.href)) {
                const cached = state.sessionCache.get(info.href);
                if (cached) {
                    injectBadge(item, cached.rating, cached.votes);
                    item.setAttribute(CONFIG.PROCESSED_ATTR, 'cache-hit');
                }
                continue;
            }

            currentBatch.push({ container: item, info });

            // If we hit the batch size (or if this item itself requires immediate batching)
            if (currentBatch.length >= batchSize) {
                sendBatch(currentBatch);
                currentBatch = [];
            }
        }

        if (currentBatch.length > 0) {
            sendBatch(currentBatch);
        }
    };

    /**
     * sendBatch: Sends a prepared batch of items to the worker
     */
    const sendBatch = async (batch) => {
        const payload = batch.map(item => ({
            title: item.info.title,
            href: item.info.href,
            entityType: item.info.entityType
        }));

        const containerMap = new Map();
        batch.forEach(item => {
            if (!containerMap.has(item.info.href)) {
                containerMap.set(item.info.href, []);
            }
            containerMap.get(item.info.href).push(item.container);

            // Mark as pending and add to processed set immediately to prevent double-queueing
            item.container.setAttribute(CONFIG.PROCESSED_ATTR, 'pending');
            state.processedItems.add(item.info.href);
        });

        const CHUNK_SIZE = 25;
        for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
            const chunk = payload.slice(i, i + CHUNK_SIZE);
            log(`Sending batch chunk (${chunk.length} items)...`);

            try {
                chrome.runtime.sendMessage({
                    type: 'BATCH_LOOKUP',
                    movies: chunk
                }, (response) => {
                    if (response && response.success && response.results) {
                        log(`Received ${response.results.length} results for chunk.`);
                        handleBatchResponse(response.results, containerMap);
                    } else if (response && response.error) {
                        logError('Batch chunk failed:', response.error);
                        // Optional: clear processed status to allow retry on next scroll/scan
                        chunk.forEach(item => {
                            const containers = containerMap.get(item.href);
                            containers?.forEach(c => c.removeAttribute(CONFIG.PROCESSED_ATTR));
                            state.processedItems.delete(item.href);
                        });
                    }
                });
            } catch (error) {
                if (error.message.includes('Extension context invalidated')) {
                    log('Extension context invalidated (extension updated/reloaded). Stopping further processing.');
                    // Disconnect observers to stop processing
                    if (state.observer) state.observer.disconnect();
                    if (state.intersectionObserver) state.intersectionObserver.disconnect();
                    state.rowObservers.forEach(obs => obs.disconnect());
                } else {
                    logError('Runtime message error:', error);
                }
            }
        }
    };

    const logError = (...args) => {
        console.error('[IMDb Prime ERROR]', ...args);
    };


    const handleBatchResponse = (results, containerMap) => {
        results.forEach(item => {
            const containers = containerMap.get(item.href);
            if (!containers) return;

            containers.forEach(container => {
                if (item.data) {
                    injectBadge(container, item.data.rating, item.data.votes);
                    container.setAttribute(CONFIG.PROCESSED_ATTR, 'success');
                    state.sessionCache.set(item.href, item.data);
                } else {
                    container.setAttribute(CONFIG.PROCESSED_ATTR, 'no-data');
                }
            });
        });
    };

    /**
     * Queue a single thumbnail (fallback for non-row items)
     */
    const queueThumbnail = (container) => {
        if (container.hasAttribute(CONFIG.PROCESSED_ATTR)) return;

        const info = extractInfo(container);
        if (!info || !info.href) return;

        if (state.processedItems.has(info.href)) {
            const cached = state.sessionCache.get(info.href);
            if (cached) {
                injectBadge(container, cached.rating, cached.votes);
                container.setAttribute(CONFIG.PROCESSED_ATTR, 'cache-hit');
            }
            return;
        }

        // Send a single item batch
        sendBatch([{ container, info }]);
    };

    /**
     * Extract Title and Href
     */
    const extractInfo = (container) => {
        // 1. Title
        let title = container.getAttribute('data-card-title');
        if (!title) {
            // Fallback: Check inner elements
            for (const selector of SELECTORS.TITLE_ELEMENTS) {
                const el = container.querySelector(selector);
                if (el) {
                    title = el.textContent || el.getAttribute('alt') || el.getAttribute('aria-label');
                    if (title) {
                        // If it's a placeholder title, we'd rather have no title than a bad one for hero types
                        if (title.startsWith('Title number') && container.matches('[data-testid="single-item-carousel"]')) {
                            title = null;
                        }
                        break;
                    }
                }
            }
        }
        title = cleanTitle(title);

        // 2. Href (Critical for new architecture)
        let href = null;

        // Priority for Hero/Carousel: The "More details" link in action-box is very reliable
        const actionLink = container.querySelector('[data-testid="details-cta"]');
        if (actionLink) {
            href = actionLink.getAttribute('href');
        }

        if (!href) {
            // Check container itself if it's an anchor
            if (container.tagName === 'A') {
                href = container.getAttribute('href');
            } else {
                // Look for link inside
                const link = container.querySelector('a[href*="/detail/"], a[href*="title"]'); // Broaden selector
                if (link) href = link.getAttribute('href');
            }
        }

        if (href) {
            href = cleanHref(href);
        }

        // 3. Entity Type (Movie or TV Show)
        const entityType = container.getAttribute('data-card-entity-type') || null;

        return { title, href, entityType };
    };

    const cleanTitle = (text) => {
        if (!text) return '';
        const original = text;
        const cleaned = text
            .replace(/^Watch\s+/i, '')
            .replace(/\s*\(\d{4}\)\s*$/, '') // Remove Year
            .replace(/\s*-?\s*Prime Video\s*$/i, '')
            .replace(/\s*(?:-|:)?\s*Season\s+\d+.*/i, '') // Remove Season info
            .trim();
        return cleaned;
    };

    const cleanHref = (href) => {
        if (!href) return null;

        // Common patterns for Prime Video / Amazon URLs
        // We want to extract just the relevant path segment (e.g., /detail/ID)
        const patterns = [
            /\/detail\/[A-Za-z0-9]+/,
            /\/gp\/video\/detail\/[A-Za-z0-9]+/,
            /\/dp\/[A-Za-z0-9]+/
        ];

        for (const pattern of patterns) {
            const match = href.match(pattern);
            if (match) return match[0];
        }

        // Fallback: simple cleanup if no pattern matches
        return href.split('?')[0].split('/ref=')[0];
    };

    // ============================================
    // UI INJECTION
    // ============================================

    const createBadge = (rating, votes) => {
        const badge = document.createElement('div');
        badge.className = 'imdb-rating-badge';
        // Ensure rating is always X.Y (e.g. 7 -> 7.0)
        const formattedRating = parseFloat(rating).toFixed(1);
        badge.innerHTML = `<span class="imdb-rating-star">★</span> <span class="imdb-rating-value">${formattedRating}</span>`;
        if (votes) badge.title = `${votes} votes`;
        return badge;
    };

    const injectBadge = (container, rating, votes) => {
        // Find best position (usually top-left of image)
        // Find best position
        // 1. Standard packshot
        // 2. Poster link image container (Super Carousel)
        // 3. Generic aspect ratio box (Fallback)
        // 4. Container itself
        let target;

        // Special checking for Top Hero Card or Single Item Carousel
        if (container.matches('[data-testid="top-hero-card"], [data-testid="single-item-carousel"]')) {
            target = container.querySelector('[data-testid="title-metadata-main"]');
        }

        if (!target) {
            target = container.querySelector('[data-testid="packshot"]') ||
                container.querySelector('[data-testid="poster-link"] .om7nme') ||
                container.querySelector('.om7nme') ||
                container;
        }

        // If target is the image itself (fallback), go to parent
        if (target.tagName === 'IMG') target = target.parentElement;

        // Check valid positioning
        if (window.getComputedStyle(target).position === 'static') {
            target.style.position = 'relative';
        }

        // Check if badge already exists
        if (target.querySelector('.imdb-rating-badge')) {
            log('Badge already exists, skipping.');
            return;
        }

        // Apply filter BEFORE showing badge if threshold is set
        // Skip excluded types (top hero, single carousel)
        if (state.currentThreshold > 0 && !container.matches(EXCLUDED_FROM_FILTER)) {
            const ratingNum = parseFloat(rating);
            if (ratingNum < state.currentThreshold) {
                // Hide immediately - badge still injected but parent <li> is collapsed
                hideCard(container);
            }
        }

        const badge = createBadge(rating, votes);
        if (target.getAttribute('data-testid') === 'title-metadata-main') {
            target.prepend(badge);
        } else {
            target.appendChild(badge);
        }
    };

    // ============================================
    // OBSERVERS
    // ============================================

    const setupObservers = () => {
        // 1. Intersection Observer for Rows
        state.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const row = entry.target;

                if (entry.isIntersecting) {
                    log('Row entered viewport context:', row);

                    // a. Process existing items
                    processRowItems(row);

                    // b. Setup MutationObserver for this row to catch lazy-loaded items
                    if (!state.rowObservers.has(row)) {
                        const observer = new MutationObserver((mutations) => {
                            let hasNewItems = false;
                            for (const mutation of mutations) {
                                if (mutation.addedNodes.length) {
                                    for (const node of mutation.addedNodes) {
                                        if (node.nodeType === Node.ELEMENT_NODE) {
                                            if (node.matches(SELECTORS.THUMBNAIL_CONTAINERS) ||
                                                node.querySelector(SELECTORS.THUMBNAIL_CONTAINERS)) {
                                                hasNewItems = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                                if (hasNewItems) break;
                            }
                            if (hasNewItems) {
                                log('New items detected in row via mutation:', row);
                                processRowItems(row);
                            }
                        });

                        observer.observe(row, { childList: true, subtree: true });
                        state.rowObservers.set(row, observer);
                    }
                } else {
                    // Clean up observer if it leaves the margin (optional, but good for performance)
                    const observer = state.rowObservers.get(row);
                    if (observer) {
                        observer.disconnect();
                        state.rowObservers.delete(row);
                    }
                }
            });
        }, {
            threshold: CONFIG.INTERSECTION_THRESHOLD,
            rootMargin: CONFIG.ROOT_MARGIN
        });

        // 2. Global Mutation Observer for new Rows
        state.observer = new MutationObserver((mutations) => {
            let added = false;
            mutations.forEach(m => {
                if (m.addedNodes.length) added = true;
            });
            if (added) scan();
        });

        state.observer.observe(document.body, { childList: true, subtree: true });
    };

    const scan = () => {
        // 1. Observe Row Wrappers (Priority)
        const wrappers = document.querySelectorAll(SELECTORS.CAROUSEL_WRAPPERS);
        wrappers.forEach(wrapper => {
            state.intersectionObserver.observe(wrapper);
        });

        // 2. Process Individual Containers that aren't in a recognized wrapper
        const containers = document.querySelectorAll(SELECTORS.THUMBNAIL_CONTAINERS);
        containers.forEach(container => {
            if (container.hasAttribute(CONFIG.PROCESSED_ATTR)) return;

            const parentRow = container.closest(SELECTORS.CAROUSEL_WRAPPERS);
            if (!parentRow) {
                // If it's not in a row, use standard individual intersection logic
                state.intersectionObserver.observe(container);
            }
        });
    };

    // ============================================
    // RATING FILTER (Prime-Safe Hybrid Hide)
    // ============================================

    const FILTER_ATTR = 'data-pv-hidden';

    /**
     * Hide a card by collapsing its parent <li> layout slot to zero width
     * Uses zero-width collapse instead of display:none to preserve Prime's
     * carousel navigation (arrow keys rely on DOM elements being "present")
     */
    const hideCard = (container) => {
        const li = container.closest('li');
        if (li && li.getAttribute(FILTER_ATTR) !== 'true') {
            // Collapse to zero width while keeping in DOM for navigation
            li.style.cssText = `
                width: 0 !important;
                min-width: 0 !important;
                max-width: 0 !important;
                padding: 0 !important;
                margin: 0 !important;
                overflow: hidden !important;
                opacity: 0;
                pointer-events: none;
            `;
            li.setAttribute(FILTER_ATTR, 'true');
        }
    };

    /**
     * Restore a hidden card by clearing inline styles from parent <li>
     */
    const restoreCard = (container) => {
        const li = container.closest('li');
        if (li && li.getAttribute(FILTER_ATTR) === 'true') {
            li.style.cssText = '';
            li.removeAttribute(FILTER_ATTR);
        }
    };

    /**
     * Apply rating filter to all processed items
     * Uses batched DOM updates for instant filtering without visible 1-by-1 effect
     */
    const applyRatingFilter = (threshold) => {
        state.currentThreshold = threshold;
        log(`Applying rating filter: hiding items below ${threshold}`);

        // Collect all changes first (no DOM modifications yet)
        const toHide = [];
        const toRestore = [];

        const containers = document.querySelectorAll(`[${CONFIG.PROCESSED_ATTR}]`);

        containers.forEach(container => {
            // Skip excluded types (top hero, single carousel)
            if (container.matches(EXCLUDED_FROM_FILTER)) {
                return;
            }

            const info = extractInfo(container);
            if (!info.href) return;

            const li = container.closest('li');
            if (!li) return;

            const cached = state.sessionCache.get(info.href);
            if (!cached || !cached.rating) {
                // No rating data - ensure visible
                if (li.getAttribute(FILTER_ATTR) === 'true') {
                    toRestore.push(li);
                }
                return;
            }

            const rating = parseFloat(cached.rating);
            const isCurrentlyHidden = li.getAttribute(FILTER_ATTR) === 'true';

            if (threshold > 0 && rating < threshold) {
                if (!isCurrentlyHidden) toHide.push(li);
            } else {
                if (isCurrentlyHidden) toRestore.push(li);
            }
        });

        // Apply all changes in one batch (single repaint)
        requestAnimationFrame(() => {
            // Hide items
            toHide.forEach(li => {
                li.style.cssText = `
                    width: 0 !important;
                    min-width: 0 !important;
                    max-width: 0 !important;
                    padding: 0 !important;
                    margin: 0 !important;
                    overflow: hidden !important;
                    opacity: 0;
                    pointer-events: none;
                `;
                li.setAttribute(FILTER_ATTR, 'true');
            });

            // Restore items
            toRestore.forEach(li => {
                li.style.cssText = '';
                li.removeAttribute(FILTER_ATTR);
            });

            log(`Filter applied: ${toHide.length} hidden, ${toRestore.length} restored`);
        });
    };

    /**
     * Load threshold from storage on init
     */
    const loadThresholdFromStorage = () => {
        chrome.storage.local.get(['minRatingThreshold'], (result) => {
            if (result.minRatingThreshold !== undefined) {
                state.currentThreshold = result.minRatingThreshold;
                log(`Loaded threshold from storage: ${state.currentThreshold}`);
            }
        });
    };

    /**
     * Listen for messages from popup
     */
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'APPLY_RATING_FILTER') {
            applyRatingFilter(message.threshold);
            sendResponse({ success: true });
        }
        return true; // Keep channel open for async response
    });

    // ============================================
    // INIT
    // ============================================

    const init = () => {
        log('Initializing Row-Based Batching...');
        loadThresholdFromStorage();
        setupObservers();
        scan();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
