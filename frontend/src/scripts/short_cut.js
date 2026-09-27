//------------------------ Short cut ---------

document.addEventListener('DOMContentLoaded', function() {
    const originalLeftPanel = document.querySelector('.left-panel').cloneNode(true);

    // Enter: trigger the search button (real REST search — see query_backend.js)
    document.addEventListener('keydown', async function(event) {
        if (event.key === "Enter" && !event.shiftKey) {
            const activeElement = document.activeElement;
            const searchScene = activeElement.closest('.Search_Scene');

            if (searchScene) {
                const isTextInput = activeElement.matches('textarea[name="Text_Query"]');

                if (isTextInput) {
                    event.preventDefault(); // Prevent default Enter behavior
                    collectTextQueries();
                    await performSearchFromTextareas();
                }
            }
        }
    });

    // search-button's click handler lives in query_backend.js (it owns the
    // real REST call); just collect history here.
    const searchButton = document.getElementById('search-button');
    if (searchButton) {
        searchButton.addEventListener('click', collectTextQueries);
    }

    // Alt + w: Toggle switch view
    const toggleSwitch = document.getElementById('mode-toggle');
    toggleSwitch.addEventListener('change', togglePanelLayout);
    document.addEventListener('keydown', function(event) {
        if (event.altKey && event.key === 'w') {
            event.preventDefault();
            toggleSwitch.checked = !toggleSwitch.checked;
            togglePanelLayout.call(toggleSwitch);
        }
    });

    // Alt + e: Toggle translate
    document.addEventListener('keydown', function(event) {
        if (event.altKey && event.key === 'e') {
            event.preventDefault();
            const translateOptionCheckbox = document.querySelector('.translate-option .toggle-checkbox');
            if (translateOptionCheckbox) {
                translateOptionCheckbox.checked = !translateOptionCheckbox.checked;
            }
        }
    });

    // Ctrl + i: Explain the new OCR routing rule (no extra input box)
    document.addEventListener('keydown', function(event) {
        if (event.ctrlKey && event.key === 'i') {
            event.preventDefault();
            insertOcrTextarea();
        }
    });

    // Ctrl + k: Explain the new ASR routing rule (no extra input box)
    document.addEventListener('keydown', function(event) {
        if (event.ctrlKey && event.key === 'k') {
            event.preventDefault();
            insertAsmTextarea();
        }
    });

    // Ctrl + l: Add search QunNhiuChien textarea
    document.addEventListener('keydown', function(event) {
        if (event.ctrlKey && event.key === 'l') {
            event.preventDefault();
            insertQunNhiuChienTextarea();
        }
    });

    // Ctrl + h: Add a new search scene
    document.addEventListener('keydown', function(event) {
        if (event.ctrlKey && event.key === 'h') {
            event.preventDefault();
            addNewSearchScene();
        }
    });

    // Ctrl + q: Reset the search panel
    document.addEventListener('keydown', function(event) {
        if (event.ctrlKey && event.key === 'q') {
            event.preventDefault();
            resetLeftPanel(originalLeftPanel);
            clearAllTextareas();
            removeAddedScenes();
            focusOnFirstTextbox();
        }
    });
    
    // Event listener for keyboard shortcuts
    document.addEventListener('keydown', function(event) {
        // Slash (/): Focus on the first textbox in search-scene-1
        if (event.key === '/' && !event.shiftKey) {
            event.preventDefault();
            focusOnFirstTextbox();
        }
        
        // Shift + Slash (?): Cycle through Text_Query textboxes
        if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
            event.preventDefault();
            cycleThroughTextboxes();
        }
    });

    // Ctrl + e: Clear all textareas
    document.addEventListener('keydown', function(event) {
        if (event.ctrlKey && event.key === 'e') {
            event.preventDefault();
            clearAllTextareas();
        }
    });

    // Alt + r is retained as a harmless compatibility shortcut.  KIS image
    // search is no longer exposed in the production UI.
    document.addEventListener('keydown', function(event) {
        if (event.altKey && event.key === 'r') {
            event.preventDefault();
            const scene1 = document.getElementById('search-scene-1');
            if (scene1) switchTab(scene1, 'text');
        }
    });

    // Alt + t is also kept safe for old muscle memory; there is no second
    // query scene in the current UI.
    document.addEventListener('keydown', function(event) {
        if (event.altKey && event.key === 't') {
            event.preventDefault();
            const scene2 = document.getElementById('search-scene-2');
            if (scene2) switchTab(scene2, 'text');
        }
    });

    // Alt + a: Toggle export area
    document.addEventListener('keydown', function(event) {
        if (event.altKey && event.key === 'a') {
          event.preventDefault();
          toggleExportArea();
        }
    });

    // Alt + x: Press reset-export-button to delete all images in export area
    document.addEventListener('keydown', function(event) {
        if (event.altKey && event.key === 's') {
            event.preventDefault();
            document.getElementById('reset-export').click();
        }
    });

    
    // Ctrl + s: Trigger submit button
    document.addEventListener('keydown', function(event) {
        if (event.ctrlKey && event.key === 's') {
            event.preventDefault();
            document.getElementById('submit-button').click();
        }
    });
});

