// "Quick search" mode toggle. The WebSocket-based infinite-scroll pagination
// this used to drive (Milvus /ws/pagnition) has no equivalent in the real
// API — search already returns up to top_k results in one REST call, so
// this is now just a UI affordance; cleanupSearchResults() clears the
// current results when entering quick-search mode.

let isQuickSearch = false;

function toggleQuickSearchMode() {
    const lightingQuickSearchButton = document.getElementById('quick-search');
    isQuickSearch = !isQuickSearch;

    if (isQuickSearch) {
        lightingQuickSearchButton.innerHTML = '<img src="src/Img/icon-lighting-yellow.png" alt="icon">';
        lightingQuickSearchButton.title = 'Switch to quick search mode';
        cleanupSearchResults();
    } else {
        lightingQuickSearchButton.innerHTML = '<img src="src/Img/icon-lighting-grey.png" alt="icon">';
        lightingQuickSearchButton.title = 'Switch to normal search mode';
        cleanupSearchResults();
    }
}

document.addEventListener('DOMContentLoaded', function() {
    const quickSearchButton = document.getElementById('quick-search');
    quickSearchButton.addEventListener('click', toggleQuickSearchMode);
});
