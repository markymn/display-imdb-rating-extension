document.addEventListener('DOMContentLoaded', () => {
    const slider = document.getElementById('ratingSlider');
    const input = document.getElementById('ratingInput');

    // Load saved threshold on popup open
    chrome.storage.local.get(['minRatingThreshold'], (result) => {
        const threshold = result.minRatingThreshold ?? 0.0;
        slider.value = threshold;
        input.value = parseFloat(threshold).toFixed(1);
    });

    // Sync slider to input (live while dragging)
    slider.addEventListener('input', (e) => {
        input.value = parseFloat(e.target.value).toFixed(1);
    });

    // Apply filter when slider is released
    slider.addEventListener('change', (e) => {
        applyThreshold(parseFloat(e.target.value));
    });

    // Sync input to slider and apply on change (blur/Enter)
    input.addEventListener('change', (e) => {
        let val = parseFloat(e.target.value);

        // Clamp values
        if (isNaN(val)) val = 0.0;
        if (val < 0) val = 0.0;
        if (val > 10.0) val = 10.0;

        val = parseFloat(val.toFixed(1));
        input.value = val.toFixed(1);
        slider.value = val;

        applyThreshold(val);
    });

    // Live slider sync while typing
    input.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        if (!isNaN(val) && val >= 0 && val <= 10) {
            slider.value = val;
        }
    });

    // Apply filter on Enter key in input
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.target.blur(); // Triggers 'change' event
        }
    });

    /**
     * Save threshold and notify content script
     */
    function applyThreshold(threshold) {
        // Save to storage
        chrome.storage.local.set({ minRatingThreshold: threshold });

        // Send message to content script on active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'APPLY_RATING_FILTER',
                    threshold: threshold
                });
            }
        });
    }
});
