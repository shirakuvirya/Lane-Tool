import { ViryaOSLaneStudio } from './core.js';
import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

Object.assign(ViryaOSLaneStudio.prototype, {
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
    },

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
    },

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
    },
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
    },

    /**
     * Hide the text input modal
     */
    hideTextInputModal() {
        const modal = document.getElementById('text-input-modal');
        if (modal) modal.classList.add('hidden');
        this.textInsertionPoint = null;
        this.isEditingText = false;
    },
    
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
    },

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
        mesh.position.set(centerX, centerY, -0.001);

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
    },

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
    },
    
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
    },

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
    },

    /**
     * Add visual outline to selected shape
     * * @param {THREE.Mesh} shape - Shape to outline
     */
    addSelectionOutline(shape) {
         if (shape.selectionOutline) return;

        // 1. Create a box geometry that matches the shape's original unscaled size.
        // We get the size from the shape's geometry's bounding box.
        shape.geometry.computeBoundingBox();
        const size = shape.geometry.boundingBox.getSize(new THREE.Vector3());
        const outlineGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);

        // 2. Use EdgesGeometry to get only the lines of the box.
        const edges = new THREE.EdgesGeometry(outlineGeometry);

        // 3. Create a line material and the final LineSegments object.
        const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x4a9eff, depthTest: false });
        const outline = new THREE.LineSegments(edges, outlineMaterial);

        // 4. Match the outline's transform (position, rotation, scale) to the shape's transform.
        // This is the key part that makes it an Oriented Bounding Box (OBB).
        outline.position.copy(shape.position);
        outline.rotation.copy(shape.rotation);
        outline.scale.copy(shape.scale);
        
        // 5. Store the outline and add it to the scene.
        shape.selectionOutline = outline;
        this.shapeGroup.add(outline);

    },
    
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
    },
    /**
     * Rotates the currently selected shape by a given number of degrees.
     * @param {number} degrees - The number of degrees to rotate by (positive for CW, negative for CCW).
     */
    rotateSelectedShape(degrees) {
        if (!this.selectedShape) return;

        // Convert degrees to radians and add to the shape's z-axis rotation
        const radians = degrees * (Math.PI / 180);
        this.selectedShape.rotation.z += radians;

        if (this.selectedShape.selectionOutline) {
            this.selectedShape.selectionOutline.rotation.copy(this.selectedShape.rotation);
        }

        this.updateResizeHandlePositions(this.selectedShape);

        // Update the UI display with the new rotation value
        const rotationInput = document.getElementById('shape-rotation-value');
        if (rotationInput) {
            const currentDegrees = (this.selectedShape.rotation.z * 180 / Math.PI);
            rotationInput.value = currentDegrees.toFixed(1);
        }
    },
    /**
     * Create resize handles for the selected shape at its actual transformed corners.
     * * @param {THREE.Mesh} shape - Shape to create handles for
     */
    createResizeHandles(shape) {
        this.clearResizeHandles();
        shape.updateMatrixWorld(); // Ensure the shape's world matrix is up-to-date

        // Get the original, unscaled size of the shape's geometry
        shape.geometry.computeBoundingBox();
        const size = shape.geometry.boundingBox.getSize(new THREE.Vector3());
        
        const handleSize = this.dynamicPointSize * 2;
        const handleGeometry = new THREE.BoxGeometry(handleSize, handleSize, handleSize);
        const handleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });

        // Define the 4 corner positions in the shape's LOCAL space (before transformation)
        const localHandlePositions = [
            new THREE.Vector3(-size.x / 2, -size.y / 2, 0), // Bottom-left
            new THREE.Vector3( size.x / 2, -size.y / 2, 0), // Bottom-right
            new THREE.Vector3( size.x / 2,  size.y / 2, 0), // Top-right
            new THREE.Vector3(-size.x / 2,  size.y / 2, 0)  // Top-left
        ];

        localHandlePositions.forEach((pos, index) => {
            const handle = new THREE.Mesh(handleGeometry.clone(), handleMaterial.clone());
            
            // Transform the local corner position to its world position
            const worldPos = pos.clone().applyMatrix4(shape.matrixWorld);
            handle.position.copy(worldPos);
            
            handle.userData = {
                type: 'resizeHandle',
                handleIndex: index,
                parentShape: shape,
            };
            this.resizeHandles.push(handle);
            this.shapeGroup.add(handle);
        });
    },

    /**
     * Update resize handle positions after shape transformation by transforming local corners to world space.
     * * @param {THREE.Mesh} shape - Shape whose handles need updating
     */
    updateResizeHandlePositions(shape) {
        if (this.resizeHandles.length === 0) return;
        shape.updateMatrixWorld(); // Ensure the shape's world matrix is up-to-date

        // Get the original, unscaled size of the shape's geometry
        shape.geometry.computeBoundingBox();
        const size = shape.geometry.boundingBox.getSize(new THREE.Vector3());
        
        // Define the 4 corner positions in the shape's LOCAL space
        const localHandlePositions = [
            new THREE.Vector3(-size.x / 2, -size.y / 2, 0), // Bottom-left
            new THREE.Vector3( size.x / 2, -size.y / 2, 0), // Bottom-right
            new THREE.Vector3( size.x / 2,  size.y / 2, 0), // Top-right
            new THREE.Vector3(-size.x / 2,  size.y / 2, 0)  // Top-left
        ];

        // Loop through the handles and update their positions
        this.resizeHandles.forEach((handle, index) => {
            // Transform the local corner point to its new world position and update the handle
            const worldPos = localHandlePositions[index].clone().applyMatrix4(shape.matrixWorld);
            handle.position.copy(worldPos);
        });
    },
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
    },
    
    // UI and Style Application
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
            const rotationInput = document.getElementById('shape-rotation-value');
            if (rotationInput) {
                const currentDegrees = (shape.rotation.z * 180 / Math.PI);
                rotationInput.value = currentDegrees.toFixed(1);
            }
        }
    },
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
    },

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
});