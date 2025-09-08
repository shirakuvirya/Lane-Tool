/**
 * UI Adapter for WaypointEdit+
 * This script connects the tabbed UI in index.html to the event listeners
 * expected by app.js, without modifying app.js itself.
 * It works by programmatically "clicking" hidden buttons that app.js is wired to.
 */
document.addEventListener('DOMContentLoaded', () => {
    // Visible UI Tab Buttons
    const tabView = document.getElementById('tab-view');
    const tabEdit = document.getElementById('tab-waypoint-edit');
    const tabDraw = document.getElementById('tab-layout-drawings');
    const allTabs = [tabView, tabEdit, tabDraw];

    // Hidden buttons that app.js is listening to
    const hiddenEditBtn = document.getElementById('edit');
    const hiddenDrawBtn = document.getElementById('add-label-toggle');
    
    // Display panel toggle
    const displayToggleBtn = document.getElementById('display-toggle');
    const displayPanel = document.getElementById('display-panel');


    // Keep track of the current mode based on which tab is active
    let currentMode = 'view'; // Can be 'view', 'edit', or 'draw'

    function switchMode(newMode) {
        // Don't do anything if a disabled tab is clicked
        if ( (newMode === 'edit' && tabEdit.disabled) || (newMode === 'draw' && tabDraw.disabled) ) {
            return;
        }

        // --- Deactivate the current mode ---
        if (currentMode === 'edit') {
            hiddenEditBtn.click(); // Toggles editMode OFF in app.js
        }
        if (currentMode === 'draw') {
            hiddenDrawBtn.click(); // Toggles drawing palette OFF in app.js
        }
        
        // --- Activate the new mode ---
        // If the new mode is the one we just deactivated, we switch to 'view'
        if (newMode === currentMode) {
            currentMode = 'view';
        } else {
            currentMode = newMode;
            if (newMode === 'edit') {
                hiddenEditBtn.click(); // Toggles editMode ON in app.js
            }
            if (newMode === 'draw') {
                hiddenDrawBtn.click(); // Toggles drawing palette ON in app.js
            }
        }

        // Update the visual state of the tabs
        allTabs.forEach(tab => tab.classList.remove('active'));
        document.querySelector(`[id="tab-${currentMode}"]`)?.classList.add('active');
    }

    // Wire up the tab buttons to the mode switcher
    tabView.addEventListener('click', () => switchMode('view'));
    tabEdit.addEventListener('click', () => switchMode('edit'));
    tabDraw.addEventListener('click', () => switchMode('draw'));

    // Wire up the display panel toggle button
    displayToggleBtn.addEventListener('click', () => {
        displayPanel.classList.toggle('hidden');
        displayToggleBtn.classList.toggle('active');
    });
});