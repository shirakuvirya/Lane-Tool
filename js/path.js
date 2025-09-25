import { ViryaOSLaneStudio } from './core.js';
import * as THREE from 'three';

Object.assign(ViryaOSLaneStudio.prototype, {
    // Turn Generation
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
    },
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
    },
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
    },
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
    },

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
    },
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
    },    
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
    },
    // Lane Generation
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

        this.createLane(Array.from(edgesToSkip));

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
    },
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
    },
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
    },
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
    },
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
    },

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
    },

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
    },


   
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
            let count =0;

            while (true) {
                const neighbors = adj.get(curr);

                // If this node is a junction (degree > 2), stop here
                if (neighbors.length > 2 || count >5) {
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
                count = count +1;
            }
        }

        return paths;
    },
    
    createLane(edges){
        let c=0;
        for (const edge of edges) {
            console.log("Edge:", edge);
            c=c+1;
        }
    }

});