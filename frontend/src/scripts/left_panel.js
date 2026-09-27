//------------------------ Left Panel ------------------------//

function clearAllTextareas() {
    const textareas = document.querySelectorAll('textarea');
    textareas.forEach(textarea => {
    textarea.value = '';
    });
}

// Function to focus on the first textbox in search-scene-1
function focusOnFirstTextbox() {
    const firstScene = document.querySelector('#search-scene-1');
    if (firstScene) {
        const textbox = firstScene.querySelector('textarea[name="Text_Query"]');
        if (textbox) {
            textbox.focus();
        }
    }
}

// Function to cycle through Text_Query textboxes
function cycleThroughTextboxes() {
    const scenes = document.querySelectorAll('.Search_Scene');
    if (scenes.length === 0) return;

    const activeElement = document.activeElement;
    let currentSceneIndex = -1;

    for (let i = 0; i < scenes.length; i++) {
        if (scenes[i].contains(activeElement)) {
            currentSceneIndex = i;
            break;
        }
    }

    const nextSceneIndex = (currentSceneIndex + 1) % scenes.length;
    const nextScene = scenes[nextSceneIndex];

    const nextTextQuery = nextScene.querySelector('textarea[name="Text_Query"]');
    if (nextTextQuery) {
        nextTextQuery.focus();
    }
}

//------------------------------------------------------------------------//


//------------------------------------------------------------------------//
// Insert elements

// Insert a textarea for entering OCR (Optical Character Recognition) query
function insertOcrTextarea() {
    if (typeof showToast === 'function') {
        showToast('OCR được chọn bằng Multi-mode hoặc dấu ngoặc kép trong query.', 'info');
    }
}

// Insert a textarea for entering ASM
function insertAsmTextarea() {
    if (typeof showToast === 'function') {
        showToast('ASR được chọn bằng Multi-mode hoặc dấu ngoặc kép trong query.', 'info');
    }
}


//---------------------------------------------------------------------------------------------------
//---------------------------------------------------------------------------------------------------
//---------------------------------------------------------------------------------------------------

function insertQunNhiuChienTextarea() {
    const activeElement = document.activeElement;
    const queryGroup = activeElement.closest('.query-group');
    
    if (queryGroup) {
        const textQuery = queryGroup.querySelector('textarea[name="Text_Query"]');
        if (textQuery && textQuery.style.display !== 'none') {
            const queryImageArea = queryGroup.querySelector('.query-content-area');
            
            const existingQunNhiuChien = queryGroup.querySelector('textarea[name="QunNhiuChien_Query"]');
            if (!existingQunNhiuChien) {
                const QunNhiuChienContainer = document.createElement('div');
                QunNhiuChienContainer.className = 'QunNhiuChien-container';
                
                const newQunNhiuChienTextarea = document.createElement('textarea');
                newQunNhiuChienTextarea.name = 'QunNhiuChien_Query';
                newQunNhiuChienTextarea.rows = '2';
                newQunNhiuChienTextarea.placeholder = 'Search QunNhiuChien';
                
                const closeButton = document.createElement('button');
                closeButton.innerHTML = '&times;';
                closeButton.className = 'close-QunNhiuChien-button';
                closeButton.addEventListener('click', function() {
                    QunNhiuChienContainer.remove();
                });
                
                QunNhiuChienContainer.appendChild(newQunNhiuChienTextarea);
                QunNhiuChienContainer.appendChild(closeButton);
                
                queryImageArea.after(QunNhiuChienContainer);

                // Focus on the newly created QunNhiuChien textarea
                newQunNhiuChienTextarea.focus();
            }
        }
    }
}


