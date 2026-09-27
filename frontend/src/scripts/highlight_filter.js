document.addEventListener('DOMContentLoaded', () => {
    const highlightInput = document.getElementById('local-highlight-input');
    if (highlightInput) {
        highlightInput.addEventListener('input', (e) => {
            const keyword = e.target.value.trim().toLowerCase();
            const allDivs = document.querySelectorAll('#list-photo .img-dis');
            allDivs.forEach(div => {
                const matchedText = div.dataset.matchedText;
                if (keyword.length > 0 && matchedText && matchedText.toLowerCase().includes(keyword)) {
                    div.classList.add('has-text-match');
                } else {
                    div.classList.remove('has-text-match');
                }
            });
        });
    }
});
