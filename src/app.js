/**
 * WaypointEdit+ - Complete Point Cloud Viewer with Enhanced Layout Tools
 * Refactored: Replaced transform buttons with direct manipulation (move/resize) via bounding box handles.
 * Fixed: Bugs related to text editing and shape transformation by removing duplicate functions.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

// Define the database schema at the top level
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
    width_right REAL DEFAULT 0.5
);`;

class WaypointEditPlus {
    constructor() {
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0b0e14);
        this.camera = null;
        this.controls = null;
        this.renderer = null;

        // Objects
        this.mapObject = null;
        this.waypointsObject = null;
        this.originalMapGeometry = null;
        this.hoverIndicator = null;
        this.pathGroup = new THREE.Group();

        // Enhanced Drawing/Annotation State
        this.shapeGroup = new THREE.Group();
        this.isDrawing = false;
        this.drawStartPoint = new THREE.Vector3();
        this.ghostShape = null;
        this.shapes = [];
        this.selectedShape = null;
        this.font = null;
        this.fontLoader = new FontLoader();
        this.textInsertionPoint = null;

        // REFACTORED: Shape transformation state
        this.isMovingShape = false;
        this.isResizingShape = false;
        this.resizeHandles = [];
        this.activeHandle = null;
        this.transformStartPos = new THREE.Vector2();
        this.shapeStartTransform = {};
        this.isEditingText = false; // Flag to know if we are editing existing text

        // State from viewer.html
        this.editMode = false;
        this.editSubMode = 'select';
        this.activeTab = 'view';
        this.activeTool = null;
        this.laneEditSelection = [];
        this.selectedIndices = new Set();
        this.hoveredPointIndex = null;
        this.indexToDbId = [];
        this.dynamicPointSize = 0.05;
        this.mapOffset = new THREE.Vector3();

        // Tool states
        this.isDraggingPoint = false;
        this.dragStartIndex = -1;
        this.dragStartOffset = new THREE.Vector3();
        this.dragStartPositions = new Map();
        this.pathSelectionStartIndex = null;
        this.interpolationOriginalPositions = new Map();

        // Marquee selection
        this.isMarqueeSelecting = false;
        this.marqueeStart = new THREE.Vector2();
        this.marqueeEnd = new THREE.Vector2();

        // Database
        this.db = null;
        this.SQL = null;

        // Interaction
        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this.raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        this.isInitialized = false;
        this.animationId = null;

        console.log('🚀 WaypointEdit+ Application starting...');
    }

    async init() {
        try {
            console.log('🔧 Initializing WaypointEdit+ system...');
            const container = document.getElementById('app');
            if (!container) {
                throw new Error('Main app container not found');
            }

            // Initialize SQL.js
            await this.initDatabase();
            this.loadFont();

            // Setup renderer
            this.setupRenderer(container);

            // Setup lighting and grid
            this.setupLighting();

            // Create hover indicator
            this.createHoverIndicator();

            // Setup raycaster
            this.raycaster.params.Points.threshold = 0.05;

            // Setup default camera view
            this.setView('orbit');

            // Attach event listeners
            this.attachEventListeners();

            // Start animation loop
            this.startAnimationLoop();

            this.isInitialized = true;

            console.log('');
            console.log('🎉 ===== WAYPOINTEDIT+ READY =====');
            console.log('✅ Direct manipulation for shapes (move/resize)');
            console.log('✅ Double-click to edit text enabled');
            console.log('✅ Removed conflicting transform logic');
            console.log('');
            console.log('🐛 DEBUG: window.waypointEditPlus.getStatus()');
            console.log('=====================================');
        } catch (error) {
            console.error('❌ Failed to initialize WaypointEdit+:', error);
            this.showErrorMessage(error.message);
        }
    }

    async initDatabase() {
        try {
            if (typeof initSqlJs !== 'undefined') {
                this.SQL = await initSqlJs({
                    locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
                });
                console.log('✅ SQL.js initialized for WaypointEdit+');
                return true;
            } else {
                console.warn('⚠️ SQL.js not available');
                return false;
            }
        } catch (error) {
            console.error('❌ Failed to initialize SQL.js:', error);
            return false;
        }
    }

    setupRenderer(container) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        container.appendChild(this.renderer.domElement);
        window.addEventListener('resize', () => this.onWindowResize());
    }

    setupLighting() {
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(2, 2, 3);
        this.scene.add(directionalLight);

        const gridHelper = new THREE.GridHelper(10, 20, 0x3d4a66, 0x202838);
        gridHelper.rotation.x = Math.PI / 2;
        this.scene.add(gridHelper);

        this.scene.add(this.pathGroup);
        this.scene.add(this.shapeGroup);
    }
    
    // ====================================================================
    // NEW / REFACTORED SHAPE AND TEXT EDITING LOGIC
    // ====================================================================

    updateText(textMesh, newText) {
        if (!this.font || textMesh.userData.type !== 'text' || !newText) return;

        // Create new geometry with the original size/scale in mind
        const textGeo = new TextGeometry(newText, {
            font: this.font,
            size: 1, // Base size is 1, we control final size with mesh.scale
            height: 0.01
        });

        textMesh.geometry.dispose(); // Clean up old geometry
        textMesh.geometry = textGeo;
        textMesh.userData.originalText = newText;

        // Recenter the new geometry so the mesh's position is the true center
        textGeo.computeBoundingBox();
        const centerOffset = new THREE.Vector3();
        textGeo.boundingBox.getCenter(centerOffset).negate();
        textMesh.geometry.translate(centerOffset.x, centerOffset.y, centerOffset.z);

        // Update selection visuals
        if (this.selectedShape === textMesh) {
            this.removeSelectionOutline(textMesh);
            this.addSelectionOutline(textMesh);
            this.clearResizeHandles();
            this.createResizeHandles(textMesh);
        }
    }

    updateStyleUI(shape) {
        if (!shape) return;

        document.getElementById('style-controls').classList.remove('hidden');

        const isText = shape.userData.type === 'text';
        document.getElementById('shape-style-controls').classList.toggle('hidden', isText);
        document.getElementById('text-style-controls').classList.toggle('hidden', !isText);

        if (isText) {
            document.getElementById('text-color').value = `#${shape.material.color.getHexString()}`;
            const sizeSlider = document.getElementById('text-size');
            // Text size is controlled by scale. Since it's uniform, we use X.
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

    onDblClick(event) {
        if (this.activeTab !== 'layout-drawings') return;

        const coords = this.getPointerCoordinates(event);
        this.pointer.copy(coords);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        
        // Find if we double-clicked a text shape
        const intersects = this.raycaster.intersectObjects(this.shapes);
        const textIntersect = intersects.find(hit => hit.object.userData.type === 'text');

        if (textIntersect) {
            this.selectShape(textIntersect.object);
            this.showTextInputModal(true, this.selectedShape.userData.originalText);
        }
    }

    selectShape(shape) {
        if (this.selectedShape === shape) return;
        this.clearShapeSelection();
        this.selectedShape = shape;

        if (shape) {
            this.addSelectionOutline(shape);
            this.createResizeHandles(shape); // Add handles on selection
            this.updateStyleUI(shape);
        }
    }

    clearShapeSelection() {
        if (this.selectedShape) {
            this.removeSelectionOutline(this.selectedShape);
            this.clearResizeHandles(); // Remove handles on deselection
            this.selectedShape = null;
        }
        document.getElementById('style-controls').classList.add('hidden');
        document.getElementById('layout-edit-text').classList.add('hidden');
    }

    addSelectionOutline(shape) {
        if (shape.selectionOutline) return;
        // Use BoxHelper for a simple, clean outline
        const outline = new THREE.BoxHelper(shape, 0x4a9eff);
        shape.selectionOutline = outline;
        this.shapeGroup.add(outline);
    }
    
    removeSelectionOutline(shape) {
        if (shape.selectionOutline) {
            this.shapeGroup.remove(shape.selectionOutline);
            shape.selectionOutline.geometry.dispose();
            shape.selectionOutline.material.dispose();
            shape.selectionOutline = null;
        }
    }

    createResizeHandles(shape) {
        this.clearResizeHandles();
        const box = new THREE.Box3().setFromObject(shape);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        
        // Make handle size responsive to camera zoom
        const handleSize = this.dynamicPointSize * 2;
        const handleGeometry = new THREE.BoxGeometry(handleSize, handleSize, handleSize);
        const handleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

        // 8 corner handles
        const handlePositions = [
            new THREE.Vector3(center.x - size.x / 2, center.y - size.y / 2, 0), // bottom-left
            new THREE.Vector3(center.x + size.x / 2, center.y - size.y / 2, 0), // bottom-right
            new THREE.Vector3(center.x + size.x / 2, center.y + size.y / 2, 0), // top-right
            new THREE.Vector3(center.x - size.x / 2, center.y + size.y / 2, 0), // top-left
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

    clearResizeHandles() {
        this.resizeHandles.forEach(handle => {
            this.shapeGroup.remove(handle);
            handle.geometry.dispose();
            handle.material.dispose();
        });
        this.resizeHandles = [];
    }

    // ====================================================================
    // END OF REFACTORED SECTION
    // ====================================================================


    loadFont() {
        const fontPath = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/helvetiker_regular.typeface.json';
        this.fontLoader.load(fontPath, (loadedFont) => {
            this.font = loadedFont;
            console.log('✅ Font loaded successfully for text labels.');
        }, undefined, (error) => {
            console.error('❌ Failed to load font:', error);
        });
    }

    addTextLabel(text, position) {
        if (!this.font) return alert('Font not loaded.');

        const size = parseFloat(document.getElementById('text-size').value);
        const color = document.getElementById('text-color').value;
        
        const textGeo = new TextGeometry(text, { font: this.font, size: 1, height: 0.01 });
        const textMat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true });
        const textMesh = new THREE.Mesh(textGeo, textMat);
        
        textGeo.computeBoundingBox();
        const centerOffset = new THREE.Vector3();
        textGeo.boundingBox.getCenter(centerOffset).negate();
        textMesh.geometry.translate(centerOffset.x, centerOffset.y, centerOffset.z);
        
        textMesh.position.copy(position);
        textMesh.scale.setScalar(size);
        
        textMesh.userData = {
            type: 'text', isShape: true, originalText: text
        };
        
        this.shapes.push(textMesh);
        this.shapeGroup.add(textMesh);
        return textMesh;
    }

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

    hideTextInputModal() {
        const modal = document.getElementById('text-input-modal');
        if (modal) modal.classList.add('hidden');
        this.textInsertionPoint = null;
        this.isEditingText = false;
    }
    
    applyColorToSelectedShape() {
        if (!this.selectedShape || !this.selectedShape.material) return;
        const colorPicker = document.getElementById('fill-color');
        if (colorPicker) {
            this.selectedShape.material.color.setStyle(colorPicker.value);
        }
    }

    applyOpacityToSelectedShape() {
        if (!this.selectedShape || !this.selectedShape.material) return;
        const opacitySlider = document.getElementById('shape-opacity');
        if (opacitySlider) {
            this.selectedShape.material.opacity = parseFloat(opacitySlider.value);
        }
    }
    
    async drawLane() {
        this.clearLane();
        if (!this.db) return;

        const stmt = this.db.prepare("SELECT x, y, z, width_left, width_right FROM waypoints ORDER BY id;");
        const waypointsData = [];

        while(stmt.step()) {
            const row = stmt.getAsObject();
            if (!(row.x === 0 && row.y === 0 && row.z === 0)) {
                waypointsData.push({
                    ...row,
                    pos: this.rosToThree({x: row.x, y: row.y, z: row.z}).sub(this.mapOffset)
                });
            }
        }
        stmt.free();

        if (waypointsData.length < 2) return;

        const leftVerts = [];
        const rightVerts = [];

        for (let i = 0; i < waypointsData.length; i++) {
            const p_curr = waypointsData[i].pos;
            const halfWidthLeft = (waypointsData[i].width_left || 0.5);
            const halfWidthRight = (waypointsData[i].width_right || 0.5);

            let normal, miterScale = 1.0;

            if (i === 0) {
                const dir_out = waypointsData[i+1].pos.clone().sub(p_curr).normalize();
                normal = new THREE.Vector3(-dir_out.y, dir_out.x, 0).normalize();
            } else if (i === waypointsData.length - 1) {
                const dir_in = p_curr.clone().sub(waypointsData[i-1].pos).normalize();
                normal = new THREE.Vector3(-dir_in.y, dir_in.x, 0).normalize();
            } else {
                const dir_in = p_curr.clone().sub(waypointsData[i-1].pos).normalize();
                const dir_out = waypointsData[i+1].pos.clone().sub(p_curr).normalize();
                const normal_in = new THREE.Vector3(-dir_in.y, dir_in.x, 0);
                const normal_out = new THREE.Vector3(-dir_out.y, dir_out.x, 0);
                normal = normal_in.clone().add(normal_out).normalize();
                const dot = normal_in.dot(normal);
                if (Math.abs(dot) > 0.0001) miterScale = 1 / dot;
            }

            leftVerts.push(p_curr.clone().add(normal.clone().multiplyScalar(halfWidthLeft * miterScale)));
            rightVerts.push(p_curr.clone().sub(normal.clone().multiplyScalar(halfWidthRight * miterScale)));
        }

        const vertices = [];
        for (let i = 0; i < waypointsData.length; i++) {
            vertices.push(leftVerts[i].x, leftVerts[i].y, leftVerts[i].z);
            vertices.push(rightVerts[i].x, rightVerts[i].y, rightVerts[i].z);
        }

        const indices = [];
        for (let i = 0; i < waypointsData.length - 1; i++) {
            const i2 = i * 2;
            indices.push(i2, i2 + 1, i2 + 2, i2 + 2, i2 + 1, i2 + 3);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setIndex(indices);

        const material = new THREE.MeshBasicMaterial({
            color: 0x559FFF,
            transparent: true,
            opacity: 0.8,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = -1;
        this.pathGroup.add(mesh);
    }

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
                shape.moveTo(-halfWidth,0.5 );
                shape.lineTo(halfWidth, 0.5);
                break;
            default: return null;
        }
        return new THREE.ShapeGeometry(shape);
    }

    addShape(type, startPos, endPos, isGhost = false) {
        const width = Math.abs(endPos.x - startPos.x);
        const height = Math.abs(endPos.y - startPos.y);
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

    deleteSelectedShape() {
        const shape = this.selectedShape;
        if (!shape) return;

        this.clearShapeSelection();
        this.shapeGroup.remove(shape);
        const index = this.shapes.indexOf(shape);
        if (index > -1) {
            this.shapes.splice(index, 1);
        }
        shape.geometry.dispose();
        shape.material.dispose();
        console.log('🗑️ Deleted shape');
    }

    // ... (All other methods like generateLane, createHoverIndicator, load files, etc., remain the same)
    clearLane() {
        while(this.pathGroup.children.length > 0){
            const mesh = this.pathGroup.children[0];
            this.pathGroup.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
    }
    
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
            console.log(`✅ Applied global width ${totalWidth}m to all waypoints.`);
            await this.drawLane();
        } catch (error) {
            console.error("❌ Failed to update waypoint widths:", error);
        }
    }

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

    setView(viewType) {
        if (this.controls) this.controls.dispose();

        const aspect = window.innerWidth / window.innerHeight;
        let targetObject = this.mapObject || this.scene.children.find(child => child.type === 'GridHelper');
        const box = new THREE.Box3().setFromObject(targetObject || this.scene);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 10;

        if (viewType === 'orbit') {
            const near = Math.max(maxDim * 0.001, 0.01);
            const far = maxDim * 100;
            this.camera = new THREE.PerspectiveCamera(60, aspect, near, far);
            this.camera.up.set(0, 0, 1);
            const camDist = maxDim * 1.5;
            this.camera.position.copy(center).add(new THREE.Vector3(camDist * 0.7, -camDist * 0.7, camDist * 0.7));
            this.raycastPlane.set(new THREE.Vector3(0, 0, 1), center.z);
        } else if (viewType === 'top') {
            const orthoSize = maxDim * 0.6;
            this.camera = new THREE.OrthographicCamera(-orthoSize * aspect, orthoSize * aspect, orthoSize, -orthoSize, -maxDim * 5, maxDim * 5);
            this.camera.up.set(0, 0, 1);
            this.camera.position.set(center.x, center.y, center.z + maxDim);
            this.raycastPlane.set(new THREE.Vector3(0, 0, 1), center.z);
        }

        this.camera.lookAt(center);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.target.copy(center);
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.PAN
        };

        if (viewType === 'top') {
            this.controls.minPolarAngle = 0;
            this.controls.maxPolarAngle = 0;
        }

        this.dynamicPointSize = Math.max(maxDim / 800, 0.02);
        this.updateWaypointVisuals();
    }

    async loadPointCloudFile(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const loader = file.name.toLowerCase().endsWith('.ply') ? new PLYLoader() : new PCDLoader();

            loader.load(url, (object) => {
                try {
                    const geometry = object.isPoints ? object.geometry : object;

                    if (this.mapObject) {
                        this.scene.remove(this.mapObject);
                        this.mapObject.geometry.dispose();
                        this.mapObject.material.dispose();
                    }

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
                    console.log(`✅ Loaded point cloud: ${file.name}`);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }, undefined, reject);
        });
    }

    applyROSTransformation(geometry) {
        const positions = geometry.attributes.position.array;
        for (let i = 0; i < positions.length; i += 3) {
            let x = positions[i];
            let y = positions[i + 1];
            positions[i] = -y;
            positions[i + 1] = x;
        }
        geometry.attributes.position.needsUpdate = true;
        console.log('✅ Applied ROS coordinate transformation');
    }

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

            this.db.run("UPDATE waypoints SET zone = 'N/A' WHERE zone IS NULL;");

            const tableCheck = this.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='waypoints'");
            if (tableCheck.length === 0) {
                throw new Error("No waypoints table found in the database");
            }

            await this.refreshWaypointsFromDB();
            console.log('✅ WaypointEdit+ waypoints loaded successfully');
        } catch (err) {
            console.error("❌ Error loading database:", err);
            alert(`Error loading database: ${err.message}`);
        }
    }

    async refreshWaypointsFromDB() {
        this.clearVisualWaypoints();
        if (!this.db) return;

        try {
            const stmt = this.db.prepare("SELECT id, x, y, z FROM waypoints ORDER BY id;");
            const positions = [];
            this.indexToDbId = [];

            while (stmt.step()) {
                const row = stmt.get();
                const currentIndex = this.indexToDbId.length;
                this.indexToDbId.push(row[0]);

                const transformed = this.rosToThree({x: row[1], y: row[2], z: row[3]});
                positions.push(
                    transformed.x - this.mapOffset.x,
                    transformed.y - this.mapOffset.y,
                    transformed.z - this.mapOffset.z
                );
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
            console.error("❌ Error loading waypoints:", err);
        }
    }

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

    rosToThree(v) {
        return new THREE.Vector3(-v.y, v.x, v.z);
    }

    threeToRos(v) {
        return new THREE.Vector3(v.y, -v.x, v.z);
    }

    findClosestPointOrthographic(event) {
        if (!this.waypointsObject || !this.camera) return -1;

        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        };

        const hitRadius = 10;
        let closestPointIndex = -1;
        let minDistanceSq = Infinity;

        const positions = this.waypointsObject.geometry.attributes.position;
        const tempVec = new THREE.Vector3();

        for (let i = 0; i < positions.count; i++) {
            tempVec.fromBufferAttribute(positions, i);
            tempVec.project(this.camera);

            const screenX = (tempVec.x * 0.5 + 0.5) * rect.width;
            const screenY = (-tempVec.y * 0.5 + 0.5) * rect.height;

            const dx = mouse.x - screenX;
            const dy = mouse.y - screenY;
            const distanceSq = dx * dx + dy * dy;

            if (distanceSq < minDistanceSq && distanceSq < hitRadius * hitRadius) {
                minDistanceSq = distanceSq;
                closestPointIndex = i;
            }
        }

        return closestPointIndex;
    }

    getPointerCoordinates(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        return {
            x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
            y: -((event.clientY - rect.top) / rect.height) * 2 + 1
        };
    }

    transformWorldToLocal(worldPoint) {
        return worldPoint.clone().sub(this.mapOffset);
    }

    transformLocalToWorld(localPoint) {
        return localPoint.clone().add(this.mapOffset);
    }

    handleHover(event) {
        if (!this.camera || this.editMode || this.isDraggingPoint || this.isMarqueeSelecting || !this.waypointsObject) {
            if (this.hoverIndicator.visible) {
                this.hoveredPointIndex = null;
                this.hoverIndicator.visible = false;
            }
            return;
        }

        let index = -1;
        if (this.camera.isOrthographicCamera) {
            index = this.findClosestPointOrthographic(event);
        } else {
            const rect = this.renderer.domElement.getBoundingClientRect();
            this.pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
            this.pointer.y = (event.clientY - rect.top) / rect.height * -2 + 1;

            this.raycaster.params.Points.threshold = this.dynamicPointSize;
            this.raycaster.setFromCamera(this.pointer, this.camera);

            const intersects = this.raycaster.intersectObject(this.waypointsObject);
            if (intersects.length > 0) {
                index = intersects[0].index;
            }
        }

        if (index === -1) {
            if (this.hoveredPointIndex !== null) {
                this.hoveredPointIndex = null;
                this.hoverIndicator.visible = false;
                this.clearWaypointInfo();
            }
        } else if (this.hoveredPointIndex !== index) {
            this.hoveredPointIndex = index;
            const pos = new THREE.Vector3().fromBufferAttribute(this.waypointsObject.geometry.attributes.position, index);
            this.hoverIndicator.position.copy(pos);
            this.hoverIndicator.visible = true;
            this.updateWaypointInfo(index);
        }
    }

    async addPoint(position) {
        if (!this.db) {
            this.db = new this.SQL.Database();
            this.db.run(WAYPOINT_TABLE_SQL);
        }

        const threePos = position.clone().add(this.mapOffset);
        const rosPos = this.threeToRos(threePos);
        this.db.run("INSERT INTO waypoints (x, y, z, roll, pitch, yaw) VALUES (?, ?, ?, 0, 0, 0)", [rosPos.x, rosPos.y, rosPos.z]);
        await this.refreshWaypointsFromDB();
    }

    async deleteSelectedPoints() {
        if (!this.db || this.selectedIndices.size === 0) return;

        const idsToDelete = Array.from(this.selectedIndices).map(index => this.indexToDbId[index]);
        if (idsToDelete.length === 0) return;

        const placeholders = idsToDelete.map(() => '?').join(',');
        this.db.run(`DELETE FROM waypoints WHERE id IN (${placeholders})`, idsToDelete);

        this.clearSelection();
        await this.refreshWaypointsFromDB();
    }

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

    async batchUpdateDbPositions(indicesToUpdate, newPositions) {
        if (!this.db || !this.waypointsObject) return;

        try {
            this.db.run("BEGIN TRANSACTION");

            for (let i = 0; i < indicesToUpdate.length; i++) {
                const index = indicesToUpdate[i];
                const db_id = this.indexToDbId[index];
                const threePos = newPositions[i].clone().add(this.mapOffset);
                const rosPos = this.threeToRos(threePos);

                this.db.run("UPDATE waypoints SET x = ?, y = ?, z = ? WHERE id = ?", [rosPos.x, rosPos.y, rosPos.z, db_id]);
            }

            this.db.run("COMMIT");
        } catch (e) {
            console.error("Batch DB update failed, rolling back.", e);
            this.db.run("ROLLBACK");
        }
    }

    clearSelection() {
        this.selectedIndices.clear();
        this.pathSelectionStartIndex = null;
        this.laneEditSelection = [];
        this.updateAllColors();
        this.updateInfoPanel();
    }

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

    updateWaypointInfo(waypointIndex) {
        if (!this.db || waypointIndex < 0 || waypointIndex >= this.indexToDbId.length) {
            this.clearWaypointInfo();
            return;
        }

        try {
            const dbId = this.indexToDbId[waypointIndex];
            const stmt = this.db.prepare("SELECT x, y, z, roll, pitch, yaw FROM waypoints WHERE id = ?");
            const result = stmt.get(dbId);
            stmt.free();

            if (result) {
                const waypointInfo = document.getElementById('waypoint-info');
                if (waypointInfo) {
                    waypointInfo.classList.remove('hidden');
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

    clearWaypointInfo() {
        const waypointInfo = document.getElementById('waypoint-info');
        if (waypointInfo) {
            waypointInfo.classList.add('hidden');
        }
    }

    updateWaypointCount() {
        const waypointCount = document.getElementById('waypoint-count');
        if (waypointCount) {
            waypointCount.textContent = this.indexToDbId.length.toString();
        }
    }

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
            console.error(`❌ Failed to apply lane ${side} width:`, error);
        }
    }

    updateInfoPanel() {
        if (this.selectedIndices.size === 1) {
            const index = this.selectedIndices.values().next().value;
            this.updateWaypointInfo(index);
        } else {
            this.clearWaypointInfo();
        }
    }

    setEditMode(mode) {
        this.editMode = ['waypoint-edit', 'lane-edit', 'layout-drawings'].includes(mode);
        this.activeTab = mode;
        console.log(`📝 Edit mode: ${this.editMode ? 'ON' : 'OFF'}`);
        if (!this.editMode) {
            this.clearSelection();
            this.clearShapeSelection();
        }
    }

    selectTool(toolName) {
        this.activeTool = toolName;
        console.log(`🛠️ Selected tool: ${toolName}`);

        const toolButtons = document.querySelectorAll('.tool-button, .tool-button-layout, .action-btn');
        toolButtons.forEach(btn => btn.classList.remove('active'));

        const activeBtn = document.getElementById(`tool-${toolName}`) || document.getElementById(`layout-${toolName}`);
        if(activeBtn) activeBtn.classList.add('active');

        if (!['square', 'oval', 'arrow', 'line', 'insert-text'].includes(toolName)) {
            this.isDrawing = false;
        }

        this.clearSelection();
    }
    
    // REFACTORED: Pointer event handlers for new direct manipulation
    onPointerDown(event) {
        if (!this.camera) return;

        const coords = this.getPointerCoordinates(event);
        this.pointer.copy(coords);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        this.transformStartPos.set(event.clientX, event.clientY);

        // --- Layout Drawings Tab Logic ---
        if (this.activeTab === 'layout-drawings') {
            const handleIntersects = this.raycaster.intersectObjects(this.resizeHandles);
            const shapeIntersects = this.raycaster.intersectObjects(this.shapes);

            // Priority 1: Clicked a resize handle
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
                    startDragPoint: this.transformWorldToLocal(planeIntersect),
                    initialSize: new THREE.Box3().setFromObject(shape).getSize(new THREE.Vector3())
                };
                return;
            }

            // Priority 2: Clicked a shape
            if (shapeIntersects.length > 0) {
                const shape = shapeIntersects[0].object;
                this.selectShape(shape);
                this.isMovingShape = true;
                this.controls.enabled = false;
                
                const planeIntersect = new THREE.Vector3();
                this.raycaster.ray.intersectPlane(this.raycastPlane, planeIntersect);

                this.shapeStartTransform = {
                    position: shape.position.clone(),
                    offset: shape.position.clone().sub(this.transformWorldToLocal(planeIntersect))
                };
                return;
            }

            // Priority 3: Drawing a new shape
            if (['square', 'oval', 'arrow', 'line'].includes(this.activeTool)) {
                const point = new THREE.Vector3();
                if (this.raycaster.ray.intersectPlane(this.raycastPlane, point)) {
                    this.drawStartPoint.copy(this.transformWorldToLocal(point));
                    this.isDrawing = true;
                    this.controls.enabled = false;
                }
                return;
            }
             
            // Priority 4: Inserting text
            if (this.activeTool === 'insert-text') {
                const point = new THREE.Vector3();
                if (this.raycaster.ray.intersectPlane(this.raycastPlane, point)) {
                    this.textInsertionPoint = this.transformWorldToLocal(point);
                    this.showTextInputModal();
                }
                this.selectTool(null); // Deselect tool after use
                return;
            }

            // Otherwise: Clicked on empty space, so deselect
            this.clearShapeSelection();
            return;
        }

        // --- Waypoint Editing Logic (unchanged) ---
        const clickedIndex = this.waypointsObject ? this.findClosestPointOrthographic(event) : -1;

        if (this.activeTab === 'lane-edit' && this.activeTool === 'edit-lane') {
            if (clickedIndex !== -1) {
                if (this.laneEditSelection.length < 2 && !this.laneEditSelection.includes(clickedIndex)) {
                    this.laneEditSelection.push(clickedIndex);
                } else {
                    this.laneEditSelection = [clickedIndex];
                }
                this.updateLaneEditInfo();
            }
        } else if (this.activeTab === 'waypoint-edit') {
            switch (this.activeTool) {
                case 'add-points':
                    const intersectionAdd = new THREE.Vector3();
                    if (this.raycaster.ray.intersectPlane(this.raycastPlane, intersectionAdd)) {
                        this.addPoint(intersectionAdd);
                    }
                    break;
                case 'remove-points':
                    if (clickedIndex !== -1) {
                        this.selectedIndices.add(clickedIndex);
                        this.deleteSelectedPoints();
                    }
                    break;
                case 'move-points':
                    if (clickedIndex === -1) {
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
                    break;
                case 'interpolate':
                    if (clickedIndex !== -1) {
                        if (this.pathSelectionStartIndex === null) {
                            this.clearSelection();
                            this.pathSelectionStartIndex = clickedIndex;
                            this.selectedIndices.add(clickedIndex);
                        } else {
                            const start = Math.min(this.pathSelectionStartIndex, clickedIndex);
                            const end = Math.max(this.pathSelectionStartIndex, clickedIndex);
                            for (let i = start; i <= end; i++) {
                                this.selectedIndices.add(i);
                            }
                            this.pathSelectionStartIndex = null;
                        }
                        this.updateAllColors();
                    }
                    break;
            }
        }
    }

    onPointerMove(event) {
        if (!this.camera) return;

        const coords = this.getPointerCoordinates(event);
        this.pointer.copy(coords);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        
        const planeIntersect = new THREE.Vector3();
        const hasIntersection = this.raycaster.ray.intersectPlane(this.raycastPlane, planeIntersect);
        if (!hasIntersection) return;
        
        const currentPoint = this.transformWorldToLocal(planeIntersect);

        // --- Shape Transformation Logic ---
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
            
            // Determine the anchor (the corner opposite to the one being dragged)
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
            
            // Calculate new size and center
            const newWidth = Math.abs(currentPoint.x - anchor.x);
            const newHeight = Math.abs(currentPoint.y - anchor.y);
            const newCenter = new THREE.Vector3().addVectors(anchor, currentPoint).multiplyScalar(0.5);

            // Apply new transforms
            shape.position.copy(newCenter);
            // Prevent zero or negative scaling
            if (originalSize.x > 0.01) shape.scale.x = (newWidth / originalSize.x) * this.shapeStartTransform.scale.x;
            if (originalSize.y > 0.01) shape.scale.y = (newHeight / originalSize.y) * this.shapeStartTransform.scale.y;

            if (shape.selectionOutline) shape.selectionOutline.update();
            this.updateResizeHandlePositions(shape);
            return;
        }

        // --- Ghost Shape Drawing Logic ---
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
        
        // --- Marquee Selection Logic ---
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

    onPointerUp(event) {
        // Finalize shape drawing
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
                const transformedEndPoint = this.transformWorldToLocal(endPoint);
                this.addShape(this.activeTool, this.drawStartPoint, transformedEndPoint);
            }
            this.isDrawing = false;
        }

        // Reset all transformation states
        if (this.isMovingShape || this.isResizingShape) {
            this.isMovingShape = false;
            this.isResizingShape = false;
            this.activeHandle = null;
        }

        // Finalize marquee selection
        if (this.isMarqueeSelecting) {
            this.isMarqueeSelecting = false;
            const selectionBox = document.getElementById('selection-box');
            if (selectionBox) selectionBox.style.display = 'none';
            this.updateInfoPanel();
        }

        if (this.controls) this.controls.enabled = true;
    }

    getWorldCoordinates(x, y) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2();
        mouse.x = ((x - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((y - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(mouse, this.camera);
        this.raycaster.params.Points.threshold = 0.5;

        const intersects = this.raycaster.intersectObjects([this.mapObject].filter(Boolean));
        return intersects.length ? intersects[0].point : null;
    }

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

    startAnimationLoop() {
        const tick = () => {
            this.animationId = requestAnimationFrame(tick);
            if (this.controls) this.controls.update();
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
    
    attachEventListeners() {
        // File inputs
        document.getElementById('pcd-file').addEventListener('change', async (event) => {
            const files = Array.from(event.target.files);
            if (files.length === 0) return;
            this.showLoader();
            try {
                for (const file of files) await this.loadPointCloudFile(file);
            } catch (error) {
                console.error('❌ Failed to load point cloud:', error);
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
                console.error('❌ Failed to load database:', error);
            } finally {
                this.hideLoader();
                event.target.value = '';
            }
        });

        // Tabs
        ['view', 'waypoint-edit', 'lane-edit', 'layout-drawings'].forEach(tab => {
            document.getElementById(`tab-${tab}`).addEventListener('click', () => this.switchTab(tab));
        });

        // Waypoint Tools
        ['add-points', 'remove-points', 'move-points', 'interpolate'].forEach(tool => {
            document.getElementById(`tool-${tool}`).addEventListener('click', () => this.selectTool(tool));
        });
        document.getElementById('linear-interpolate').addEventListener('click', () => this.linearInterpolateSelected());
        
        // Lane Tools
        document.getElementById('generate-lane').addEventListener('click', () => this.generateLane());
        document.getElementById('delete-lane').addEventListener('click', () => this.clearLane());
        document.getElementById('tool-edit-lane').addEventListener('click', () => this.selectTool('edit-lane'));
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

        // Layout Tools
        ['add-square', 'add-oval', 'add-arrow', 'add-line'].forEach(toolId => {
            const toolName = toolId.split('-').slice(1).join('-');
            document.getElementById(`tool-${toolId}`).addEventListener('click', () => this.selectTool(toolName));
        });
        document.getElementById('layout-insert-text').addEventListener('click', () => this.selectTool('insert-text'));
        document.getElementById('layout-delete-element').addEventListener('click', () => this.deleteSelectedShape());
        document.getElementById('layout-edit-text').addEventListener('click', () => {
            if (this.selectedShape && this.selectedShape.userData.type === 'text') {
                this.showTextInputModal(true, this.selectedShape.userData.originalText);
            }
        });
        
        // Style Controls
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

        // Bottom Controls
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

        // Modal Listeners
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

        // Global Event Listeners
        this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown.bind(this), true);
        this.renderer.domElement.addEventListener('pointermove', this.onPointerMove.bind(this));
        this.renderer.domElement.addEventListener('pointerup', this.onPointerUp.bind(this));
        this.renderer.domElement.addEventListener('dblclick', this.onDblClick.bind(this));
        this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

        document.addEventListener('keydown', (event) => {
            if (document.activeElement.tagName === 'INPUT') return;
            switch (event.key.toLowerCase()) {
                case 'escape':
                    this.clearSelection();
                    this.clearShapeSelection();
                    break;
                case 'delete':
                case 'backspace':
                    if (this.selectedIndices.size > 0) this.deleteSelectedPoints();
                    if (this.selectedShape) this.deleteSelectedShape();
                    break;
            }
        });
    }

    switchTab(tabName) {
        console.log(`📑 Switching to tab: ${tabName}`);
        this.activeTab = tabName;
        this.clearSelection();
        this.clearShapeSelection();
        this.setEditMode(tabName);

        document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
        document.getElementById(`tab-${tabName}`).classList.add('active');
        
        document.querySelectorAll('.tool-button, .tool-button-layout').forEach(b => b.classList.remove('active'));
        this.activeTool = null;
        this.updatePanelVisibility(tabName);
    }

    updatePanelVisibility(tabName) {
        document.querySelectorAll('.side-panel').forEach(p => p.classList.add('hidden'));
        if (tabName === 'waypoint-edit') {
            document.getElementById('left-panel').classList.remove('hidden');
            document.getElementById('right-panel').classList.remove('hidden');
        } else if (tabName === 'lane-edit') {
            document.getElementById('left-lane-panel').classList.remove('hidden');
            document.getElementById('right-lane-panel').classList.remove('hidden');
        } else if (tabName === 'layout-drawings') {
            document.getElementById('left-layout-panel').classList.remove('hidden');
            document.getElementById('right-layout-panel').classList.remove('hidden');
        }
    }

    showLoader() { document.getElementById('loader').style.display = 'block'; }
    hideLoader() { document.getElementById('loader').style.display = 'none'; }
    showErrorMessage(message) { /* ... same as before ... */ }
    getStatus() { /* ... same as before ... */ }
}

// Initialize the application
let app = null;

function bootstrap() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
        return;
    }
    app = new WaypointEditPlus();
    app.init();
    window.waypointEditPlus = app; // For debugging
}

window.addEventListener('error', (event) => {
    console.error('💥 WaypointEdit+ error:', event.error);
    if (app) app.showErrorMessage(`Unexpected error: ${event.error.message}`);
});

bootstrap();
