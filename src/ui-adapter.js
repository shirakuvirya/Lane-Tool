/**
 * UI Adapter for WaypointEdit+
 * This script connects the tabbed UI in index.html to the event listeners
 * expected by app.js, without modifying app.js itself.
 */
document.addEventListener('DOMContentLoaded', () => {
    // Visible UI Elements
    const tabView = document.getElementById('tab-view');
    const tabEdit = document.getElementById('tab-waypoint-edit');
    const tabDraw = document.getElementById('tab-layout-drawings');
    const allTabs = [tabView, tabEdit, tabDraw];
    const displayToggleBtn = document.getElementById('display-toggle');
    const displayPanel = document.getElementById('display-panel');
    const closeToolButtons = document.querySelectorAll('.close-tool-options');

    // Hidden buttons that app.js is listening to
    const hiddenEditBtn = document.getElementById('edit');
    const hiddenDrawBtn = document.getElementById('add-label-toggle');
    
    // State tracking for the UI
    let currentMode = 'view';

    function switchMode(newMode) {
        if ((newMode === 'edit' && tabEdit.disabled) || (newMode === 'draw' && tabDraw.disabled)) {
            return;
        }

        const isCurrentlyEdit = tabEdit.classList.contains('active');
        const isCurrentlyDraw = tabDraw.classList.contains('active');

        // Deactivate current mode by "clicking" the hidden button if needed
        if (isCurrentlyEdit) hiddenEditBtn.click();
        if (isCurrentlyDraw) hiddenDrawBtn.click();

        // Activate the new mode, or switch to 'view' if clicking the same tab again
        if (newMode === 'edit' && !isCurrentlyEdit) {
            hiddenEditBtn.click();
            currentMode = 'edit';
        } else if (newMode === 'draw' && !isCurrentlyDraw) {
            hiddenDrawBtn.click();
            currentMode = 'draw';
        } else {
            currentMode = 'view';
        }

        // Update visual state of the tabs
        allTabs.forEach(tab => tab.classList.remove('active'));
        document.getElementById(`tab-${currentMode}`).classList.add('active');
    }

    // --- Event Listeners ---
    tabView.addEventListener('click', () => switchMode('view'));
    tabEdit.addEventListener('click', () => switchMode('edit'));
    tabDraw.addEventListener('click', () => switchMode('draw'));

    displayToggleBtn.addEventListener('click', () => {
        displayPanel.classList.toggle('hidden');
        displayToggleBtn.classList.toggle('active');
    });

    // NEW: Add listeners for the close buttons on the tool option panels
    closeToolButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Find the tool to switch back to (usually 'select')
            const targetToolId = button.dataset.tool;
            if (targetToolId) {
                const selectToolButton = document.getElementById(`edit-${targetToolId}`);
                if (selectToolButton) {
                    selectToolButton.click(); // This tells app.js to switch its internal state
                }
            }
        });
    });
});