// Reset the content of the left panel to its original state
function resetLeftPanel(originalLeftPanel) {
    const searchForm = document.getElementById('Search');
    const scenes = searchForm.querySelectorAll('.Search_Scene');

    scenes.forEach(scene => {
        // Remove all divs with class="ocr-container"
        const ocrContainers = scene.querySelectorAll('.ocr-container');
        ocrContainers.forEach(container => container.remove());

        // Remove all divs with class="asm-container"
        const asmContainers = scene.querySelectorAll('.asm-container');
        asmContainers.forEach(container => container.remove());

        // Remove all divs with class="QunNhiuChien-container"
        const QunNhiuChienContainers = scene.querySelectorAll('.QunNhiuChien-container');
        QunNhiuChienContainers.forEach(container => container.remove());
        
        // Remove image in image-drop-area
        const imageDropAreas = scene.querySelectorAll('.image-drop-area');
        imageDropAreas.forEach(dropArea => {
            const previewContainer = dropArea.querySelector('.preview-upload-container');
            const fileInput = dropArea.querySelector('input[type="file"]');
            clearImage(previewContainer, dropArea.querySelector('.drop-instruction'), fileInput);
        });

        // Reset tab to text
        switchTab(scene, 'text');

        // Reset mode to temporal
        switchMode(scene, 'standard-search');
    });
}


// Function to set up the search scene tabs
function setupSearchScene(scene) {
    if (!scene || scene.dataset.uiWired === 'true') return;
    scene.dataset.uiWired = 'true';
    const textButton = scene.querySelector('.text-button');
    const imageButton = scene.querySelector('.image-button');

    textButton?.addEventListener('click', (e) => {
        e.preventDefault();
        switchTab(scene, 'text');
    });
    imageButton?.addEventListener('click', (e) => {
        e.preventDefault();
        switchTab(scene, 'image');
    });

    const imageDropArea = scene.querySelector('.image-drop-area');
    if (imageDropArea) {
        const fileInput = imageDropArea.querySelector('input[type="file"]');
        const previewContainer = imageDropArea.querySelector('.preview-upload-container');
        if (fileInput && previewContainer && imageDropArea.dataset.uploadWired !== 'true') {
            imageDropArea.dataset.uploadWired = 'true';
            setupImageUpload(imageDropArea, fileInput, previewContainer);
        }
    }
    
    // Set up mode buttons
    setupModeButtons(scene);
}


//------------------------------------------------------------------------//
// Change tab

// Switch between tabs
function switchTab(scene, tabName) {
    const buttons = scene.querySelectorAll('.tab-buttons button');
    const queryContentArea = scene.querySelector('.query-content-area');
    const textQuery = queryContentArea?.querySelector('textarea[name="Text_Query"]');
    const imageDropArea = queryContentArea?.querySelector('.image-drop-area');

    buttons.forEach(button => button.classList.remove('active'));
    
    // Hide all content areas
    [textQuery, imageDropArea].forEach(el => {
        if (el) el.style.display = 'none';
    });

    switch (tabName) {
        case 'text':
            scene.querySelector('.text-button')?.classList.add('active');
            if (textQuery) textQuery.style.display = 'block';
            break;
        case 'image':
            scene.querySelector('.image-button')?.classList.add('active');
            if (imageDropArea) imageDropArea.style.display = 'flex';
            break;
    }
}


//------------------------------------------------------------------------//

//------------------------------------------------------------------------//
// Search mode selection

const DEFAULT_SEARCH_CONFIG = Object.freeze({
    family: 'standard',
    search_mode: 'standard',
    fusion_mode: 'late',
    multimodal_mode: 'none',
    deepseek_vision: false,
});

function activeModeChoice(scene, attribute, fallback) {
    return scene.querySelector(`.mode-choice.active[${attribute}]`)?.getAttribute(attribute) || fallback;
}

