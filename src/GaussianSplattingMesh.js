import { Mesh, Matrix4 } from 't3d';
import { GaussianSplattingMaterial } from './GaussianSplattingMaterial.js';
import { GaussianSplattingGeometry } from './GaussianSplattingGeometry.js';
import { SplatIndexSortWorker } from './SplatIndexSortWorker.js';
import { Utils } from './Utils.js';

class GaussianSplattingMesh extends Mesh {

	constructor(splatBuffer) {
		const internalData = Utils.convertSplatToInternalData(splatBuffer);

		const material = new GaussianSplattingMaterial();
		material.setTextures(internalData);

		const geometry = new GaussianSplattingGeometry(internalData.vertexCount);
		geometry.boundingSphere.setFromArray(internalData.positions);
		geometry.boundingBox.setFromArray(internalData.positions);

		super(geometry, material);

		// Initialize worker
		const worker = new SplatIndexSortWorker();
		worker.init(internalData.positions, internalData.vertexCount);
		worker.onUpdate = (indices, count) => {
			geometry.updateSplatIndices(indices, count);
		};

		this.frustumCulled = false;

		this._internalData = internalData;
		this._worker = worker;
	}

	update(camera, width, height) {
		_mvpMatrix.copy(camera.projectionViewMatrix);
		_mvpMatrix.multiply(this.worldMatrix);
		this._worker.update(_mvpMatrix);

		if (this._internalData.vertexCount > 0) {
			this.material.updateUniforms(camera, width, height);
		}
	}

	dispose() {
		this._worker.dispose();
		this._internalData = null;
	}

}

GaussianSplattingMesh.prototype.isGaussianSplattingMesh = true;

const _mvpMatrix = new Matrix4();

export { GaussianSplattingMesh };