import { Loader, FileLoader } from 't3d';
import { GaussianSplattingMesh } from './GaussianSplattingMesh.js';

class SplatLoader extends Loader {

	constructor(manager) {
		super(manager);
	}

	load(url, onLoad, onProgress, onError) {
		const scope = this;

		const loader = new FileLoader(this.manager);
		loader.setResponseType('arraybuffer');
		loader.setRequestHeader(this.requestHeader);
		loader.setPath(this.path);
		loader.setWithCredentials(this.withCredentials);

		loader.load(url, function(buffer) {
			if (onLoad !== undefined) {
				onLoad(scope.parse(buffer));
			}
		}, onProgress, onError);
	}

	parse(buffer) {
		const node = new GaussianSplattingMesh(buffer);
		return { buffer, node };
	}

}

export { SplatLoader };