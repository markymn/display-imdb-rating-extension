document.addEventListener('DOMContentLoaded', () => {
    const slider = document.getElementById('ratingSlider');
    const input = document.getElementById('ratingInput');

    // Sync slider to input
    slider.addEventListener('input', (e) => {
        input.value = parseFloat(e.target.value).toFixed(1);
    });

    // Sync input to slider
    input.addEventListener('change', (e) => {
        let val = parseFloat(e.target.value);

        // Clamp values
        if (isNaN(val)) val = 0.0;
        if (val < 0) val = 0.0;
        if (val > 10.0) val = 10.0;

        val = val.toFixed(1);
        input.value = val;
        slider.value = val;
    });

    // Optional: immediate reflection while typing in number box
    input.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        if (!isNaN(val) && val >= 0 && val <= 10) {
            slider.value = val;
        }
    });
});
