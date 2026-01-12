document.addEventListener('DOMContentLoaded', () => {
    // Controls
    const slider = document.getElementById('ratingSlider');
    const input = document.getElementById('ratingInput');

    const rtSlider = document.getElementById('rtSlider');
    const rtInput = document.getElementById('rtInput');

    const opacitySlider = document.getElementById('opacitySlider');
    const opacityValue = document.getElementById('opacityValue');

    const scaleSlider = document.getElementById('scaleSlider');
    const scaleInput = document.getElementById('scaleInput');

    const showImdbCheckbox = document.getElementById('showImdb');
    const showRtCheckbox = document.getElementById('showRt');

    // Load saved settings
    chrome.storage.local.get(['minRatingThreshold', 'minRtThreshold', 'ghostOpacity', 'badgeScale', 'showImdb', 'showRt'], (result) => {
        const threshold = result.minRatingThreshold ?? 0.0;
        const rtThreshold = result.minRtThreshold ?? 0;
        const opacity = result.ghostOpacity ?? 0;
        const scale = result.badgeScale ?? 1.0;
        const showImdb = result.showImdb ?? true;
        const showRt = result.showRt ?? false;

        // IMDb
        slider.value = threshold;
        input.value = parseFloat(threshold).toFixed(1);

        // RT
        rtSlider.value = rtThreshold;
        rtInput.value = rtThreshold;

        // Opacity
        opacitySlider.value = opacity;
        opacityValue.textContent = `${opacity}%`;

        // Scale
        scaleSlider.value = scale;
        scaleInput.value = parseFloat(scale).toFixed(2);

        // Visibility
        showImdbCheckbox.checked = showImdb;
        showRtCheckbox.checked = showRt;
    });

    // --- Helper: Sync Slider <-> Input ---
    // decimals: number of decimal places (0 for integers, 1 for IMDb, 2 for scale)
    function setupSync(sliderEl, inputEl, decimals) {
        // Slider -> Input
        sliderEl.addEventListener('input', (e) => {
            inputEl.value = decimals > 0 ? parseFloat(e.target.value).toFixed(decimals) : parseInt(e.target.value);
        });

        sliderEl.addEventListener('change', () => applySettings());

        // Input -> Slider
        inputEl.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            const max = parseFloat(sliderEl.max);
            const min = parseFloat(sliderEl.min);

            if (isNaN(val)) val = min;
            if (val < min) val = min;
            if (val > max) val = max;

            val = decimals > 0 ? parseFloat(val.toFixed(decimals)) : parseInt(val);

            inputEl.value = decimals > 0 ? val.toFixed(decimals) : val;
            sliderEl.value = val;

            applySettings();
        });

        // Input Typing Live Sync
        inputEl.addEventListener('input', (e) => {
            let val = parseFloat(e.target.value);
            const max = parseFloat(sliderEl.max);
            const min = parseFloat(sliderEl.min);
            if (!isNaN(val) && val >= min && val <= max) {
                sliderEl.value = val;
            }
        });

        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') e.target.blur();
        });
    }

    // Setup Syncs
    setupSync(slider, input, 1);           // IMDb (1 decimal)
    setupSync(rtSlider, rtInput, 0);       // RT (integer)
    setupSync(scaleSlider, scaleInput, 2); // Scale (2 decimals)

    // --- Opacity Slider Logic ---
    opacitySlider.addEventListener('input', (e) => {
        opacityValue.textContent = `${e.target.value}%`;
    });
    opacitySlider.addEventListener('change', () => applySettings());

    // --- Checkbox Logic ---
    showImdbCheckbox.addEventListener('change', () => applySettings());
    showRtCheckbox.addEventListener('change', () => applySettings());

    /**
     * Save settings and notify content script
     */
    function applySettings() {
        const threshold = parseFloat(slider.value);
        const rtThreshold = parseInt(rtSlider.value);
        const opacity = parseInt(opacitySlider.value);
        const scale = parseFloat(scaleSlider.value);
        const showImdb = showImdbCheckbox.checked;
        const showRt = showRtCheckbox.checked;

        // Save to storage
        chrome.storage.local.set({
            minRatingThreshold: threshold,
            minRtThreshold: rtThreshold,
            ghostOpacity: opacity,
            badgeScale: scale,
            showImdb: showImdb,
            showRt: showRt
        });

        // Send message to content script on active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'APPLY_SETTINGS',
                    settings: {
                        minRating: threshold,
                        minRt: rtThreshold,
                        opacity: opacity,
                        scale: scale,
                        showImdb: showImdb,
                        showRt: showRt
                    }
                });
            }
        });
    }
});
