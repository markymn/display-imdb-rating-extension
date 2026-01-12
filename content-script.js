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
        DEBUG: false,
        DEBOUNCE_DELAY: 500,           // ms to wait before sending batch
        INTERSECTION_THRESHOLD: 0,      // Trigger as soon as it enters the margin
        ROOT_MARGIN: '800px 0px 800px 0px', // Pre-load ratings for rows near viewport
        PROCESSED_ATTR: 'data-imdb-processed',
        WORKER_URL: 'https://imdb-ratings-proxy.markymn-dev.workers.dev'
    };

    const log = (...args) => {
        if (CONFIG.DEBUG) console.log('[IMDb Prime]', ...args);
    };

    const logError = (...args) => {
        if (CONFIG.DEBUG) console.error('[IMDb Prime]', ...args);
    };

    // ============================================
    // SELECTORS
    // ============================================
    const SELECTORS = {
        THUMBNAIL_CONTAINERS: [
            '[data-testid="top-hero-card"]',
            '[data-testid="single-item-carousel"]',
            '[data-testid="intermission-hero-card"]',
            '[data-testid="card"]',
            '[data-testid="product-details-hero"]', // NEW: Detail Page Hero
            '[data-testid="detail-hero"]', // NEW: Alternate Detail Hero
            '.dv-node-dp-container',
            '.tst-title-card',
            '.av-hover-wrapper',
            '.pv-detail-container',
            '._2RtpkI',
            '[class*="TitleCard"]',
            '[class*="packshot"]',
            '[data-testid="super-carousel-card"]',
            '[data-testid="atf-component"]' // Main Detail Hero
        ].join(', '),

        TITLE_ELEMENTS: [
            '[data-automation-id="title"]',
            'h1',
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
            '[data-testid="intermission-hero"]',
            '.tst-ordered-collection'
        ].join(', ')
    };

    const EXCLUDED_FROM_FILTER = '[data-testid="top-hero-card"], [data-testid="single-item-carousel"], [data-testid="intermission-hero-card"], [data-testid="atf-component"]';
    const FILTER_ATTR = 'data-pv-hidden';

    // ============================================
    // STATE
    // ============================================
    const state = {
        observer: null,
        intersectionObserver: null,
        processedItems: new Set(), // Track individual movie hrefs/IDs
        rowObservers: new Map(), // Map<RowElement, MutationObserver>
        sessionCache: new Map(), // Map<href, data> - Client side cache
        pendingContainers: new Map(), // Map<href, Set<Container>> - For items waiting on inflight requests
        processingTimeout: null,

        // Filtering & Visibility State
        currentThreshold: 0.0, // Min IMDb
        currentRtThreshold: 0, // Min RT
        currentOpacity: 0,
        currentScale: 1.0,
        showImdb: true,
        showRt: true
    };

    // ============================================
    // HELPERS & EXTRACTION
    // ============================================

    const cleanTitle = (text) => {
        if (!text) return '';
        const cleaned = text
            .replace(/^Watch\s+/i, '')
            .replace(/\s*\(\d{4}\)\s*$/, '') // Remove Year
            .replace(/\s*-?\s*Prime Video\s*$/i, '')
            .replace(/\s*(?:-|:)?\s*Season\s+\d+.*/i, '') // Remove Season info
            .replace(/\s*(?:-|:)?\s*S\d{1,2}$/i, '') // Remove S1, S02 etc
            .trim();
        return cleaned;
    };

    const cleanHref = (href) => {
        if (!href) return null;
        // Common patterns for Prime Video / Amazon URLs
        const patterns = [
            /\/detail\/[A-Za-z0-9]+/,
            /\/gp\/video\/detail\/[A-Za-z0-9]+/,
            /\/dp\/[A-Za-z0-9]+/
        ];

        for (const pattern of patterns) {
            const match = href.match(pattern);
            if (match) return match[0];
        }
        return href.split('?')[0].split('/ref=')[0];
    };

    const extractInfo = (container) => {
        if (container.matches('[data-testid="atf-component"]')) {
            log('Extracting Info for Main Component...');
        }
        // 1. Title
        let title = null;
        const packshotBtn = container.querySelector('[data-testid="packshot"] button[aria-label]');
        if (packshotBtn) {
            title = packshotBtn.getAttribute('aria-label');
        }

        if (!title) {
            for (const selector of SELECTORS.TITLE_ELEMENTS) {
                const el = container.querySelector(selector);
                if (el) {
                    // Try text content first
                    title = el.textContent.trim();

                    // IF empty, try alt or aria-label on element itself
                    if (!title) {
                        title = el.getAttribute('alt') || el.getAttribute('aria-label');
                    }

                    // IF STILL empty, look for an image inside (e.g. H1 > Div > Picture > Img)
                    if (!title) {
                        const img = el.querySelector('img');
                        if (img) title = img.getAttribute('alt');
                    }

                    if (title) {
                        if (title.startsWith('Title number') && container.matches('[data-testid="single-item-carousel"]')) {
                            title = null;
                        } else {
                            break; // Found it
                        }
                    }
                }
            }
        }
        title = cleanTitle(title);

        // 2. Href
        let href = null;

        // Critical Fix for Detail Pages:
        // If this container holds the "Prime's Native IMDb Badge", it IS the main entity of the detail page.
        // We must ignore any other links inside (which might point to seasons, episodes, or recommendations)
        // and strictly use the current window URL data.
        const nativeBadge = container.querySelector('[data-automation-id="imdb-rating-badge"]');
        const isDetailPage = window.location.href.includes('/detail/') || window.location.href.includes('/gp/video/detail/') || window.location.href.includes('/dp/');

        if (isDetailPage && nativeBadge) {
            // Force the Href to be the current page
            href = window.location.href;
            log('Identified Main Detail Hero via Native Badge, forcing HREF:', href);
        } else {
            // Standard Extraction
            const actionLink = container.querySelector('[data-testid="details-cta"]');
            if (actionLink) {
                href = actionLink.getAttribute('href');
            }

            if (!href) {
                if (container.tagName === 'A') {
                    href = container.getAttribute('href');
                } else {
                    const link = container.querySelector('a[href*="/detail/"], a[href*="title"]');
                    if (link) href = link.getAttribute('href');
                }
            }
        }

        if (href) href = cleanHref(href);

        // 3. Entity Type
        const entityType = container.getAttribute('data-card-entity-type') || null;

        // 4. Verification Data
        let verificationRating = null;
        if (isDetailPage) {
            const imdbBadge = container.querySelector('[data-automation-id="imdb-rating-badge"]');
            if (imdbBadge) {
                const match = imdbBadge.textContent.match(/(\d+(?:\.\d+)?)/);
                if (match) verificationRating = match[1];
            }
        }

        // 5. Release Year
        let year = null;
        if (isDetailPage) {
            const yearBadge = container.querySelector('[data-automation-id="release-year-badge"]');
            if (yearBadge) {
                // Try text content first (e.g. "2025")
                const yearText = yearBadge.textContent.trim();
                // Basic check if it looks like a year
                if (/^\d{4}$/.test(yearText)) {
                    year = yearText;
                } else {
                    // Try aria-label (e.g. "Released 2025")
                    const aria = yearBadge.getAttribute('aria-label');
                    if (aria) {
                        const match = aria.match(/(\d{4})/);
                        if (match) year = match[1];
                    }
                }
            }
        }

        if (isDetailPage) {
            const isHero = container.querySelector('.dv-node-dp-details-metdatablock') !== null;
            if (isHero) {
                log('!!! PROCESSING HERO CONTAINER !!!');
                const imdbBadge = container.querySelector('[data-automation-id="imdb-rating-badge"]');
                log('Hero Badge Found?', !!imdbBadge, imdbBadge ? imdbBadge.outerHTML : '');

                const yearBadge = container.querySelector('[data-automation-id="release-year-badge"]');
                log('Hero Year Badge Found?', !!yearBadge, yearBadge ? yearBadge.outerHTML : '');
            }
            log(`[Detail Page Extraction] Title: "${title}", Rating: ${verificationRating}, Year: ${year}`);
        }

        return { title, href, entityType, verificationRating, year };
    };

    const calculateBatchSize = (row) => {
        if (row.matches('[data-testid="top-hero-card"], [data-testid="single-item-carousel"], [data-testid="intermission-hero-card"], [data-testid="atf-component"]')) {
            return 1;
        }
        const rowWidth = row.offsetWidth;
        const firstItem = row.querySelector(SELECTORS.THUMBNAIL_CONTAINERS);
        if (!firstItem) return 10;

        const itemWidth = firstItem.offsetWidth;
        if (itemWidth === 0) return 10;

        const visibleCount = Math.floor(rowWidth / itemWidth);
        return Math.max(visibleCount * 2, 4);
    };

    // ============================================
    // FILTER LOGIC
    // ============================================

    const hideCard = (container) => {
        const li = container.closest('li');
        if (li && li.getAttribute(FILTER_ATTR) !== 'true') {
            li.style.transition = 'opacity 0.3s ease';
            li.style.opacity = (state.currentOpacity / 100).toString();
            li.style.pointerEvents = 'none';
            li.setAttribute(FILTER_ATTR, 'true');
        } else if (li && li.getAttribute(FILTER_ATTR) === 'true') {
            li.style.opacity = (state.currentOpacity / 100).toString();
        }
    };

    const restoreCard = (container) => {
        const li = container.closest('li');
        if (li && li.getAttribute(FILTER_ATTR) === 'true') {
            li.style.opacity = '';
            li.style.pointerEvents = '';
            li.removeAttribute(FILTER_ATTR);
        }
    };

    const checkAndHideCard = (container, rating, rtRating) => {
        if (container.matches(EXCLUDED_FROM_FILTER)) return;

        const imdbVal = parseFloat(rating) || 0;
        let rtVal = 0;
        if (rtRating) {
            rtVal = parseInt(rtRating.replace('%', '')) || 0;
        }

        let shouldHide = false;

        // IMDb Filter: Hide if rating exists and is below threshold
        if (state.currentThreshold > 0 && imdbVal > 0 && imdbVal < state.currentThreshold) {
            shouldHide = true;
        }

        // RT Filter: Hide if RT rating exists and is below threshold
        // Note: We only filter by RT if RT rating actually exists.
        if (!shouldHide && state.currentRtThreshold > 0 && rtRating && rtVal < state.currentRtThreshold) {
            shouldHide = true;
        }

        if (shouldHide) {
            hideCard(container);
        } else {
            restoreCard(container);
        }
    };

    // ============================================
    // UI INJECTION
    // ============================================

    const createBadge = (type, value, votes) => {
        const badge = document.createElement('div');

        if (type === 'imdb') {
            badge.className = 'imdb-rating-badge';
            const numRating = parseFloat(value);
            const formattedRating = (!numRating || numRating === 0) ? 'N/A' : numRating.toFixed(1);
            badge.innerHTML = `<span class="imdb-rating-star">★</span> <span class="imdb-rating-value">${formattedRating}</span>`;
            if (votes) badge.title = `${votes} votes`;
        } else if (type === 'rt') {
            badge.className = 'rt-rating-badge';
            badge.innerHTML = `<span class="rt-icon"></span> <span class="rt-rating-value">${value}</span>`;
            badge.title = 'RT';
        }
        return badge;
    };

    const injectBadge = (container, rating, votes, rtRating) => {
        // Skip injection for Detail Page Hero (Main Component) -> Verification only
        if (container.matches('[data-testid="atf-component"]')) return;

        let target;
        if (container.matches('[data-testid="top-hero-card"], [data-testid="single-item-carousel"], [data-testid="intermission-hero-card"]')) {
            target = container.querySelector('[data-testid="title-metadata-main"]');
        }

        if (!target) {
            target = container.querySelector('[data-testid="packshot"]') ||
                container.querySelector('[data-testid="poster-link"] .om7nme') ||
                container.querySelector('.om7nme') ||
                container;
        }

        if (target && target.tagName === 'IMG') target = target.parentElement;
        if (!target) return;

        if (window.getComputedStyle(target).position === 'static') {
            target.style.position = 'relative';
        }

        if (target.querySelector('.badge-container')) return;
        if (target.querySelector('.imdb-rating-badge')) return;

        checkAndHideCard(container, rating, rtRating);

        const badgeContainer = document.createElement('div');
        badgeContainer.className = 'badge-container';

        // Apply Scale
        if (state.currentScale !== 1) {
            badgeContainer.style.zoom = state.currentScale;
        }

        if (state.showImdb) {
            const imdbBadge = createBadge('imdb', rating, votes);
            badgeContainer.appendChild(imdbBadge);
        }

        if (state.showRt && rtRating) {
            const rtBadge = createBadge('rt', rtRating);
            badgeContainer.appendChild(rtBadge);
        }

        // Only append if we added at least one badge
        if (badgeContainer.children.length > 0) {
            if (target.getAttribute('data-testid') === 'title-metadata-main') {
                target.prepend(badgeContainer);
            } else {
                target.appendChild(badgeContainer);
            }
        }
    };

    // ============================================
    // BATCH & PROCESS LOGIC
    // ============================================

    const handleBatchResponse = (results) => {
        results.forEach(item => {
            const containers = state.pendingContainers.get(item.href);
            if (!containers) return;

            containers.forEach(container => {
                if (item.data) {
                    injectBadge(container, item.data.rating, item.data.votes, item.data.rt_rating);
                    container.setAttribute(CONFIG.PROCESSED_ATTR, 'success');
                    state.sessionCache.set(item.href, item.data);
                } else {
                    container.setAttribute(CONFIG.PROCESSED_ATTR, 'no-data');
                }
            });
            state.pendingContainers.delete(item.href);
        });
    };

    const sendBatch = async (batch) => {
        const payload = batch.map(item => ({
            title: item.info.title,
            href: item.info.href,
            entityType: item.info.entityType,
            verificationRating: item.info.verificationRating,
            year: item.info.year
        }));

        batch.forEach(item => {
            if (!state.pendingContainers.has(item.info.href)) {
                state.pendingContainers.set(item.info.href, new Set());
            }
            state.pendingContainers.get(item.info.href).add(item.container);
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
                        handleBatchResponse(response.results);
                    } else if (response && response.error) {
                        logError('Batch chunk failed:', response.error);
                        chunk.forEach(item => {
                            const pending = state.pendingContainers.get(item.href);
                            if (pending) {
                                pending.forEach(c => c.removeAttribute(CONFIG.PROCESSED_ATTR));
                                state.pendingContainers.delete(item.href);
                            }
                            state.processedItems.delete(item.href);
                        });
                    }
                });
            } catch (error) {
                // Ignore
            }
        }
    };

    const processRowItems = (row) => {
        const batchSize = calculateBatchSize(row);
        const allFound = Array.from(row.querySelectorAll(SELECTORS.THUMBNAIL_CONTAINERS));
        const uniqueItems = [row.matches(SELECTORS.THUMBNAIL_CONTAINERS) ? row : null, ...allFound]
            .filter((el, index, self) => el && self.indexOf(el) === index);

        let currentBatch = [];

        for (const item of uniqueItems) {
            if (item.hasAttribute(CONFIG.PROCESSED_ATTR)) continue;

            const info = extractInfo(item);
            if (!info || !info.href) continue;

            if (state.processedItems.has(info.href)) {
                // EXCEPTION: If this is the Main Hero with Verification Data (Year + Rating),
                // and we are on the detail page, we MUST ensure the backend logic ran with this data.
                // If the item was previously processed by a generic card (e.g. recommendation), it sent null/null.
                // We force a re-send here.
                const isDetailPage = window.location.href.includes('/detail/');
                const isHeroVerification = info.verificationRating && info.year && isDetailPage;

                if (!isHeroVerification) {
                    const cached = state.sessionCache.get(info.href);
                    if (cached) {
                        injectBadge(item, cached.rating, cached.votes, cached.rt_rating);
                        item.setAttribute(CONFIG.PROCESSED_ATTR, 'cache-hit');
                    } else {
                        if (!state.pendingContainers.has(info.href)) {
                            state.pendingContainers.set(info.href, new Set());
                        }
                        state.pendingContainers.get(info.href).add(item);
                        item.setAttribute(CONFIG.PROCESSED_ATTR, 'pending-queue');
                    }
                    continue;
                } else {
                    log('Force-processing Hero Item to ensure Verification:', info.title);
                }
            }

            currentBatch.push({ container: item, info });

            if (currentBatch.length >= batchSize) {
                sendBatch(currentBatch);
                currentBatch = [];
            }
        }

        if (currentBatch.length > 0) {
            sendBatch(currentBatch);
        }
    };

    const queueThumbnail = (container) => {
        if (container.hasAttribute(CONFIG.PROCESSED_ATTR)) return;
        const info = extractInfo(container);
        if (!info || !info.href) return;

        if (state.processedItems.has(info.href)) {
            const cached = state.sessionCache.get(info.href);
            if (cached) {
                injectBadge(container, cached.rating, cached.votes, cached.rt_rating);
                container.setAttribute(CONFIG.PROCESSED_ATTR, 'cache-hit');
            } else {
                if (!state.pendingContainers.has(info.href)) {
                    state.pendingContainers.set(info.href, new Set());
                }
                state.pendingContainers.get(info.href).add(container);
                container.setAttribute(CONFIG.PROCESSED_ATTR, 'pending-queue');
            }
            return;
        }
        sendBatch([{ container, info }]);
    };

    // ============================================
    // DYNAMIC UPDATES LOGIC
    // ============================================

    const reapplyAllFilters = () => {
        log(`Re-applying filters: IMDb>${state.currentThreshold}, RT>${state.currentRtThreshold}, Opacity=${state.currentOpacity}`);

        const containers = document.querySelectorAll(`[${CONFIG.PROCESSED_ATTR}]`);
        const toHide = [];
        const toRestore = [];

        containers.forEach(container => {
            const info = extractInfo(container);
            if (!info.href) return;

            const cached = state.sessionCache.get(info.href);
            if (!cached) return;

            const li = container.closest('li');
            if (!li) return;

            const imdbVal = parseFloat(cached.rating) || 0;
            let rtVal = 0;
            if (cached.rt_rating) {
                rtVal = parseInt(cached.rt_rating.replace('%', '')) || 0;
            }

            let shouldHide = false;
            if (state.currentThreshold > 0 && imdbVal > 0 && imdbVal < state.currentThreshold) shouldHide = true;
            if (!shouldHide && state.currentRtThreshold > 0 && cached.rt_rating && rtVal < state.currentRtThreshold) shouldHide = true;

            const isHidden = li.getAttribute(FILTER_ATTR) === 'true';

            if (shouldHide) {
                if (!isHidden || li.style.opacity != (state.currentOpacity / 100)) toHide.push(li);
            } else {
                if (isHidden) toRestore.push(li);
            }
        });

        requestAnimationFrame(() => {
            toHide.forEach(li => {
                li.style.transition = 'opacity 0.3s ease';
                li.style.opacity = (state.currentOpacity / 100).toString();
                li.style.pointerEvents = 'none';
                li.setAttribute(FILTER_ATTR, 'true');
            });
            toRestore.forEach(li => {
                li.style.opacity = '';
                li.style.pointerEvents = '';
                li.removeAttribute(FILTER_ATTR);
            });
        });
    };

    const updateBadgeVisibility = () => {
        const imdbBadges = document.querySelectorAll('.imdb-rating-badge');
        imdbBadges.forEach(b => b.style.display = state.showImdb ? '' : 'none');

        const rtBadges = document.querySelectorAll('.rt-rating-badge');
        rtBadges.forEach(b => b.style.display = state.showRt ? '' : 'none');
    };

    // ============================================
    // OBSERVERS
    // ============================================

    const setupObservers = () => {
        state.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const row = entry.target;
                if (entry.isIntersecting) {
                    processRowItems(row);
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
                            if (hasNewItems) processRowItems(row);
                        });
                        observer.observe(row, { childList: true, subtree: true });
                        state.rowObservers.set(row, observer);
                    }
                } else {
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

        const throttle = (func, limit) => {
            let inThrottle;
            return function () {
                const args = arguments;
                const context = this;
                if (!inThrottle) {
                    func.apply(context, args);
                    inThrottle = true;
                    setTimeout(() => inThrottle = false, limit);
                }
            }
        };

        const throttledScan = throttle(scan, 250);

        state.observer = new MutationObserver((mutations) => {
            let added = false;
            mutations.forEach(m => {
                if (m.addedNodes.length) added = true;
            });
            if (added) throttledScan();
        });
        state.observer.observe(document.body, { childList: true, subtree: true });
    };

    const scan = () => {
        const wrappers = document.querySelectorAll(SELECTORS.CAROUSEL_WRAPPERS);
        wrappers.forEach(wrapper => state.intersectionObserver.observe(wrapper));

        const containers = document.querySelectorAll(SELECTORS.THUMBNAIL_CONTAINERS);
        containers.forEach(container => {
            if (container.hasAttribute(CONFIG.PROCESSED_ATTR)) return;
            const parentRow = container.closest(SELECTORS.CAROUSEL_WRAPPERS);
            if (!parentRow) state.intersectionObserver.observe(container);
        });
    };

    // ============================================
    // INIT
    // ============================================

    const updateBadgeScale = () => {
        const badges = document.querySelectorAll('.badge-container');
        badges.forEach(b => {
            b.style.zoom = state.currentScale;
        });
    };

    const loadSettings = () => {
        chrome.storage.local.get(['minRatingThreshold', 'minRtThreshold', 'ghostOpacity', 'badgeScale', 'showImdb', 'showRt'], (result) => {
            if (result.minRatingThreshold !== undefined) state.currentThreshold = result.minRatingThreshold;
            if (result.minRtThreshold !== undefined) state.currentRtThreshold = result.minRtThreshold;
            if (result.ghostOpacity !== undefined) state.currentOpacity = result.ghostOpacity;
            if (result.badgeScale !== undefined) state.currentScale = result.badgeScale;

            if (result.showImdb !== undefined) state.showImdb = result.showImdb;
            if (result.showRt !== undefined) state.showRt = result.showRt;

            log(`Loaded settings: IMDb>${state.currentThreshold}, RT>${state.currentRtThreshold}, Opacity=${state.currentOpacity}, Scale=${state.currentScale}`);
        });
    };

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'APPLY_SETTINGS') {
            const s = message.settings;
            state.currentThreshold = s.minRating;
            state.currentRtThreshold = s.minRt;
            state.currentOpacity = s.opacity;
            state.currentScale = s.scale;
            state.showImdb = s.showImdb;
            state.showRt = s.showRt;

            reapplyAllFilters();
            updateBadgeVisibility();
            updateBadgeScale();

            sendResponse({ success: true });
        }
        return true;
    });

    const init = () => {
        log('Initializing Row-Based Batching...');
        loadSettings();
        setupObservers();
        scan();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
