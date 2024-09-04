import { Matrix4 } from 't3d';

class SplatIndexSortWorker {

	constructor() {
		this.onUpdate = null;

		this._worker = null;
		this._status = WORKER_STATUS.OFF;

		this._mixArray = null;

		this._lastMVPMatrix = new Matrix4();
	}

	init(positions, count) {
		const blob = new Blob(['(', workerTemplate.toString(), ')(self)'], {
			type: 'application/javascript'
		});

		this._worker = new Worker(URL.createObjectURL(blob));

		this._worker.postMessage({ positions, count });

		this._mixArray = new BigInt64Array(count);// eslint-disable-line

		this._worker.onmessage = e => {
			if (e.data.init) {
				this._status = WORKER_STATUS.READY;
			} else {
				let updatedMixArray = e.data.slicedArray;
				let validCount = e.data.validCount;
				const indices = new Uint32Array(updatedMixArray.buffer);
				this.onUpdate && this.onUpdate(indices, validCount, 2);
				this._status = WORKER_STATUS.READY;
			}
		};
	}

	update(mvpMatrix, frustum, worldMatrix) {
		if (this._status === WORKER_STATUS.READY) {
			const el1 = mvpMatrix.elements;
			const el2 = this._lastMVPMatrix.elements;

			const dot = el2[2] * el1[2] + el2[6] * el1[6] + el2[10] * el1[10];

			if (Math.abs(dot - 1) >= 0.01) {
				this._lastMVPMatrix.copy(mvpMatrix);
				this._status = WORKER_STATUS.BUSY;
				// 修改后的 _mixArray
				const updatedMixArray = this._mixArray.slice();
				this._worker.postMessage({ mvpMatrix: el1, mixArray: updatedMixArray, frustum: frustum, worldMatrix });
				// this._worker.postMessage({ mvpMatrix: el1, mixArray: this._mixArray, frustum }, [this._mixArray.buffer]);
			}
		}
	}

	dispose() {
		if (this._worker) {
			this._worker.terminate();
			this._worker = null;
		}

		this._status = WORKER_STATUS.OFF;
		this._mixArray = null;
	}

}

const WORKER_STATUS = {
	OFF: 0,
	READY: 1,
	BUSY: 2
};

function workerTemplate(self) {
	let count = 0;
	let positions;

	function dot(A, B) {
		return A[0] * B[0] + A[1] * B[1] + A[2] * B[2];
	}
	function containsPoint(frustum, point) {

		const planes = frustum.planes;

		for (let i = 0; i < 6; i++) {
			const normal = [planes[i].normal.x, planes[i].normal.y, planes[i].normal.z];
			const distance = dot(point, normal) + planes[i].constant;
			if (distance < 0) {
				return false;
			}
		}
		return true;
	}

	self.onmessage = e => {
		if (e.data.positions) {
			positions = e.data.positions;
			count = e.data.count;
			self.postMessage({ init: true });
		} else if (e.data.mvpMatrix) {
			const mvpMatrix = e.data.mvpMatrix;
			const mixArray = e.data.mixArray;
			const frustum = e.data.frustum;
			const worldMatrix = e.data.worldMatrix;
			let validCount = 0;

			const indices = new Uint32Array(mixArray.buffer);
			const floatMix = new Float32Array(mixArray.buffer);

			// for (let i = 0; i < count; i++) {
			// 	indices[2 * i] = i;
			// }

			// for (let i = 0; i < count; i++) {
			// 	floatMix[2 * i + 1] = 10000 - (
			// 		mvpMatrix[2] * positions[3 * i + 0] +
			//         mvpMatrix[6] * positions[3 * i + 1] +
			//         mvpMatrix[10] * positions[3 * i + 2]
			// 	);
			// }

			let isInsideFrustum = false;
			for (let i = 0; i < count; i++) {
				// model pos
				const point = [positions[3 * i + 0], positions[3 * i + 1], positions[3 * i + 2]];
				let worldPos = [];

				const w = 1 / (positions[3 * i + 0] * worldMatrix[3] + positions[3 * i + 1] * worldMatrix[7] + positions[3 * i + 2] * worldMatrix[11] + worldMatrix[15]);//

				worldPos[0] = (positions[3 * i + 0] * worldMatrix[0] + positions[3 * i + 1] * worldMatrix[4] + positions[3 * i + 2] * worldMatrix[8] + worldMatrix[12]) * w;//
				worldPos[1] = (positions[3 * i + 0] * worldMatrix[1] + positions[3 * i + 1] * worldMatrix[5] + positions[3 * i + 2] * worldMatrix[9] + worldMatrix[13]) * w;//
				worldPos[2] = (positions[3 * i + 0] * worldMatrix[2] + positions[3 * i + 1] * worldMatrix[6] + positions[3 * i + 2] * worldMatrix[10] + worldMatrix[14]) * w;//

				isInsideFrustum = containsPoint(frustum, worldPos);
				if (isInsideFrustum) {
					indices[2 * validCount] = i;

					floatMix[2 * validCount + 1] = 10000 - (
						mvpMatrix[2] * positions[3 * i + 0] +
						mvpMatrix[6] * positions[3 * i + 1] +
						mvpMatrix[10] * positions[3 * i + 2]
					);
					validCount++;
				}
				// Skip behind of camera and small, transparent splat
			}
			// console.log(validCount, count)
			// mixArray.sort();

			const slicedArray = mixArray.slice(0, validCount);
			slicedArray.sort();
			self.postMessage({ slicedArray, validCount });

			// self.postMessage(mixArray, [mixArray.buffer]);
		} else {
			console.error('positions or mvpMatrix is not defined!');
		}
	};
}

export { SplatIndexSortWorker };