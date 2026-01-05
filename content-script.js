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
        INTERSECTION_THRESHOLD: 0.1,
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
        ]
    };

    // ============================================
    // STATE
    // ============================================
    const state = {
        observer: null,
        intersectionObserver: null,
        batchQueue: new Map(), // Map<Container, {title, href}>
        sessionCache: new Map(), // Map<href, data> - Client side cache
        processingTimeout: null,
    };

    // ============================================
    // CORE LOGIC
    // ============================================

    /**
     * processBatch: Sends the accumulated queue to the worker
     */
    const processBatch = async () => {
        if (state.batchQueue.size === 0) return;

        const batch = Array.from(state.batchQueue.entries());
        state.batchQueue.clear(); // Clear immediately

        const payload = batch.map(([container, data]) => ({
            title: data.title,
            href: data.href
        }));

        // Map href back to containers for UI update
        const containerMap = new Map(); // Map<href, Array<Container>>
        batch.forEach(([container, data]) => {
            if (data.href) {
                if (!containerMap.has(data.href)) {
                    containerMap.set(data.href, []);
                }
                containerMap.get(data.href).push(container);
            }
        });

        try {
            log(`Sending batch of ${payload.length} items...`);

            chrome.runtime.sendMessage({
                type: 'BATCH_LOOKUP',
                movies: payload
            }, (response) => {
                log('Received batch response:', response);
                if (response && response.results) {
                    handleBatchResponse(response.results, containerMap);
                }
            });

        } catch (error) {
            log('Batch processing error:', error);
        }
    };

    const handleBatchResponse = (results, containerMap) => {
        log('Processing results against map keys:', Array.from(containerMap.keys()));
        results.forEach(item => {
            log('Processing item:', item);
            const containers = containerMap.get(item.href);
            if (!containers) {
                log('No containers found for href:', item.href);
                return;
            }

            containers.forEach(container => {
                if (item.data) {
                    injectBadge(container, item.data.rating, item.data.votes);
                    container.setAttribute(CONFIG.PROCESSED_ATTR, 'success');
                    // Update session cache
                    state.sessionCache.set(item.href, item.data);
                } else {
                    container.setAttribute(CONFIG.PROCESSED_ATTR, 'no-data');
                }
            });
        });
    };

    /**
     * Queue a container for processing
     */
    const queueThumbnail = (container) => {
        if (container.hasAttribute(CONFIG.PROCESSED_ATTR)) return;

        const info = extractInfo(container);
        const isHeroOrCarousel = container.matches('[data-testid="top-hero-card"], [data-testid="single-item-carousel"]');

        // If it's a single-item-carousel, we allow title to be missing (we'll fetch by href only)
        const isSingleItemCarousel = container.matches('[data-testid="single-item-carousel"]');
        const hasRequiredInfo = isSingleItemCarousel ? info?.href : (info?.title && info?.href);

        if (!hasRequiredInfo) {
            // Special handling for Top Hero or Single Item Carousel: Retry if data is missing (it loads dynamically)
            if (isHeroOrCarousel) {
                let retries = parseInt(container.getAttribute('data-imdb-retries') || '0');
                if (retries < 10) { // Retry for ~10 seconds (10 * 1000ms)
                    container.setAttribute('data-imdb-retries', retries + 1);
                    console.log(`[IMDb Prime] Retrying dynamic hero/carousel card (${retries + 1}/10)...`);
                    setTimeout(() => queueThumbnail(container), 1000);
                    return;
                }
            }
            return;
        }

        // Check session cache
        if (state.sessionCache.has(info.href)) {
            const cached = state.sessionCache.get(info.href);
            injectBadge(container, cached.rating, cached.votes);
            container.setAttribute(CONFIG.PROCESSED_ATTR, 'cache-hit');
            return;
        }

        // Add to batch
        state.batchQueue.set(container, info);
        container.setAttribute(CONFIG.PROCESSED_ATTR, 'pending');

        // Debounce batch send
        clearTimeout(state.processingTimeout);
        state.processingTimeout = setTimeout(processBatch, CONFIG.DEBOUNCE_DELAY);
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

        return { title, href };
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
        // Intersection Observer for lazy loading
        state.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    queueThumbnail(entry.target);
                    state.intersectionObserver.unobserve(entry.target);
                }
            });
        }, { threshold: CONFIG.INTERSECTION_THRESHOLD });

        // Mutation Observer for dynamic content
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
        const containers = document.querySelectorAll(SELECTORS.THUMBNAIL_CONTAINERS);
        containers.forEach(container => {
            if (!container.hasAttribute(CONFIG.PROCESSED_ATTR)) {
                state.intersectionObserver.observe(container);
            }
        });
    };

    // ============================================
    // INIT
    // ============================================

    const init = () => {
        log('Initializing...');
        setupObservers();
        scan();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
