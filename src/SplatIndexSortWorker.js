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
				this._mixArray = e.data.mixArray;
				const validCount = e.data.validCount;
				const indices = new Uint32Array(this._mixArray.buffer);
				console.log(validCount,count)
				this.onUpdate && this.onUpdate(indices, count, validCount, 2);
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
				this._worker.postMessage({ mvpMatrix: el1, mixArray: this._mixArray, frustum: frustum, worldMatrix }, [this._mixArray.buffer]);
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

	// dot: vector3 * vector3
	const dotFunc = function dotFunc(vec1, vec2) {
		return vec1[0] * vec2[0] + vec1[1] * vec2[1] + vec1[2] * vec2[2];
	}

	// multiply: matrix4x4 * vector3
	const mulFunc = function mulFunc(e, x, y, z) {
		const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);

		return [
			(e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
			(e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
			(e[2] * x + e[6] * y + e[10] * z + e[14]) * w,
		];
	}
	function containsPoint(frustum, point) {

		const planes = frustum.planes;

		for (let i = 0; i < 6; i++) {
			const normal = [planes[i].normal.x, planes[i].normal.y, planes[i].normal.z];
			const distance = dotFunc(point, normal) + planes[i].constant;
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

			console.time("sort");
			let isInsideFrustum = false;
			for (let i = 0; i < count; i++) {
				// model pos
				let worldPos = [];
				worldPos = mulFunc(worldMatrix, positions[3 * i + 0], positions[3 * i + 1], positions[3 * i + 2]);

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
				else{
					const j = count -1 -(i- validCount);
					indices[2 * j] = count;
					floatMix[2 * j + 1] = 10000;
				}
				
				// Skip behind of camera and small, transparent splat
			}
			mixArray.sort();

			console.timeEnd("sort");
			self.postMessage({ mixArray, validCount }, [mixArray.buffer]);
			
			// self.postMessage(mixArray, [mixArray.buffer]);
		} else {
			console.error('positions or mvpMatrix is not defined!');
		}
	};
}

export { SplatIndexSortWorker };