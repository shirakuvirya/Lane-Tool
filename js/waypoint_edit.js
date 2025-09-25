import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';

// ✅ Database schema constants
const WAYPOINT_TABLE_SQL = `...`; // Copy from original core.js
const EDGE_GRAPH_TABLE_SQL = `...`; // Copy from original core.js
const JUNCTION_POINTS_TABLE_SQL = `...`; // Copy from original core.js

// ✅ EXPORT all methods
export {
    // Initialization and Event Handling
    init,
    attachEventListeners,
    // File and DB Loading
    initDatabase,
    loadPointCloudFile,
    applyROSTransformation,
    loadWaypointsFromFile,
    refreshWaypointsFromDB,
    exportDatabase,
    // Waypoint Manipulation
    drawPoints,
    batchAddPoints,
    deleteSelectedPoints,
    // ... (and all your other waypoint edit methods) ...
};

    // Waypoint Creation & Deletion
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
    /**
     * Delete selected waypoints from database
     * * @async
     */
    async deleteSelectedPoints() {
        if (!this.db || this.selectedIndices.size === 0) return;
        
        const idsToDelete = Array.from(this.selectedIndices).map(index => this.indexToDbId[index]);
        console.log(`${idsToDelete}`);
        if (idsToDelete.length === 0) return;

        const placeholders = idsToDelete.map(() => '?').join(',');
        try{
            this.db.run(`DELETE FROM waypoints WHERE id IN (${placeholders})`, idsToDelete);
            this.db.run(`DELETE FROM junction_points WHERE junction_waypoint_id IN (${placeholders})`, idsToDelete);
            this.db.run(`DELETE FROM edge_graph WHERE id1 IN (${placeholders})`, idsToDelete);
            this.db.run(`DELETE FROM edge_graph WHERE id2 IN (${placeholders})`, idsToDelete);
        } catch(e){}




        this.clearSelection();
        await this.refreshWaypointsFromDB();
    }
    
    // Selection & Interaction
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
    
    // Visuals & UI
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
    updateDeletePanel() {
            const deleteBtn = document.getElementById('delete-selected-btn');
            if (deleteBtn) {
                // The button is enabled only if one or more points are selected
                deleteBtn.disabled = this.selectedIndices.size === 0;
            }
        }


    // Interpolation
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

        console.log(`âœ… Marked ${idsToUpdate.length} points as two-way.`);
        this.clearSelection();
        await this.refreshWaypointsFromDB(); // Reload data to show color change
    }
    
    // Persistent Drawing Mode
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