function setSearchFamily(scene, family) {
    if (!scene) return;
    const allowed = new Set(['standard', 'multi', 'video_lock']);
    const selected = allowed.has(family) ? family : 'standard';

    scene.dataset.searchFamily = selected;
    scene.querySelectorAll('.search-family-button').forEach(button => {
        const isActive = button.dataset.searchFamily === selected;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    scene.querySelectorAll('[data-family-options]').forEach(group => {
        group.hidden = group.dataset.familyOptions !== selected;
    });

    // Each family has an independent default.  Selecting a family must not
    // leave a hidden choice marked active and later send it to the API.
    const subgroup = scene.querySelector(`.mode-subgroup[data-family-options="${selected}"]`);
    if (subgroup) {
        const choices = subgroup.querySelectorAll('.mode-choice');
        if (!subgroup.querySelector('.mode-choice.active')) {
            choices[0]?.classList.add('active');
        }
        choices.forEach(choice => {
            choice.setAttribute('aria-pressed', choice.classList.contains('active') ? 'true' : 'false');
        });
    }
}

function setModeChoice(subgroup, choice) {
    if (!subgroup || !choice) return;
    subgroup.querySelectorAll('.mode-choice').forEach(button => {
        const isActive = button === choice;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function getSearchConfig(scene = document.getElementById('search-scene-1')) {
    if (!scene) return { ...DEFAULT_SEARCH_CONFIG };
    const family = scene.dataset.searchFamily || 'standard';
    if (family === 'video_lock') {
        return {
            family,
            search_mode: 'video_lock',
            fusion_mode: 'late',
            multimodal_mode: 'none',
            deepseek_vision: true,
        };
    }
    if (family === 'multi') {
        return {
            family,
            // The backend treats Multi-mode as a Standard request with an
            // explicit multimodal ablation.  Keeping search_mode=standard
            // satisfies the public API contract while multimodal_mode picks
            // the actual branch.
            search_mode: 'standard',
            fusion_mode: 'late',
            multimodal_mode: activeModeChoice(scene, 'data-multimodal-mode', 'only_visual'),
            deepseek_vision: false,
        };
    }
    return {
        family: 'standard',
        search_mode: 'standard',
        fusion_mode: activeModeChoice(scene, 'data-fusion-mode', 'late'),
        multimodal_mode: 'none',
        deepseek_vision: false,
    };
}

// Backward-compatible entry point used by resetLeftPanel() and older
// keyboard/plugin code.  New UI code selects a family plus its sub-choice.
function switchMode(scene, modeName) {
    const familyByLegacyClass = {
        'standard-search': 'standard',
        'multi-search': 'multi',
        'video-lock-search': 'video_lock',
    };
    setSearchFamily(scene, familyByLegacyClass[modeName] || modeName);
}

function setupModeButtons(scene) {
    if (!scene || scene.dataset.modeWired === 'true') return;
    scene.dataset.modeWired = 'true';

    scene.querySelectorAll('.search-family-button').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            setSearchFamily(scene, button.dataset.searchFamily);
        });
    });

    scene.querySelectorAll('.mode-subgroup .mode-choice').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            setModeChoice(button.closest('.mode-subgroup'), button);
        });
    });

    setSearchFamily(scene, scene.dataset.searchFamily || 'standard');
}



//------------------------------------------------------------------------//
// Upload image

// Set up image upload functionality
function setupImageUpload(dropZone, fileInput, previewContainer) {
    const dropInstruction = dropZone.querySelector('.drop-instruction');
    
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        handleImageUpload(file, previewContainer, dropInstruction);
    });

    dropZone.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        handleImageUpload(file, previewContainer, dropInstruction);
    });
}


// Handle the image upload and display the image
function handleImageUpload(file, previewContainer, dropInstruction) {
    if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        
        reader.onload = (e) => {
            const imgContainer = document.createElement('div');
            imgContainer.className = 'image-preview-container';
            
            const img = document.createElement('img');
            img.src = e.target.result;
            img.id = 'Img-review';
            
            const removeButton = document.createElement('button');
            removeButton.innerHTML = '&times;';
            removeButton.className = 'remove-image-button';
            removeButton.addEventListener('click', (event) => {
                event.stopPropagation(); // Prevent triggering the dropZone click event
                clearImage(previewContainer, dropInstruction, imgContainer.closest('.image-drop-area').querySelector('input[type="file"]'));
            });
            
            imgContainer.appendChild(img);
            imgContainer.appendChild(removeButton);
            
            previewContainer.innerHTML = '';
            previewContainer.appendChild(imgContainer);
            dropInstruction.style.display = 'none';
        };
        reader.readAsDataURL(file);
    }
}

