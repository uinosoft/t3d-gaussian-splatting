import { Matrix4 } from 't3d';

class SplatIndexSortWorker {

	constructor() {
		this.onUpdate = null;

		this._worker = null;
		this._status = WORKER_STATUS.OFF;

		this._indices = null;

		this._lastMVPMatrix = new Matrix4();
	}

	init(positions, count) {
		const blob = new Blob(['(', workerTemplate.toString(), ')(self)'], {
			type: 'application/javascript'
		});

		this._worker = new Worker(URL.createObjectURL(blob));

		this._worker.postMessage({ positions, count });

		this._indices = new Uint32Array(count);

		this._worker.onmessage = e => {
			if (e.data.init) {
				this._status = WORKER_STATUS.READY;
			} else {
				this._indices = e.data;
				this.onUpdate && this.onUpdate(this._indices, count);
				this._status = WORKER_STATUS.READY;
			}
		};
	}

	update(mvpMatrix) {
		if (this._status === WORKER_STATUS.READY) {
			const el1 = mvpMatrix.elements;
			const el2 = this._lastMVPMatrix.elements;

			const dot = el2[2] * el1[2] + el2[6] * el1[6] + el2[10] * el1[10];

			if (Math.abs(dot - 1) >= 0.01) {
				this._lastMVPMatrix.copy(mvpMatrix);
				this._status = WORKER_STATUS.BUSY;
				this._worker.postMessage({ mvpMatrix: el1, indices: this._indices }, [this._indices.buffer]);
			}
		}
	}

	dispose() {
		if (this._worker) {
			this._worker.terminate();
			this._worker = null;
		}

		this._status = WORKER_STATUS.OFF;
		this._indices = null;
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

	let counts;
	let starts;
	let zArray;
	let zIntArray;

	self.onmessage = e => {
		if (e.data.positions) {
			positions = e.data.positions;
			count = e.data.count;

			counts = new Uint32Array(256 * 256);
			starts = new Uint32Array(256 * 256);
			zArray = new Float32Array(count);
			zIntArray = new Int32Array(zArray.buffer);

			self.postMessage({ init: true });
		} else if (e.data.mvpMatrix) {
			const mvpMatrix = e.data.mvpMatrix;
			const indices = e.data.indices;

			let minZ = Infinity, maxZ = -Infinity;

			for (let i = 0; i < count; i++) {
				const z = -(
					mvpMatrix[2] * positions[3 * i + 0] +
					mvpMatrix[6] * positions[3 * i + 1] +
					mvpMatrix[10] * positions[3 * i + 2] +
					mvpMatrix[14]
				);

				// todo frustum culling

				zArray[i] = z;

				if (z > maxZ) maxZ = z;
				if (z < minZ) minZ = z;
			}

			counts.fill(0);

			const zInv = (256 * 256 - 1) / (maxZ - minZ);
			for (let i = 0; i < count; i++) {
				zIntArray[i] = ((zArray[i] - minZ) * zInv) | 0;
				counts[zIntArray[i]]++;
			}

			starts[0] = 0;
			for (let i = 1; i < 256 * 256; i++) {
				starts[i] = starts[i - 1] + counts[i - 1];
			}

			for (let i = 0; i < count; i++) {
				indices[starts[zIntArray[i]]++] = i;
			}

			self.postMessage(indices, [indices.buffer]);
		} else {
			console.error('positions or mvpMatrix is not defined!');
		}
	};
}

export { SplatIndexSortWorker };