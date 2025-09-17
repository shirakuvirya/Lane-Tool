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
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

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
    // FONT AND TEXT MANAGEMENT
    // ====================================================================

    /**
     * Load the default font for text rendering
     * Uses Helvetiker Regular from Three.js examples
     */
    loadFont() {
        const fontPath = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/helvetiker_regular.typeface.json';
        this.fontLoader.load(fontPath, (loadedFont) => {
            this.font = loadedFont;
            console.log('âœ… Font loaded successfully for text labels.');
        }, undefined, (error) => {
            console.error('âŒ Failed to load font:', error);
        });
    }

    /**
     * Create a 3D text label at the specified position
     * * @param {string} text - Text content for the label
     * @param {THREE.Vector3} position - World position for text placement
     * @returns {THREE.Mesh|null} Created text mesh or null if font not loaded
     */
    addTextLabel(text, position) {
        if (!this.font) {
            alert('Font not loaded.');
            return null;
        }

        const size = parseFloat(document.getElementById('text-size').value);
        const color = document.getElementById('text-color').value;
        
        const textGeo = new TextGeometry(text, { 
            font: this.font, 
            size: 1, 
            height: 0.01 
        });
        const textMat = new THREE.MeshBasicMaterial({ 
            color, 
            side: THREE.DoubleSide, 
            transparent: true 
        });
        const textMesh = new THREE.Mesh(textGeo, textMat);
        
        // Center the text geometry
        textGeo.computeBoundingBox();
        const centerOffset = new THREE.Vector3();
        textGeo.boundingBox.getCenter(centerOffset).negate();
        textMesh.geometry.translate(centerOffset.x, centerOffset.y, centerOffset.z);
        
        textMesh.position.copy(position);
        textMesh.scale.setScalar(size);
        
        textMesh.userData = {
            type: 'text', 
            isShape: true, 
            originalText: text
        };
        
        this.shapes.push(textMesh);
        this.shapeGroup.add(textMesh);
        return textMesh;
    }

    /**
     * Update existing text mesh with new content
     * * @param {THREE.Mesh} textMesh - Text mesh to update
     * @param {string} newText - New text content
     */
    updateText(textMesh, newText) {
        if (!this.font || textMesh.userData.type !== 'text' || !newText) return;

        // Create new geometry with the original size/scale in mind
        const textGeo = new TextGeometry(newText, {
            font: this.font,
            size: 1,
            height: 0.01
        });

        textMesh.geometry.dispose();
        textMesh.geometry = textGeo;
        textMesh.userData.originalText = newText;

        // Recenter the new geometry
        textGeo.computeBoundingBox();
        const centerOffset = new THREE.Vector3();
        textGeo.boundingBox.getCenter(centerOffset).negate();
        textMesh.geometry.translate(centerOffset.x, centerOffset.y, centerOffset.z);

        // Update selection visuals if this text is selected
        if (this.selectedShape === textMesh) {
            this.removeSelectionOutline(textMesh);
            this.addSelectionOutline(textMesh);
            this.clearResizeHandles();
            this.createResizeHandles(textMesh);
        }
    }

    // ====================================================================
    // SHAPE CREATION AND MANAGEMENT
    // ====================================================================

    /**
     * Create geometric shapes based on type and dimensions
     * * @param {string} type - Shape type (square, oval, arrow, line)
     * @param {number} width - Shape width
     * @param {number} height - Shape height
     * @returns {THREE.ShapeGeometry|null} Created geometry or null if invalid type
     */
    createShapeGeometry(type, width, height) {
        const halfWidth = width / 2;
        const halfHeight = height / 2;
        const shape = new THREE.Shape();

        switch(type) {
            case 'square':
                shape.moveTo(-halfWidth, -halfHeight);
                shape.lineTo(halfWidth, -halfHeight);
                shape.lineTo(halfWidth, halfHeight);
                shape.lineTo(-halfWidth, halfHeight);
                shape.closePath();
                break;
            case 'oval':
                shape.absellipse(0, 0, halfWidth, halfHeight, 0, Math.PI * 2, false);
                break;
            case 'arrow':
                const bodyW = halfWidth * 0.4;
                const headW = halfWidth;
                const headH = halfHeight * 0.4;
                shape.moveTo(0, halfHeight);
                shape.lineTo(-headW, halfHeight - headH);
                shape.lineTo(-bodyW, halfHeight - headH);
                shape.lineTo(-bodyW, -halfHeight);
                shape.lineTo(bodyW, -halfHeight);
                shape.lineTo(bodyW, halfHeight - headH);
                shape.lineTo(headW, halfHeight - headH);
                shape.closePath();
                break;
            case 'line':
                shape.moveTo(-halfWidth, 0.5);
                shape.lineTo(halfWidth, 0.5);
                break;
            default: 
                return null;
        }
        return new THREE.ShapeGeometry(shape);
    }

    /**
     * Add a new shape to the scene
     * * @param {string} type - Shape type
     * @param {THREE.Vector3} startPos - Starting position
     * @param {THREE.Vector3} endPos - Ending position
     * @param {boolean} isGhost - Whether this is a preview shape
     * @returns {THREE.Mesh|null} Created shape mesh
     */
    addShape(type, startPos, endPos, isGhost = false) {
        const width = Math.abs(endPos.x - startPos.x);
        const height = Math.abs(endPos.y - startPos.y);
        
        // Minimum size check for non-line shapes
        if (width < 0.1 && height < 0.1 && type !== 'line') return null;

        const geometry = this.createShapeGeometry(type, width, height);
        if (!geometry) return null;

        const fillColor = document.getElementById('fill-color')?.value || '#ffffff';
        const opacity = parseFloat(document.getElementById('shape-opacity')?.value || '0.7');

        const material = new THREE.MeshBasicMaterial({
            color: fillColor,
            transparent: true,
            opacity: isGhost ? 0.4 : opacity,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        const centerX = (startPos.x + endPos.x) / 2;
        const centerY = (startPos.y + endPos.y) / 2;
        mesh.position.set(centerX, centerY, 0.0);

        // Special handling for line rotation
        if (type === 'line') {
            const diff = new THREE.Vector3().subVectors(endPos, startPos);
            mesh.rotation.z = Math.atan2(diff.y, diff.x);
        }

        mesh.userData = { type, isShape: true };

        if (!isGhost) {
            this.shapes.push(mesh);
        }
        this.shapeGroup.add(mesh);
        return mesh;
    }

    /**
     * Delete the currently selected shape
     */
    deleteSelectedShape() {
        const shape = this.selectedShape;
        if (!shape) return;

        this.clearShapeSelection();
        this.shapeGroup.remove(shape);
        const index = this.shapes.indexOf(shape);
        if (index > -1) {
            this.shapes.splice(index, 1);
        }
        
        // Proper cleanup
        shape.geometry.dispose();
        shape.material.dispose();
        console.log('ðŸ—‘ï¸ Deleted shape');
    }

    // ====================================================================
    // SHAPE SELECTION AND TRANSFORMATION
    // ====================================================================

    /**
     * Select a shape for editing operations
     * * @param {THREE.Mesh} shape - Shape to select
     */
    selectShape(shape) {
        if (this.selectedShape === shape) return;
        this.clearShapeSelection();
        this.selectedShape = shape;

        if (shape) {
            this.addSelectionOutline(shape);
            this.createResizeHandles(shape);
            this.updateStyleUI(shape);
        }
    }

    /**
     * Clear the current shape selection
     */
    clearShapeSelection() {
        if (this.selectedShape) {
            this.removeSelectionOutline(this.selectedShape);
            this.clearResizeHandles();
            this.selectedShape = null;
        }
        document.getElementById('style-controls').classList.add('hidden');
        document.getElementById('layout-edit-text').classList.add('hidden');
    }

    /**
     * Add visual outline to selected shape
     * * @param {THREE.Mesh} shape - Shape to outline
     */
    addSelectionOutline(shape) {
        if (shape.selectionOutline) return;
        const outline = new THREE.BoxHelper(shape, 0x4a9eff);
        shape.selectionOutline = outline;
        this.shapeGroup.add(outline);
    }
    
    /**
     * Remove visual outline from shape
     * * @param {THREE.Mesh} shape - Shape to remove outline from
     */
    removeSelectionOutline(shape) {
        if (shape.selectionOutline) {
            this.shapeGroup.remove(shape.selectionOutline);
            shape.selectionOutline.geometry.dispose();
            shape.selectionOutline.material.dispose();
            shape.selectionOutline = null;
        }
    }

    /**
     * Create resize handles for the selected shape
     * * @param {THREE.Mesh} shape - Shape to create handles for
     */
    createResizeHandles(shape) {
        this.clearResizeHandles();
        const box = new THREE.Box3().setFromObject(shape);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        
        const handleSize = this.dynamicPointSize * 2;
        const handleGeometry = new THREE.BoxGeometry(handleSize, handleSize, handleSize);
        const handleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

        // Create 4 corner handles
        const handlePositions = [
            new THREE.Vector3(center.x - size.x / 2, center.y - size.y / 2, 0),
            new THREE.Vector3(center.x + size.x / 2, center.y - size.y / 2, 0),
            new THREE.Vector3(center.x + size.x / 2, center.y + size.y / 2, 0),
            new THREE.Vector3(center.x - size.x / 2, center.y + size.y / 2, 0),
        ];

        handlePositions.forEach((pos, index) => {
            const handle = new THREE.Mesh(handleGeometry.clone(), handleMaterial.clone());
            handle.position.copy(pos);
            handle.userData = {
                type: 'resizeHandle',
                handleIndex: index,
                parentShape: shape,
            };
            this.resizeHandles.push(handle);
            this.shapeGroup.add(handle);
        });
    }
    
    /**
     * Update resize handle positions after shape transformation
     * * @param {THREE.Mesh} shape - Shape whose handles need updating
     */
    updateResizeHandlePositions(shape) {
        if (this.resizeHandles.length === 0) return;
        const box = new THREE.Box3().setFromObject(shape);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        
        const handlePositions = [
             new THREE.Vector3(center.x - size.x / 2, center.y - size.y / 2, 0),
             new THREE.Vector3(center.x + size.x / 2, center.y - size.y / 2, 0),
             new THREE.Vector3(center.x + size.x / 2, center.y + size.y / 2, 0),
             new THREE.Vector3(center.x - size.x / 2, center.y + size.y / 2, 0),
        ];

        this.resizeHandles.forEach((handle, index) => {
             handle.position.copy(handlePositions[index]);
        });
    }

    /**
     * Remove all resize handles from the scene
     */
    clearResizeHandles() {
        this.resizeHandles.forEach(handle => {
            this.shapeGroup.remove(handle);
            handle.geometry.dispose();
            handle.material.dispose();
        });
        this.resizeHandles = [];
    }

    /**
     * Update the style control UI based on selected shape
     * * @param {THREE.Mesh} shape - Selected shape to update UI for
     */
    updateStyleUI(shape) {
        if (!shape) return;

        document.getElementById('style-controls').classList.remove('hidden');

        const isText = shape.userData.type === 'text';
        document.getElementById('shape-style-controls').classList.toggle('hidden', isText);
        document.getElementById('text-style-controls').classList.toggle('hidden', !isText);

        if (isText) {
            document.getElementById('text-color').value = `#${shape.material.color.getHexString()}`;
            const sizeSlider = document.getElementById('text-size');
            sizeSlider.value = shape.scale.x;
            document.getElementById('text-size-value').textContent = shape.scale.x.toFixed(2);
            document.getElementById('layout-edit-text').classList.remove('hidden');
        } else {
            document.getElementById('fill-color').value = `#${shape.material.color.getHexString()}`;
            const opacitySlider = document.getElementById('shape-opacity');
            opacitySlider.value = shape.material.opacity;
            document.getElementById('shape-opacity-value').textContent = shape.material.opacity.toFixed(2);
            document.getElementById('layout-edit-text').classList.add('hidden');
        }
    }

    // ====================================================================
    // MODAL AND UI INTERACTION
    // ====================================================================

    /**
     * Show text input modal for creating or editing text
     * * @param {boolean} isEdit - Whether this is editing existing text
     * @param {string} existingText - Current text content if editing
     */
    showTextInputModal(isEdit = false, existingText = '') {
        const modal = document.getElementById('text-input-modal');
        const input = document.getElementById('text-input-field');
        const title = document.getElementById('modal-title');

        if (modal && input && title) {
            this.isEditingText = isEdit;
            title.textContent = isEdit ? 'Edit Label Text' : 'Enter Label Text';
            input.value = existingText;
            modal.classList.remove('hidden');
            input.focus();
        }
    }

    /**
     * Hide the text input modal
     */
    hideTextInputModal() {
        const modal = document.getElementById('text-input-modal');
        if (modal) modal.classList.add('hidden');
        this.textInsertionPoint = null;
        this.isEditingText = false;
    }

    

  /**
 * Master function to process the entire waypoint graph. It first rebuilds complex
 * junctions (nodes with >2 edges) and then smooths all simple corners (nodes with 2 edges)
 * in a comprehensive two-part process.
 * @async
 */
async generateturn() {
    if (!this.db || !this.waypointsData) {
        alert("Please load a database and waypoints first.");
        return;
    }

    this.db.run(JUNCTION_POINTS_TABLE_SQL);

    this.showLoader();
    console.log('🚀 Starting full graph processing...');

    this.db.run("DELETE FROM junction_points");
    const insertJunctionStmt = this.db.prepare(
        `INSERT INTO junction_points 
        (junction_waypoint_id, from_waypoint_id, to_waypoint_id, entry_x, entry_y, entry_z, exit_x, exit_y, exit_z) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const vehicleSelect = document.getElementById('vehicle-select-turn');
    const R = parseFloat(vehicleSelect.value) || 1.0;

    // ======================================================================
    // PART 1: PROCESS JUNCTIONS (Nodes with > 2 edges)
    // ======================================================================
    console.log("--- Part 1: Checking for and rebuilding junctions... ---");

    let adj = new Map();
    let dbIdToWaypointMap = new Map();
    this.waypointsData.forEach(wp => {
        adj.set(wp.id, new Set());
        dbIdToWaypointMap.set(wp.id, { id: wp.id, pos: wp.pos });
    });
    let stmt = this.db.prepare("SELECT id1, id2 FROM edge_graph");
    while (stmt.step()) {
        const [id1, id2] = stmt.get();
        if (adj.has(id1) && adj.has(id2)) {
            adj.get(id1).add(id2);
            adj.get(id2).add(id1);
        }
    }
    stmt.free();

    const junctions = [];
    for (const [id, neighbors] of adj.entries()) {
        if (neighbors.size > 2) {
            junctions.push(id);
        }
    }
    if (junctions.length > 0) {
        console.log(`Found ${junctions.length} junctions. Rebuilding...`);
        const numPointsInArc = 10;
        const idsToDelete = new Set();
        const pointsToAdd = [];
        const edgesToAdd = [];
        let tempPointCounter = 0;

        for (const junctionId of junctions) {
            const neighbors = Array.from(adj.get(junctionId));
            const p_j = dbIdToWaypointMap.get(junctionId).pos;

            for (let i = 0; i < neighbors.length; i++) {
                for (let j = i + 1; j < neighbors.length; j++) {
                    const p1_id = neighbors[i];
                    const p2_id = neighbors[j];
                    const p1 = dbIdToWaypointMap.get(p1_id).pos;
                    const p2 = dbIdToWaypointMap.get(p2_id).pos;

                    const v1 = new THREE.Vector3().subVectors(p1, p_j).normalize();
                    const v2 = new THREE.Vector3().subVectors(p2, p_j).normalize();
                    const dotProduct = v1.dot(v2);
                    
                    if (dotProduct < -0.999) continue;
                    const turn_angle = Math.PI - Math.acos(dotProduct);
                    if (turn_angle < 0.01) continue;
                    
                    const idealTangentDist = R / Math.tan(turn_angle / 2);
                    const dist1 = p_j.distanceTo(p1);
                    const dist2 = p_j.distanceTo(p2);
                    const trimDist = idealTangentDist;
                    if (trimDist < 0.1) continue;

                    const startPoint = new THREE.Vector3().lerpVectors(p_j, p1, trimDist / dist1);
                    const endPoint = new THREE.Vector3().lerpVectors(p_j, p2, trimDist / dist2);
                    
                    const entryRos = this.threeToRos(startPoint.clone().add(this.mapOffset));
                    const exitRos = this.threeToRos(endPoint.clone().add(this.mapOffset));
                    insertJunctionStmt.run([junctionId, p1_id, p2_id, entryRos.x, entryRos.y, entryRos.z, exitRos.x, exitRos.y, exitRos.z]);
                    insertJunctionStmt.run([junctionId, p2_id, p1_id, exitRos.x, exitRos.y, exitRos.z, entryRos.x, entryRos.y, entryRos.z]);

                    // ==========================================================
                    //  NEW: Find the physically closest nodes to attach the curve to.
                    // ==========================================================
                    const connectToId1 = this.findClosestNodeOnBranch(p1_id, junctionId, startPoint, adj, dbIdToWaypointMap);
                    const connectToId2 = this.findClosestNodeOnBranch(p2_id, junctionId, endPoint, adj, dbIdToWaypointMap);
                    // ==========================================================

                    const curve = new THREE.QuadraticBezierCurve3(startPoint, p_j, endPoint);
                    const arcPoints = curve.getPoints(numPointsInArc);                
                    
                    // **THE FIX**: Start the new chain from the CORRECTED connection ID.
                    let lastPointId = connectToId1; 
                    
                    for (let k = 1; k < arcPoints.length - 1; k++) {
                        const tempId = `new_${tempPointCounter++}`;
                        pointsToAdd.push({ tempId, pos: arcPoints[k] });
                        edgesToAdd.push({ from: lastPointId, to: tempId });
                        lastPointId = tempId;
                    }
                    // **THE FIX**: End the new chain at the CORRECTED connection ID.
                    edgesToAdd.push({ from: lastPointId, to: connectToId2 });
                }
            }
        }
        await this.applyGraphModifications(idsToDelete, pointsToAdd, edgesToAdd, dbIdToWaypointMap);
    } else {
        console.log("No junctions found. Proceeding to simple corners.");
    }

    // ======================================================================
    // PART 2: PROCESS SIMPLE CORNERS (Unchanged)
    // ======================================================================
    console.log("--- Part 2: Smoothing simple corners... ---");

    await this.refreshWaypointsFromDB();
    adj = new Map();
    dbIdToWaypointMap = new Map();
    this.waypointsData.forEach(wp => {
        adj.set(wp.id, new Set());
        dbIdToWaypointMap.set(wp.id, { id: wp.id, pos: wp.pos });
    });
    stmt = this.db.prepare("SELECT id1, id2 FROM edge_graph");
    while (stmt.step()) {
        const [id1, id2] = stmt.get();
        if (adj.has(id1) && adj.has(id2)) {
            adj.get(id1).add(id2);
            adj.get(id2).add(id1);
        }
    }
    stmt.free();

    const cornerNodeIds = [];
    for (const [id, neighbors] of adj.entries()) {
        if (neighbors.size === 2) {
            cornerNodeIds.push(id);
        }
    }

    if (cornerNodeIds.length > 0) {
        const halfIndex = Math.ceil(cornerNodeIds.length / 2);
        const nodesToProcess = [...cornerNodeIds, ...cornerNodeIds.slice(0, halfIndex)];
        console.log(`Found ${cornerNodeIds.length} corners. Smoothing over ${nodesToProcess.length} steps.`);
        
        for (const cornerId of nodesToProcess) {
            await this.refreshWaypointsFromDB();
            const currentMap = new Map(this.waypointsData.map(wp => [wp.id, { id: wp.id, pos: wp.pos }]));
            if (!adj.has(cornerId)) continue;
            const neighbor_ids = Array.from(adj.get(cornerId));
            const updates = this.calculateCornerUpdates(cornerId, neighbor_ids, R, adj, currentMap);
            if (updates.size > 0) {
                await this.applyWaypointUpdates(updates);
            }
        }
    } else {
        console.log("No simple corners found to smooth.");
    }

    // --- Final Cleanup ---
    insertJunctionStmt.free();
    console.log("✅ Junction entry/exit points saved to the database.");
    console.log("✅ Full graph processing complete!");
    await this.refreshWaypointsFromDB();
    this.hideLoader();
}



/**
     * Walks along a branch away from a junction to find the existing node that is
     * physically closest to a target point (the start of a new curve).
     * @param {number} startNodeId - The direct neighbor of the junction to start searching from.
     * @param {number} prevNodeId - The ID of the junction center, to prevent walking backwards.
     * @param {THREE.Vector3} targetPoint - The 3D point we want to be close to.
     * @param {Map<number, Set<number>>} adj - The adjacency list of the graph.
     * @param {Map<number, object>} dbIdToWaypointMap - Map of all waypoints.
     * @returns {number} The ID of the closest waypoint found on the branch.
     */
    findClosestNodeOnBranch(startNodeId, prevNodeId, targetPoint, adj, dbIdToWaypointMap) {
        let bestNodeId = startNodeId;
        let minDistance = dbIdToWaypointMap.get(startNodeId).pos.distanceTo(targetPoint);
        
        let currentNodeId = startNodeId;
        let previousNodeId = prevNodeId;
        
        // Walk away from the junction for a max of 20 steps to find a better connection point.
        for (let i = 0; i < 20; i++) {
            const neighbors = adj.get(currentNodeId);
            if (!neighbors) break;

            // Find the next node in the chain that isn't the one we just came from.
            const nextNodeId = Array.from(neighbors).find(n => n !== previousNodeId);
            if (!nextNodeId) break;

            const dist = dbIdToWaypointMap.get(nextNodeId).pos.distanceTo(targetPoint);
            if (dist < minDistance) {
                // This node is a better candidate.
                minDistance = dist;
                bestNodeId = nextNodeId;
            } else {
                // If the distance starts increasing, it means we've passed the closest point.
                break;
            }

            previousNodeId = currentNodeId;
            currentNodeId = nextNodeId;
        }
        return bestNodeId;
    }

/**
 * Applies complex modifications (deletions, additions) for JUNCTIONS.
 */
async applyGraphModifications(idsToDelete, pointsToAdd, edgesToAdd, dbIdToWaypointMap) {
    if (idsToDelete.size === 0 && pointsToAdd.length === 0) return;
    try {
        this.db.run("BEGIN TRANSACTION");
        if (idsToDelete.size > 0) {
            const placeholders = Array.from(idsToDelete).map(() => '?').join(',');
            this.db.run(`DELETE FROM waypoints WHERE id IN (${placeholders})`, Array.from(idsToDelete));
            this.db.run(`DELETE FROM edge_graph WHERE id1 IN (${placeholders}) OR id2 IN (${placeholders})`, [...Array.from(idsToDelete), ...Array.from(idsToDelete)]);
        }
        const newIdMap = new Map();
        const insertStmt = this.db.prepare("INSERT INTO waypoints (x, y, z) VALUES (?, ?, ?)");
        for (const point of pointsToAdd) {
            const rosPos = this.threeToRos(point.pos.clone().add(this.mapOffset));
            insertStmt.run([rosPos.x, rosPos.y, rosPos.z]);
            const newId = this.db.exec("SELECT last_insert_rowid()")[0].values[0][0];
            newIdMap.set(point.tempId, newId);
            dbIdToWaypointMap.set(newId, { id: newId, pos: point.pos });
        }
        insertStmt.free();
        const edgeStmt = this.db.prepare("INSERT INTO edge_graph (id1, id2, weight) VALUES (?, ?, ?)");
        for (const edge of edgesToAdd) {
            const id1 = typeof edge.from === 'string' ? newIdMap.get(edge.from) : edge.from;
            const id2 = typeof edge.to === 'string' ? newIdMap.get(edge.to) : edge.to;
            if (id1 && id2) {
                const pos1 = dbIdToWaypointMap.get(id1)?.pos;
                const pos2 = dbIdToWaypointMap.get(id2)?.pos;
                if (pos1 && pos2) edgeStmt.run([id1, id2, pos1.distanceTo(pos2)]);
            }
        }
        edgeStmt.free();
        this.db.run("COMMIT");
    } catch (e) {
        console.error("Database modification failed, rolling back.", e);
        this.db.run("ROLLBACK");
    }
}

/**
 * Calculates position updates for SIMPLE CORNERS (non-destructive).
 */
calculateCornerUpdates(curr_id, neighbor_ids, R, adj, dbIdToWaypointMap) {
    const updates = new Map();
    const TURN_SENSITIVITY = 0.95;
    const [id_A, id_B] = neighbor_ids;

    const p_A = dbIdToWaypointMap.get(id_A)?.pos;
    const p_curr = dbIdToWaypointMap.get(curr_id)?.pos;
    const p_B = dbIdToWaypointMap.get(id_B)?.pos;

    if (!p_A || !p_curr || !p_B) return updates;

    const v_A = new THREE.Vector3().subVectors(p_A, p_curr).normalize();
    const v_B = new THREE.Vector3().subVectors(p_B, p_curr).normalize();
    const dotProduct = v_A.dot(v_B);

    if (dotProduct > -TURN_SENSITIVITY) {
        const turn_angle = Math.PI - Math.acos(dotProduct);
        if (turn_angle < 0.01) return updates;
        
        const tangentDist = R / Math.tan(turn_angle / 2);
        const start_id = this.walkPathForDistance(curr_id, id_A, tangentDist, adj, dbIdToWaypointMap);
        const end_id = this.walkPathForDistance(curr_id, id_B, tangentDist, adj, dbIdToWaypointMap);
        
        const pointsToInterpolate_ids = this.getIdsBetween(start_id, end_id, adj);
        if (pointsToInterpolate_ids.length < 2) return updates;
        
        const p0 = dbIdToWaypointMap.get(start_id).pos;
        const p1 = p_curr;
        const p2 = dbIdToWaypointMap.get(end_id).pos;

        for (let j = 0; j < pointsToInterpolate_ids.length; j++) {
            const t = j / (pointsToInterpolate_ids.length - 1);
            const newPos = new THREE.Vector3()
                .addScaledVector(p0, (1 - t) ** 2)
                .addScaledVector(p1, 2 * (1 - t) * t)
                .addScaledVector(p2, t ** 2);
                
            const currentDbId = pointsToInterpolate_ids[j];
            const newRosPos = this.threeToRos(newPos.clone().add(this.mapOffset));
            updates.set(currentDbId, newRosPos);
        }
    }
    return updates;
}

/**
 * Applies position updates for SIMPLE CORNERS.
 */
async applyWaypointUpdates(updates) {
    if (updates.size === 0) return;
    try {
        this.db.run("BEGIN TRANSACTION");
        const stmt = this.db.prepare("UPDATE waypoints SET x = ?, y = ?, z = ? WHERE id = ?");
        for (const [id, pos] of updates.entries()) {
            stmt.run([pos.x, pos.y, pos.z, id]);
        }
        stmt.free();
        this.db.run("COMMIT");
    } catch (e){
        console.error("Failed to apply waypoint updates:", e);
        this.db.run("ROLLBACK");
    }
}

/**
 * Helper to walk along a path for a target distance.
 */
walkPathForDistance(start_node, away_from_node, target_dist, adj, dbIdToWaypointMap) {
    let final_id = start_node;
    let accumulated_dist = 0;
    let current_id = start_node;
    let prev_id = away_from_node;

    while (accumulated_dist < target_dist) {
        let next_id = Array.from(adj.get(current_id)).find(n => n !== prev_id) || null;
        if (!next_id) break;

        const pos_current = dbIdToWaypointMap.get(current_id)?.pos;
        const pos_next = dbIdToWaypointMap.get(next_id)?.pos;
        if (!pos_current || !pos_next) break;

        accumulated_dist += pos_current.distanceTo(pos_next);
        
        prev_id = current_id;
        current_id = next_id;
        
        if (accumulated_dist < target_dist) {
            final_id = current_id;
        }
    }
    return final_id;
}

/**
 * Helper to get a list of all waypoint IDs in sequence between two nodes.
 */
getIdsBetween(start_id, end_id, adj) {
    if (start_id === end_id) return [start_id];
    const queue = [[start_id]];
    const visited = new Set([start_id]);
    while (queue.length > 0) {
        const path = queue.shift();
        const last_node = path[path.length - 1];
        if (last_node === end_id) return path;
        for (const neighbor of adj.get(last_node)) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push([...path, neighbor]);
            }
        }
    }
    return [];
}


    // ====================================================================
    // STYLE APPLICATION METHODS
    // ====================================================================

    /**
     * Apply color change to the currently selected shape
     */
    applyColorToSelectedShape() {
        if (!this.selectedShape || !this.selectedShape.material) return;
        const colorPicker = document.getElementById('fill-color');
        if (colorPicker) {
            this.selectedShape.material.color.setStyle(colorPicker.value);
        }
    }

    /**
     * Apply opacity change to the currently selected shape
     */
    applyOpacityToSelectedShape() {
        if (!this.selectedShape || !this.selectedShape.material) return;
        const opacitySlider = document.getElementById('shape-opacity');
        if (opacitySlider) {
            this.selectedShape.material.opacity = parseFloat(opacitySlider.value);
        }
    }

    // ====================================================================
    // LANE GENERATION AND MANAGEMENT
    // ====================================================================

    /**
     * Walks along a path from a starting node and returns the ID of the destination node.
     * @param {number} startNodeId - The ID of the waypoint to start from.
     * @param {number} prevNodeId - The ID of the node we came from (to prevent walking backwards).
     * @param {number} numSteps - The number of steps to walk.
     * @param {Map<number, Array<number>>} adj - A simple adjacency list.
     * @returns {number} The ID of the waypoint at the end of the walk.
     */
    walkToNode(startNodeId, prevNodeId, numSteps, adj) {
        let currentNodeId = startNodeId;
        let previousNodeId = prevNodeId;
        for (let i = 0; i < numSteps; i++) {
            const neighbors = adj.get(currentNodeId);
            if (!neighbors) return currentNodeId; // Stop if we can't go further

            const nextNodeId = neighbors.find(n_id => n_id !== previousNodeId);
            if (!nextNodeId) return currentNodeId; // Stop at end of the line

            previousNodeId = currentNodeId;
            currentNodeId = nextNodeId;
        }
        return currentNodeId;
    }

    /**
     * Finds the shortest path between two nodes using Breadth-First Search (BFS).
     * @param {number} startNodeId - The ID of the starting waypoint.
     * @param {number} endNodeId - The ID of the target waypoint.
     * @param {Map<number, Array<number>>} adj - A simple adjacency list.
     * @returns {Array<string>} An array of all edge keys (e.g., ["1-2", "2-3"]) on the path.
     */
    findPathBetween(startNodeId, endNodeId, adj) {
        const queue = [[startNodeId]]; // Queue stores paths
        const visited = new Set([startNodeId]);

        while (queue.length > 0) {
            const path = queue.shift();
            const lastNode = path[path.length - 1];

            if (lastNode === endNodeId) {
                // Path found! Convert the list of nodes into a list of edge keys.
                const edgesOnPath = new Set();
                for (let i = 0; i < path.length - 1; i++) {
                    const id1 = path[i];
                    const id2 = path[i + 1];
                    const key = id1 < id2 ? `${id1}-${id2}` : `${id2}-${id1}`;
                    edgesOnPath.add(key);
                }
                return Array.from(edgesOnPath);
            }

            const neighbors = adj.get(lastNode) || [];
            for (const neighbor of neighbors) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    const newPath = [...path, neighbor];
                    queue.push(newPath);
                }
            }
        }
        return []; // Return empty array if no path is found
    }


    /**
 * Finds all edges on paths from a junction to its nearest neighboring junctions.
 * Uses BFS and stops each path when it hits another junction (node with >2 edges).
 *
 * @param {number} junctionId - The ID of the junction to start the search from.
 * @param {Map<number, Array<number>>} adj - The adjacency list of the graph.
 * @returns {Set<string>} A Set containing all the edge keys (e.g., "1-2") found.
 */
/**
 * From a given junction, finds paths to its nearest neighboring junctions.
 * Each path is the sequence of edges between the start junction
 * and the first other junction (>2 degree) it hits in that direction.
 *
 * @param {number} junctionId - The junction node ID.
 * @param {Map<number, Array<number>>} adj - Graph adjacency list.
 * @returns {Array<Array<string>>} Array of paths, each path is an array of edge keys ("id1-id2").
 */
findPathsToNearestJunctions(junctionId, adj) {
    const paths = [];

    if (!adj.has(junctionId) || adj.get(junctionId).length <= 2) {
        return paths; // not a junction
    }

    for (const startNeighbor of adj.get(junctionId)) {
        const pathEdges = [];
        let prev = junctionId;
        let curr = startNeighbor;

        // add first edge
        pathEdges.push(
            prev < curr ? `${prev}-${curr}` : `${curr}-${prev}`
        );

        while (true) {
            const neighbors = adj.get(curr);

            // If this node is a junction (degree > 2), stop here
            if (neighbors.length > 2) {
                paths.push(pathEdges);
                break;
            }

            // If dead end, discard
            if (neighbors.length === 1) {
                break;
            }

            // Otherwise degree == 2 → continue walking
            const next = neighbors.find(n => n !== prev);
            if (next == null) break;

            pathEdges.push(
                curr < next ? `${curr}-${next}` : `${next}-${curr}`
            );

            prev = curr;
            curr = next;
        }
    }

    return paths;
}




    /**
        * Generates lane geometry, skipping only the direct path segments between an
        * entry and exit point of a junction turn.
        * @async
        */
       async drawLane() {
    this.clearLane();
    if (!this.db) return;

    // Step 1: Load graph data and build adjacency list.
    const dbIdToWaypointMap = new Map();
    const simpleAdj = new Map();
    let stmt = this.db.prepare("SELECT id, x, y, z, width_left, width_right FROM waypoints");
    while (stmt.step()) {
        const row = stmt.getAsObject();
        dbIdToWaypointMap.set(row.id, {
            ...row,
            pos: this.rosToThree({ x: row.x, y: row.y, z: row.z }).sub(this.mapOffset)
        });
        simpleAdj.set(row.id, []);
    }
    stmt.free();

    if (dbIdToWaypointMap.size < 2) return;

    stmt = this.db.prepare("SELECT id1, id2 FROM edge_graph");
    const edges = [];
    while (stmt.step()) {
        const [id1, id2] = stmt.get();
        edges.push({ id1, id2 });
        simpleAdj.get(id1).push(id2);
        simpleAdj.get(id2).push(id1);
    }
    stmt.free();

    // Step 2: Build the list of edges to skip.
    const edgesToSkip = new Set();

    // Find all junctions in the graph.
    for (const [j_id, neighbors] of simpleAdj.entries()) {
        if (neighbors.length <= 2) continue; // not a junction

        // Get all corridor paths from this junction to its nearest neighbor junctions.
        const junctionPaths = this.findPathsToNearestJunctions(j_id, simpleAdj);

        // Flatten the paths into the skip list.
        for (const path of junctionPaths) {
            for (const edgeKey of path) {
                edgesToSkip.add(edgeKey);
            }
        }
    }

    console.log("Edges to skip:", Array.from(edgesToSkip));

    // Step 3: Iterate over every edge and draw a lane unless it's in our skip list.
    for (const edge of edges) {
        const edgeKey = edge.id1 < edge.id2 ? `${edge.id1}-${edge.id2}` : `${edge.id2}-${edge.id1}`;
        if (edgesToSkip.has(edgeKey)) {
            continue; // skip junction-to-junction corridor edges
        }

        const p1_data = dbIdToWaypointMap.get(edge.id1);
        const p2_data = dbIdToWaypointMap.get(edge.id2);

        if (!p1_data || !p2_data) continue;

        const waypointsData = [p1_data, p2_data];
        const leftVerts = [];
        const rightVerts = [];

        for (let i = 0; i < waypointsData.length; i++) {
            const p_curr = waypointsData[i].pos;
            const halfWidthLeft = (waypointsData[i].width_left || 0.5);
            const halfWidthRight = (waypointsData[i].width_right || 0.5);
            let normal;
            if (i === 0) {
                const dir_out = waypointsData[i + 1].pos.clone().sub(p_curr).normalize();
                normal = new THREE.Vector3(-dir_out.y, dir_out.x, 0).normalize();
            } else {
                const dir_in = p_curr.clone().sub(waypointsData[i - 1].pos).normalize();
                normal = new THREE.Vector3(-dir_in.y, dir_in.x, 0).normalize();
            }
            leftVerts.push(p_curr.clone().add(normal.clone().multiplyScalar(halfWidthLeft)));
            rightVerts.push(p_curr.clone().sub(normal.clone().multiplyScalar(halfWidthRight)));
        }

        const fillVertices = [
            leftVerts[0].x, leftVerts[0].y, leftVerts[0].z,
            rightVerts[0].x, rightVerts[0].y, rightVerts[0].z,
            leftVerts[1].x, leftVerts[1].y, leftVerts[1].z,
            rightVerts[1].x, rightVerts[1].y, rightVerts[1].z
        ];
        const indices = [0, 1, 2, 2, 1, 3];
        const fillGeometry = new THREE.BufferGeometry();
        fillGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fillVertices, 3));
        fillGeometry.setIndex(indices);
        const fillMaterial = new THREE.MeshBasicMaterial({ color: 0x404040, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
        const fillMesh = new THREE.Mesh(fillGeometry, fillMaterial);
        this.pathGroup.add(fillMesh);

        const boundaryMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
        const leftLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftVerts), boundaryMaterial);
        const rightLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightVerts), boundaryMaterial);
        this.pathGroup.add(leftLine, rightLine);
    }
}


    /**
     * Clear all lane geometry from the scene
     */
    clearLane() {
        while(this.pathGroup.children.length > 0){
            const mesh = this.pathGroup.children[0];
            this.pathGroup.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
    }

    /**
     * Generate lane geometry with uniform width for all waypoints
     * * @async
     */
    async generateLane() {
        if (!this.db) {
            alert("Please load a waypoint database first.");
            return;
        }

        const vehicleSelect = document.getElementById('vehicle-select');
        const totalWidth = parseFloat(vehicleSelect.value) || 1.0;
        const halfWidth = totalWidth / 2;

        try {
            this.db.run("UPDATE waypoints SET width_left = ?, width_right = ?", [halfWidth, halfWidth]);
            console.log(`âœ… Applied global width ${totalWidth}m to all waypoints.`);
            await this.drawLane();
        } catch (error) {
            console.error("âŒ Failed to update waypoint widths:", error);
        }
    }

    // ====================================================================
    // WAYPOINT MANIPULATION METHODS
    // ====================================================================

    /**
     * Handle pointer down for waypoint move operations
     * Supports both single point and marquee selection
     * * @param {number} clickedIndex - Index of clicked waypoint (-1 if none)
     * @param {PointerEvent} event - Original pointer event
     */
    handleMovePointerDown(clickedIndex, event) {
        if (clickedIndex !== -1) {
            // Start dragging selected waypoint(s)
            this.isDraggingPoint = true;
            this.dragStartIndex = clickedIndex;

            if (!this.selectedIndices.has(clickedIndex)) {
                this.clearSelection();
                this.selectedIndices.add(clickedIndex);
                this.updateAllColors();
                this.updateInfoPanel();
            }

            // Store initial positions for all selected points
            const positions = this.waypointsObject.geometry.attributes.position;
            this.dragStartPositions.clear();
            for (const index of this.selectedIndices) {
                this.dragStartPositions.set(index, new THREE.Vector3().fromBufferAttribute(positions, index));
            }

            // Calculate drag offset from ray intersection
            const startPos = this.dragStartPositions.get(clickedIndex);
            const cameraDirection = new THREE.Vector3();
            this.camera.getWorldDirection(cameraDirection);
            this.raycastPlane.setFromNormalAndCoplanarPoint(cameraDirection, startPos);

            const intersectionMove = new THREE.Vector3();
            if (this.raycaster.ray.intersectPlane(this.raycastPlane, intersectionMove)) {
                this.dragStartOffset.subVectors(startPos, intersectionMove);
            }

            this.controls.enabled = false;
            document.getElementById('app').classList.add('draggable');
        } else {
            // Start marquee selection
            this.isMarqueeSelecting = true;
            this.controls.enabled = false;
            this.marqueeStart.set(event.clientX, event.clientY);
            const selectionBox = document.getElementById('selection-box');
            if (selectionBox) {
                selectionBox.style.display = 'block';
                selectionBox.style.left = `${event.clientX}px`;
                selectionBox.style.top = `${event.clientY}px`;
                selectionBox.style.width = '0px';
                selectionBox.style.height = '0px';
            }
        }
    }

    /**
     * Create visual hover indicator for waypoint interaction
     */
    createHoverIndicator() {
        const hoverRingGeo = new THREE.RingGeometry(0.8, 1.2, 32);
        const hoverRingMat = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.8,
            depthTest: false
        });

        this.hoverIndicator = new THREE.Mesh(hoverRingGeo, hoverRingMat);
        this.hoverIndicator.visible = false;
        this.scene.add(this.hoverIndicator);
    }

    // ====================================================================
    // CAMERA AND VIEW MANAGEMENT
    // ====================================================================

    /**
     * Set up camera and controls for different view modes
     * * @param {string} viewType - View mode ('orbit' or 'top')
     */
    setView(viewType) {
        if (this.controls) this.controls.dispose();

        const aspect = window.innerWidth / window.innerHeight;
        let targetObject = this.mapObject || this.scene.children.find(child => child.type === 'GridHelper');
        const box = new THREE.Box3().setFromObject(targetObject || this.scene);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 10;

        if (viewType === 'orbit') {
            // 3D perspective view with full rotation
            const near = Math.max(maxDim * 0.001, 0.01);
            const far = maxDim * 100;
            this.camera = new THREE.PerspectiveCamera(60, aspect, near, far);
            this.camera.up.set(0, 0, 1);
            const camDist = maxDim * 1.5;
            this.camera.position.copy(center).add(new THREE.Vector3(camDist * 0.7, -camDist * 0.7, camDist * 0.7));
            this.raycastPlane.set(new THREE.Vector3(0, 0, 1), 0);
        } else if (viewType === 'top') {
            // Top-down perspective view with restricted rotation
            const near = Math.max(maxDim * 0.001, 0.01);
            const far = maxDim * 100;
            this.camera = new THREE.PerspectiveCamera(60, aspect, near, far);
            this.camera.up.set(0, 1, 0);
            this.camera.position.set(center.x, center.y, center.z + maxDim * 1.5);
            this.raycastPlane.set(new THREE.Vector3(0, 0, 1), center.z);
        }

        this.camera.lookAt(center);

        // Configure controls based on view type
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.target.copy(center);

        if (viewType === 'top') {
            this.controls.enableRotate = true;
            this.controls.enablePan = true;
            this.controls.mouseButtons = { 
                LEFT: THREE.MOUSE.PAN,
                MIDDLE: THREE.MOUSE.DOLLY,
                RIGHT: THREE.MOUSE.PAN
            };
            // Lock to top-down view
            this.controls.minPolarAngle = Math.PI / 2;
            this.controls.maxPolarAngle = Math.PI / 2;
            this.controls.minDistance = maxDim * 0.1;
            this.controls.maxDistance = maxDim * 5;
        } else {
            this.controls.enableRotate = true;
            this.controls.enablePan = true;
            this.controls.mouseButtons = { 
                LEFT: THREE.MOUSE.ROTATE, 
                MIDDLE: THREE.MOUSE.DOLLY, 
                RIGHT: THREE.MOUSE.PAN 
            };
            this.controls.minPolarAngle = 0;
            this.controls.maxPolarAngle = Math.PI;
        }

        this.dynamicPointSize = Math.max(maxDim / 800, 0.02);
        this.updateWaypointVisuals();
    }

    // ====================================================================
    // POINT CLOUD VISUALIZATION
    // ====================================================================

    /**
     * Update point cloud coloring based on selected mode
     * * @param {string} colorMode - Color mode ('height' or 'default')
     */
    updatePointCloudColors(colorMode) {
        if (!this.mapObject || !this.originalMapGeometry) return;

        const positions = this.originalMapGeometry.attributes.position;
        const colors = new Float32Array(positions.count * 3);

        if (colorMode === 'height') {
            let minZ = Infinity, maxZ = -Infinity;

            // Find Z-value range
            for (let i = 0; i < positions.count; i++) {
                const z = positions.getZ(i);
                minZ = Math.min(minZ, z);
                maxZ = Math.max(maxZ, z);
            }

            // Apply height-based gradient coloring
            for (let i = 0; i < positions.count; i++) {
                const z = positions.getZ(i);
                const normalizedHeight = (z - minZ) / (maxZ - minZ);
                const color = new THREE.Color();
                color.setHSL(0.7 - normalizedHeight * 0.7, 1.0, 0.5);

                colors[i * 3] = color.r;
                colors[i * 3 + 1] = color.g;
                colors[i * 3 + 2] = color.b;
            }

            this.mapObject.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            this.mapObject.material.vertexColors = true;
        } else {
            // Default uniform white coloring
            for (let i = 0; i < positions.count; i++) {
                colors[i * 3] = 1.0;
                colors[i * 3 + 1] = 1.0;
                colors[i * 3 + 2] = 1.0;
            }

            this.mapObject.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            this.mapObject.material.vertexColors = false;
        }

        this.mapObject.material.needsUpdate = true;
        console.log(`ðŸŽ¨ Point cloud color mode set to: ${colorMode}`);
    }

    /**
     * Update point size for both point cloud and waypoints
     */
    updateAllPointSizes() {
        this.updateWaypointVisuals();

        if (this.mapObject && this.mapObject.material) {
            const pointSizeSlider = document.getElementById('point-size');
            const currentPointSize = pointSizeSlider ? parseFloat(pointSizeSlider.value) : 0.5;
            this.mapObject.material.size = currentPointSize;
            this.mapObject.material.sizeAttenuation = true;
            this.mapObject.material.needsUpdate = true;
        }
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
    // WAYPOINT INTERACTION METHODS
    // ====================================================================

    // NEW: Unified point selection with increased radius for better usability on large maps.
    /**
     * Finds the closest waypoint to the mouse cursor, handling both camera types.
     * Uses a larger, more forgiving selection radius.
     * @param {PointerEvent} event - The mouse event.
     * @returns {number} The index of the closest waypoint, or -1 if none is found.
     */
    findClosestPoint(event) {
        if (!this.waypointsObject || !this.camera) return -1;

        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        };
        const pointerNDC = {
            x: (mouse.x / rect.width) * 2 - 1,
            y: -(mouse.y / rect.height) * 2 + 1
        };

        this.raycaster.params.Points.threshold = this.dynamicPointSize * 5; // A generous radius
        this.raycaster.setFromCamera(pointerNDC, this.camera);

        const intersects = this.raycaster.intersectObject(this.waypointsObject);

        if (intersects.length === 0) {
            return -1;
        }

        // If we only hit one point, it's our target.
        if (intersects.length === 1) {
            return intersects[0].index;
        }

        // If we hit multiple points, find the one closest to the mouse on the 2D screen.
        let closestPointIndex = -1;
        let minDistanceSq = Infinity;
        const tempVec = new THREE.Vector3();
        const positions = this.waypointsObject.geometry.attributes.position;

        for (const hit of intersects) {
            tempVec.fromBufferAttribute(positions, hit.index);
            tempVec.project(this.camera);

            const screenX = (tempVec.x * 0.5 + 0.5) * rect.width;
            const screenY = (-tempVec.y * 0.5 + 0.5) * rect.height;

            const dx = mouse.x - screenX;
            const dy = mouse.y - screenY;
            const distanceSq = dx * dx + dy * dy;

            if (distanceSq < minDistanceSq) {
                minDistanceSq = distanceSq;
                closestPointIndex = hit.index;
            }
        }
        return closestPointIndex;
    }

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

    // ====================================================================
    // HOVER AND INTERACTION FEEDBACK
    // ====================================================================

    /**
     * Handle mouse hover over waypoints
     * * @param {PointerEvent} event - Pointer event
     */
    handleHover(event) {
        if (!this.camera || this.isDraggingPoint || this.isMarqueeSelecting || !this.waypointsObject || this.isPersistentDrawing) {
            if (this.hoverIndicator.visible) {
                this.hoveredPointIndex = null;
                this.hoverIndicator.visible = false;
            }
            return;
        }

        const index = this.findClosestPoint(event);

        if (index === -1) {
            if (this.hoveredPointIndex !== null) {
                this.hoveredPointIndex = null;
                this.hoverIndicator.visible = false;
                // this.clearWaypointInfo(); // <--- REMOVE THIS LINE
            }
        } else if (this.hoveredPointIndex !== index) {
            this.hoveredPointIndex = index;
            const pos = new THREE.Vector3().fromBufferAttribute(this.waypointsObject.geometry.attributes.position, index);
            this.hoverIndicator.position.copy(pos);
            this.hoverIndicator.visible = true;
            // this.updateWaypointInfo(index); // <--- REMOVE THIS LINE
        }
    }

    // ====================================================================
    // WAYPOINT DATABASE OPERATIONS
    // ====================================================================

    /**
     * Adds a new single waypoint and connects it to the previously last waypoint in the DB.
     * @param {THREE.Vector3} position - The 3D position for the new waypoint.
     * @async
     */
    async addPoint(position) {
        if (!this.db) {
            this.db = new this.SQL.Database();
            this.db.run(WAYPOINT_TABLE_SQL);
            this.db.run(EDGE_GRAPH_TABLE_SQL);
        }
    
        // Get last point info before inserting the new one
        let lastPointId = null;
        let lastPointRosPos = null;
        const result = this.db.exec("SELECT id, x, y, z FROM waypoints ORDER BY id DESC LIMIT 1");
        if (result.length > 0 && result[0].values.length > 0) {
            const lastPoint = result[0].values[0];
            lastPointId = lastPoint[0];
            lastPointRosPos = { x: lastPoint[1], y: lastPoint[2], z: lastPoint[3] };
        }
    
        const threePos = position.clone().add(this.mapOffset);
        
        // ===================== FIX START =====================
        // Force Z-coordinate to 0 to ensure all added points are 2D.
        threePos.z = 0;
        // ===================== FIX END =======================

        const rosPos = this.threeToRos(threePos);
    
        this.db.run("BEGIN TRANSACTION");
        try {
            // Insert the new waypoint
            this.db.run("INSERT INTO waypoints (x, y, z) VALUES (?, ?, ?)", [rosPos.x, rosPos.y, rosPos.z]);
            const newPointId = this.db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    
            // If there was a previous point, create an edge to it
            if (lastPointId !== null && lastPointRosPos !== null) {
                const dx = rosPos.x - lastPointRosPos.x;
                const dy = rosPos.y - lastPointRosPos.y;
                const dz = rosPos.z - lastPointRosPos.z;
                const weight = Math.sqrt(dx * dx + dy * dy + dz * dz);
                this.db.run("INSERT INTO edge_graph (id1, id2, weight) VALUES (?, ?, ?)", [lastPointId, newPointId, weight]);
            }
            this.db.run("COMMIT");
        } catch (e) {
            this.db.run("ROLLBACK");
            console.error("Failed to add point and edge:", e);
            this.showErrorMessage("Failed to add point.");
        }
    
        await this.refreshWaypointsFromDB();
    }


    /**
     * Delete selected waypoints from database
     * * @async
     */
    async deleteSelectedPoints() {
        if (!this.db || this.selectedIndices.size === 0) return;

        const idsToDelete = Array.from(this.selectedIndices).map(index => this.indexToDbId[index]);
        if (idsToDelete.length === 0) return;

        const placeholders = idsToDelete.map(() => '?').join(',');
        this.db.run(`DELETE FROM waypoints WHERE id IN (${placeholders})`, idsToDelete);

        this.clearSelection();
        await this.refreshWaypointsFromDB();
    }

    updateDeletePanel() {
        const deleteBtn = document.getElementById('delete-selected-btn');
        if (deleteBtn) {
            // The button is enabled only if one or more points are selected
            deleteBtn.disabled = this.selectedIndices.size === 0;
        }
    }

    /**
     * Handles pointer down for selection-based tools (Move, Remove).
     * Manages single-click, shift-click, and marquee selection initiation.
     * @param {number} clickedIndex - The index of the clicked waypoint, or -1.
     * @param {PointerEvent} event - The DOM pointer event.
     */
    handleSelectionPointerDown(clickedIndex, event) {
        if (clickedIndex !== -1) {
            // --- Logic for clicking directly on a point ---
            if (event.shiftKey) {
                // Toggle selection with Shift key
                if (this.selectedIndices.has(clickedIndex)) {
                    this.selectedIndices.delete(clickedIndex);
                } else {
                    this.selectedIndices.add(clickedIndex);
                }
            } else {
                // Normal click
                if (!this.selectedIndices.has(clickedIndex)) {
                    // If it's not already in the selection, start a new selection.
                    this.clearSelection();
                    this.selectedIndices.add(clickedIndex);
                }
                // If it is already selected, do nothing. This allows dragging a group.
            }

            // If the active tool is 'move-points', start the drag operation.
            if (this.activeTool === 'move-points') {
                this.isDraggingPoint = true;
                this.dragStartIndex = clickedIndex;
                const positions = this.waypointsObject.geometry.attributes.position;
                this.dragStartPositions.clear();
                for (const index of this.selectedIndices) {
                    this.dragStartPositions.set(index, new THREE.Vector3().fromBufferAttribute(positions, index));
                }
                const startPos = this.dragStartPositions.get(clickedIndex);
                const cameraDirection = new THREE.Vector3();
                this.camera.getWorldDirection(cameraDirection);
                this.raycastPlane.setFromNormalAndCoplanarPoint(cameraDirection, startPos);
                const intersectionMove = new THREE.Vector3();
                if (this.raycaster.ray.intersectPlane(this.raycastPlane, intersectionMove)) {
                    this.dragStartOffset.subVectors(startPos, intersectionMove);
                }
                this.controls.enabled = false;
            }

        } else {
            // --- Logic for clicking on empty space (start marquee) ---
            if (!event.shiftKey) {
                this.clearSelection();
            }
            this.isMarqueeSelecting = true;
            this.controls.enabled = false;
            this.marqueeStart.set(event.clientX, event.clientY);
            const selectionBox = document.getElementById('selection-box');
            if (selectionBox) {
                selectionBox.style.display = 'block';
                selectionBox.style.left = `${event.clientX}px`;
                selectionBox.style.top = `${event.clientY}px`;
                selectionBox.style.width = '0px';
                selectionBox.style.height = '0px';
            }
        }
        // Update UI elements after any selection change
        this.updateAllColors();
        this.updateInfoPanel();
        this.updateDeletePanel();
    }
    // ====================================================================
    // WAYPOINT INTERPOLATION ALGORITHMS
    // ====================================================================

    /**
     * Apply linear interpolation between selected waypoints
     * * @async
     */
    async linearInterpolateSelected() {
        const indices = Array.from(this.selectedIndices).sort((a, b) => a - b);
        if (indices.length < 3) return;

        const positions = this.waypointsObject.geometry.attributes.position;
        const startIdx = indices[0];
        const endIdx = indices[indices.length - 1];

        const pStart = new THREE.Vector3().fromBufferAttribute(positions, startIdx);
        const pEnd = new THREE.Vector3().fromBufferAttribute(positions, endIdx);

        const intermediaryIndices = [];
        const newPositions = [];

        for (let i = 1; i < indices.length - 1; i++) {
            const currentIdx = indices[i];
            const t = (currentIdx - startIdx) / (endIdx - startIdx);
            const newPos = pStart.clone().lerp(pEnd, t);

            positions.setXYZ(currentIdx, newPos.x, newPos.y, newPos.z);
            intermediaryIndices.push(currentIdx);
            newPositions.push(newPos);
        }

        positions.needsUpdate = true;
        await this.batchUpdateDbPositions(intermediaryIndices, newPositions);
    }

    /**
     * Restore waypoints to their original positions before interpolation
     */
    restoreInterpolationPoints() {
        if (this.interpolationOriginalPositions.size === 0 || !this.waypointsObject) return;
        const positions = this.waypointsObject.geometry.attributes.position;
        for (const [index, pos] of this.interpolationOriginalPositions) {
            positions.setXYZ(index, pos.x, pos.y, pos.z);
        }
        positions.needsUpdate = true;
    }

    /**
     * Synchronize radial interpolation controls and preview changes
     * * @param {number} value - Interpolation strength value
     */
    syncAndPreviewRadial(value) {
        const radialSlider = document.getElementById('radial-strength');
        const radialValueInput = document.getElementById('radial-strength-value');
        const min = parseFloat(radialSlider.min);
        const max = parseFloat(radialSlider.max);
        let clampedValue = Math.max(min, Math.min(max, value));
        radialSlider.value = clampedValue;
        if (document.activeElement !== radialValueInput) {
           radialValueInput.value = clampedValue.toFixed(2);
        }
        this.restoreInterpolationPoints();
        this.performRadialInterpolation(false);
    }

    /**
     * Commit radial interpolation changes to database
     */
    commitRadialChange() {
        const radialSlider = document.getElementById('radial-strength');
        const radialValueInput = document.getElementById('radial-strength-value');
        this.restoreInterpolationPoints();
        this.performRadialInterpolation(true);
        this.interpolationOriginalPositions.clear();
        let finalValue = parseFloat(radialSlider.value);
        radialValueInput.value = finalValue.toFixed(2);
    }
   
    /**
     * Initialize radial interpolation preview mode
     */
    startRadialPreview() {
        if (this.interpolationOriginalPositions.size > 0) return;
        this.interpolationOriginalPositions.clear();
        if (!this.waypointsObject) return;
        const positions = this.waypointsObject.geometry.attributes.position;
        for (const index of this.selectedIndices) {
            this.interpolationOriginalPositions.set(index, new THREE.Vector3().fromBufferAttribute(positions, index));
        }
    };

    /**
     * Perform radial (Bezier curve) interpolation between selected waypoints
     * * @async
     * @param {boolean} saveToDb - Whether to persist changes to database
     */
    async performRadialInterpolation(saveToDb = false) {
        const indices = Array.from(this.selectedIndices).sort((a, b) => a - b);
        if (indices.length < 3) return;

        const positions = this.waypointsObject.geometry.attributes.position;
        const startIdx = indices[0];
        const endIdx = indices[indices.length - 1];
       
        const p0 = new THREE.Vector3().fromBufferAttribute(positions, startIdx);
        const p3 = new THREE.Vector3().fromBufferAttribute(positions, endIdx);

        // Get adjacent points for tangent calculation
        const prevIdx = startIdx > 0 ? startIdx - 1 : 0;
        const p_minus_1 = new THREE.Vector3().fromBufferAttribute(positions, prevIdx);
       
        const nextIdx = endIdx < positions.count - 1 ? endIdx + 1 : endIdx;
        const p_plus_1 = new THREE.Vector3().fromBufferAttribute(positions, nextIdx);

        const strength = parseFloat(document.getElementById('radial-strength').value);
        const tension = 0.35;

        // Calculate control points for Bezier curve
        const tangentDir0 = p3.clone().sub(p_minus_1).normalize();
        const tangentDir1 = p_plus_1.clone().sub(p0).normalize();

        const chord = p3.clone().sub(p0);
        const handleMagnitude = chord.length() * tension;
        if (handleMagnitude < 1e-6) return;

        let p1 = p0.clone().add(tangentDir0.multiplyScalar(handleMagnitude));
        let p2 = p3.clone().sub(tangentDir1.multiplyScalar(handleMagnitude));

        // Apply radial offset
        const perp = new THREE.Vector3(-chord.y, chord.x, 0).normalize();
        const offsetVector = perp.multiplyScalar(strength);

        p1.add(offsetVector);
        p2.add(offsetVector);

        const intermediaryIndices = [];
        const newPositions = [];
        
        // Apply Bezier curve interpolation
        for (let i = 1; i < indices.length - 1; i++) {
            const currentIdx = indices[i];
            const t = (currentIdx - startIdx) / (endIdx - startIdx);
           
            const t_inv = 1 - t;
            const c0 = t_inv * t_inv * t_inv;
            const c1 = 3 * t_inv * t_inv * t;
            const c2 = 3 * t_inv * t * t;
            const c3 = t * t * t;
           
            const newPos = p0.clone().multiplyScalar(c0)
                .add(p1.clone().multiplyScalar(c1))
                .add(p2.clone().multiplyScalar(c2))
                .add(p3.clone().multiplyScalar(c3));
           
            positions.setXYZ(currentIdx, newPos.x, newPos.y, newPos.z);
            intermediaryIndices.push(currentIdx);
            newPositions.push(newPos);
        }

        positions.needsUpdate = true;
       
        if (saveToDb) {
            await this.batchUpdateDbPositions(intermediaryIndices, newPositions);
        }
    }

    /**
     * Batch update waypoint positions in database
     * * @async
     * @param {Array<number>} indicesToUpdate - Indices of waypoints to update
     * @param {Array<THREE.Vector3>} newPositions - New positions for waypoints
     */
    async batchUpdateDbPositions(indicesToUpdate, newPositions) {
        if (!this.db || !this.waypointsObject) return;

        try {
            this.db.run("BEGIN TRANSACTION");

            for (let i = 0; i < indicesToUpdate.length; i++) {
                const index = indicesToUpdate[i];
                const db_id = this.indexToDbId[index];
                const threePos = newPositions[i].clone().add(this.mapOffset);
                const rosPos = this.threeToRos(threePos);

                this.db.run("UPDATE waypoints SET x = ?, y = ?, z = ? WHERE id = ?", 
                           [rosPos.x, rosPos.y, rosPos.z, db_id]);
            }

            this.db.run("COMMIT");
        } catch (e) {
            console.error("Batch DB update failed, rolling back.", e);
            this.db.run("ROLLBACK");
        }
    }

    // ====================================================================
    // SELECTION MANAGEMENT
    // ====================================================================

    /**
     * Clear all waypoint selections
     */
    clearSelection() {
        this.selectedIndices.clear();
        this.pathSelectionStartIndex = null;
        this.laneEditSelection = [];
        this.updateAllColors();
        this.updateInfoPanel();
        this.updateInterpolationPanel();
        this.updateTwoWayPanel(); 
        this.updateDeletePanel();
    }

    /**
     * Update interpolation panel UI based on current selection
     */
    updateInterpolationPanel() {
        const infoText = document.getElementById('interpolation-info');
        const linearBtn = document.getElementById('linear-interpolate');
        const radialSlider = document.getElementById('radial-strength');
        const radialValueInput = document.getElementById('radial-strength-value');
        const selectionSize = this.selectedIndices.size;

        if (this.pathSelectionStartIndex !== null && selectionSize > 0) {
            infoText.textContent = `Path start point selected. Click an end point.`;
        } else if (selectionSize > 0) {
             infoText.textContent = `${selectionSize} points selected.`;
        } else {
             infoText.textContent = `Select a path of 3 or more points to interpolate.`;
        }
       
        const canInterpolate = selectionSize >= 3;
        linearBtn.disabled = !canInterpolate;
        radialSlider.disabled = !canInterpolate;
        radialValueInput.disabled = !canInterpolate;
    }

    /**
     * Update waypoint colors based on selection state
     */
    updateAllColors() {
        if (!this.waypointsObject) return;

        const positions = this.waypointsObject.geometry.attributes.position;
        const colors = new Float32Array(positions.count * 3);

        const selectedColor = new THREE.Color(0xff8800);
        const defaultColor = new THREE.Color(0xffff00);
        const pathStartColor = new THREE.Color(0x00ff00);

        for (let i = 0; i < positions.count; i++) {
            let color = defaultColor;

            if (i === this.pathSelectionStartIndex) {
                color = pathStartColor;
            } else if (this.selectedIndices.has(i)) {
                color = selectedColor;
            }

            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        }

        this.waypointsObject.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    /**
     * Update waypoint visual properties based on camera settings
     */
    updateWaypointVisuals() {
        if (!this.waypointsObject || !this.camera) return;

        const perspectiveSize = this.dynamicPointSize;
        const orthoBaseSize = 3.0;
        const defaultDynamicSize = 0.05;
        const orthoSize = orthoBaseSize * (this.dynamicPointSize / defaultDynamicSize);

        this.waypointsObject.material.size = this.camera.isPerspectiveCamera ? perspectiveSize : orthoSize;
        this.waypointsObject.material.sizeAttenuation = this.camera.isPerspectiveCamera;
        this.waypointsObject.material.needsUpdate = true;
    }

    /**
     * Update selection based on marquee rectangle
     */
    updateSelectionFromMarquee() {
        if (!this.waypointsObject || !this.camera) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        const boxMinX = Math.min(this.marqueeStart.x, this.marqueeEnd.x) - rect.left;
        const boxMinY = Math.min(this.marqueeStart.y, this.marqueeEnd.y) - rect.top;
        const boxMaxX = Math.max(this.marqueeStart.x, this.marqueeEnd.x) - rect.left;
        const boxMaxY = Math.max(this.marqueeStart.y, this.marqueeEnd.y) - rect.top;

        const positions = this.waypointsObject.geometry.attributes.position;
        const tempVec = new THREE.Vector3();

        this.clearSelection();

        for (let i = 0; i < positions.count; i++) {
            tempVec.fromBufferAttribute(positions, i);
            tempVec.project(this.camera);

            const screenX = (tempVec.x * 0.5 + 0.5) * rect.width;
            const screenY = (-tempVec.y * 0.5 + 0.5) * rect.height;

            if (screenX >= boxMinX && screenX <= boxMaxX && screenY >= boxMinY && screenY <= boxMaxY) {
                this.selectedIndices.add(i);
            }
        }

        this.updateAllColors();
    }

    // ====================================================================
    // INFO PANEL AND UI UPDATES
    // ====================================================================

    updateWaypointCount() {
    const waypointCount = document.getElementById('waypoint-count');
    if (waypointCount) {
        waypointCount.textContent = this.indexToDbId.length.toString();
    }
}

    /**
 * Clear waypoint information display or reset it to a default state.
 */
clearWaypointInfo() {
    const waypointInfo = document.getElementById('waypoint-info');
    if (waypointInfo) {
        // Instead of hiding the panel, reset the text.
        let idText = 'None';
        if (this.selectedIndices.size > 1) {
            // Display a count if multiple points are selected.
            idText = `${this.selectedIndices.size} Selected`;
            
        }

        document.getElementById('waypoint-id').textContent = idText;
        document.getElementById('coord-x').textContent = '---';
        document.getElementById('coord-y').textContent = '---';
        document.getElementById('coord-z').textContent = '---';
    }
}
    /**
 * Update waypoint information display
 * @param {number} waypointIndex - Index of waypoint to display info for
 */
updateWaypointInfo(waypointIndex) {
    if (!this.db || waypointIndex < 0 || waypointIndex >= this.indexToDbId.length) {
        this.clearWaypointInfo();
        return;
    }

    try {
        const dbId = this.indexToDbId[waypointIndex];
        const stmt = this.db.prepare("SELECT x, y, z, roll, pitch, yaw FROM waypoints WHERE id = ?");
        const result = stmt.get([dbId]);
        stmt.free();

        if (result) {   
            const waypointInfo = document.getElementById('waypoint-info');
            console.log("Database result for selected point:", result);
            if (waypointInfo) {
                // The line that was here has been removed.

                document.getElementById('coord-x').textContent = (result[0] || 0).toFixed(4);
                document.getElementById('coord-y').textContent = (result[1] || 0).toFixed(4);
                document.getElementById('coord-z').textContent = (result[2] || 0).toFixed(4);
                document.getElementById('waypoint-id').textContent = dbId.toString();
            }
        }
    } catch (error) {
        console.error('Error updating waypoint info:', error);
        this.clearWaypointInfo();
    }
}
    // ====================================================================
    // LANE EDITING INTERFACE
    // ====================================================================

    /**
     * Update lane editing information panel
     */
    updateLaneEditInfo() {
        const infoDiv = document.getElementById('lane-edit-info');
        const widthEditor = document.getElementById('lane-width-editor');

        if (!infoDiv || !widthEditor) return;

        if (this.laneEditSelection.length === 0) {
            infoDiv.classList.add('hidden');
            widthEditor.classList.add('hidden');
            return;
        }

        let infoText = '';
        this.laneEditSelection.forEach((waypointIndex, i) => {
            const dbId = this.indexToDbId[waypointIndex];
            if (dbId === undefined) return;

            const stmt = this.db.prepare("SELECT x, y, z, width_left, width_right FROM waypoints WHERE id = ?");
            const result = stmt.get(dbId);
            stmt.free();

            if (result) {
                const x = (result[0] || 0).toFixed(3);
                const y = (result[1] || 0).toFixed(3);
                const z = (result[2] || 0).toFixed(3);

                infoText += `Point ${i + 1}: ID ${dbId}\n`;
                infoText += ` X:${x}, Y:${y}, Z:${z}\n\n`;

                if (i === 0) {
                    document.getElementById('left-lane-width-input').value = (result[3] || 0.5).toFixed(2);
                    document.getElementById('right-lane-width-input').value = (result[4] || 0.5).toFixed(2);
                }
            }
        });

        infoDiv.innerHTML = `<pre>${infoText}</pre>`;
        infoDiv.classList.remove('hidden');

        if (this.laneEditSelection.length === 2) {
            widthEditor.classList.remove('hidden');
        } else {
            widthEditor.classList.add('hidden');
        }
    }

    /**
     * Apply lane width changes and regenerate lane geometry
     * * @async
     * @param {string} side - Lane side ('left' or 'right')
     */
    async applyAndRegenerateLaneWidth(side) {
        if (!this.db || this.laneEditSelection.length !== 2 || !['left', 'right'].includes(side)) return;

        const widthInput = document.getElementById(`${side}-lane-width-input`);
        const width = parseFloat(widthInput.value);
        if (isNaN(width) || width < 0) return;

        const indices = [...this.laneEditSelection].sort((a, b) => a - b);
        const startDbId = this.indexToDbId[indices[0]];
        const endDbId = this.indexToDbId[indices[1]];
        const column = `width_${side}`;

        try {
            this.db.run(`UPDATE waypoints SET ${column} = ? WHERE id >= ? AND id < ?`, [width, startDbId, endDbId]);
            await this.drawLane();
        } catch (error) {
            console.error(`âŒ Failed to apply lane ${side} width:`, error);
        }
    }

    /**
     * Update main information panel
     */
    updateInfoPanel() {
        if (this.selectedIndices.size === 1) {
            const index = this.selectedIndices.values().next().value;
            this.updateWaypointInfo(index);
        } else {
            this.clearWaypointInfo();
        }
    }



/**
 * Generates and saves a line of points between two coordinates, creating sequential edges.
 */
async drawPoints(start, end, startDbId = null, endDbId = null) {
    const direction = end.clone().sub(start);
    const distance = direction.length();
    const step = 0.25;
    
    // This correctly allows creating a final connecting edge even if it's very short
    if (distance < step && endDbId === null) {
        return startDbId; 
    }

    const numPoints = Math.floor(distance / step);
    const pointsToAdd = [];

    for (let i = 1; i <= numPoints; i++) {
        const newPoint = start.clone().add(direction.clone().multiplyScalar(i * step / distance));
        pointsToAdd.push(newPoint);
    }
    
    return await this.batchAddPoints(pointsToAdd, startDbId, endDbId);
}

/**
 * Batch adds points and creates edges. Includes special handling for closing loops.
 */
async batchAddPoints(points, startDbId = null, endDbId = null) {
    if (!this.db) {
        this.db = new this.SQL.Database();
        this.db.run(WAYPOINT_TABLE_SQL);
        this.db.run(EDGE_GRAPH_TABLE_SQL);
    }

    // --- CRITICAL FIX ---
    // Handles closing a loop when the final segment is too short to add new points.
    // Its only job is to create the single, final edge.
    if (points.length === 0 && startDbId && endDbId) {
         try {
            const startRes = this.db.exec(`SELECT x, y, z FROM waypoints WHERE id = ${startDbId}`);
            const endRes = this.db.exec(`SELECT x, y, z FROM waypoints WHERE id = ${endDbId}`);
            if (startRes.length > 0 && endRes.length > 0) {
                const startPos = { x: startRes[0].values[0][0], y: startRes[0].values[0][1], z: startRes[0].values[0][2] };
                const endPos = { x: endRes[0].values[0][0], y: endRes[0].values[0][1], z: endRes[0].values[0][2] };
                const weight = Math.sqrt(Math.pow(endPos.x - startPos.x, 2) + Math.pow(endPos.y - startPos.y, 2) + Math.pow(endPos.z - startPos.z, 2));
                this.db.run("INSERT INTO edge_graph (id1, id2, weight) VALUES (?, ?, ?)", [startDbId, endDbId, weight]);
                await this.refreshWaypointsFromDB();
            }
        } catch(e) { console.error("Failed to create closing edge:", e); }
        return endDbId;
    }
    
    if (points.length === 0) return startDbId;

    let lastPointId = startDbId;
    try {
        this.db.run("BEGIN TRANSACTION");
        const waypointStmt = this.db.prepare("INSERT INTO waypoints (x, y, z) VALUES (?, ?, ?)");
        const edgeStmt = this.db.prepare("INSERT INTO edge_graph (id1, id2, weight) VALUES (?, ?, ?)");
        let lastPointRosPos = null;

        if (startDbId !== null) {
            const res = this.db.exec(`SELECT x, y, z FROM waypoints WHERE id = ${startDbId}`);
            if (res.length > 0 && res[0].values.length > 0) {
                 lastPointRosPos = { x: res[0].values[0][0], y: res[0].values[0][1], z: res[0].values[0][2] };
            }
        }

        for (const point of points) {
            const rosPos = this.threeToRos(point.clone().add(this.mapOffset));
            waypointStmt.run([rosPos.x, rosPos.y, rosPos.z]);
            const newPointId = this.db.exec("SELECT last_insert_rowid()")[0].values[0][0];
            if (lastPointId !== null && lastPointRosPos !== null) {
                const weight = Math.sqrt(Math.pow(rosPos.x - lastPointRosPos.x, 2) + Math.pow(rosPos.y - lastPointRosPos.y, 2) + Math.pow(rosPos.z - lastPointRosPos.z, 2));
                edgeStmt.run([lastPointId, newPointId, weight]);
            }
            lastPointId = newPointId;
            lastPointRosPos = rosPos;
        }
        
        if (endDbId !== null && lastPointId !== null) {
            const res = this.db.exec(`SELECT x, y, z FROM waypoints WHERE id = ${endDbId}`);
            if (res.length > 0 && res[0].values.length > 0) {
                const endPointRosPos = { x: res[0].values[0][0], y: res[0].values[0][1], z: res[0].values[0][2] };
                const weight = Math.sqrt(Math.pow(endPointRosPos.x - lastPointRosPos.x, 2) + Math.pow(endPointRosPos.y - lastPointRosPos.y, 2) + Math.pow(endPointRosPos.z - lastPointRosPos.z, 2));
                edgeStmt.run([lastPointId, endDbId, weight]);
            }
        }

        waypointStmt.free();
        edgeStmt.free();
        this.db.run("COMMIT");
    } catch (e) {
        console.error("Batch DB insert failed, rolling back.", e);
        this.db.run("ROLLBACK");
    } finally {
        await this.refreshWaypointsFromDB();
        // The final return value must be the ID of the last point in the chain
        if (endDbId !== null) {
             return endDbId;
        }
        return lastPointId;
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


    updateTwoWayPanel() {
        const infoText = document.getElementById('two-way-info');
        const markBtn = document.getElementById('mark-two-way');
        const selectionSize = this.selectedIndices.size;

        if (this.pathSelectionStartIndex !== null) {
            infoText.textContent = `Path start selected. Click an end point.`;
        } else if (selectionSize > 0) {
            infoText.textContent = `${selectionSize} points selected.`;
        } else {
            infoText.textContent = `Select a start and end point to define a path.`;
        }
        markBtn.disabled = selectionSize < 1;
    }

    /**
     * Marks the currently selected points as two_way=1 in the database.
     */
    async markSelectedAsTwoWay() {
        if (!this.db || this.selectedIndices.size === 0) return;

        const idsToUpdate = Array.from(this.selectedIndices).map(index => this.indexToDbId[index]);
        if (idsToUpdate.length === 0) return;

        const placeholders = idsToUpdate.map(() => '?').join(',');
        this.db.run(`UPDATE waypoints SET two_way = 1 WHERE id IN (${placeholders})`, idsToUpdate);

        this.clearSelection();
        await this.refreshWaypointsFromDB(); // Reload data to show color change
        console.log(`âœ… Marked ${idsToUpdate.length} points as two-way.`);
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
        const toolButtons = document.querySelectorAll('.tool-button, .tool-button-layout, .action-btn');
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
    
    // NEW: Function to cleanly exit the persistent drawing mode.
    exitPersistentDrawing() {
        this.isPersistentDrawing = false;
        this.isDrawingPoints = false;
        if (this.ghostLine) {
            this.scene.remove(this.ghostLine);
            this.ghostLine.geometry.dispose();
            this.ghostLine.material.dispose();
            this.ghostLine = null;
        }
        this.drawPointsStartDbId = null;
        this.drawingPlane = null;
        this.controls.enabled = true;
        this.activeTool = null;
        document.getElementById('app').style.cursor = 'default';
        const drawToolBtn = document.getElementById('tool-draw-points');
        if (drawToolBtn) drawToolBtn.classList.remove('active');
        console.log('Exited persistent drawing mode.');
    }

    // ====================================================================
    // EVENT HANDLING METHODS
    // ====================================================================

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
            case 'add-points':
                {
                    let intersectionPoint;
                    const mapIntersects = this.mapObject ? this.raycaster.intersectObject(this.mapObject) : [];
                    if (mapIntersects.length > 0) {
                        intersectionPoint = mapIntersects[0].point;
                    } else {
                        const planeIntersect = new THREE.Vector3();
                        if (this.raycaster.ray.intersectPlane(this.raycastPlane, planeIntersect)) {
                            intersectionPoint = planeIntersect;
                        }
                    }
                    if (intersectionPoint) this.addPoint(intersectionPoint);
                }
                break;
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
            if (this.selectedShape.selectionOutline) this.selectedShape.selectionOutline.update();
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

            if (shape.selectionOutline) shape.selectionOutline.update();
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

    // ====================================================================
    // UTILITY METHODS
    // ====================================================================
    
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
            this.showErrorMessage("Database exported successfully!"); // Use error message as a notification
    
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
     * Update hover coordinate display
     * * @param {THREE.Vector3|null} coords - World coordinates to display
     */
    updateHoverCoordinates(coords) {
        const hoverCoords = document.getElementById('hover-coords');
        if (!hoverCoords) return;

        if (coords) {
            const formatted = `X: ${coords.x.toFixed(2)}, Y: ${coords.y.toFixed(2)}, Z: ${coords.z.toFixed(2)}`;
            hoverCoords.textContent = formatted;
            hoverCoords.style.display = 'block';
        } else {
            hoverCoords.style.display = 'none';
        }
    }

    /**
     * Handle window resize events
     */
    onWindowResize() {
        if (!this.camera) return;

        const aspect = window.innerWidth / window.innerHeight;

        if (this.camera.isPerspectiveCamera) {
            this.camera.aspect = aspect;
        } else if (this.camera.isOrthographicCamera) {
            const orthoSize = (this.camera.top - this.camera.bottom) / 2;
            this.camera.left = -orthoSize * aspect;
            this.camera.right = orthoSize * aspect;
        }

        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
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
    // EVENT LISTENER SETUP
    // ====================================================================

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
        ['add-points', 'draw-points', 'remove-points', 'move-points', 'interpolate', 'two-way'].forEach(tool => {
            document.getElementById(`tool-${tool}`).addEventListener('click', () => this.selectTool(tool));
        });

        document.getElementById('linear-interpolate').addEventListener('click', () => this.linearInterpolateSelected());
        document.getElementById('mark-two-way').addEventListener('click', () => this.markSelectedAsTwoWay());
        
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
                    if (this.selectedIndices.size > 0) this.deleteSelectedPoints();
                    if (this.selectedShape) this.deleteSelectedShape();
                    break;
            }
        });
    }

    // ====================================================================
    // TAB AND PANEL MANAGEMENT
    // ====================================================================

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
        document.querySelectorAll('.tool-button, .tool-button-layout').forEach(b => b.classList.remove('active'));
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
        alert(`Error: ${message}`);
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
}

// ====================================================================
// APPLICATION BOOTSTRAP AND ERROR HANDLING
// ====================================================================

/** @type {WaypointEditPlus} Global application instance */
let app = null;

/**
 * Bootstrap the ViryaOSLaneStudio application
 * Ensures DOM is ready before initialization
 */
function bootstrap() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
        return;
    }
    app = new ViryaOSLaneStudio();
    app.init();
    window.viryaOSLaneStudio = app; // For debugging
    // Expose to window for debugging
    window.waypointEditPlus = app;
}

// Global error handler
window.addEventListener('error', (event) => {
    console.error('ðŸ’¥ ViryaOSLaneStudio error:', event.error);
    if (app) {
        app.showErrorMessage(`Unexpected error: ${event.error.message}`);
    }
});

// Start the application
bootstrap();