// Clear the image from the preview container and reset the file input
function clearImage(previewContainer, dropInstruction, fileInput) {
    previewContainer.innerHTML = '';
    dropInstruction.style.display = 'block';
    fileInput.value = ''; // Clear the file input value
}






//------------------------------------------------------------------------//
// Add new search scene

function addNewSearchScene() {
    // The current production UI intentionally has one main query.  Keeping
    // this guard avoids resurrecting the removed second-query/OCR/ASR form
    // through the legacy Ctrl+H shortcut.
    const existingMainScene = document.getElementById('search-scene-1');
    if (existingMainScene) {
        if (typeof showToast === 'function') {
            showToast('FE hiện dùng một query chính; hãy chọn mode ngay trên query đó.', 'info');
        }
        return;
    }
    const searchForm = document.getElementById('Search');
    const existingScenes = searchForm.querySelectorAll('.Search_Scene');
    const newSceneNumber = existingScenes.length + 1;

    // Create a new search scene based on the original HTML structure
    const newSceneHTML = `
        <div class="Search_Scene" id="search-scene-${newSceneNumber}">
            <div class="tab-buttons">
                <button class="text-button active">
                    <img src="src/Img/icon-outline-text.png" alt="icon">
                </button>
                <button class="image-button">
                    <img src="src/Img/icon-image-plus.png" alt="icon">
                </button>
            </div>
            
            <div class="mode-button">
                <button class="standard-search active" type="button">Standard</button>
                <button class="video-lock-search" type="button">Video-Lock</button>
            </div>

            <div class="query-group">
                <div class="query-content-area">
                    <textarea name="Text_Query" id="Text-Query-${newSceneNumber}" rows="4" placeholder="Enter query"></textarea>
                    
                    <div class="image-drop-area" style="display: none;">
                        <p class="drop-instruction">Drag and drop image here or click to upload</p>
                        <input type="file" accept="image/*" style="display: none;" id="Image-Query-${newSceneNumber}">
                        <div class="preview-upload-container"></div>
                    </div>

                </div>
            </div>
        </div>
    `;

    // Create a new element from the HTML string
    const newScene = document.createElement('div');
    newScene.innerHTML = newSceneHTML.trim();
    const newSceneElement = newScene.firstChild;

    // Add a close button
    const closeButton = document.createElement('button');
    closeButton.innerHTML = '&times;';
    closeButton.className = 'close-scene-button';
    closeButton.addEventListener('click', function() {
        newSceneElement.remove();
    });
    newSceneElement.style.position = 'relative';
    newSceneElement.insertBefore(closeButton, newSceneElement.firstChild);

    // Append the new scene to the search form
    searchForm.appendChild(newSceneElement);

    // Set up event listeners for the new scene
    setupSearchScene(newSceneElement);

    // Set up image upload for the new scene
    const imageDropArea = newSceneElement.querySelector('.image-drop-area');
    if (imageDropArea) {
        const newFileInput = imageDropArea.querySelector('input[type="file"]');
        const newPreviewContainer = imageDropArea.querySelector('.preview-upload-container');
        setupImageUpload(imageDropArea, newFileInput, newPreviewContainer);
    }
}

// Set up all existing search scenes when the document loads
document.addEventListener('DOMContentLoaded', function() {
    const searchScenes = document.querySelectorAll('.Search_Scene');
    searchScenes.forEach(setupSearchScene);
});


function removeAddedScenes() {
    const searchForm = document.getElementById('Search');
    const scenes = searchForm.querySelectorAll('.Search_Scene');
    scenes.forEach((scene, index) => {
        if (index >= 1) { // Keep the single production query scene
            scene.remove();
        }
    });
}
