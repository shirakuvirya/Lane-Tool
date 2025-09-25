/**
 * ViryaOSLaneStudio - Professional Point Cloud Viewer with Enhanced Layout Tools
 * * A comprehensive 3D web application for visualizing point clouds, editing waypoints,
 * generating lane geometries, and creating interactive annotations. Built with Three.js
 * and featuring direct manipulation interfaces, database integration, and real-time
 * collaborative editing capabilities.
 * * Key Features:
 * - Point cloud visualization (PLY/PCD format support)
 * - Waypoint database management with SQLite integration
 * - Lane generation with customizable width parameters
 * - Interactive shape and text annotation tools
 * - Real-time coordinate transformation (ROS â†” Three.js)
 * - Advanced interpolation algorithms (linear and radial)
 * - Multi-view support (orbit, top-down orthographic)
 * * @author ViryaOSLaneStudio Development Team
 * @version 2.1.0
 * @license MIT
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';

/**
 * Database schema definition for waypoint storage
 * Supports spatial coordinates, orientation, and lane width parameters
 */
const WAYPOINT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS waypoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x REAL NOT NULL,
    y REAL NOT NULL,
    z REAL NOT NULL,
    roll REAL DEFAULT 0,
    pitch REAL DEFAULT 0,
    yaw REAL DEFAULT 0,
    zone TEXT DEFAULT 'N/A',
    width_left REAL DEFAULT 0.5,
    width_right REAL DEFAULT 0.5,
    two_way INTEGER DEFAULT 0
);`;

/**
 * Database schema definition for edge graph storage
 * Stores connections between waypoints with distance-based weights
 */
const EDGE_GRAPH_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS edge_graph (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id1 INTEGER NOT NULL,
    id2 INTEGER NOT NULL,
    weight REAL NOT NULL DEFAULT 0.0,
    FOREIGN KEY (id1) REFERENCES waypoints (id) ON DELETE CASCADE,
    FOREIGN KEY (id2) REFERENCES waypoints (id) ON DELETE CASCADE
);`;

