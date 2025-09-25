import { ViryaOSLaneStudio } from './core.js';
import * as ViewMethods from './view.js';
import * as WaypointMethods from './waypoint_edit.js';
import * as PathMethods from './path.js';
import * as LayoutMethods from './layout.js';


// --- Main Application Bootstrap ---
let app = null;

function bootstrap() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
        return;
    }
    app = new ViryaOSLaneStudio();
    app.init();
    window.viryaOSLaneStudio = app; // Expose to window for debugging
    window.waypointEditPlus = app;
}

// Global error handler
window.addEventListener('error', (event) => {
    console.error('💥 ViryaOSLaneStudio error:', event.error);
    if (app) {
        app.showErrorMessage(`Unexpected error: ${event.error.message}`);
    }
});

// Start the application
bootstrap();