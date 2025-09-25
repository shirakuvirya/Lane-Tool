import { ViryaOSLaneStudio } from './core.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ✅ EXPORT the methods as a single object
export {
    setView,
    updatePointCloudColors,
    updateAllPointSizes,
    updateWaypointVisuals,
    updateHoverCoordinates,
    onWindowResize
};

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


    // ====================================================================
    // POINT CLOUD VISUALIZATION
    // ====================================================================
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
