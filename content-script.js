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
        LOOP_INTERVAL: 2000,            // ms between scans (was 1000)
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
    // SELECTORS (Narrowed — matching Sift's approach)
    // ============================================

    // Container selectors: the large sections that hold program cards
    const CONTAINER_SELECTORS = [
        'section[data-testid="standard-carousel"]',
        'section[data-testid="super-carousel"]',
        'section[data-testid="charts-container"]',
        'section[data-testid="collection-carousel"]',
        'div[data-testid="grid-container"]',
        'div[data-testid="navigation-bar-content-cards-below"]',
        '[data-testid="top-hero"]',
        '[data-testid="intermission-hero"]',
        '[data-testid="atf-component"]'
    ].join(', ');

    // Program selectors: the individual cards inside containers
    const getProgramSelector = (container) => {
        const testId = container.getAttribute('data-testid');
        if (testId === 'super-carousel') return 'article[data-testid="super-carousel-card"]';
        if (testId === 'top-hero') return '[data-testid="top-hero-card"]';
        if (testId === 'intermission-hero') return '[data-testid="intermission-hero-card"]';
        if (testId === 'atf-component') return '[data-testid="product-details-hero"], [data-testid="detail-hero"]';
        // Broad match: any card article (with or without data-card-title)
        return 'article[data-testid="card"]';
    };

    // Title extraction fallback strategies (hoisted to avoid re-allocation)
    const TITLE_STRATEGIES = [
        { selector: '[data-testid="title-art"]', attr: 'aria-label' },
        { selector: '[data-testid="image-link"]', attr: 'aria-label' },
        { selector: 'a[aria-label]', attr: 'aria-label' },
        { selector: 'h2[aria-label]', attr: 'aria-label' },
        { selector: 'button[aria-label]', attr: 'aria-label' },
        { selector: 'h1', attr: 'textContent' },
        { selector: '[data-automation-id="title"]', attr: 'textContent' },
        { selector: '[data-testid="card-title"]', attr: 'textContent' },
        { selector: 'img[alt]', attr: 'alt' },
        { selector: '[class*="Title"]', attr: 'textContent' }
    ];

    const EXCLUDED_FROM_FILTER = '[data-testid="top-hero-card"], [data-testid="single-item-carousel"], [data-testid="intermission-hero-card"], [data-testid="atf-component"]';
    const FILTER_CLASS = 'pv-filtered-out';

    // ============================================
    // STATE
    // ============================================
    const state = {
        sessionCache: new Map(),        // Map<href, data>
        pendingContainers: new Map(),   // Map<href, Set<Container>>
        processedItems: new Set(),      // Track hrefs already sent/in-flight
        currentBatch: [],

        // Filtering & Visibility
        currentThreshold: 0.0,
        currentRtThreshold: 0,
        currentOpacity: 0,
        currentScale: 1.0,
        showImdb: true,
        showRt: false,
        lastUrl: window.location.href
    };

    // ============================================
    // POLLING LOOP
    // ============================================

    let isPolling = false;
    let loopTimeout = null;
    let loopAbortController = null;

    const startPolling = () => {
        if (isPolling) return;
        isPolling = true;
        log('Starting polling loop...');
        loopAbortController = new AbortController();
        loop();
    };

    const stopPolling = () => {
        isPolling = false;
        if (loopTimeout) clearTimeout(loopTimeout);
        if (loopAbortController) loopAbortController.abort();
        loopAbortController = null;
    };

    const loop = () => {
        if (!isPolling) return;
        if (loopAbortController && loopAbortController.signal.aborted) return;

        try {
            if (!document.hidden) runScan();
        } catch (e) {
            logError('Error in loop:', e);
        }

        loopTimeout = setTimeout(loop, CONFIG.LOOP_INTERVAL);
    };

    // ============================================
    // SCAN & PROCESS
    // ============================================

    const runScan = () => {
        const currentUrl = window.location.href;

        // SPA navigation detected — clear tracking state, keep session cache
        if (currentUrl !== state.lastUrl) {
            log('SPA navigation detected:', state.lastUrl, '->', currentUrl);
            state.lastUrl = currentUrl;
            state.processedItems.clear();
            state.pendingContainers.clear();
            state.currentBatch = [];
        }

        const containers = document.querySelectorAll(CONTAINER_SELECTORS);
        containers.forEach(processContainer);

        // Flush any remaining batch
        if (state.currentBatch.length > 0) {
            sendBatch(state.currentBatch);
            state.currentBatch = [];
        }

        // Flush deferred cached-item injections in a single RAF
        if (deferredInjections.length > 0) {
            const batch = deferredInjections.splice(0);
            requestAnimationFrame(() => {
                batch.forEach(({ program, cached }) => {
                    injectBadge(program, cached.rating, cached.votes, cached.rt_rating);
                    checkAndFilterCard(program, cached.rating, cached.rt_rating);
                });
            });
        }
    };

    // Deferred DOM updates — collected during scan, flushed in one RAF
    let deferredInjections = [];

    const processContainer = (container) => {
        const selector = getProgramSelector(container);
        const programs = container.querySelectorAll(selector);

        programs.forEach(program => {
            // O(1) attribute check first — avoid querySelector on every card
            const status = program.getAttribute(CONFIG.PROCESSED_ATTR);
            if (status === 'success' || status === 'no-data') return;

            // Retry stuck pending items (failed requests that never resolved)
            if (status === 'pending') {
                const pendingTime = parseInt(program.dataset.pendingSince || '0');
                if (pendingTime && (Date.now() - pendingTime) < 10000) return;
                program.removeAttribute(CONFIG.PROCESSED_ATTR);
            }

            // Safety net: badge exists but attribute was cleared (e.g. SPA nav)
            if (program.querySelector('.badge-container')) return;

            processProgram(program);
        });
    };

    const processProgram = (program) => {
        const info = extractInfo(program);
        if (!info || !info.href) {
            // Mark so we don't re-run extractInfo every scan cycle
            program.setAttribute(CONFIG.PROCESSED_ATTR, 'no-data');
            return;
        }

        // Check session cache first
        if (state.processedItems.has(info.href)) {
            const cached = state.sessionCache.get(info.href);
            if (cached) {
                // Defer DOM work — don't inject synchronously in the scan loop
                deferredInjections.push({ program, cached, href: info.href });
                program.setAttribute(CONFIG.PROCESSED_ATTR, 'success');
            } else {
                // In-flight request — register this container for when it returns
                if (!state.pendingContainers.has(info.href)) {
                    state.pendingContainers.set(info.href, new Set());
                }
                state.pendingContainers.get(info.href).add(program);
                program.setAttribute(CONFIG.PROCESSED_ATTR, 'pending');
                program.dataset.pendingSince = Date.now().toString();
            }
            return;
        }

        // Queue for batch network request
        state.currentBatch.push({ container: program, info });
        state.processedItems.add(info.href);
        program.setAttribute(CONFIG.PROCESSED_ATTR, 'pending');
        program.dataset.pendingSince = Date.now().toString();

        if (!state.pendingContainers.has(info.href)) {
            state.pendingContainers.set(info.href, new Set());
        }
        state.pendingContainers.get(info.href).add(program);

        if (state.currentBatch.length >= 10) {
            sendBatch(state.currentBatch);
            state.currentBatch = [];
        }
    };

    // ============================================
    // HELPERS & EXTRACTION
    // ============================================

    const cleanTitle = (text) => {
        if (!text) return '';
        return text
            .replace(/^Watch\s+/i, '')
            .replace(/\s*\(\d{4}\)\s*$/, '')
            .replace(/\s*-?\s*Prime Video\s*$/i, '')
            .replace(/\s*(?:-|:)?\s*Season\s+\d+.*/i, '')
            .replace(/\s*(?:-|:)?\s*S\d{1,2}$/i, '')
            .trim();
    };

    const cleanHref = (href) => {
        if (!href) return null;
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
        const currentUrl = state.lastUrl;
        let title = null;

        // 1. Fast path: aria-label on packshot button (most reliable)
        const packshotBtn = container.querySelector('[data-testid="packshot"] button[aria-label]');
        if (packshotBtn) {
            title = packshotBtn.getAttribute('aria-label');
        }
        // 2. Super carousel: aria-label on poster link
        else if (container.matches('[data-testid="super-carousel-card"]')) {
            const link = container.querySelector('a.shared-poster-link');
            if (link) title = link.getAttribute('aria-label');
        }
        // 3. Top hero card
        else if (container.matches('[data-testid="top-hero-card"]')) {
            const titleNode = container.querySelector('h1, h2, [data-testid="carousel-title"]');
            if (titleNode) title = titleNode.textContent;
        }
        // 4. Full fallback: prioritized strategy list
        if (!title) {
            for (const { selector, attr } of TITLE_STRATEGIES) {
                const el = container.querySelector(selector);
                if (!el) continue;
                const candidate = attr === 'textContent' ? el.textContent?.trim() : el.getAttribute(attr);
                if (candidate && !candidate.startsWith('Title number')) {
                    title = candidate;
                    break;
                }
            }
        }

        title = cleanTitle(title);

        // Href extraction
        let href = null;
        const isDetailPage = currentUrl.includes('/detail/') || currentUrl.includes('/gp/video/detail/') || currentUrl.includes('/dp/');
        const nativeBadge = container.querySelector('[data-automation-id="imdb-rating-badge"]');

        if (isDetailPage && nativeBadge) {
            href = currentUrl;
        } else {
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

        // Entity type
        const entityType = container.dataset.cardEntityType || null;

        // Verification data (detail pages only)
        let verificationRating = null;
        let year = null;
        if (isDetailPage && nativeBadge) {
            const match = nativeBadge.textContent.match(/(\d+(?:\.\d+)?)/);
            if (match) verificationRating = match[1];

            const yearBadge = container.querySelector('[data-automation-id="release-year-badge"]');
            if (yearBadge) {
                const yearText = yearBadge.textContent.trim();
                if (/^\d{4}$/.test(yearText)) {
                    year = yearText;
                } else {
                    const aria = yearBadge.getAttribute('aria-label');
                    if (aria) {
                        const ym = aria.match(/(\d{4})/);
                        if (ym) year = ym[1];
                    }
                }
            }
        }

        return { title, href, entityType, verificationRating, year };
    };

    // ============================================
    // NETWORK
    // ============================================

    const sendBatch = (batch) => {
        const payload = batch.map(item => ({
            title: item.info.title,
            href: item.info.href,
            entityType: item.info.entityType,
            verificationRating: item.info.verificationRating,
            year: item.info.year
        }));

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
                        log(`Received ${response.results.length} results.`);
                        handleBatchResponse(response.results);
                    } else if (response && response.error) {
                        logError('Batch failed:', response.error);
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
                // Ignore — extension context may be invalidated
            }
        }
    };

    const handleBatchResponse = (results) => {
        const domUpdates = [];

        results.forEach(item => {
            const containers = state.pendingContainers.get(item.href);
            if (!containers) return;

            if (item.data) {
                state.sessionCache.set(item.href, item.data);
            }

            containers.forEach(container => {
                domUpdates.push({ container, data: item.data, href: item.href });
            });
            state.pendingContainers.delete(item.href);
        });

        // Single RAF for all DOM updates
        if (domUpdates.length > 0) {
            requestAnimationFrame(() => {
                domUpdates.forEach(({ container, data }) => {
                    if (data) {
                        injectBadge(container, data.rating, data.votes, data.rt_rating);
                        container.setAttribute(CONFIG.PROCESSED_ATTR, 'success');
                        checkAndFilterCard(container, data.rating, data.rt_rating);
                    } else {
                        container.setAttribute(CONFIG.PROCESSED_ATTR, 'no-data');
                        checkAndFilterCard(container, 0, null);
                    }
                });
            });
        }
    };

    // ============================================
    // FILTER LOGIC (CSS class based)
    // ============================================

    const checkAndFilterCard = (container, rating, rtRating) => {
        // Skip all filter work when no thresholds are set
        if (state.currentThreshold <= 0 && state.currentRtThreshold <= 0) return;

        const testId = container.getAttribute('data-testid');
        if (testId === 'top-hero-card' || testId === 'single-item-carousel' ||
            testId === 'intermission-hero-card' || testId === 'atf-component') return;

        const li = container.closest('li');
        if (!li) return;

        const imdbVal = parseFloat(rating) || 0;
        let rtVal = 0;
        if (rtRating) rtVal = parseInt(rtRating.replace('%', '')) || 0;

        let shouldHide = false;
        if (state.currentThreshold > 0 && imdbVal < state.currentThreshold) shouldHide = true;
        if (!shouldHide && state.currentRtThreshold > 0 && rtRating && rtVal < state.currentRtThreshold) shouldHide = true;

        if (shouldHide) {
            li.classList.add(FILTER_CLASS);
        } else {
            li.classList.remove(FILTER_CLASS);
        }
    };

    const reapplyAllFilters = () => {
        log(`Re-applying filters: IMDb>${state.currentThreshold}, RT>${state.currentRtThreshold}`);

        const containers = document.querySelectorAll(`[${CONFIG.PROCESSED_ATTR}]`);
        containers.forEach(container => {
            const href = getHrefFromContainer(container);
            if (!href) return;

            const li = container.closest('li');
            if (!li) return;
            if (container.matches(EXCLUDED_FROM_FILTER)) return;

            const cached = state.sessionCache.get(href);
            const imdbVal = cached ? (parseFloat(cached.rating) || 0) : 0;
            let rtVal = 0;
            if (cached?.rt_rating) rtVal = parseInt(cached.rt_rating.replace('%', '')) || 0;

            let shouldHide = false;
            if (state.currentThreshold > 0 && imdbVal < state.currentThreshold) shouldHide = true;
            if (!shouldHide && state.currentRtThreshold > 0 && cached?.rt_rating && rtVal < state.currentRtThreshold) shouldHide = true;

            if (shouldHide) {
                li.classList.add(FILTER_CLASS);
            } else {
                li.classList.remove(FILTER_CLASS);
            }
        });
    };

    // Quick href lookup for reapplyAllFilters without full extractInfo
    const getHrefFromContainer = (container) => {
        // Try cached session data by checking all known hrefs
        for (const [href, _] of state.sessionCache) {
            // This is O(n) but only runs on settings change, not per-frame
            const pending = state.pendingContainers.get(href);
            if (pending && pending.has(container)) return href;
        }
        // Fallback: re-extract href only
        let href = null;
        const actionLink = container.querySelector('[data-testid="details-cta"]');
        if (actionLink) href = actionLink.getAttribute('href');
        if (!href) {
            const link = container.querySelector('a[href*="/detail/"], a[href*="title"]');
            if (link) href = link.getAttribute('href');
        }
        return href ? cleanHref(href) : null;
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
            const star = document.createElement('span');
            star.className = 'imdb-rating-star';
            star.textContent = '★';
            const val = document.createElement('span');
            val.className = 'imdb-rating-value';
            val.textContent = formattedRating;
            badge.append(star, ' ', val);
            if (votes) badge.title = `${votes} votes`;
        } else if (type === 'rt') {
            badge.className = 'rt-rating-badge';
            const icon = document.createElement('span');
            icon.className = 'rt-icon';
            const val = document.createElement('span');
            val.className = 'rt-rating-value';
            val.textContent = value;
            badge.append(icon, ' ', val);
            badge.title = 'RT';
        }
        return badge;
    };

    // Cache resolved targets per card to avoid repeated querySelector on re-injection
    const targetCache = new WeakMap();

    const findBadgeTarget = (container) => {
        if (targetCache.has(container)) return targetCache.get(container);

        let target;
        const testId = container.getAttribute('data-testid');

        if (testId === 'top-hero-card' || testId === 'single-item-carousel' || testId === 'intermission-hero-card') {
            target = container.querySelector('[data-testid="title-metadata-main"]');
        }

        if (!target) {
            target = container.querySelector('[data-testid="packshot"]') || container;
        }

        if (target.tagName === 'IMG') target = target.parentElement;

        targetCache.set(container, target);
        return target;
    };

    const injectBadge = (container, rating, votes, rtRating) => {
        // Skip injection for Detail Page Hero
        const testId = container.getAttribute('data-testid');
        if (testId === 'atf-component') return;

        const target = findBadgeTarget(container);
        if (!target) return;

        target.classList.add('pv-badge-target');

        // Already has badge — skip
        if (target.querySelector('.badge-container')) return;

        const badgeContainer = document.createElement('div');
        badgeContainer.className = 'badge-container';

        if (state.currentScale !== 1) {
            badgeContainer.style.zoom = state.currentScale;
        }

        if (state.showImdb) {
            badgeContainer.appendChild(createBadge('imdb', rating, votes));
        }

        if (state.showRt && rtRating) {
            badgeContainer.appendChild(createBadge('rt', rtRating));
        }

        if (badgeContainer.children.length > 0) {
            if (testId === 'title-metadata-main' || target.getAttribute('data-testid') === 'title-metadata-main') {
                target.prepend(badgeContainer);
            } else {
                target.appendChild(badgeContainer);
            }
        }
    };

    // ============================================
    // DYNAMIC UPDATES
    // ============================================

    const updateBadgeVisibility = () => {
        document.querySelectorAll('.imdb-rating-badge').forEach(b => b.style.display = state.showImdb ? '' : 'none');
        document.querySelectorAll('.rt-rating-badge').forEach(b => b.style.display = state.showRt ? '' : 'none');
    };

    const updateBadgeScale = () => {
        document.querySelectorAll('.badge-container').forEach(b => {
            b.style.zoom = state.currentScale;
        });
    };

    // ============================================
    // SETTINGS
    // ============================================

    const loadSettings = () => {
        chrome.storage.local.get(['minRatingThreshold', 'minRtThreshold', 'ghostOpacity', 'badgeScale', 'showImdb', 'showRt'], (result) => {
            if (result.minRatingThreshold !== undefined) state.currentThreshold = result.minRatingThreshold;
            if (result.minRtThreshold !== undefined) state.currentRtThreshold = result.minRtThreshold;
            if (result.ghostOpacity !== undefined) state.currentOpacity = result.ghostOpacity;
            if (result.badgeScale !== undefined) state.currentScale = result.badgeScale;
            if (result.showImdb !== undefined) state.showImdb = result.showImdb;
            if (result.showRt !== undefined) state.showRt = result.showRt;
            log(`Settings loaded: IMDb>${state.currentThreshold}, RT>${state.currentRtThreshold}`);
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

            // Update the dynamic filter style
            injectFilterStyles();
            reapplyAllFilters();
            updateBadgeVisibility();
            updateBadgeScale();

            sendResponse({ success: true });
        }
        return true;
    });

    // ============================================
    // DYNAMIC STYLING
    // ============================================

    const injectFilterStyles = () => {
        const styleId = 'imdb-prime-filter-styles';
        let styleNode = document.getElementById(styleId);
        if (!styleNode) {
            styleNode = document.createElement('style');
            styleNode.id = styleId;
            document.head.appendChild(styleNode);
        }

        const opacity = state.currentOpacity / 100;
        styleNode.textContent = `
            .pv-badge-target {
                position: relative !important;
            }
            .${FILTER_CLASS} {
                opacity: ${opacity} !important;
                pointer-events: none !important;
                transition: opacity 0.3s ease !important;
            }
        `;
    };

    const injectDynamicStyles = () => {
        const pageFontFamily = window.getComputedStyle(document.body).getPropertyValue('font-family');
        const styleId = 'imdb-prime-dynamic-styles';
        let styleNode = document.getElementById(styleId);
        if (!styleNode) {
            styleNode = document.createElement('style');
            styleNode.id = styleId;
            document.head.appendChild(styleNode);
        }
        styleNode.textContent = `
            .badge-container {
                font-family: ${pageFontFamily}, sans-serif !important;
            }
            .imdb-rating-badge, .rt-rating-badge {
                font-family: inherit !important;
            }
        `;
    };

    // ============================================
    // LIFECYCLE
    // ============================================

    const cleanup = () => {
        log('Cleaning up orphaned script...');
        stopPolling();
        window.removeEventListener('message', handleWindowMessage);

        const filterStyle = document.getElementById('imdb-prime-filter-styles');
        if (filterStyle) filterStyle.remove();
        const dynamicStyle = document.getElementById('imdb-prime-dynamic-styles');
        if (dynamicStyle) dynamicStyle.remove();
    };

    const handleWindowMessage = (event) => {
        if (event.source !== window) return;
        if (event.data && event.data.type === 'IMDB_PRIME_ORPHAN_CHECK') {
            try {
                if (!chrome.runtime.id) cleanup();
            } catch (e) {
                cleanup();
            }
        }
    };

    const init = () => {
        window.postMessage({ type: 'IMDB_PRIME_ORPHAN_CHECK' }, '*');
        window.addEventListener('message', handleWindowMessage);

        log('Initializing...');

        injectDynamicStyles();
        injectFilterStyles();
        loadSettings();
        startPolling();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
