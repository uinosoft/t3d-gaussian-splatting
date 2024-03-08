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
				this._mixArray = e.data;
				const indices = new Uint32Array(this._mixArray.buffer);
				this.onUpdate && this.onUpdate(indices, count, 2);
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
				this._worker.postMessage({ mvpMatrix: el1, mixArray: this._mixArray }, [this._mixArray.buffer]);
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

	self.onmessage = e => {
		if (e.data.positions) {
			positions = e.data.positions;
			count = e.data.count;
			self.postMessage({ init: true });
		} else if (e.data.mvpMatrix) {
			const mvpMatrix = e.data.mvpMatrix;
			const mixArray = e.data.mixArray;

			const indices = new Uint32Array(mixArray.buffer);
			const floatMix = new Float32Array(mixArray.buffer);

			for (let i = 0; i < count; i++) {
				indices[2 * i] = i;
			}

			for (let i = 0; i < count; i++) {
				floatMix[2 * i + 1] = 10000 - (
					mvpMatrix[2] * positions[3 * i + 0] +
                    mvpMatrix[6] * positions[3 * i + 1] +
                    mvpMatrix[10] * positions[3 * i + 2]
				);
			}

			mixArray.sort();

			self.postMessage(mixArray, [mixArray.buffer]);
		} else {
			console.error('positions or mvpMatrix is not defined!');
		}
	};
}

export { SplatIndexSortWorker };