const JUNCTION_POINTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS junction_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    junction_waypoint_id INTEGER NOT NULL,
    from_waypoint_id INTEGER NOT NULL,
    to_waypoint_id INTEGER NOT NULL,
    entry_x REAL NOT NULL,
    entry_y REAL NOT NULL,
    entry_z REAL NOT NULL,
    exit_x REAL NOT NULL,
    exit_y REAL NOT NULL,
    exit_z REAL NOT NULL,
    FOREIGN KEY (junction_waypoint_id) REFERENCES waypoints (id) ON DELETE CASCADE
);`;


/**
 * Main application class for ViryaOSLaneStudio
 * Manages the complete 3D editing environment including point clouds,
 * waypoints, lanes, and interactive annotations
 */
class ViryaOSLaneStudio {
    /**
     * Initialize the ViryaOSLaneStudio application with default configuration
     * Sets up all necessary components for 3D scene management, user interaction,
     * and data persistence
     */
    constructor() {
        // ====================================================================
        // CORE SCENE COMPONENTS
        // ====================================================================
        
        /** @type {THREE.Scene} Main 3D scene container */
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0b0e14);
        
        /** @type {THREE.Camera} Active camera instance (Perspective or Orthographic) */
        this.camera = null;
        
        /** @type {OrbitControls} Camera controls for navigation */
        this.controls = null;
        
        /** @type {THREE.WebGLRenderer} Main rendering engine */
        this.renderer = null;

        // ====================================================================
        // 3D OBJECT MANAGEMENT
        // ====================================================================
        
        /** @type {THREE.Points} Point cloud visualization object */
        this.mapObject = null;
        
        /** @type {THREE.Points} Waypoint visualization object */
        this.waypointsObject = null;
        
        /** @type {THREE.BufferGeometry} Original point cloud geometry for transformations */
        this.originalMapGeometry = null;
        
        /** @type {THREE.Mesh} Visual indicator for point hovering */
        this.hoverIndicator = null;
        
        /** @type {THREE.Group} Container for lane geometry meshes */
        this.pathGroup = new THREE.Group();

        // ====================================================================
        // SHAPE AND ANNOTATION SYSTEM
        // ====================================================================
        
        /** @type {THREE.Group} Container for all drawable shapes and annotations */
        this.shapeGroup = new THREE.Group();
        
        /** @type {boolean} Flag indicating active drawing operation */
        this.isDrawing = false;
        
        /** @type {THREE.Vector3} Starting point for shape drawing */
        this.drawStartPoint = new THREE.Vector3();
        
        /** @type {THREE.Mesh} Preview shape during drawing operation */
        this.ghostShape = null;
        
        /** @type {Array<THREE.Mesh>} Collection of all created shapes */
        this.shapes = [];
        
        /** @type {THREE.Mesh} Currently selected shape for editing */
        this.selectedShape = null;
        
        /** @type {THREE.Font} Loaded font for text rendering */
        this.font = null;
        
        /** @type {FontLoader} Font loading utility */
        this.fontLoader = new FontLoader();
        
        /** @type {THREE.Vector3} Position for text insertion */
        this.textInsertionPoint = null;

        // ====================================================================
        // SHAPE TRANSFORMATION SYSTEM
        // ====================================================================
        
        /** @type {boolean} Flag for active shape movement operation */
        this.isMovingShape = false;
        
        /** @type {boolean} Flag for active shape resizing operation */
        this.isResizingShape = false;

        /** @type {boolean} Flag for active shape rotation operation */
        this.isRotatingShape = false;

        /** @type {THREE.Mesh} Rotation handle object for the selected shape */
        this.rotateHandle = null;
        
        /** @type {Array<THREE.Mesh>} Resize handle objects for selected shapes */
        this.resizeHandles = [];
        
        /** @type {THREE.Mesh} Currently active resize handle */
        this.activeHandle = null;
        
        /** @type {THREE.Vector2} Mouse position at transformation start */
        this.transformStartPos = new THREE.Vector2();
        
        /** @type {Object} Shape state at transformation start */
        this.shapeStartTransform = {};
        
        /** @type {boolean} Flag for text editing mode */
        this.isEditingText = false;

        // ====================================================================
        // APPLICATION STATE MANAGEMENT
        // ====================================================================
        
        /** @type {boolean} Master edit mode flag */
        this.editMode = false;
        
        /** @type {string} Current edit sub-mode (select, add, remove, etc.) */
        this.editSubMode = 'select';
        
        /** @type {string} Currently active application tab */
        this.activeTab = 'view';
        
        /** @type {string} Currently selected tool */
        this.activeTool = null;
        
        /** @type {Array<number>} Selected waypoints for lane editing */
        this.laneEditSelection = [];
        
        /** @type {Set<number>} Set of selected waypoint indices */
        this.selectedIndices = new Set();
        
        /** @type {number} Index of currently hovered waypoint */
        this.hoveredPointIndex = null;
        
        /** @type {Array<number>} Mapping from visual index to database ID */
        this.indexToDbId = [];
        
        /** @type {number} Dynamic point size based on camera distance */
        this.dynamicPointSize = 0.05;
        
        /** @type {THREE.Vector3} Offset for coordinate system alignment */
        this.mapOffset = new THREE.Vector3();

        // ====================================================================
        // WAYPOINT MANIPULATION STATE
        // ====================================================================
        
        /** @type {boolean} Flag for active point dragging operation */
        this.isDraggingPoint = false;

        // NEW: State management for the new persistent drawing tool
        /** @type {boolean} Global flag for the persistent 'Draw Points' mode */
        this.isPersistentDrawing = false;
        /** @type {boolean} Flag indicating if the first point has been placed in a persistent drawing session */
        this.isDrawingPoints = false;
        
        /** @type {THREE.Plane} Fixed drawing plane to prevent jumping during draw operations */
        this.drawingPlane = null;
        /** @type {THREE.Vector3} Starting point for drawing a line of points */
        this.drawPointsStartPoint = new THREE.Vector3();
        /** @type {number|null} DB ID of the starting point for a drawing segment */
        this.drawPointsStartDbId = null;
        /** @type {THREE.Line} Visual feedback line for drawing points */
        this.ghostLine = null;

        /** @type {number} Index of point being dragged */
        this.dragStartIndex = -1;
        
        /** @type {THREE.Vector3} Offset from click point to drag point */
        this.dragStartOffset = new THREE.Vector3();
        
        /** @type {Map<number, THREE.Vector3>} Original positions for drag operation */
        this.dragStartPositions = new Map();
        
        /** @type {number} Starting index for path selection */
        this.pathSelectionStartIndex = null;
        
        /** @type {Map<number, THREE.Vector3>} Original positions for interpolation preview */
        this.interpolationOriginalPositions = new Map();

        /** @type {boolean} Flag for active point dragging operation */
        this.isDraggingPoint = false;

        // NEW: State for turn detection
        /** @type {Set<number>} Set of waypoint indices identified as being part of a turn */
        this.turnPointIndices = new Set();

        // NEW: State management for the new persistent drawing tool
        /** @type {boolean} Global flag for the persistent 'Draw Points' mode */
        this.isPersistentDrawing = false;


        // ====================================================================
        // SELECTION SYSTEM
        // ====================================================================
        
        /** @type {boolean} Flag for active marquee selection */
        this.isMarqueeSelecting = false;
        
        /** @type {THREE.Vector2} Starting point of marquee selection */
        this.marqueeStart = new THREE.Vector2();
        
        /** @type {THREE.Vector2} Ending point of marquee selection */
        this.marqueeEnd = new THREE.Vector2();

        // ====================================================================
        // DATABASE AND PERSISTENCE
        // ====================================================================
        
        /** @type {Database} SQLite database instance */
        this.db = null;
        
        /** @type {Object} SQL.js library reference */
        this.SQL = null;

        // ====================================================================
        // INTERACTION AND RENDERING
        // ====================================================================
        
        /** @type {THREE.Raycaster} Ray casting utility for mouse interaction */
        this.raycaster = new THREE.Raycaster();
        
        /** @type {THREE.Vector2} Normalized mouse coordinates */
        this.pointer = new THREE.Vector2();
        
        /** @type {THREE.Plane} Plane for ray intersection calculations */
        this.raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        
        /** @type {boolean} Application initialization status */
        this.isInitialized = false;
        
        /** @type {number} Animation frame request ID */
        this.animationId = null;

        this.waypointsData = [];

        console.log('ðŸš€ ViryaOSLaneStudio Application starting...');
    }

    // ====================================================================
    // INITIALIZATION AND SETUP METHODS
    // ====================================================================

    /**
     * Initialize the complete ViryaOSLaneStudio system
     * Sets up rendering, database, UI, and starts the main application loop
     * * @async
     * @throws {Error} If critical components fail to initialize
     */
    async init() {
        try {
            console.log('ðŸ”§ Initializing ViryaOSLaneStudio system...');
            const container = document.getElementById('app');
            if (!container) {
                throw new Error('Main app container not found');
            }

            await this.initDatabase();
            this.loadFont();
            this.setupRenderer(container);
            this.setupLighting();
            this.createHoverIndicator();
            
            // Configure raycaster for point cloud interaction
            this.raycaster.params.Points.threshold = 0.05;
            
            this.setView('orbit');
            this.attachEventListeners();
            this.startAnimationLoop();

            this.isInitialized = true;

            console.log('');
            console.log('ðŸŽ‰ ===== ViryaOSLaneStudio READY =====');
            console.log('âœ… Direct manipulation for shapes (move/resize)');
            console.log('âœ… Double-click to edit text enabled');
            console.log('âœ… Removed conflicting transform logic');
            console.log('');
            console.log('ðŸ› DEBUG: window.waypointEditPlus.getStatus()');
            console.log('=====================================');
        } catch (error) {
            console.error('âŒ Failed to initialize ViryaOSLaneStudio:', error);
            this.showErrorMessage(error.message);
        }
    }

    /**
     * Initialize the SQLite database engine for waypoint persistence
     * * @async
     * @returns {Promise<boolean>} Success status of database initialization
     */
    async initDatabase() {
        try {
            if (typeof initSqlJs !== 'undefined') {
                this.SQL = await initSqlJs({
                    locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
                });
                console.log('âœ… SQL.js initialized for ViryaOSLaneStudio');
                return true;
            } else {
                console.warn('âš ï¸ SQL.js not available');
                return false;
            }
        } catch (error) {
            console.error('âŒ Failed to initialize SQL.js:', error);
            return false;
        }
    }

    /**
     * Setup the WebGL renderer with optimized settings
     * * @param {HTMLElement} container - DOM container for the renderer
     */
    setupRenderer(container) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        container.appendChild(this.renderer.domElement);
        window.addEventListener('resize', () => this.onWindowResize());
    }

    /**
     * Configure scene lighting and add visual aids (grid)
     */
    setupLighting() {
        // Ambient lighting for overall scene illumination
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        
        // Directional light for depth perception
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(2, 2, 3);
        this.scene.add(directionalLight);

        // Grid helper for spatial reference
        const gridHelper = new THREE.GridHelper(10, 20, 0x3d4a66, 0x202838);
        gridHelper.rotation.x = Math.PI / 2;
        this.scene.add(gridHelper);

        // Add group containers to scene
        this.scene.add(this.pathGroup);
        this.scene.add(this.shapeGroup);
    }

    // ====================================================================
    // COORDINATE SYSTEM UTILITIES
    // ====================================================================

    /**
     * Convert ROS coordinates to Three.js coordinates
     * * @param {Object} v - ROS coordinate vector {x, y, z}
     * @returns {THREE.Vector3} Three.js coordinate vector
     */
    rosToThree(v) {
        return new THREE.Vector3(-v.y, v.x, v.z);
    }

    /**
     * Convert Three.js coordinates to ROS coordinates
     * * @param {THREE.Vector3} v - Three.js coordinate vector
     * @returns {THREE.Vector3} ROS coordinate vector
     */
    threeToRos(v) {
        return new THREE.Vector3(v.y, -v.x, v.z);
    }

    // ====================================================================
    // UI UTILITY METHODS
    // ====================================================================

    /**
     * Show loading indicator
     */
    showLoader() { 
        document.getElementById('loader').style.display = 'block'; 
    }

    /**
     * Hide loading indicator
     */
    hideLoader() { 
        document.getElementById('loader').style.display = 'none'; 
    }

    /**
     * Show error message to user
     * * @param {string} message - Error message to display
     */
    showErrorMessage(message) {
        console.error('Error:', message);
        //alert(`Error: ${message}`);
    }


        // ====================================================================
    // ANIMATION AND RENDERING
    // ====================================================================

    /**
     * Start the main animation loop for continuous rendering
     */
    startAnimationLoop() {
        const tick = () => {
            this.animationId = requestAnimationFrame(tick);
            
            // Update controls
            if (this.controls) this.controls.update();
            
            // Update hover indicator
            if (this.hoverIndicator.visible && this.camera) {
                this.hoverIndicator.quaternion.copy(this.camera.quaternion);
                if (this.camera.isOrthographicCamera) {
                    const scale = (this.camera.top - this.camera.bottom) / window.innerHeight;
                    this.hoverIndicator.scale.setScalar(scale * 15);
                } else {
                    const distance = this.hoverIndicator.position.distanceTo(this.camera.position);
                    const vFOV = THREE.MathUtils.degToRad(this.camera.fov);
                    const height = 2 * Math.tan(vFOV / 2) * distance;
                    const scale = height / this.renderer.domElement.clientHeight * 15;
                    this.hoverIndicator.scale.setScalar(scale);
                }
            }
            
            this.renderer.render(this.scene, this.camera);
        };
        tick();
    }

    

    // ====================================================================
    // FILE LOADING AND DATA MANAGEMENT
    // ====================================================================

    /**
     * Load point cloud file (PLY or PCD format)
     * * @async
     * @param {File} file - Point cloud file to load
     * @returns {Promise} Loading completion promise
     */
    async loadPointCloudFile(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const loader = file.name.toLowerCase().endsWith('.ply') ? new PLYLoader() : new PCDLoader();

            loader.load(url, (object) => {
                try {
                    const geometry = object.isPoints ? object.geometry : object;

                    // Clean up existing point cloud
                    if (this.mapObject) {
                        this.scene.remove(this.mapObject);
                        this.mapObject.geometry.dispose();
                        this.mapObject.material.dispose();
                    }

                    // Apply coordinate transformation and centering
                    this.applyROSTransformation(geometry);
                    geometry.computeBoundingBox();
                    geometry.boundingBox.getCenter(this.mapOffset);
                    geometry.translate(-this.mapOffset.x, -this.mapOffset.y, -this.mapOffset.z);

                    this.originalMapGeometry = geometry.clone();
                    const material = new THREE.PointsMaterial({
                        size: 0.5,
                        vertexColors: this.originalMapGeometry.attributes.color !== undefined
                    });

                    this.mapObject = new THREE.Points(this.originalMapGeometry.clone(), material);
                    this.scene.add(this.mapObject);

                    if (this.db) {
                        this.refreshWaypointsFromDB();
                    }

                    this.setView('orbit');
                    URL.revokeObjectURL(url);
                    console.log(`âœ… Loaded point cloud: ${file.name}`);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }, undefined, reject);
        });
    }

    /**
     * Apply ROS to Three.js coordinate system transformation
     * * @param {THREE.BufferGeometry} geometry - Geometry to transform
     */
    applyROSTransformation(geometry) {
        const positions = geometry.attributes.position.array;
        for (let i = 0; i < positions.length; i += 3) {
            let x = positions[i];
            let y = positions[i + 1];
            positions[i] = -y;      // ROS Y becomes Three.js -X
            positions[i + 1] = x;   // ROS X becomes Three.js Y
        }
        geometry.attributes.position.needsUpdate = true;
        console.log('âœ… Applied ROS coordinate transformation');
    }

    /**
     * Load waypoints from SQLite database file
     * * @async
     * @param {File} file - Database file to load
     */
    async loadWaypointsFromFile(file) {
        if (!this.SQL) {
            alert("Database engine is not ready yet. Please wait a moment and try again.");
            return;
        }

        try {
            const buffer = await file.arrayBuffer();
            if (this.db) this.db.close();
            this.clearLane();

            this.db = new this.SQL.Database(new Uint8Array(buffer));

            // ===================== FIX 1 START =====================
            // Ensure the edge_graph table exists. If it already does, this command does nothing.
            // This prevents errors when loading a DB that was created before the graph feature was added.
            this.db.run(EDGE_GRAPH_TABLE_SQL);
            this.db.run(JUNCTION_POINTS_TABLE_SQL);
            // ===================== FIX 1 END =======================

            // Ensure all required columns exist
            const columns = this.db.exec("PRAGMA table_info(waypoints);")[0].values;

            if (!columns.some(col => col[1] === 'zone')) {
                this.db.run("ALTER TABLE waypoints ADD COLUMN zone TEXT DEFAULT 'N/A';");
            }
            if (!columns.some(col => col[1] === 'width_left')) {
                this.db.run("ALTER TABLE waypoints ADD COLUMN width_left REAL DEFAULT 0.5;");
            }
            if (!columns.some(col => col[1] === 'width_right')) {
                this.db.run("ALTER TABLE waypoints ADD COLUMN width_right REAL DEFAULT 0.5;");
            }
            if (!columns.some(col => col[1] === 'two_way')) {
                this.db.run("ALTER TABLE waypoints ADD COLUMN two_way INTEGER DEFAULT 0;");
            }

            this.db.run("UPDATE waypoints SET zone = 'N/A' WHERE zone IS NULL;");

            // Validate table structure
            const tableCheck = this.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='waypoints'");
            if (tableCheck.length === 0) {
                throw new Error("No waypoints table found in the database");
            }

            await this.refreshWaypointsFromDB();
            console.log('âœ… ViryaOSLaneStudio waypoints loaded successfully');
        } catch (err) {
            console.error("âŒ Error loading database:", err);
            alert(`Error loading database: ${err.message}`);
        }
    }


    /**
     * Refresh waypoint visualization from database
     * * @async
     */
    async refreshWaypointsFromDB() {
        this.clearVisualWaypoints();
        if (!this.db) return;

        try {
            const stmt = this.db.prepare("SELECT id, x, y, z FROM waypoints ORDER BY id;");
            const positions = [];
            this.indexToDbId = [];
            this.waypointsData = [];

            while (stmt.step()) {
               const row = stmt.get();
                const dbId = row[0];
                const twoWayFlag = row[4];

                this.indexToDbId.push(dbId);

                const transformed = this.rosToThree({ x: row[1], y: row[2], z: row[3] });
                const position = transformed.clone().sub(this.mapOffset);
                
                positions.push(position.x, position.y, position.z);

                // Store the data together
                this.waypointsData.push({
                    id: dbId,
                    pos: position,
                    two_way: twoWayFlag
                });
            }
            stmt.free();

            if (positions.length === 0) return;

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

            const material = new THREE.PointsMaterial({
                size: this.dynamicPointSize,
                vertexColors: true
            });

            this.waypointsObject = new THREE.Points(geometry, material);
            this.updateAllColors();
            this.scene.add(this.waypointsObject);

            this.updateWaypointVisuals();
            this.updateWaypointCount();
        } catch (err) {
            console.error("âŒ Error loading waypoints:", err);
        }
    }

    /**
     * Clear waypoint visualization from scene
     */
    clearVisualWaypoints() {
        if (this.waypointsObject) {
            this.scene.remove(this.waypointsObject);
            this.waypointsObject.geometry.dispose();
            this.waypointsObject.material.dispose();
            this.waypointsObject = null;
        }
        this.clearSelection();
        this.indexToDbId = [];
    }


    // ====================================================================
    // WAYPOINT INTERACTION METHODS
    // ====================================================================

    /**
     * Convert screen coordinates to normalized device coordinates
     * * @param {PointerEvent} event - Pointer event
     * @returns {Object} Normalized coordinates {x, y}
     */
    getPointerCoordinates(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        return {
            x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
            y: -((event.clientY - rect.top) / rect.height) * 2 + 1
        };
    }

    /**
     * Transform world coordinates to local coordinate system
     * * @param {THREE.Vector3} worldPoint - World coordinate point
     * @returns {THREE.Vector3} Local coordinate point
     */
    transformWorldToLocal(worldPoint) {
        return worldPoint.clone().sub(this.mapOffset);
    }

    /**
     * Transform local coordinates to world coordinate system
     * * @param {THREE.Vector3} localPoint - Local coordinate point
     * @returns {THREE.Vector3} World coordinate point
     */
    transformLocalToWorld(localPoint) {
        return localPoint.clone().add(this.mapOffset);
    }

    updateWaypointCount() {
        const waypointCount = document.getElementById('waypoint-count');
        if (waypointCount) {
            waypointCount.textContent = this.indexToDbId.length.toString();
        }
    }

// ====================================================================
    // APPLICATION STATE MANAGEMENT
    // ====================================================================

    /**
     * Set application edit mode
     * * @param {string} mode - Edit mode ('waypoint-edit', 'lane-edit', 'layout-drawings')
     */
    setEditMode(mode) {
        this.editMode = ['waypoint-edit', 'lane-edit', 'layout-drawings'].includes(mode);
        this.activeTab = mode;
        console.log(`ðŸ“ Edit mode: ${this.editMode ? 'ON' : 'OFF'}`);
        if (!this.editMode) {
            this.clearSelection();
            this.clearShapeSelection();
        }
    }

    /**
     * Select active tool for editing operations
     * @param {string} toolName - Logical name of the tool to activate (e.g., 'square', 'move-points')
     * @param {string|null} buttonId - The specific ID of the button element that was clicked
     */
    selectTool(toolName, buttonId = null) {
        // NEW: Exit persistent drawing mode if another tool is selected.
        if (this.isPersistentDrawing && toolName !== 'draw-points') {
            this.exitPersistentDrawing();
        }

        this.activeTool = toolName;
        console.log(`ðŸ› ï¸ Selected tool: ${toolName}`);

        // Remove the 'active' class from all tool buttons
        const toolButtons = document.querySelectorAll('.tool-button, .tool-button-large, .tool-button-layout, .action-btn');
        toolButtons.forEach(btn => btn.classList.remove('active'));

        let activeBtn;
        if (buttonId) {
            activeBtn = document.getElementById(buttonId);
        } else {
            activeBtn = document.getElementById(`tool-${toolName}`);
        }

        if (activeBtn) {
            activeBtn.classList.add('active');
        }

        // NEW: Handle entering persistent drawing mode.
        if (toolName === 'draw-points') {
            this.isPersistentDrawing = true;
            this.controls.enabled = false; // Disable camera controls while this tool is active
            document.getElementById('app').style.cursor = 'crosshair';
        } else {
            this.isPersistentDrawing = false;
            this.controls.enabled = true;
            document.getElementById('app').style.cursor = 'default';
        }

        if (!['square', 'oval', 'arrow', 'line', 'insert-text'].includes(toolName)) {
            this.isDrawing = false;
        }

        this.clearSelection();
    }

    /**
     * Handle pointer down events for interaction initiation
     * * @param {PointerEvent} event - Pointer down event
     */
    async onPointerDown(event) {
    if (!this.camera) return;

    // This block handles only the "Persistent Drawing" mode and should be at the top.
    if (this.isPersistentDrawing) {
        const coords = this.getPointerCoordinates(event);
        this.pointer.copy(coords);
        this.raycaster.setFromCamera(this.pointer, this.camera);

        let intersectionPoint;
        let targetDbId = null;

        // Check if the user clicked on an existing point
        const clickedIndex = this.findClosestPoint(event);
        if (clickedIndex !== -1) {
            // If so, use that point's data
            const positions = this.waypointsObject.geometry.attributes.position;
            intersectionPoint = new THREE.Vector3().fromBufferAttribute(positions, clickedIndex);
            targetDbId = this.indexToDbId[clickedIndex];
        } else {
            // Otherwise, find the intersection on the map or a virtual plane
            const mapIntersects = this.mapObject ? this.raycaster.intersectObject(this.mapObject) : [];
            if (mapIntersects.length > 0) {
                intersectionPoint = mapIntersects[0].point;
            } else {
                const planeIntersect = new THREE.Vector3();
                if (this.raycaster.ray.intersectPlane(this.raycastPlane, planeIntersect)) {
                    intersectionPoint = planeIntersect;
                }
            }
        }
        
        if (!intersectionPoint) return; // Exit if no valid click location is found

        if (!this.isDrawingPoints) {
            // This is the VERY FIRST click of a new drawing session
            this.drawPointsStartPoint.copy(intersectionPoint);
            if (clickedIndex !== -1) {
               this.drawPointsStartDbId = targetDbId;
            } else {
               // Create the first point if the click is in empty space
               const firstId = await this.batchAddPoints([intersectionPoint], null);
               this.drawPointsStartDbId = firstId;
            }
            this.isDrawingPoints = true;
        } else {
            // This is for all subsequent clicks in a drawing session
            const lastAddedId = await this.drawPoints(this.drawPointsStartPoint, intersectionPoint, this.drawPointsStartDbId, targetDbId);
            
            // --- STATE MANAGEMENT FIX ---
            // The new "start point" for the next segment is always the point we just clicked on.
            this.drawPointsStartPoint.copy(intersectionPoint);
            // The new "start ID" is the ID of the point we clicked on (targetDbId) if it exists,
            // otherwise it's the ID of the last new point we created (lastAddedId).
            this.drawPointsStartDbId = targetDbId !== null ? targetDbId : lastAddedId;
        }
        return; // End the function here for persistent drawing mode
    }

    // --- The rest of the logic for other tools and tabs follows here ---

    this.transformStartPos.set(event.clientX, event.clientY);

    if (this.activeTab === 'waypoint-edit') {
        // NOTE: The redundant 'isPersistentDrawing' block has been removed from here.
        const clickedIndex = this.findClosestPoint(event);
        this.raycaster.params.Points.threshold = this.dynamicPointSize;

        switch (this.activeTool) {
            case 'remove-points':
            case 'move-points':
                this.handleSelectionPointerDown(clickedIndex, event);
                break;
            case 'interpolate':
                if (clickedIndex !== -1) {
                    if (this.pathSelectionStartIndex === null) {
                        document.getElementById('interpolation-panel').classList.remove('hidden');
                        this.clearSelection();
                        this.pathSelectionStartIndex = clickedIndex;
                        this.selectedIndices.add(clickedIndex);
                    } else {
                        const start = Math.min(this.pathSelectionStartIndex, clickedIndex);
                        const end = Math.max(this.pathSelectionStartIndex, clickedIndex);
                        for (let i = start; i <= end; i++) this.selectedIndices.add(i);
                        this.pathSelectionStartIndex = null;
                    }
                    this.updateAllColors();
                    this.updateInterpolationPanel();
                } else {
                    this.clearSelection();
                }
                break;
            case 'two-way':
                 if (clickedIndex !== -1) {
                    if (this.pathSelectionStartIndex === null) {
                        document.getElementById('two-way-panel').classList.remove('hidden');
                        this.clearSelection();
                        this.pathSelectionStartIndex = clickedIndex;
                        this.selectedIndices.add(clickedIndex);
                    } else {
                        const start = Math.min(this.pathSelectionStartIndex, clickedIndex);
                        const end = Math.max(this.pathSelectionStartIndex, clickedIndex);
                        for (let i = start; i <= end; i++) this.selectedIndices.add(i);
                        this.pathSelectionStartIndex = null;
                    }
                    this.updateAllColors();
                    this.updateTwoWayPanel();
                } else {
                    this.clearSelection();
                }
                break;
        }
    } else if (this.activeTab === 'lane-edit') {
         const clickedIndex = this.findClosestPoint(event);
         if (clickedIndex !== -1) {
            if (this.laneEditSelection.length < 2 && !this.laneEditSelection.includes(clickedIndex)) {
                this.laneEditSelection.push(clickedIndex);
            } else {
                this.laneEditSelection = [clickedIndex];
            }
            this.updateLaneEditInfo();
        }
    } else if (this.activeTab === 'layout-drawings') {
        // Layout drawings interaction logic (unchanged)
        const handleIntersects = this.raycaster.intersectObjects(this.resizeHandles);
        const shapeIntersects = this.raycaster.intersectObjects(this.shapes);

        if (handleIntersects.length > 0) {
            const handle = handleIntersects[0].object;
            this.isResizingShape = true;
            this.activeHandle = handle;
            this.controls.enabled = false;
            
            const shape = handle.userData.parentShape;
            const planeIntersect = new THREE.Vector3();
            this.raycaster.ray.intersectPlane(this.raycastPlane, planeIntersect);
            
            this.shapeStartTransform = {
                position: shape.position.clone(),
                scale: shape.scale.clone(),
                startDragPoint: planeIntersect.clone(),
                initialSize: new THREE.Box3().setFromObject(shape).getSize(new THREE.Vector3())
            };
            return;
        }

        if (shapeIntersects.length > 0) {
            const shape = shapeIntersects[0].object;
            this.selectShape(shape);
            this.isMovingShape = true;
            this.controls.enabled = false;
            
            const planeIntersect = new THREE.Vector3();
            this.raycaster.ray.intersectPlane(this.raycastPlane, planeIntersect);

            this.shapeStartTransform = {
                position: shape.position.clone(),
                offset: shape.position.clone().sub(planeIntersect)
            };
            return;
        }

        if (['square', 'oval', 'arrow', 'line'].includes(this.activeTool)) {
            const point = new THREE.Vector3();
            if (this.raycaster.ray.intersectPlane(this.raycastPlane, point)) {
                this.drawStartPoint.copy(point);
                this.isDrawing = true;
                this.controls.enabled = false;
            }
            return;
        }
         
        if (this.activeTool === 'insert-text') {
            const point = new THREE.Vector3();
            if (this.raycaster.ray.intersectPlane(this.raycastPlane, point)) {
                this.textInsertionPoint = point;
                this.showTextInputModal();
            }
            this.selectTool(null);
            return;
        }

        this.clearShapeSelection();
    }
    }
    /**
     * Handle pointer move events for drag operations and hover feedback
     * * @param {PointerEvent} event - Pointer move event
     */
    onPointerMove(event) {
        if (!this.camera) return;

        const coords = this.getPointerCoordinates(event);
        this.pointer.copy(coords);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        
        // MODIFIED: Logic for the persistent drawing tool's preview line
        if (this.isDrawingPoints) {
            if (this.ghostLine) {
                this.scene.remove(this.ghostLine);
                this.ghostLine.geometry.dispose();
                this.ghostLine.material.dispose();
            }
            
            // Create a dynamic plane for smooth previewing
            this.drawingPlane = new THREE.Plane();
            const cameraDirection = new THREE.Vector3();
            this.camera.getWorldDirection(cameraDirection);
            this.drawingPlane.setFromNormalAndCoplanarPoint(cameraDirection.negate(), this.drawPointsStartPoint);
            
            const currentPoint = new THREE.Vector3();
            if (this.drawingPlane && this.raycaster.ray.intersectPlane(this.drawingPlane, currentPoint)) {
                const points = [this.drawPointsStartPoint, currentPoint];
                const geometry = new THREE.BufferGeometry().setFromPoints(points);
                const material = new THREE.LineDashedMaterial({
                    color: 0x00ffff,
                    linewidth: 2,
                    scale: 1,
                    dashSize: 0.1,
                    gapSize: 0.1,
                });
                this.ghostLine = new THREE.Line(geometry, material);
                this.ghostLine.computeLineDistances();
                this.scene.add(this.ghostLine);
            }
            return;
        }

        const planeIntersect = new THREE.Vector3();
        if (!this.raycaster.ray.intersectPlane(this.raycastPlane, planeIntersect)) {
             this.updateHoverCoordinates(null);
             return;
        }
        const currentPoint = planeIntersect;

        if (this.isMovingShape) {
            this.selectedShape.position.copy(currentPoint).add(this.shapeStartTransform.offset);
            
            // CORRECTED: Manually sync outline position instead of calling .update()
            if (this.selectedShape.selectionOutline) {
                this.selectedShape.selectionOutline.position.copy(this.selectedShape.position);
            }

            this.updateResizeHandlePositions(this.selectedShape);
            return;
        }

        if (this.isResizingShape) {
            const shape = this.selectedShape;
            const handleIndex = this.activeHandle.userData.handleIndex;
            
            const originalSize = this.shapeStartTransform.initialSize;
            const originalCenter = this.shapeStartTransform.position;
            
            const anchor = new THREE.Vector3();
            const handleSign = new THREE.Vector2(
                (handleIndex === 0 || handleIndex === 3) ? 1 : -1,
                (handleIndex === 0 || handleIndex === 1) ? 1 : -1
            );
            anchor.set(
                originalCenter.x + (originalSize.x / 2 * handleSign.x),
                originalCenter.y + (originalSize.y / 2 * handleSign.y),
                originalCenter.z
            );
            
            const newWidth = Math.abs(currentPoint.x - anchor.x);
            const newHeight = Math.abs(currentPoint.y - anchor.y);
            const newCenter = new THREE.Vector3().addVectors(anchor, currentPoint).multiplyScalar(0.5);

            shape.position.copy(newCenter);
            if (originalSize.x > 0.01) shape.scale.x = (newWidth / originalSize.x) * this.shapeStartTransform.scale.x;
            if (originalSize.y > 0.01) shape.scale.y = (newHeight / originalSize.y) * this.shapeStartTransform.scale.y;
            
            // CORRECTED: Manually sync outline position and scale instead of calling .update()
            if (shape.selectionOutline) {
                shape.selectionOutline.position.copy(shape.position);
                shape.selectionOutline.scale.copy(shape.scale);
            }

            this.updateResizeHandlePositions(shape);
            return;
        }

        if (this.isDraggingPoint) {
            const intersection = new THREE.Vector3();
            if (this.raycaster.ray.intersectPlane(this.raycastPlane, intersection)) {
                const positions = this.waypointsObject.geometry.attributes.position;
                const newDragPointPos = intersection.clone().add(this.dragStartOffset);
                const initialDraggedPointPos = this.dragStartPositions.get(this.dragStartIndex);
                if (initialDraggedPointPos) {
                    const delta = new THREE.Vector3().subVectors(newDragPointPos, initialDraggedPointPos);

                    for (const index of this.selectedIndices) {
                        const initialPos = this.dragStartPositions.get(index);
                        if (initialPos) {
                            const newPos = initialPos.clone().add(delta);
                            positions.setXYZ(index, newPos.x, newPos.y, newPos.z);
                        }
                    }
                    positions.needsUpdate = true;
                }
            }
            return;
        }

        if (this.isDrawing) {
            if (this.ghostShape) {
                this.shapeGroup.remove(this.ghostShape);
                this.ghostShape.geometry.dispose();
                this.ghostShape.material.dispose();
            }
            this.ghostShape = this.addShape(this.activeTool, this.drawStartPoint, currentPoint, true);
            return;
        }

        this.handleHover(event);
        this.updateHoverCoordinates(this.getWorldCoordinates(event.clientX, event.clientY));
        
        if (this.isMarqueeSelecting) {
            this.marqueeEnd.set(event.clientX, event.clientY);
            const left = Math.min(this.marqueeStart.x, this.marqueeEnd.x);
            const top = Math.min(this.marqueeStart.y, this.marqueeEnd.y);
            const width = Math.abs(this.marqueeStart.x - this.marqueeEnd.x);
            const height = Math.abs(this.marqueeStart.y - this.marqueeEnd.y);

            const selectionBox = document.getElementById('selection-box');
            if (selectionBox) {
                selectionBox.style.left = `${left}px`;
                selectionBox.style.top = `${top}px`;
                selectionBox.style.width = `${width}px`;
                selectionBox.style.height = `${height}px`;
            }
            this.updateSelectionFromMarquee();
        }
    }
    /**
     * Handle pointer up events to finalize interactions
     * * @param {PointerEvent} event - Pointer up event
     */
    onPointerUp(event) {
        // MODIFIED: This function now does nothing for the persistent drawing tool.
        // The logic was moved to onPointerDown.

        if (this.isDrawing) {
            if (this.ghostShape) {
                this.shapeGroup.remove(this.ghostShape);
                this.ghostShape.geometry.dispose();
                this.ghostShape.material.dispose();
            }
            const coords = this.getPointerCoordinates(event);
            this.pointer.copy(coords);
            this.raycaster.setFromCamera(this.pointer, this.camera);
            
            const endPoint = new THREE.Vector3();
            if (this.raycaster.ray.intersectPlane(this.raycastPlane, endPoint)) {
                this.addShape(this.activeTool, this.drawStartPoint, endPoint);
            }
            this.isDrawing = false;
        }

        if (this.isDraggingPoint) {
            const positions = this.waypointsObject.geometry.attributes.position;
            const indicesToUpdate = Array.from(this.selectedIndices);
            const newPositions = indicesToUpdate.map(index => 
                new THREE.Vector3().fromBufferAttribute(positions, index));
            this.batchUpdateDbPositions(indicesToUpdate, newPositions);

            this.isDraggingPoint = false;
            document.getElementById('app').classList.remove('draggable');
        }

        if (this.isMovingShape || this.isResizingShape) {
            this.isMovingShape = false;
            this.isResizingShape = false;
            this.activeHandle = null;
        }

        if (this.isMarqueeSelecting) {
            this.isMarqueeSelecting = false;
            const selectionBox = document.getElementById('selection-box');
            if (selectionBox) selectionBox.style.display = 'none';
            this.updateInfoPanel();
        }
        
        // MODIFIED: Do not re-enable controls if in persistent drawing mode.
        if (this.controls && !this.isPersistentDrawing) {
            this.controls.enabled = true;
        }
    }

    /**
     * Handle double-click events for text editing
     * * @param {PointerEvent} event - Double-click event
     */
    onDblClick(event) {
        if (this.activeTab !== 'layout-drawings') return;

        const coords = this.getPointerCoordinates(event);
        this.pointer.copy(coords);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        
        const intersects = this.raycaster.intersectObjects(this.shapes);
        const textIntersect = intersects.find(hit => hit.object.userData.type === 'text');

        if (textIntersect) {
            this.selectShape(textIntersect.object);
            this.showTextInputModal(true, this.selectedShape.userData.originalText);
        }
    }

    /**
     * Exports the current state of the database to a downloadable file.
     * The edge_graph table is populated during drawing actions, not here.
     * @async
     */
    async exportDatabase() {
        if (!this.db) {
            alert("No database is loaded to export.");
            return;
        }
    
        console.log('ðŸš€ Exporting database...');
        this.showLoader();
    
        try {
            const data = this.db.export();
            const blob = new Blob([data], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
    
            const a = document.createElement("a");
            a.href = url;
            a.download = "waypoints_with_graph.db";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
    
            console.log('ðŸŽ‰ Database exported successfully!');
            this.showErrorMessage("Database exported successfully!"); 
    
        } catch (error) {
            console.error('âŒ Failed to export database:', error);
            this.showErrorMessage(`Export failed: ${error.message}`);
        } finally {
            this.hideLoader();
        }
    }
    /**
     * Get world coordinates from screen position
     * * @param {number} x - Screen X coordinate
     * @param {number} y - Screen Y coordinate
     * @returns {THREE.Vector3|null} World coordinates or null if no intersection
     */
    getWorldCoordinates(x, y) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2();
        mouse.x = ((x - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((y - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(mouse, this.camera);
        this.raycaster.params.Points.threshold = 0.5;

        // Prioritize intersecting with the map object
        const intersects = this.raycaster.intersectObjects([this.mapObject, this.waypointsObject].filter(Boolean));
        if (intersects.length > 0) {
            return intersects[0].point;
        }

        // Fallback to the ground plane
        const planeIntersect = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(this.raycastPlane, planeIntersect)) {
            return planeIntersect;
        }

        return null;
    }

    /**
     * Attach all necessary event listeners for application interaction
     */
    attachEventListeners() {
        // File input handlers
        document.getElementById('pcd-file').addEventListener('change', async (event) => {
            const files = Array.from(event.target.files);
            if (files.length === 0) return;
            this.showLoader();
            try {
                for (const file of files) await this.loadPointCloudFile(file);
            } catch (error) {
                console.error('âŒ Failed to load point cloud:', error);
            } finally {
                this.hideLoader();
                event.target.value = '';
            }
        });

        document.getElementById('db-file').addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            this.showLoader();
            try {
                await this.loadWaypointsFromFile(file);
            } catch (error) {
                console.error('âŒ Failed to load database:', error);
            } finally {
                this.hideLoader();
                event.target.value = '';
            }
        });

        document.getElementById('export-db-btn').addEventListener('click', () => this.exportDatabase());


        // Tab switching
        ['view', 'waypoint-edit', 'lane-edit', 'layout-drawings'].forEach(tab => {
            document.getElementById(`tab-${tab}`).addEventListener('click', () => this.switchTab(tab));
        });

        // Point cloud controls
        const colorModeSelect = document.getElementById('color-mode');
        if (colorModeSelect) {
            colorModeSelect.addEventListener('change', (event) => {
                this.updatePointCloudColors(event.target.value);
            });
        }

        // Waypoint editing tools
        ['draw-points', 'remove-points', 'move-points', 'interpolate', 'two-way'].forEach(tool => {
            document.getElementById(`tool-${tool}`).addEventListener('click', () => this.selectTool(tool));
        });

        document.getElementById('linear-interpolate').addEventListener('click', () => this.linearInterpolateSelected());
        document.getElementById('mark-two-way').addEventListener('click', () => this.markSelectedAsTwoWay());

        //Delete confirmation
        document.getElementById('confirm-deletion').addEventListener('click', () => this.confirmDelete());
        document.getElementById('delete-confirm-cancel').addEventListener('click', () => this.cancelDelete());
        
        
        // Radial interpolation controls
        const radialSlider = document.getElementById('radial-strength');
        const radialValueInput = document.getElementById('radial-strength-value');

        radialSlider.addEventListener('input', () => this.syncAndPreviewRadial(parseFloat(radialSlider.value)));
        radialValueInput.addEventListener('input', () => {
            let value = parseFloat(radialValueInput.value);
            if (!isNaN(value)) {
                this.syncAndPreviewRadial(value);
            }
        });

        radialSlider.addEventListener('pointerdown', () => this.startRadialPreview());
        radialValueInput.addEventListener('focus', () => this.startRadialPreview());
    
        radialSlider.addEventListener('change', () => this.commitRadialChange());
        radialValueInput.addEventListener('change', () => this.commitRadialChange());

        // Lane editing tools
        document.getElementById('generate-lane').addEventListener('click', () => this.generateLane());
        document.getElementById('delete-lane').addEventListener('click', () => this.clearLane());
        document.getElementById('tool-edit-lane').addEventListener('click', () => this.selectTool('edit-lane'));


        // Lane width controls
        ['left', 'right'].forEach(side => {
            const input = document.getElementById(`${side}-lane-width-input`);
            document.getElementById(`${side}-width-decrease-btn`).addEventListener('click', () => {
                input.value = (Math.max(0.0, parseFloat(input.value) - 0.05)).toFixed(2);
                this.applyAndRegenerateLaneWidth(side);
            });
            document.getElementById(`${side}-width-increase-btn`).addEventListener('click', () => {
                input.value = (parseFloat(input.value) + 0.05).toFixed(2);
                this.applyAndRegenerateLaneWidth(side);
            });
            input.addEventListener('change', () => this.applyAndRegenerateLaneWidth(side));
        });


        document.getElementById('generate-turn').addEventListener('click', () => this.generateturn());

        // Visual controls
        const voxelSizeSlider = document.getElementById('voxel-size');
        if (voxelSizeSlider) {
            voxelSizeSlider.addEventListener('input', (event) => {
                const size = parseFloat(event.target.value);
                if (this.mapObject && this.mapObject.material) {
                    const pointSizeSlider = document.getElementById('point-size');
                    const baseSize = pointSizeSlider ? parseFloat(pointSizeSlider.value) : 0.5;
                    this.mapObject.material.size = baseSize * size;
                    this.mapObject.material.needsUpdate = true;
                }
                const voxelValue = document.getElementById('voxel-value');
                if (voxelValue) voxelValue.textContent = size.toFixed(1);
            });
        }

        const opacitySlider = document.getElementById('opacity');
        if (opacitySlider) {
            opacitySlider.addEventListener('input', (event) => {
                const opacity = parseFloat(event.target.value);
                if (this.mapObject && this.mapObject.material) {
                    this.mapObject.material.transparent = opacity < 1.0;
                    this.mapObject.material.opacity = opacity;
                    this.mapObject.material.needsUpdate = true;
                }
                if (this.waypointsObject && this.waypointsObject.material) {
                    this.waypointsObject.material.transparent = opacity < 1.0;
                    this.waypointsObject.material.opacity = opacity;
                    this.waypointsObject.material.needsUpdate = true;
                }
                const opacityValue = document.getElementById('opacity-value');
                if (opacityValue) opacityValue.textContent = opacity.toFixed(2);
            });
        }

        // Layout drawing tools
        const layoutTools = {
            'tool-add-square': 'square',
            'tool-add-oval': 'oval',
            'tool-add-arrow': 'arrow',
            'tool-add-line': 'line',
            'layout-insert-text': 'insert-text',
            'tool-select-shape': 'select-shape',
            'layout-delete-element': 'delete-element',
            'layout-edit-text': 'edit-text'
        };

        for (const [buttonId, toolName] of Object.entries(layoutTools)) {
            const button = document.getElementById(buttonId);
            if (button) {
                // This now handles all layout buttons correctly
                button.addEventListener('click', () => this.selectTool(toolName, buttonId));
            }
        }

        // Add direct listeners for buttons that perform an immediate action
        document.getElementById('layout-delete-element').addEventListener('click', () => {
            this.deleteSelectedShape();
        });
        
        // Style controls
        document.getElementById('fill-color').addEventListener('input', () => this.applyColorToSelectedShape());
        document.getElementById('shape-opacity').addEventListener('input', (e) => {
            this.applyOpacityToSelectedShape();
            document.getElementById('shape-opacity-value').textContent = parseFloat(e.target.value).toFixed(2);
        });

         document.getElementById('rotate-ccw-btn').addEventListener('click', () => {
            this.rotateSelectedShape(-1); // Rotate -1 degree
        });
        document.getElementById('rotate-cw-btn').addEventListener('click', () => {
            this.rotateSelectedShape(1); // Rotate +1 degree
        });


        document.getElementById('text-color').addEventListener('input', (e) => {
            if (this.selectedShape && this.selectedShape.userData.type === 'text') {
                this.selectedShape.material.color.set(e.target.value);
            }
        });
        document.getElementById('text-size').addEventListener('input', (e) => {
            if (this.selectedShape && this.selectedShape.userData.type === 'text') {
                const newSize = parseFloat(e.target.value);
                this.selectedShape.scale.setScalar(newSize);
                if (this.selectedShape.selectionOutline) this.selectedShape.selectionOutline.update();
                this.updateResizeHandlePositions(this.selectedShape);
                document.getElementById('text-size-value').textContent = newSize.toFixed(2);
            }
        });

        // Bottom controls
        document.getElementById('point-size').addEventListener('input', (e) => {
            if (this.mapObject) this.mapObject.material.size = parseFloat(e.target.value);
            document.getElementById('size-value').textContent = parseFloat(e.target.value).toFixed(1);
        });
        document.getElementById('waypoint-size').addEventListener('input', (e) => {
            this.dynamicPointSize = parseFloat(e.target.value);
            this.updateWaypointVisuals();
            document.getElementById('waypoint-size-value').textContent = this.dynamicPointSize.toFixed(3);
        });
        document.getElementById('view-mode').addEventListener('change', (e) => this.setView(e.target.value));

        // Text input modal
        const textInputConfirm = document.getElementById('text-input-confirm');
        textInputConfirm.addEventListener('click', () => {
            const text = document.getElementById('text-input-field').value;
            if (this.isEditingText && this.selectedShape) {
                this.updateText(this.selectedShape, text);
            } else if (text && this.textInsertionPoint) {
                this.addTextLabel(text, this.textInsertionPoint);
            }
            this.hideTextInputModal();
        });
        document.getElementById('text-input-cancel').addEventListener('click', () => this.hideTextInputModal());
        document.getElementById('text-input-field').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') textInputConfirm.click();
            if (e.key === 'Escape') document.getElementById('text-input-cancel').click();
        });

        // Global event listeners
        this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown.bind(this), true);
        this.renderer.domElement.addEventListener('pointermove', this.onPointerMove.bind(this));
        this.renderer.domElement.addEventListener('pointerup', this.onPointerUp.bind(this));
        this.renderer.domElement.addEventListener('dblclick', this.onDblClick.bind(this));
        this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

        // Keyboard shortcuts
        document.addEventListener('keydown', (event) => {
            if (document.activeElement.tagName === 'INPUT') return;
            switch (event.key.toLowerCase()) {
                case 'escape':
                    // MODIFIED: Escape key now also exits the persistent drawing mode.
                    if (this.isPersistentDrawing) {
                        this.exitPersistentDrawing();
                    } else {
                        this.clearSelection();
                        this.clearShapeSelection();
                        this.switchTab('view');
                    }
                    break;
                case 'delete':
                case 'backspace':
                    if (this.selectedIndices.size > 0) {const modal = document.getElementById('delete-confirm');modal.classList.remove('hidden');}
                    if (this.selectedShape) this.deleteSelectedShape();
                    break;
            }
        });
    }

    /**
     * Switch between application tabs
     * * @param {string} tabName - Name of tab to switch to
     */
    switchTab(tabName) {
        console.log(`ðŸ“‘ Switching to tab: ${tabName}`);
        this.activeTab = tabName;
        this.clearSelection();
        this.clearShapeSelection();
        this.setEditMode(tabName);
        const waypointInfoPanel = document.getElementById('waypoint-info');
        if (waypointInfoPanel) {
            if (tabName === 'waypoint-edit') {
                waypointInfoPanel.classList.remove('hidden');
                // Immediately update the panel to reflect the current selection
                this.updateInfoPanel();
            } else {
                waypointInfoPanel.classList.add('hidden');
            }
        }
        // NEW: Ensure we exit persistent drawing mode when switching tabs.
        if (this.isPersistentDrawing) {
            this.exitPersistentDrawing();
        }

        // Update tab UI
        document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
        document.getElementById(`tab-${tabName}`).classList.add('active');
        
        // Clear tool selection
        document.querySelectorAll('.tool-button, .tool-button-large .tool-button-layout').forEach(b => b.classList.remove('active'));
        this.activeTool = null;
        
        this.updatePanelVisibility(tabName);
    }

    /**
     * Update panel visibility based on active tab
     * * @param {string} tabName - Name of active tab
     */
    updatePanelVisibility(tabName) {
        document.querySelectorAll('.side-panel').forEach(p => p.classList.add('hidden'));
        
        switch (tabName) {
            case 'waypoint-edit':
                document.getElementById('left-panel').classList.remove('hidden');
                document.getElementById('right-panel').classList.remove('hidden');
                break;
            case 'lane-edit':
                document.getElementById('left-lane-panel').classList.remove('hidden');
                document.getElementById('right-lane-panel').classList.remove('hidden');
                break;
            case 'layout-drawings':
                document.getElementById('left-layout-panel').classList.remove('hidden');
                document.getElementById('right-layout-panel').classList.remove('hidden');
                break;
        }
    }

    /**
     * Get application status for debugging
     * * @returns {Object} Current application status
     */
    getStatus() {
        return {
            initialized: this.isInitialized,
            activeTab: this.activeTab,
            activeTool: this.activeTool,
            editMode: this.editMode,
            hasPointCloud: !!this.mapObject,
            hasWaypoints: !!this.waypointsObject,
            waypointCount: this.indexToDbId.length,
            selectedWaypoints: this.selectedIndices.size,
            shapes: this.shapes.length,
            selectedShape: !!this.selectedShape
        };
    }

    confirmDelete(){
        this.deleteSelectedPoints();
        const modal = document.getElementById('delete-confirm');
        modal.classList.add('hidden');
    }

    cancelDelete(){
        const modal = document.getElementById('delete-confirm');
        modal.classList.add('hidden');
    }
}
