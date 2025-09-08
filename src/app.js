import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    import { PLYLoader }  from 'three/addons/loaders/PLYLoader.js';
    import { PCDLoader }  from 'three/addons/loaders/PCDLoader.js';

    // --- Basic setup ---
    const app = document.getElementById('app');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    app.appendChild(renderer.domElement);
   
    // --- Global Camera and Controls ---
    let camera;
    let controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(2, 2, 3);
    scene.add(directionalLight);
    const gridHelper = new THREE.GridHelper(10, 20, 0x3d4a66, 0x202838);
    gridHelper.rotation.x = Math.PI / 2;
    scene.add(gridHelper);
   
    // --- Hover Indicator ---
    const hoverRingGeo = new THREE.RingGeometry(1, 1.2, 32);
    const hoverRingMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthTest: false });
    const hoverIndicator = new THREE.Mesh(hoverRingGeo, hoverRingMat);
    hoverIndicator.visible = false;
    scene.add(hoverIndicator);
    let hoveredPointIndex = null;

    // --- App State ---
    const mapOffset = new THREE.Vector3();
    let mapObject = null;
    let waypointsObject = null;
    let originalMapGeometry = null;
    let editMode = false;
    let editSubMode = 'select'; // Default to select mode
    let moveSubMode = 'drag'; // 'drag', 'box-select', 'path-select'
    let movePathStartIndex = null;
    let selectedIndices = new Set();
    let isDraggingPoint = false;
    let dragStartIndex = -1;
    let dragStartOffset = new THREE.Vector3();
    let dragStartPositions = new Map();
    let isRotationLocked = false; 
    let isCameraOverrideActive = false;
    let indexToDbId = [];
    let dynamicPointSize = 0.05;
    let pathSelectionStartIndex = null;
    let lastMovedIndices = null;
    let transientGhostObject = null;
    let persistentGhostObject = null;
    let undoStack = [];
    let redoStack = [];
    const MAX_HISTORY = 50;
    const pathGroup = new THREE.Group();
    scene.add(pathGroup);
   
    // Zone State
    let zoneStartIndex = null;
    const zoneColors = {};

    // Interpolation State
    let interpolationOriginalPositions = new Map();

    // Marquee Selection State
    let isMarqueeSelecting = false;
    const selectionBox = document.getElementById('selection-box');
    const marqueeStart = new THREE.Vector2();
    const marqueeEnd = new THREE.Vector2();
   
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.05;
    const pointer = new THREE.Vector2();
    const raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const infoPanel = document.getElementById('info-panel');
    const interpolationPanel = document.getElementById('interpolation-panel');
    const movePanel = document.getElementById('move-panel');
    const zonePanel = document.getElementById('zone-panel');
    const hintMain = document.getElementById('hint');
    const displayPanel = document.getElementById('display-panel');
    const editToolbar = document.getElementById('edit-toolbar');
    const cameraModeIndicator = document.getElementById('camera-mode-indicator');
    const drawingPalette = document.getElementById('drawing-palette');

    // --- Drawing/Annotation State ---
    const shapeGroup = new THREE.Group();
    scene.add(shapeGroup);
    let currentTool = 'select';
    let isDrawingShape = false;
    let isMovingShape = false;
    let shapeDragOffset = new THREE.Vector3();
    let shapeDrawStartPoint = new THREE.Vector3();
    let selectedShape = null;
    let ghostShape = null;
    let shapeCounter = 1;
    const shapes = [];
    let isDrawingPaletteVisible = false;


    // --- Coordinate System Transformations ---
    // ROS (x-fwd, y-left, z-up) to Three.js (y-fwd, x-right, z-up)
    function rosToThree(v) {
        return new THREE.Vector3(-v.y, v.x, v.z);
    }
    // Three.js to ROS
    function threeToRos(v) {
        return new THREE.Vector3(v.y, -v.x, v.z);
    }


    // --- Database Setup ---
    let db = null;
    let SQL = null;
    const WAYPOINT_TABLE_SQL = `
      CREATE TABLE IF NOT EXISTS waypoints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
          roll REAL DEFAULT 0, pitch REAL DEFAULT 0, yaw REAL DEFAULT 0,
          zone TEXT DEFAULT 'N/A'
      );`;
     
    async function initDatabase() {
        SQL = await initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}` });
    }

    // --- Undo/Redo and State Management ---
    const undoBtn = document.getElementById('edit-undo');
    const redoBtn = document.getElementById('edit-redo');
    
    // --- Shape Serialization for Undo/Redo ---
    function serializeShapes() {
        return shapeGroup.children.map(mesh => {
            return {
                ...mesh.userData.shapeData,
                position: mesh.position.clone(),
            };
        });
    }

    function deserializeShapes(shapesState) {
        // Clear existing shapes cleanly
        while (shapeGroup.children.length > 0) {
            const shape = shapeGroup.children[0];
            shapeGroup.remove(shape);
            shape.geometry.dispose();
            shape.material.dispose();
            if (shape.children.length > 0) {
                const labelMesh = shape.children[0];
                labelMesh.geometry.dispose();
                if (labelMesh.material.map) labelMesh.material.map.dispose();
                labelMesh.material.dispose();
            }
        }
        shapes.length = 0; // Clear helper array

        // Recreate shapes from the saved state
        shapesState.forEach(data => {
            const halfWidth = data.width / 2;
            const halfHeight = data.height / 2;
            const startPos = new THREE.Vector3(data.position.x - halfWidth, data.position.y - halfHeight, 0);
            const endPos = new THREE.Vector3(data.position.x + halfWidth, data.position.y + halfHeight, 0);
            
            addShapeMesh(data.type, startPos, endPos, data.fillColor, data.text, false);
        });
    }


    function updateUndoRedoButtons() {
        undoBtn.disabled = undoStack.length < 2;
        redoBtn.disabled = redoStack.length === 0;
    }

    function recordState() {
        redoStack = [];
        const state = {
            dbState: db ? db.export() : null,
            shapesState: serializeShapes()
        };
        undoStack.push(state);
        if (undoStack.length > MAX_HISTORY) {
            undoStack.shift();
        }
        updateUndoRedoButtons();
    }

    async function undo() {
        if (undoStack.length < 2) return;
        const currentState = undoStack.pop();
        redoStack.push(currentState);
       
        const prevState = undoStack[undoStack.length - 1];
        
        // Restore DB
        if (prevState.dbState) {
            if (db) db.close();
            db = new SQL.Database(new Uint8Array(prevState.dbState));
            await refreshWaypointsFromDB();
        }

        // Restore Shapes
        deserializeShapes(prevState.shapesState);

        clearAllGhostPreviews();
        updateUndoRedoButtons();
    }

    async function redo() {
        if (redoStack.length === 0) return;
        const nextState = redoStack.pop();
        undoStack.push(nextState);
        
        // Restore DB
        if (nextState.dbState) {
            if (db) db.close();
            db = new SQL.Database(new Uint8Array(nextState.dbState));
            await refreshWaypointsFromDB();
        }

        // Restore Shapes
        deserializeShapes(nextState.shapesState);

        clearAllGhostPreviews();
        updateUndoRedoButtons();
    }

    // --- Ghost Preview System ---
    function createTransientGhostPreview() {
        clearTransientGhostPreview();
        const indices = Array.from(selectedIndices);
        if (indices.length === 0 || !waypointsObject) return;

        const positions = waypointsObject.geometry.attributes.position;
        const ghostPositions = [];
        for (const index of indices) {
            ghostPositions.push(positions.getX(index), positions.getY(index), positions.getZ(index));
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(ghostPositions, 3));
        const material = new THREE.PointsMaterial({
            size: camera.isPerspectiveCamera ? dynamicPointSize : (dynamicPointSize / 0.05 * 3.0),
            sizeAttenuation: camera.isPerspectiveCamera,
            color: 0x8888ff,
            transparent: true,
            opacity: 0.4
        });
        transientGhostObject = new THREE.Points(geometry, material);
        scene.add(transientGhostObject);
    }

    function clearTransientGhostPreview() {
        if (transientGhostObject) {
            scene.remove(transientGhostObject);
            transientGhostObject.geometry.dispose();
            transientGhostObject.material.dispose();
            transientGhostObject = null;
        }
    }
   
    async function createPersistentGhostPreview() {
        clearPersistentGhostPreview();
        const indices = Array.from(selectedIndices);
        if (indices.length === 0 || undoStack.length === 0) return;

        const lastState = undoStack[undoStack.length - 1];
        if (!lastState.dbState) return;

        const tempDb = new SQL.Database(new Uint8Array(lastState.dbState));
        const stmt = tempDb.prepare("SELECT x, y, z FROM waypoints ORDER BY id;");
       
        const allOldPositions = [];
        while (stmt.step()) {
            const row = stmt.get();
            const transformed = rosToThree({x: row[0], y: row[1], z: row[2]});
            allOldPositions.push(transformed.x - mapOffset.x, transformed.y - mapOffset.y, transformed.z - mapOffset.z);
        }
        stmt.free();
        tempDb.close();

        const ghostPositions = [];
        for (const index of indices) {
            if (index * 3 < allOldPositions.length) {
                ghostPositions.push(allOldPositions[index * 3], allOldPositions[index * 3 + 1], allOldPositions[index * 3 + 2]);
            }
        }
       
        if (ghostPositions.length === 0) return;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(ghostPositions, 3));
        const material = new THREE.PointsMaterial({
            size: camera.isPerspectiveCamera ? dynamicPointSize * 0.8 : (dynamicPointSize / 0.05 * 2.0),
            sizeAttenuation: camera.isPerspectiveCamera,
            color: 0x3377ff, 
            transparent: true,
            opacity: 0.7
        });
        persistentGhostObject = new THREE.Points(geometry, material);
        scene.add(persistentGhostObject);
    }
   
    function clearPersistentGhostPreview() {
        if (persistentGhostObject) {
            scene.remove(persistentGhostObject);
            persistentGhostObject.geometry.dispose();
            persistentGhostObject.material.dispose();
            persistentGhostObject = null;
        }
    }

    function clearAllGhostPreviews() {
        clearTransientGhostPreview();
        clearPersistentGhostPreview();
    }

    // --- Annotation Shape Drawing ---
    function createShapeGeometry(type, width, height) {
        const halfWidth = width / 2;
        const halfHeight = height / 2;
        const shape = new THREE.Shape();
        
        switch(type) {
            case 'rect':
                shape.moveTo(-halfWidth, -halfHeight);
                shape.lineTo(halfWidth, -halfHeight);
                shape.lineTo(halfWidth, halfHeight);
                shape.lineTo(-halfWidth, halfHeight);
                shape.closePath();
                break;
            case 'oval':
                shape.absellipse(0, 0, halfWidth, halfHeight, 0, Math.PI * 2, false);
                break;
            case 'triangle':
                shape.moveTo(0, halfHeight);
                shape.lineTo(-halfWidth, -halfHeight);
                shape.lineTo(halfWidth, -halfHeight);
                shape.closePath();
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
            case 'pentagon':
                const pRadius = Math.min(halfWidth, halfHeight);
                for (let i = 0; i < 5; i++) {
                    const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2;
                    const x = Math.cos(angle) * pRadius;
                    const y = Math.sin(angle) * pRadius;
                    if (i===0) shape.moveTo(x,y); else shape.lineTo(x,y);
                }
                shape.closePath();
                break;
            case 'star':
                const outerRadius = Math.min(halfWidth, halfHeight);
                const innerRadius = outerRadius * 0.4;
                for (let i = 0; i < 10; i++) {
                    const angle = (i * Math.PI) / 5 - Math.PI / 2;
                    const radius = i % 2 === 0 ? outerRadius : innerRadius;
                    const x = Math.cos(angle) * radius;
                    const y = Math.sin(angle) * radius;
                    if (i === 0 ) shape.moveTo(x,y); else shape.lineTo(x,y);
                }
                shape.closePath();
                break;
            default:
                return null;
        }
        return new THREE.ShapeGeometry(shape);
    }

    function addShapeMesh(type, startPos, endPos, fillColor, text, isGhost = false) {
        const width = Math.abs(endPos.x - startPos.x);
        const height = Math.abs(endPos.y - startPos.y);
        if (width < 0.05 && height < 0.05) return null;

        const geo = createShapeGeometry(type, width, height);
        if (!geo) return null;

        const mat = new THREE.MeshBasicMaterial({
            color: fillColor || 0x4477ff,
            transparent: true,
            opacity: isGhost ? 0.3 : 0.6,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -shapes.length - 1, // Pulls the polygon towards the camera
            polygonOffsetUnits: -1
        });

        const mesh = new THREE.Mesh(geo, mat);
        // A small, constant Z offset to keep shapes slightly above the grid.
        mesh.position.set((startPos.x + endPos.x)/2, (startPos.y + endPos.y)/2, 0.01);

        if (text && text.trim().length > 0 && !isGhost) {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            const fontSize = 48; // Use higher resolution for sharper text
            context.font = `${fontSize}px sans-serif`;
            const textWidth = context.measureText(text).width;

            canvas.width = THREE.MathUtils.ceilPowerOfTwo(textWidth + 20);
            canvas.height = THREE.MathUtils.ceilPowerOfTwo(fontSize * 1.5);

            // Re-apply font settings after resize
            context.font = `${fontSize}px sans-serif`;
            context.fillStyle = 'white';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(text, canvas.width/2, canvas.height/2);

            const tex = new THREE.CanvasTexture(canvas);
            tex.minFilter = THREE.LinearFilter;
            tex.needsUpdate = true; // Ensures the texture updates reliably
            const labelMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false });
            
            // Scale the label plane relative to the parent shape's width
            const labelAspect = canvas.height / canvas.width;
            const labelWidth = width * 0.9;
            const labelHeight = labelWidth * labelAspect;

            const labelGeo = new THREE.PlaneGeometry(labelWidth, labelHeight);
            const labelMesh = new THREE.Mesh(labelGeo, labelMat);
            labelMesh.position.set(0, 0, 0.001); // Keep label just slightly above its parent shape
            mesh.add(labelMesh);
        }

        if (!isGhost) {
            mesh.userData.shapeData = { type, width, height, fillColor, text };
            shapes.push(mesh);
        }
        shapeGroup.add(mesh);
        return mesh;
    }

    function selectShape(mesh) {
        if (selectedShape) {
            selectedShape.material.emissive?.setHex(0x000000);
        }
        selectedShape = mesh;
        if (selectedShape) {
            if (!selectedShape.material.emissive) {
                selectedShape.material.emissive = new THREE.Color(0x000000);
            }
            selectedShape.material.emissive.setHex(0xcccc00); // Highlight color
        }
    }

    function deleteSelectedShape() {
        if (!selectedShape) return;
        recordState();
        
        shapeGroup.remove(selectedShape);
        selectedShape.geometry.dispose();
        selectedShape.material.dispose();
        if (selectedShape.children.length > 0) {
            const labelMesh = selectedShape.children[0];
            labelMesh.geometry.dispose();
            if (labelMesh.material.map) {
                labelMesh.material.map.dispose();
            }
            labelMesh.material.dispose();
        }

        const index = shapes.indexOf(selectedShape);
        if (index > -1) {
            shapes.splice(index, 1);
        }
        selectShape(null);
    }
    
    // --- Path Generation ---
    function clearPathMesh() {
        while(pathGroup.children.length > 0){ 
            const mesh = pathGroup.children[0];
            pathGroup.remove(mesh); 
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
    }

    async function generatePathMesh() {
        clearPathMesh();
        if (!db) return;

        const stmt = db.prepare("SELECT id, x, y, z, zone FROM waypoints ORDER BY id;");
        const allWaypoints = [];
        while(stmt.step()) {
            allWaypoints.push(stmt.getAsObject());
        }
        stmt.free();

        const waypoints = allWaypoints
            .filter(wp => !(wp.x === 0 && wp.y === 0 && wp.z === 0))
            .map(wp => ({
                ...wp,
                pos: rosToThree({x: wp.x, y: wp.y, z: wp.z}).sub(mapOffset)
            }));

        if (waypoints.length < 2) return;

        let currentSegment = [];
        for (let i = 0; i < waypoints.length; i++) {
            currentSegment.push(waypoints[i]);
            const currentZone = waypoints[i].zone || 'N/A';
            const nextZone = (i + 1 < waypoints.length) ? (waypoints[i+1].zone || 'N/A') : null;

            if (currentZone !== nextZone || i === waypoints.length - 1) {
                if (currentSegment.length >= 2) {
                    createPathSegmentMesh(currentSegment, currentZone);
                }
                currentSegment = [waypoints[i]]; // Start new segment with the current point
            }
        }
        updateZoneList();
    }

    function createPathSegmentMesh(segmentPoints, zoneName) {
        const points = segmentPoints.map(p => p.pos);
        if (points.length < 2) return;

        const leftVerts = [];
        const rightVerts = [];
        const halfWidth = 0.5; // 50cm

        for (let i = 0; i < points.length; i++) {
            const p_curr = points[i];
            let normal, miterScale = 1.0;

            if (i === 0) {
                const dir_out = points[i+1].clone().sub(p_curr).normalize();
                normal = new THREE.Vector3(-dir_out.y, dir_out.x, 0).normalize();
            } else if (i === points.length - 1) {
                const dir_in = p_curr.clone().sub(points[i-1]).normalize();
                normal = new THREE.Vector3(-dir_in.y, dir_in.x, 0).normalize();
            } else {
                const dir_in = p_curr.clone().sub(points[i-1]).normalize();
                const dir_out = points[i+1].clone().sub(p_curr).normalize();
                const normal_in = new THREE.Vector3(-dir_in.y, dir_in.x, 0);
                const normal_out = new THREE.Vector3(-dir_out.y, dir_out.x, 0);
                normal = normal_in.clone().add(normal_out).normalize();
                const dot = normal_in.dot(normal);
                if (Math.abs(dot) > 0.0001) miterScale = 1 / dot;
            }
            leftVerts.push(p_curr.clone().add(normal.clone().multiplyScalar(halfWidth * miterScale)));
            rightVerts.push(p_curr.clone().sub(normal.clone().multiplyScalar(halfWidth * miterScale)));
        }

        const vertices = [];
        for (let i = 0; i < points.length; i++) {
            vertices.push(leftVerts[i].x, leftVerts[i].y, leftVerts[i].z);
            vertices.push(rightVerts[i].x, rightVerts[i].y, rightVerts[i].z);
        }

        const indices = [];
        for (let i = 0; i < points.length - 1; i++) {
            const i2 = i * 2;
            indices.push(i2, i2 + 1, i2 + 2, i2 + 2, i2 + 1, i2 + 3);
        }

        if (!zoneColors[zoneName]) {
            zoneColors[zoneName] = (zoneName === 'N/A') ? 0x559FFF : new THREE.Color().setHSL(Math.random(), 0.7, 0.6).getHex();
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setIndex(indices);
        const material = new THREE.MeshBasicMaterial({
            color: zoneColors[zoneName],
            transparent: true, opacity: 0.4, side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = -1;
        pathGroup.add(mesh);
    }

    // --- Waypoint Loading and Management ---
    function clearVisualWaypoints() {
        if (waypointsObject) {
            scene.remove(waypointsObject);
            waypointsObject.geometry.dispose();
            waypointsObject.material.dispose();
            waypointsObject = null;
        }
        clearSelection();
        indexToDbId = [];
    }
   
    function updateWaypointVisuals() {
        if (!waypointsObject || !camera) return;
       
        const perspectiveSize = dynamicPointSize;
        const orthoBaseSize = 3.0;
        const defaultDynamicSize = 0.05;
        const orthoSize = orthoBaseSize * (dynamicPointSize / defaultDynamicSize);

        waypointsObject.material.size = camera.isPerspectiveCamera ? perspectiveSize : orthoSize;
        waypointsObject.material.sizeAttenuation = camera.isPerspectiveCamera;
        waypointsObject.material.needsUpdate = true;
    }

    async function refreshWaypointsFromDB() {
        const oldSelectionDbIds = new Set(Array.from(selectedIndices).map(i => indexToDbId[i]));
        clearVisualWaypoints();
        if (!db) return;

        const stmt = db.prepare("SELECT id, x, y, z FROM waypoints ORDER BY id;"); 
        const positions = [];
        indexToDbId = [];
        const dbIdToIndex = new Map();

        while (stmt.step()) {
            const row = stmt.get();
            const currentIndex = indexToDbId.length;
            indexToDbId.push(row[0]);
            dbIdToIndex.set(row[0], currentIndex);
            const transformed = rosToThree({x: row[1], y: row[2], z: row[3]});
            positions.push(transformed.x - mapOffset.x, transformed.y - mapOffset.y, transformed.z - mapOffset.z);
        }
        stmt.free();
       
        if (positions.length === 0) return;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
       
        const material = new THREE.PointsMaterial({ size: dynamicPointSize, vertexColors: true });
        waypointsObject = new THREE.Points(geometry, material);
       
        // Restore selection
        selectedIndices.clear();
        for (const dbId of oldSelectionDbIds) {
            if (dbIdToIndex.has(dbId)) {
                selectedIndices.add(dbIdToIndex.get(dbId));
            }
        }
       
        updateAllColors();
        scene.add(waypointsObject);
        updateWaypointVisuals();
        updateInfoPanel();
    }

    async function loadWaypointsFromFile(file) {
        if (!SQL) return alert("Database engine is not ready.");
       
        if (db) { db.close(); db = null; }
        clearPathMesh();
        clearVisualWaypoints();
        document.getElementById('loader').style.display = 'block';
        await new Promise(resolve => setTimeout(resolve, 50));

        try {
            const buffer = await file.arrayBuffer();
            db = new SQL.Database(new Uint8Array(buffer));
            
            // --- DB Schema Migration for 'zone' column ---
            const columns = db.exec("PRAGMA table_info(waypoints);")[0].values;
            if (!columns.some(col => col[1] === 'zone')) {
                db.run("ALTER TABLE waypoints ADD COLUMN zone TEXT DEFAULT 'N/A';");
            }
            // Ensure any old rows with NULL zone get updated to 'N/A'
            db.run("UPDATE waypoints SET zone = 'N/A' WHERE zone IS NULL;");
            // --- End Migration ---

            undoStack = [];
            redoStack = [];
            recordState(); // Record initial state
        } catch (err) {
            alert(`Error loading database: ${err.message}`);
            db = null;
        }
       
        await refreshWaypointsFromDB();
       
        updateButtonState();
        document.getElementById('loader').style.display = 'none';
        setView(viewSelect.value);
    }

    function createNewWaypointSet() {
        if (!SQL) return alert("Database engine is not ready.");
        if (db) db.close();
        clearPathMesh();
       
        db = new SQL.Database();
        db.run(WAYPOINT_TABLE_SQL);
        undoStack = [];
        redoStack = [];
        recordState();
        refreshWaypointsFromDB();
        updateButtonState();
    }

    function saveWaypointsToDB() {
        if (!db) return;
        const data = db.export();
        const blob = new Blob([data], { type: "application/x-sqlite3" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `waypoints_${Date.now()}.db`;
        link.click();
        URL.revokeObjectURL(link.href);
    }
   
    // --- Point Manipulation ---
    async function addPoint(position) {
        if (!db) return;
        const threePos = position.clone().add(mapOffset);
        const rosPos = threeToRos(threePos);
        db.run("INSERT INTO waypoints (x, y, z, roll, pitch, yaw) VALUES (?, ?, ?, 0, 0, 0)", [rosPos.x, rosPos.y, rosPos.z]);
        recordState();
        await refreshWaypointsFromDB();
    }
       
    async function batchUpdateDbPositions(indicesToUpdate, newPositions) {
        if (!db || !waypointsObject) return;
       
        try {
            db.run("BEGIN TRANSACTION");
            for (let i = 0; i < indicesToUpdate.length; i++) {
                const index = indicesToUpdate[i];
                const db_id = indexToDbId[index];
                const threePos = newPositions[i].clone().add(mapOffset);
                const rosPos = threeToRos(threePos);
                db.run("UPDATE waypoints SET x = ?, y = ?, z = ? WHERE id = ?", [rosPos.x, rosPos.y, rosPos.z, db_id]);
            }
            db.run("COMMIT");
        } catch (e) {
            console.error("Batch DB update failed, rolling back.", e);
            db.run("ROLLBACK");
        }
        recordState();
    }


    async function linearInterpolateSelected() {
        const indices = Array.from(selectedIndices).sort((a, b) => a - b);
        if (indices.length < 3) return; 
       
        createPersistentGhostPreview();

        const positions = waypointsObject.geometry.attributes.position;
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
        await batchUpdateDbPositions(intermediaryIndices, newPositions);
    }

    async function performRadialInterpolation(saveToDb = false) {
        const indices = Array.from(selectedIndices).sort((a, b) => a - b);
        if (indices.length < 3) return;

        const positions = waypointsObject.geometry.attributes.position;
        const startIdx = indices[0];
        const endIdx = indices[indices.length - 1];
       
        const p0 = new THREE.Vector3().fromBufferAttribute(positions, startIdx);
        const p3 = new THREE.Vector3().fromBufferAttribute(positions, endIdx);

        const prevIdx = startIdx > 0 ? startIdx - 1 : 0;
        const p_minus_1 = new THREE.Vector3().fromBufferAttribute(positions, prevIdx);
       
        const nextIdx = endIdx < positions.count - 1 ? endIdx + 1 : endIdx;
        const p_plus_1 = new THREE.Vector3().fromBufferAttribute(positions, nextIdx);

        const strength = parseFloat(document.getElementById('radial-strength').value);
        const tension = 0.35;

        const tangentDir0 = p3.clone().sub(p_minus_1).normalize();
        const tangentDir1 = p_plus_1.clone().sub(p0).normalize();

        const chord = p3.clone().sub(p0);
        const handleMagnitude = chord.length() * tension;
        if (handleMagnitude < 1e-6) return;

        let p1 = p0.clone().add(tangentDir0.multiplyScalar(handleMagnitude));
        let p2 = p3.clone().sub(tangentDir1.multiplyScalar(handleMagnitude));

        const perp = new THREE.Vector3(-chord.y, chord.x, 0).normalize();
        const offsetVector = perp.multiplyScalar(strength);

        p1.add(offsetVector);
        p2.add(offsetVector);

        const intermediaryIndices = [];
        const newPositions = [];
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
            await batchUpdateDbPositions(intermediaryIndices, newPositions);
        }
    }
   
    async function generatePathConnections() {
        if (!lastMovedIndices || lastMovedIndices.size < 1) return;
        if (!db) return;

        document.getElementById('loader').textContent = 'Generating Path...';
        document.getElementById('loader').style.display = 'block';
        Object.values(editModeButtons).forEach(btn => btn.disabled = true);
        undoBtn.disabled = true;
        redoBtn.disabled = true;

        await new Promise(resolve => setTimeout(resolve, 20));

        const stmt = db.prepare("SELECT id, x, y, z, roll, pitch, yaw, zone FROM waypoints ORDER BY id;");
        const allPoints = [];
        while(stmt.step()) {
            const row = stmt.getAsObject();
            allPoints.push({
                x: row.x, y: row.y, z: row.z, 
                roll: row.roll, pitch: row.pitch, yaw: row.yaw,
                zone: row.zone
            });
        }
        stmt.free();
       
        const movedIdxs = Array.from(lastMovedIndices).sort((a,b) => a - b);
        const minIdx = movedIdxs[0];
        const maxIdx = movedIdxs[movedIdxs.length - 1];

        const newPointsList = [...allPoints];
        let insertOffset = 0;

        // Generate start connection
        if (minIdx > 0) {
            const distances = [];
            if (minIdx > 1) {
                const p1 = new THREE.Vector3(allPoints[minIdx-2].x, allPoints[minIdx-2].y, allPoints[minIdx-2].z);
                const p2 = new THREE.Vector3(allPoints[minIdx-1].x, allPoints[minIdx-1].y, allPoints[minIdx-1].z);
                distances.push(p1.distanceTo(p2));
            }
            if (minIdx < allPoints.length -1) {
                 const p1 = new THREE.Vector3(allPoints[minIdx].x, allPoints[minIdx].y, allPoints[minIdx].z);
                 const p2 = new THREE.Vector3(allPoints[minIdx+1].x, allPoints[minIdx+1].y, allPoints[minIdx+1].z);
                 distances.push(p1.distanceTo(p2));
            }
            const localAvgDist = distances.length > 0 ? distances.reduce((a,b) => a + b, 0) / distances.length : 1.0;

            const p_before = new THREE.Vector3(allPoints[minIdx-1].x, allPoints[minIdx-1].y, allPoints[minIdx-1].z);
            const p_start = new THREE.Vector3(allPoints[minIdx].x, allPoints[minIdx].y, allPoints[minIdx].z);
           
            const dist = p_before.distanceTo(p_start);
            const numNewPoints = Math.max(0, Math.round(dist / localAvgDist) - 1);

            if (numNewPoints > 0) {
                const p_before_2 = minIdx > 1 ? new THREE.Vector3(allPoints[minIdx-2].x, allPoints[minIdx-2].y, allPoints[minIdx-2].z) : p_before.clone().lerp(p_start, -1);
                const p_start_next = minIdx < allPoints.length - 1 ? new THREE.Vector3(allPoints[minIdx+1].x, allPoints[minIdx+1].y, allPoints[minIdx+1].z) : p_start.clone().lerp(p_before, -1);
                const curve = new THREE.CatmullRomCurve3([p_before_2, p_before, p_start, p_start_next]);
                const generatedPoints = curve.getPoints(numNewPoints + 1).slice(1);
                const startZone = allPoints[minIdx].zone || 'N/A'; // Inherit zone from the start of the moved segment
                const newWaypoints = generatedPoints.map(p => ({ x:p.x, y:p.y, z:p.z, roll:0, pitch:0, yaw:0, zone: startZone }));
                newPointsList.splice(minIdx + insertOffset, 0, ...newWaypoints);
                insertOffset += numNewPoints;
            }
        }
       
        // Generate end connection
        if (maxIdx < allPoints.length - 1) {
            const distances = [];
            if (maxIdx > 0) {
                const p1 = new THREE.Vector3(allPoints[maxIdx-1].x, allPoints[maxIdx-1].y, allPoints[maxIdx-1].z);
                const p2 = new THREE.Vector3(allPoints[maxIdx].x, allPoints[maxIdx].y, allPoints[maxIdx].z);
                distances.push(p1.distanceTo(p2));
            }
            if (maxIdx < allPoints.length - 2) {
                 const p1 = new THREE.Vector3(allPoints[maxIdx+1].x, allPoints[maxIdx+1].y, allPoints[maxIdx+1].z);
                 const p2 = new THREE.Vector3(allPoints[maxIdx+2].x, allPoints[maxIdx+2].y, allPoints[maxIdx+2].z);
                 distances.push(p1.distanceTo(p2));
            }
            const localAvgDist = distances.length > 0 ? distances.reduce((a,b) => a + b, 0) / distances.length : 1.0;

            const p_end = new THREE.Vector3(allPoints[maxIdx].x, allPoints[maxIdx].y, allPoints[maxIdx].z);
            const p_after = new THREE.Vector3(allPoints[maxIdx+1].x, allPoints[maxIdx+1].y, allPoints[maxIdx+1].z);
           
            const dist = p_end.distanceTo(p_after);
            const numNewPoints = Math.max(0, Math.round(dist / localAvgDist) - 1);
           
            if (numNewPoints > 0) {
                const p_end_prev = maxIdx > 0 ? new THREE.Vector3(allPoints[maxIdx-1].x, allPoints[maxIdx-1].y, allPoints[maxIdx-1].z) : p_end.clone().lerp(p_after, -1);
                const p_after_2 = maxIdx < allPoints.length - 2 ? new THREE.Vector3(allPoints[maxIdx+2].x, allPoints[maxIdx+2].y, allPoints[maxIdx+2].z) : p_after.clone().lerp(p_end, -1);
                const curve = new THREE.CatmullRomCurve3([p_end_prev, p_end, p_after, p_after_2]);
                const generatedPoints = curve.getPoints(numNewPoints + 1).slice(1);
                const endZone = allPoints[maxIdx].zone || 'N/A'; // Inherit zone from the end of the moved segment
                const newWaypoints = generatedPoints.map(p => ({ x:p.x, y:p.y, z:p.z, roll:0, pitch:0, yaw:0, zone: endZone }));
                newPointsList.splice(maxIdx + insertOffset + 1, 0, ...newWaypoints);
            }
        }

        // Update database
        if (newPointsList.length !== allPoints.length) {
            try {
                db.run("BEGIN TRANSACTION");
                db.run("DELETE FROM waypoints");
                const insertStmt = db.prepare("INSERT INTO waypoints (x, y, z, roll, pitch, yaw, zone) VALUES (?, ?, ?, ?, ?, ?, ?)");
                for(const point of newPointsList) {
                    insertStmt.run([point.x, point.y, point.z, point.roll, point.pitch, point.yaw, point.zone || 'N/A']);
                }
                insertStmt.free();
                db.run("COMMIT");
            } catch (e) {
                console.error("Connection generation failed:", e);
                db.run("ROLLBACK");
            }
        }
        recordState();
        document.getElementById('generate-connections').disabled = true;
        lastMovedIndices = null;
        await refreshWaypointsFromDB();

        document.getElementById('loader').style.display = 'none';
        Object.values(editModeButtons).forEach(btn => btn.disabled = false);
        updateUndoRedoButtons();
    }


    async function deleteSelectedPoints() { 
        if (!db || selectedIndices.size === 0) return; 
        const idsToDelete = Array.from(selectedIndices).map(index => indexToDbId[index]); 
        if (idsToDelete.length === 0) return; 
        const placeholders = idsToDelete.map(() => '?').join(','); 
        db.run(`DELETE FROM waypoints WHERE id IN (${placeholders})`, idsToDelete);
        clearSelection();
        recordState();
        await refreshWaypointsFromDB(); 
    }

    function clearSelection() { 
        selectedIndices.clear(); 
        pathSelectionStartIndex = null;
        if (editSubMode === 'zone') {
            zoneStartIndex = null;
            updateZonePanel();
        }
        updateAllColors(); 
        updateInfoPanel();
        clearAllGhostPreviews();
    }

    function updateAllColors() { 
        if (!waypointsObject) return; 
        const positions = waypointsObject.geometry.attributes.position; 
        const colors = new Float32Array(positions.count * 3); 
        const selectedColor = new THREE.Color(0xff8800); 
        const defaultColor = new THREE.Color(0xffff00); 
        const pathStartColor = new THREE.Color(0x00ff00); // Used for interpolate and zone start
       
        for (let i = 0; i < positions.count; i++) { 
            let color = defaultColor; 
            if (i === pathSelectionStartIndex || i === movePathStartIndex || i === zoneStartIndex) { 
                color = pathStartColor; 
            } else if (selectedIndices.has(i)) { 
                color = selectedColor; 
            } 
            colors[i * 3] = color.r; 
            colors[i * 3 + 1] = color.g; 
            colors[i * 3 + 2] = color.b; 
        } 
        waypointsObject.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); 
    }

    function updateActivePanels() {
        infoPanel.querySelector('#default-info-view').style.display = (editSubMode === 'select' && selectedIndices.size > 0) ? 'block' : 'none';
        interpolationPanel.style.display = editSubMode === 'interpolate' ? 'block' : 'none';
        movePanel.style.display = editSubMode === 'move' ? 'block' : 'none';
        zonePanel.style.display = editSubMode === 'zone' ? 'block' : 'none';
    }

    function updateInfoPanel() { 
        updateActivePanels();
        document.getElementById('move-info').textContent = selectedIndices.size > 0 ? `${selectedIndices.size} points selected.` : `Select points to move.`;

        if (selectedIndices.size === 1) { 
            const index = selectedIndices.values().next().value; 
            const db_id = indexToDbId[index]; 
            const stmt = db.prepare("SELECT x, y, z, roll, pitch, yaw FROM waypoints WHERE id = :id"); 
            const result = stmt.getAsObject({':id': db_id}); 
            stmt.free(); 
            if (result.x !== undefined) { 
                infoPanel.querySelector('h4').textContent = `Waypoint #${db_id}`; 
                document.getElementById('info-x').textContent = result.x.toFixed(4); 
                document.getElementById('info-y').textContent = result.y.toFixed(4); 
                document.getElementById('info-z').textContent = result.z.toFixed(4); 
                document.getElementById('info-roll').textContent = result.roll.toFixed(4); 
                document.getElementById('info-pitch').textContent = result.pitch.toFixed(4); 
                document.getElementById('info-yaw').textContent = result.yaw.toFixed(4); 
            } 
        } else if (selectedIndices.size > 1) { 
            infoPanel.querySelector('h4').textContent = `${selectedIndices.size} Waypoints Selected`; 
            document.getElementById('info-x').textContent = '---'; 
            document.getElementById('info-y').textContent = '---'; 
            document.getElementById('info-z').textContent = '---'; 
            document.getElementById('info-roll').textContent = '---'; 
            document.getElementById('info-pitch').textContent = '---'; 
            document.getElementById('info-yaw').textContent = '---'; 
        }
    }
   
    function updateInterpolationPanel() {
        const infoText = document.getElementById('interpolation-info');
        const linearBtn = document.getElementById('linear-interpolate');
        const radialSlider = document.getElementById('radial-strength');
        const radialValueInput = document.getElementById('radial-strength-value');
        const selectionSize = selectedIndices.size;

        if (pathSelectionStartIndex !== null && selectionSize > 0) {
            infoText.textContent = `Path start point selected. Click an end point.`;
        } else if (selectionSize > 0) {
             infoText.textContent = `${selectionSize} points selected.`;
        } else {
             infoText.textContent = `Click a start and end point on the path to begin.`;
        }
       
        const canInterpolate = selectionSize >= 3;
        linearBtn.disabled = !canInterpolate;
        radialSlider.disabled = !canInterpolate;
        radialValueInput.disabled = !canInterpolate;
    }

    // --- Zone Panel UI ---
    function updateZonePanel() {
        const infoText = document.getElementById('zone-info');
        const nameInput = document.getElementById('zone-name-input');
        const createBtn = document.getElementById('create-zone-btn');
        const clearBtn = document.getElementById('clear-zone-selection-btn');

        if (zoneStartIndex === null) {
            infoText.textContent = 'Click a start waypoint to begin defining a new zone.';
            nameInput.disabled = true;
            createBtn.disabled = true;
            clearBtn.style.display = 'none';
        } else if (selectedIndices.size === 1) {
            infoText.textContent = `Start point #${indexToDbId[zoneStartIndex]} selected. Click an end waypoint.`;
            nameInput.disabled = true;
            createBtn.disabled = true;
            clearBtn.style.display = 'inline-block';
        } else {
            const endIdx = Array.from(selectedIndices).find(i => i !== zoneStartIndex);
            infoText.textContent = `Zone selected from #${indexToDbId[zoneStartIndex]} to #${indexToDbId[endIdx]}. Enter a name.`;
            nameInput.disabled = false;
            createBtn.disabled = nameInput.value.trim() === '';
            clearBtn.style.display = 'inline-block';
        }
    }

    async function createZone() {
        const name = document.getElementById('zone-name-input').value.trim();
        if (!name || selectedIndices.size < 2) return;

        const indices = Array.from(selectedIndices).sort((a,b)=>a-b);
        const startDbId = indexToDbId[indices[0]];
        const endDbId = indexToDbId[indices[indices.length - 1]];

        db.run("UPDATE waypoints SET zone = ? WHERE id >= ? AND id <= ?", [name, startDbId, endDbId]);
        recordState();
        await refreshWaypointsFromDB(); // Redraw points
        await generatePathMesh(); // Redraw path with new zone color
        clearSelection();
    }
    
    function updateZoneList() {
        const listContainer = document.getElementById('zone-list');
        listContainer.innerHTML = '';
        if (!db) return;
        const zones = db.exec("SELECT DISTINCT zone FROM waypoints WHERE zone IS NOT NULL AND zone != 'N/A' ORDER BY zone;");

        if (zones.length > 0 && zones[0].values) {
            zones[0].values.forEach(row => {
                const zoneName = row[0];
                const item = document.createElement('div');
                item.className = 'zone-item';

                const colorSwatch = document.createElement('div');
                colorSwatch.className = 'zone-color-swatch';
                if(zoneColors[zoneName]) {
                    colorSwatch.style.backgroundColor = `#${zoneColors[zoneName].toString(16).padStart(6,'0')}`;
                }

                const nameLabel = document.createElement('span');
                nameLabel.textContent = zoneName;
                
                item.appendChild(colorSwatch);
                item.appendChild(nameLabel);
                listContainer.appendChild(item);
            });
        }
    }

    // --- Map Display Options
    function applyMapDisplayOptions() {
        if (!originalMapGeometry) return;

        document.getElementById('loader').textContent = 'Processing Map...';
        document.getElementById('loader').style.display = 'block';

        setTimeout(() => {
            try {
                const voxelSize = parseFloat(document.getElementById('voxel-size').value);
                let processedGeometry = voxelSize > 0 ? downsample(originalMapGeometry, voxelSize) : originalMapGeometry.clone();
               
                const colorMode = document.getElementById('color-mode').value;
                colorize(processedGeometry, colorMode);
               
                if (mapObject) {
                    scene.remove(mapObject);
                    mapObject.geometry.dispose();
                }
               
                mapObject.geometry = processedGeometry;
                scene.add(mapObject);
            } catch (error) {
                console.error("Error processing map display options:", error);
                alert("An error occurred while processing the map.");
            } finally {
                document.getElementById('loader').style.display = 'none';
            }
        }, 50);
    }

    function downsample(geometry, voxelSize) {
        const newPositions = [];
        const newColors = [];
        const grid = new Set();
        const positions = geometry.attributes.position.array;
        const hasOriginalColors = geometry.attributes.color;
        const colors = hasOriginalColors ? geometry.attributes.color.array : null;

        for (let i = 0; i < positions.length; i += 3) {
            const key = `${Math.floor(positions[i] / voxelSize)}|${Math.floor(positions[i+1] / voxelSize)}|${Math.floor(positions[i+2] / voxelSize)}`;
            if (!grid.has(key)) {
                grid.add(key);
                newPositions.push(positions[i], positions[i+1], positions[i+2]);
                if (colors) {
                    newColors.push(colors[i], colors[i+1], colors[i+2]);
                }
            }
        }
       
        const newGeom = new THREE.BufferGeometry();
        newGeom.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
        if (colors && newColors.length > 0) {
            newGeom.setAttribute('color', new THREE.Float32BufferAttribute(newColors, 3));
        }
        return newGeom;
    }

    function colorize(geometry, mode) {
        if (mode === 'default') {
            if (originalMapGeometry && originalMapGeometry.attributes.color) {
                geometry.setAttribute('color', originalMapGeometry.attributes.color.clone());
            } else {
                geometry.deleteAttribute('color');
            }
            mapObject.material.vertexColors = originalMapGeometry.attributes.color !== undefined;
            mapObject.material.needsUpdate = true;
            return;
        }

        const positions = geometry.attributes.position.array;
        const colors = new Float32Array(positions.length);
        const color = new THREE.Color();
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
       
        let minVal, maxVal;

        if (mode === 'height') {
            minVal = box.min.z;
            maxVal = box.max.z;
        } else if (mode === 'range') {
            minVal = Infinity; maxVal = -Infinity;
            const center = box.getCenter(new THREE.Vector3());
            for (let i = 0; i < positions.length; i += 3) {
                const dist = Math.sqrt((positions[i]-center.x)**2 + (positions[i+1]-center.y)**2);
                minVal = Math.min(minVal, dist);
                maxVal = Math.max(maxVal, dist);
            }
        }

        const range = maxVal - minVal;
        if (range <= 0) return;

        for (let i = 0; i < positions.length; i += 3) {
            let val;
            if (mode === 'height') {
                val = positions[i + 2];
            } else {
                const center = box.getCenter(new THREE.Vector3());
                val = Math.sqrt((positions[i]-center.x)**2 + (positions[i+1]-center.y)**2);
            }
            const normalized = (val - minVal) / range;
            color.setHSL(0.7 * (1 - normalized), 1.0, 0.5);
            colors[i] = color.r;
            colors[i + 1] = color.g;
            colors[i + 2] = color.b;
        }
       
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        mapObject.material.vertexColors = true;
        mapObject.material.needsUpdate = true;
    }
   
    // --- Orthographic View Hit Detection ---
    function findClosestPointOrthographic(event) {
        if (!waypointsObject || !camera) return -1;

        const rect = renderer.domElement.getBoundingClientRect();
        const mouse = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        };

        const hitRadius = 10; // Pixel radius for selection
        let closestPointIndex = -1;
        let minDistanceSq = Infinity;

        const positions = waypointsObject.geometry.attributes.position;
        const tempVec = new THREE.Vector3();

        for (let i = 0; i < positions.count; i++) {
            tempVec.fromBufferAttribute(positions, i);
            tempVec.project(camera);

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

    // --- Event Listeners ---
    function onPointerDown(event) {
        if (!camera) return;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        
        // --- Shape Drawing/Selection Logic ---
        if (isDrawingPaletteVisible) {
            raycaster.setFromCamera(pointer, camera);
            const shapeIntersects = raycaster.intersectObjects(shapeGroup.children, true);
            const isDrawingToolActive = currentTool !== 'select' && currentTool !== 'delete';

            if (isDrawingToolActive) {
                const point = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(raycastPlane, point)) {
                    shapeDrawStartPoint.copy(point);
                    isDrawingShape = true;
                    return; 
                }
            } else if (currentTool === 'delete') {
                if (shapeIntersects.length > 0) {
                    let clickedObject = shapeIntersects[0].object;
                    while (clickedObject.parent !== shapeGroup && clickedObject.parent !== null) {
                        clickedObject = clickedObject.parent;
                    }
                    selectedShape = clickedObject; // Temporarily select for deletion
                    deleteSelectedShape();
                    return;
                }
            } else if (currentTool === 'select') {
                 if (shapeIntersects.length > 0) {
                    let clickedObject = shapeIntersects[0].object;
                    while (clickedObject.parent !== shapeGroup && clickedObject.parent !== null) {
                        clickedObject = clickedObject.parent;
                    }
                    const clickedShape = clickedObject;

                    selectShape(clickedShape);
                    
                    isMovingShape = true;
                    controls.enabled = false;
                    app.classList.add('shape-move');
                    
                    const intersectionMove = new THREE.Vector3();
                    raycaster.setFromCamera(pointer, camera);
                    raycaster.ray.intersectPlane(raycastPlane, intersectionMove)
                    shapeDragOffset.subVectors(clickedShape.position, intersectionMove);

                    return;
                 } else {
                    selectShape(null);
                 }
            }
        }

        // --- Waypoint Editing Logic ---
        if (!editMode || isCameraOverrideActive) return;
       
        let clickedIndex = -1;
        if (waypointsObject) {
            if (camera.isOrthographicCamera) {
                clickedIndex = findClosestPointOrthographic(event);
            } else {
                raycaster.params.Points.threshold = dynamicPointSize;
                raycaster.setFromCamera(pointer, camera);
                const intersects = raycaster.intersectObject(waypointsObject);
                clickedIndex = intersects.length > 0 ? intersects[0].index : -1;
            }
        }
       
        switch (editSubMode) {
            case 'add':
                const intersectionAdd = new THREE.Vector3(); 
                raycaster.setFromCamera(pointer, camera);
                if (raycaster.ray.intersectPlane(raycastPlane, intersectionAdd)) addPoint(intersectionAdd);
                break;
            case 'select':
                if (clickedIndex !== -1) {
                    clearSelection();
                    selectedIndices.add(clickedIndex);
                    updateAllColors();
                    updateInfoPanel();
                } else {
                    isMarqueeSelecting = true;
                    controls.enabled = false;
                    marqueeStart.set(event.clientX, event.clientY);
                    selectionBox.style.display = 'block';
                    selectionBox.style.left = `${event.clientX}px`;
                    selectionBox.style.top = `${event.clientY}px`;
                    selectionBox.style.width = '0px';
                    selectionBox.style.height = '0px';
                }
                break;
            case 'interpolate':
                if (clickedIndex !== -1) {
                    if (pathSelectionStartIndex === null) {
                        clearSelection();
                        pathSelectionStartIndex = clickedIndex;
                        selectedIndices.add(clickedIndex);
                    } else {
                        const start = Math.min(pathSelectionStartIndex, clickedIndex);
                        const end = Math.max(pathSelectionStartIndex, clickedIndex);
                        for (let i = start; i <= end; i++) selectedIndices.add(i);
                        pathSelectionStartIndex = null;
                    }
                    updateAllColors();
                    updateInterpolationPanel();
                } else {
                    clearSelection();
                    updateInterpolationPanel();
                }
                break;
            case 'move':
                handleMovePointerDown(clickedIndex, event);
                break;
            case 'delete': 
                if (clickedIndex !== -1) {
                    if (!selectedIndices.has(clickedIndex)) {
                        clearSelection();
                        selectedIndices.add(clickedIndex);
                    }
                    deleteSelectedPoints(); 
                }
                break;
            case 'zone':
                if (clickedIndex !== -1) {
                    if (zoneStartIndex === null) {
                        zoneStartIndex = clickedIndex;
                        selectedIndices.add(clickedIndex);
                    } else if (zoneStartIndex !== clickedIndex) {
                        selectedIndices.add(clickedIndex);
                    }
                    updateAllColors();
                    updateZonePanel();
                }
                break;
        }
    }

    function handleMovePointerDown(clickedIndex, event) {
        switch (moveSubMode) {
            case 'drag':
                if (clickedIndex !== -1) {
                    isDraggingPoint = true;
                    dragStartIndex = clickedIndex;
                   
                    if (!selectedIndices.has(clickedIndex)) {
                        clearSelection();
                        selectedIndices.add(clickedIndex);
                        updateAllColors();
                        updateInfoPanel();
                    }
                   
                    const positions = waypointsObject.geometry.attributes.position;
                    dragStartPositions.clear();
                    for(const index of selectedIndices) {
                        dragStartPositions.set(index, new THREE.Vector3().fromBufferAttribute(positions, index));
                    }

                    const startPos = dragStartPositions.get(clickedIndex);
                    const cameraDirection = new THREE.Vector3();
                    camera.getWorldDirection(cameraDirection);
                    raycastPlane.setFromNormalAndCoplanarPoint(cameraDirection, startPos);

                    const intersectionMove = new THREE.Vector3();
                    if(raycaster.ray.intersectPlane(raycastPlane, intersectionMove)) {
                        dragStartOffset.subVectors(startPos, intersectionMove);
                    }

                    controls.enabled = false;
                    app.classList.add('draggable');
                    createPersistentGhostPreview();
                }
                break;
            case 'box-select':
                isMarqueeSelecting = true;
                controls.enabled = false;
                marqueeStart.set(event.clientX, event.clientY);
                selectionBox.style.display = 'block';
                selectionBox.style.left = `${event.clientX}px`;
                selectionBox.style.top = `${event.clientY}px`;
                selectionBox.style.width = '0px';
                selectionBox.style.height = '0px';
                break;
            case 'path-select':
                if (clickedIndex !== -1) {
                    if (movePathStartIndex === null) {
                        clearSelection();
                        movePathStartIndex = clickedIndex;
                    } else {
                        const start = Math.min(movePathStartIndex, clickedIndex);
                        const end = Math.max(movePathStartIndex, clickedIndex);
                        for (let i = start; i <= end; i++) selectedIndices.add(i);
                        movePathStartIndex = null;
                        moveSubMode = 'drag';
                    }
                    updateAllColors();
                    updateInfoPanel();
                }
                break;
        }
    }

    function handleHover(event) {
        if (!camera || isDraggingPoint || isMarqueeSelecting || !waypointsObject || (!editMode && !isDrawingPaletteVisible)) {
            if (hoverIndicator.visible) {
                hoveredPointIndex = null;
                hoverIndicator.visible = false;
            }
            return;
        }

        let index = -1;
        if (camera.isOrthographicCamera) {
            index = findClosestPointOrthographic(event);
        } else {
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.params.Points.threshold = dynamicPointSize;
            raycaster.setFromCamera(pointer, camera);
            const intersects = raycaster.intersectObject(waypointsObject);
            if (intersects.length > 0) {
                index = intersects[0].index;
            }
        }

        if (index === -1) {
            if (hoveredPointIndex !== null) {
                hoveredPointIndex = null;
                hoverIndicator.visible = false;
            }
        } else if (hoveredPointIndex !== index) {
            hoveredPointIndex = index;
            const pos = new THREE.Vector3().fromBufferAttribute(waypointsObject.geometry.attributes.position, index);
            hoverIndicator.position.copy(pos);
            hoverIndicator.visible = true;
        }
    }

    function onPointerMove(event) {
        if (!camera || isCameraOverrideActive) return;

        handleHover(event);

        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);

        // --- Shape Drawing/Moving Logic ---
        if (isDrawingShape) {
            if (ghostShape) {
                shapeGroup.remove(ghostShape);
                ghostShape.geometry.dispose();
                ghostShape.material.dispose();
                ghostShape = null;
            }
            const currentPoint = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(raycastPlane, currentPoint)) {
                const tempColor = new THREE.Color(document.getElementById('fill-color').value);
                ghostShape = addShapeMesh(currentTool, shapeDrawStartPoint, currentPoint, tempColor, '', true);
            }
            return;
        }
        if (isMovingShape && selectedShape) {
            const intersection = new THREE.Vector3();
            if(raycaster.ray.intersectPlane(raycastPlane, intersection)) {
                selectedShape.position.copy(intersection).add(shapeDragOffset);
            }
            return;
        }

        // --- Waypoint Logic ---
        if (isMarqueeSelecting) {
            marqueeEnd.set(event.clientX, event.clientY);
            const left = Math.min(marqueeStart.x, marqueeEnd.x);
            const top = Math.min(marqueeStart.y, marqueeEnd.y);
            const width = Math.abs(marqueeStart.x - marqueeEnd.x);
            const height = Math.abs(marqueeStart.y - marqueeEnd.y);
            selectionBox.style.left = `${left}px`;
            selectionBox.style.top = `${top}px`;
            selectionBox.style.width = `${width}px`;
            selectionBox.style.height = `${height}px`;

            updateSelectionFromMarquee();
            return;
        }

        if (isDraggingPoint) {
            const intersection = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(raycastPlane, intersection)) {
                const positions = waypointsObject.geometry.attributes.position;
               
                const newDragPointPos = intersection.clone().add(dragStartOffset);
                const initialDraggedPointPos = dragStartPositions.get(dragStartIndex);
                const delta = new THREE.Vector3().subVectors(newDragPointPos, initialDraggedPointPos);

                for (const index of selectedIndices) {
                    const initialPos = dragStartPositions.get(index);
                    if (initialPos) {
                        const newPos = initialPos.clone().add(delta);
                        positions.setXYZ(index, newPos.x, newPos.y, newPos.z);
                    }
                }
                positions.needsUpdate = true;
            }
        }
    }

    function onPointerUp(event) {
        if (!camera) return;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        
        // --- Shape Logic ---
        if (isDrawingShape) {
            isDrawingShape = false;
            if (ghostShape) {
                shapeGroup.remove(ghostShape);
                ghostShape.geometry.dispose();
                ghostShape.material.dispose();
                ghostShape = null;
            }
            const endPoint = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(raycastPlane, endPoint)) {
                const fillColor = document.getElementById('fill-color').value;
                const text = document.getElementById('shape-text').value;
                addShapeMesh(currentTool, shapeDrawStartPoint, endPoint, fillColor, text, false);
                recordState(); // Record state after adding a shape
            }
        }
        if (isMovingShape) {
            isMovingShape = false;
            controls.enabled = true;
            app.classList.remove('shape-move');
            recordState(); // Record state after moving a shape
        }

        // --- Waypoint Logic ---
        if (isMarqueeSelecting) {
            isMarqueeSelecting = false;
            selectionBox.style.display = 'none';
            if(editSubMode === 'move') {
                moveSubMode = 'drag';
            }
            updateInfoPanel();
        }

        if (isDraggingPoint) {
            const positions = waypointsObject.geometry.attributes.position;
            const indicesToUpdate = Array.from(selectedIndices);
            const newPositions = indicesToUpdate.map(index => new THREE.Vector3().fromBufferAttribute(positions, index));
            batchUpdateDbPositions(indicesToUpdate, newPositions); // This now calls recordState internally
            clearPersistentGhostPreview();

            if (selectedIndices.size > 0) {
                lastMovedIndices = new Set(selectedIndices);
                document.getElementById('generate-connections').disabled = false;
            }
        }

        isDraggingPoint = false;
        if(controls) controls.enabled = true;
        app.classList.remove('draggable');
    }
   
    function updateSelectionFromMarquee() {
        if (!waypointsObject || !camera) return;

        const rect = renderer.domElement.getBoundingClientRect();
        const boxMinX = Math.min(marqueeStart.x, marqueeEnd.x) - rect.left;
        const boxMinY = Math.min(marqueeStart.y, marqueeEnd.y) - rect.top;
        const boxMaxX = Math.max(marqueeStart.x, marqueeEnd.x) - rect.left;
        const boxMaxY = Math.max(marqueeStart.y, marqueeEnd.y) - rect.top;

        const positions = waypointsObject.geometry.attributes.position;
        const tempVec = new THREE.Vector3();
       
        clearSelection();

        for (let i = 0; i < positions.count; i++) {
            tempVec.fromBufferAttribute(positions, i);
            tempVec.project(camera);

            const screenX = (tempVec.x * 0.5 + 0.5) * rect.width;
            const screenY = (-tempVec.y * 0.5 + 0.5) * rect.height;
           
            if (screenX >= boxMinX && screenX <= boxMaxX && screenY >= boxMinY && screenY <= boxMaxY) {
                selectedIndices.add(i);
            }
        }
        updateAllColors();
    }


    // --- UI Wiring ---
    const mapFileInput = document.getElementById('map-file');
    const waypointFileInput = document.getElementById('waypoint-file');
    const newWaypointsBtn = document.getElementById('new-waypoints');
    const saveWaypointsBtn = document.getElementById('save-waypoints');
    const viewSelect = document.getElementById('view-select');
    const lockRotationBtn = document.getElementById('lock-rotation');
    const generatePathBtn = document.getElementById('generate-path');
    
    // --- NEW: Tab Navigation & Mode Switching ---
    const tabViewBtn = document.getElementById('tab-view');
    const tabEditBtn = document.getElementById('tab-waypoint-edit');
    const tabDrawBtn = document.getElementById('tab-layout-drawings');
    const rightInfoPanel = document.getElementById('info-panel');

    function switchMode(newMode) {
        [tabViewBtn, tabEditBtn, tabDrawBtn].forEach(b => b.classList.remove('active'));

        if (editMode) toggleEditMode(); 
        isDrawingPaletteVisible = false;
        drawingPalette.style.display = 'none';
        rightInfoPanel.style.display = 'none';

        if (newMode === 'edit') {
            if (!db) {
                alert("Please load or create a waypoint set first.");
                tabViewBtn.classList.add('active');
                return;
            }
            tabEditBtn.classList.add('active');
            toggleEditMode();
            rightInfoPanel.style.display = 'block';
        } else if (newMode === 'draw') {
            tabDrawBtn.classList.add('active');
            isDrawingPaletteVisible = true;
            drawingPalette.style.display = 'block';
            rightInfoPanel.style.display = 'block';
        } else {
            tabViewBtn.classList.add('active');
        }
    }

    tabViewBtn.addEventListener('click', () => switchMode('view'));
    tabEditBtn.addEventListener('click', () => switchMode('edit'));
    tabDrawBtn.addEventListener('click', () => switchMode('draw'));

    // MODIFIED: This function is now simpler and controlled by switchMode
    function toggleEditMode() {
        editMode = !editMode;
        editToolbar.style.display = editMode ? 'block' : 'none';
        if (!editMode) {
             clearSelection();
             selectShape(null);
             updateActivePanels();
        };
    }
    // END NEW ---

    document.getElementById('display-toggle').addEventListener('click', () => displayPanel.style.display = displayPanel.style.display === 'none' ? 'block' : 'none');
    document.getElementById('map-point-size').addEventListener('input', (e) => { if (mapObject) mapObject.material.size = parseFloat(e.target.value); });
    document.getElementById('waypoint-size').addEventListener('input', (e) => {
        dynamicPointSize = parseFloat(e.target.value);
        updateWaypointVisuals();
    });
    document.getElementById('color-mode').addEventListener('change', applyMapDisplayOptions);
    document.getElementById('voxel-size').addEventListener('change', applyMapDisplayOptions);
   
    generatePathBtn.addEventListener('click', generatePathMesh);
    document.getElementById('linear-interpolate').addEventListener('click', linearInterpolateSelected);
    document.getElementById('generate-connections').addEventListener('click', generatePathConnections);
    document.getElementById('create-zone-btn').addEventListener('click', createZone);
    document.getElementById('clear-zone-selection-btn').addEventListener('click', clearSelection);
    document.getElementById('zone-name-input').addEventListener('input', updateZonePanel);

   
    // Move Panel Buttons
    document.getElementById('move-select-box').addEventListener('click', () => {
        moveSubMode = 'box-select';
    });
     document.getElementById('move-select-path').addEventListener('click', () => {
        moveSubMode = 'path-select';
        movePathStartIndex = null;
        clearSelection();
    });

    const radialSlider = document.getElementById('radial-strength');
    const radialValueInput = document.getElementById('radial-strength-value');

    // --- Radial Interpolation Controls Synchronization ---
    function restoreInterpolationPoints() {
        if (interpolationOriginalPositions.size === 0 || !waypointsObject) return;
        const positions = waypointsObject.geometry.attributes.position;
        for (const [index, pos] of interpolationOriginalPositions) {
            positions.setXYZ(index, pos.x, pos.y, pos.z);
        }
        positions.needsUpdate = true;
    }

    function syncAndPreviewRadial(value) {
        const min = parseFloat(radialSlider.min);
        const max = parseFloat(radialSlider.max);
        let clampedValue = Math.max(min, Math.min(max, value));
        radialSlider.value = clampedValue;
        if (document.activeElement !== radialValueInput) {
           radialValueInput.value = clampedValue.toFixed(2);
        }
        restoreInterpolationPoints();
        performRadialInterpolation(false);
    }

    function commitRadialChange() {
        restoreInterpolationPoints();
        createPersistentGhostPreview();
        performRadialInterpolation(true); // this calls batchUpdate which calls recordState
        interpolationOriginalPositions.clear();
        clearTransientGhostPreview();
        let finalValue = parseFloat(radialSlider.value);
        radialValueInput.value = finalValue.toFixed(2);
    }
   
    const startRadialPreview = () => {
        if (interpolationOriginalPositions.size > 0) return;
        createTransientGhostPreview();
        interpolationOriginalPositions.clear();
        if (!waypointsObject) return;
        const positions = waypointsObject.geometry.attributes.position;
        for (const index of selectedIndices) {
            interpolationOriginalPositions.set(index, new THREE.Vector3().fromBufferAttribute(positions, index));
        }
    };

    radialSlider.addEventListener('input', () => syncAndPreviewRadial(parseFloat(radialSlider.value)));
    radialValueInput.addEventListener('input', () => {
        let value = parseFloat(radialValueInput.value);
        if (!isNaN(value)) {
            syncAndPreviewRadial(value);
        }
    });

    radialSlider.addEventListener('pointerdown', startRadialPreview);
    radialValueInput.addEventListener('focus', startRadialPreview);
   
    radialSlider.addEventListener('change', commitRadialChange);
    radialValueInput.addEventListener('change', commitRadialChange);
    // --- End Radial Controls ---

    document.getElementById('edit-undo').addEventListener('click', undo);
    document.getElementById('edit-redo').addEventListener('click', redo);

    function onMapFileSelect(file) {
        document.getElementById('loader').style.display = 'block';
        document.getElementById('loader').textContent = 'Loading Map...';
        const url = URL.createObjectURL(file);
        const loader = file.name.toLowerCase().endsWith('.ply') ? new PLYLoader() : new PCDLoader();
       
        loader.load(url, (object) => {
            const geometry = object.isPoints ? object.geometry : object;
            if (mapObject) {
                scene.remove(mapObject);
                mapObject.geometry.dispose();
                mapObject.material.dispose();
            }

            // Apply ROS transformation to map
            const positions = geometry.attributes.position.array;
            for (let i = 0; i < positions.length; i += 3) {
                let x = positions[i];
                let y = positions[i+1];
                positions[i] = -y; // three.x = -ros.y
                positions[i+1] = x; // three.y = ros.x
            }
            geometry.attributes.position.needsUpdate = true;

            geometry.computeBoundingBox();
            geometry.boundingBox.getCenter(mapOffset);
            geometry.translate(-mapOffset.x, -mapOffset.y, -mapOffset.z);
           
            originalMapGeometry = geometry.clone();
           
            const material = new THREE.PointsMaterial({
                size: 0.5,
                vertexColors: originalMapGeometry.attributes.color !== undefined
            });
            mapObject = new THREE.Points(originalMapGeometry.clone(), material);
            scene.add(mapObject);
           
            if (db) {
                refreshWaypointsFromDB();
            }
           
            document.getElementById('map-point-size').value = 0.5;
            document.getElementById('color-mode').value = 'default';
            document.getElementById('voxel-size').value = 0;
            document.getElementById('loader').style.display = 'none';
           
            setView(viewSelect.value);
            URL.revokeObjectURL(url);
        }, undefined, (error) => {
            console.error("Error loading map file:", error);
            alert("Failed to load map file. Please check the console for details.");
            document.getElementById('loader').style.display = 'none';
        });
    }

    function updateButtonState() {
        const hasDb = db !== null;
        saveWaypointsBtn.disabled = !hasDb;
        tabEditBtn.disabled = !hasDb;
        tabDrawBtn.disabled = !hasDb;
        generatePathBtn.disabled = !hasDb;
        if (!hasDb && (editMode || isDrawingPaletteVisible)) {
            switchMode('view');
        }
    }
   
    mapFileInput.addEventListener('change', e => e.target.files[0] && onMapFileSelect(e.target.files[0]));
    waypointFileInput.addEventListener('change', e => {
        if (e.target.files[0]) {
            loadWaypointsFromFile(e.target.files[0]);
            e.target.value = '';
        }
    });
    newWaypointsBtn.addEventListener('click', createNewWaypointSet);
    saveWaypointsBtn.addEventListener('click', saveWaypointsToDB);
    viewSelect.addEventListener('change', () => setView(viewSelect.value));
    
    lockRotationBtn.addEventListener('click', () => {
        isRotationLocked = !isRotationLocked;
        if (controls) {
            controls.enableRotate = !isRotationLocked;
        }
        lockRotationBtn.classList.toggle('active', isRotationLocked);
    });
   
    const editModeButtons = { 
        add: document.getElementById('edit-add'), 
        select: document.getElementById('edit-select'), 
        move: document.getElementById('edit-move'), 
        interpolate: document.getElementById('edit-interpolate'),
        delete: document.getElementById('edit-delete'), 
        zone: document.getElementById('edit-zone'), 
    };
    const hintSpan = document.getElementById('edit-mode-hint');

    Object.entries(editModeButtons).forEach(([mode, button]) => { 
        button.addEventListener('click', () => { 
            editSubMode = mode;
            moveSubMode = 'drag'; // Reset move sub-mode
            lastMovedIndices = null; // Reset for rubber banding
            document.getElementById('generate-connections').disabled = true;

            Object.values(editModeButtons).forEach(btn => btn.classList.remove('active')); 
            button.classList.add('active'); 
            app.classList.toggle('delete-mode', mode === 'delete'); 
           
            clearSelection();
            updateActivePanels();
            updateInterpolationPanel();

            switch(mode) { 
                case 'add': hintSpan.textContent = "Click on the grid to add a waypoint."; break;
                case 'select': hintSpan.textContent = "Click a point or drag a box to select."; break;
                case 'move': hintSpan.textContent = "Select points, then drag them to move."; break;
                case 'interpolate': hintSpan.textContent = "Click start and end points of a path to interpolate."; break;
                case 'delete': hintSpan.textContent = "Click a waypoint or a selection to delete."; break;
                case 'zone': hintSpan.textContent = "Click start and end waypoints to define a zone."; break;
            } 
        }); 
    });

    // --- Drawing Palette Button Listeners ---
    const drawingToolButtons = {
        rect: document.getElementById('tool-rect'),
        oval: document.getElementById('tool-oval'),
        triangle: document.getElementById('tool-triangle'),
        arrow: document.getElementById('tool-arrow'),
        pentagon: document.getElementById('tool-pentagon'),
        star: document.getElementById('tool-star'),
        select: document.getElementById('tool-select'),
        delete: document.getElementById('tool-delete'),
    };
    
    Object.entries(drawingToolButtons).forEach(([tool, button]) => {
        button.addEventListener('click', () => {
            currentTool = tool;
            Object.values(drawingToolButtons).forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            app.classList.toggle('delete-mode', tool === 'delete');
        });
    });

   
    renderer.domElement.addEventListener('pointerdown', onPointerDown, true);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
   
    function updateCameraModeIndicator(e) {
        if (!isCameraOverrideActive || viewSelect.value === 'perspective') {
            cameraModeIndicator.style.display = 'none';
            return;
        }
       
        if (e.ctrlKey && e.shiftKey) {
            controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; // Orbit
            cameraModeIndicator.textContent = "Camera Mode: Pan";
            cameraModeIndicator.style.display = 'block';
        } else if (e.ctrlKey) {
            controls.mouseButtons.LEFT = THREE.MOUSE.PAN; // Pan
            cameraModeIndicator.textContent = "Camera Mode: Orbit";
            cameraModeIndicator.style.display = 'block';
        }
    }

    window.addEventListener('keydown', (e) => {
        const activeElement = document.activeElement;
        const isInputActive = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'SELECT');

        if (isInputActive && e.key !== 'Escape') return;

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedShape) {
                deleteSelectedShape();
            } else if (editMode && selectedIndices.size > 0) {
                deleteSelectedPoints();
            }
        }
        if (e.ctrlKey && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
        } else if (e.ctrlKey && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            redo();
        }

        if ((editMode || isDrawingPaletteVisible) && e.key === 'Control' && !isCameraOverrideActive) {
            isCameraOverrideActive = true;
            controls.enabled = true;
            updateCameraModeIndicator(e);
        } else if ((editMode || isDrawingPaletteVisible) && e.key === 'Shift' && isCameraOverrideActive) {
            updateCameraModeIndicator(e);
        }
    });

    window.addEventListener('keyup', (e) => {
        if (e.key === 'Control') {
            isCameraOverrideActive = false;
            cameraModeIndicator.style.display = 'none';
            controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        } else if (e.key === 'Shift' && isCameraOverrideActive) {
            updateCameraModeIndicator(e);
        }
    });


    // --- Helper & View Functions ---
    function setView(viewType) {
        if (controls) { controls.dispose(); }

        const aspect = window.innerWidth / window.innerHeight;
        let targetObject = mapObject || gridHelper;
        const box = new THREE.Box3().setFromObject(targetObject);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 10;
       
        if (viewType === 'perspective') {
            const near = Math.max(maxDim * 0.001, 0.01);
            const far = maxDim * 100;
            camera = new THREE.PerspectiveCamera(60, aspect, near, far);
            camera.up.set(0, 0, 1);
            const camDist = maxDim * 1.5;
            camera.position.copy(center).add(new THREE.Vector3(camDist * 0.7, -camDist * 0.7, camDist * 0.7));
            raycastPlane.set(new THREE.Vector3(0, 0, 1), 0); 
        } else {
            const orthoSize = maxDim * 0.6;
            camera = new THREE.OrthographicCamera(-orthoSize * aspect, orthoSize * aspect, orthoSize, -orthoSize, -maxDim * 5, maxDim * 5);
            camera.up.set(0, 0, 1);
           
            if (viewType === 'top') {
                camera.position.set(center.x, center.y, center.z + maxDim);
                raycastPlane.set(new THREE.Vector3(0, 0, 1), center.z); 
            } else if (viewType === 'front') {
                camera.position.set(center.x, center.y - maxDim, center.z);
                camera.lookAt(center);
                raycastPlane.set(new THREE.Vector3(0, 1, 0), -center.y); 
            } else if (viewType === 'side') {
                camera.position.set(center.x + maxDim, center.y, center.z);
                camera.lookAt(center);
                raycastPlane.set(new THREE.Vector3(-1, 0, 0), -center.x); 
            }
        }
       
        if (viewType !== 'front' && viewType !== 'side') {
             camera.lookAt(center);
        }
       
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.copy(center);

        controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
        controls.enableRotate = !isRotationLocked;
        controls.minPolarAngle = 0; 
        controls.maxPolarAngle = Math.PI; 

        if (viewType === 'top') {
            controls.minPolarAngle = 0;
            controls.maxPolarAngle = 0;
        } else if (viewType === 'front' || viewType === 'side') {
            controls.minPolarAngle = Math.PI / 2;
            controls.maxPolarAngle = Math.PI / 2;
        }
       
        dynamicPointSize = Math.max(maxDim / 800, 0.02);
        document.getElementById('waypoint-size').value = dynamicPointSize;
        updateWaypointVisuals();
    }


    // --- Animate & Init ---
    function tick(){
      requestAnimationFrame(tick);
      if (controls) controls.update();
      if (hoverIndicator.visible && camera) {
          hoverIndicator.quaternion.copy(camera.quaternion);
          if (camera.isOrthographicCamera) {
              const scale = (camera.top - camera.bottom) / window.innerHeight;
              hoverIndicator.scale.setScalar(scale * 15);
          } else { 
              const distance = hoverIndicator.position.distanceTo(camera.position);
              const vFOV = THREE.MathUtils.degToRad(camera.fov);
              const height = 2 * Math.tan(vFOV / 2) * distance;
              const scale = height / renderer.domElement.clientHeight * 15;
              hoverIndicator.scale.setScalar(scale);
          }
      }
      renderer.render(scene, camera);
    }
   
    window.addEventListener('resize', () => {
        if (!camera) return;
        const aspect = window.innerWidth / window.innerHeight;
        if (camera.isPerspectiveCamera) {
            camera.aspect = aspect;
        } else if (camera.isOrthographicCamera) {
            const orthoSize = (camera.top - camera.bottom) / 2;
            camera.left = -orthoSize * aspect;
            camera.right = orthoSize * aspect;
        }
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    initDatabase().then(() => {
        setView('perspective'); // Initialize with a default view
        tick();
    }).catch(err => {
        console.error("Initialization failed:", err);
        document.getElementById('loader').textContent = 'Error! Check console.';
        alert("A fatal error occurred during initialization. The application may not work correctly. Please check the developer console for details.");
    });