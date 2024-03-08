import { ShaderMaterial } from 't3d';
import { GaussianSplattingShader } from './GaussianSplattingShader.js';
import { Utils } from './Utils.js';

class GaussianSplattingMaterial extends ShaderMaterial {

	constructor() {
		super(GaussianSplattingShader);

		this.transparent = true;
		this.depthTest = true;
		this.depthWrite = false;
		// this.side = DRAW_SIDE.DOUBLE;
	}

	setTextures(internalData) {
		const uniforms = this.uniforms;

		uniforms.covariancesTexture = Utils.generateCovariancesTexture(internalData);
		uniforms.centersTexture = Utils.generateCentersTexture(internalData);
		uniforms.colorsTexture = Utils.generateColorsTexture(internalData);
	}

	updateUniforms(camera, width, height) {
		const uniforms = this.uniforms;

		uniforms.basisViewport[0] = 1.0 / width;
		uniforms.basisViewport[1] = 1.0 / height;

		uniforms.focal[0] = camera.projectionMatrix.elements[0] * width * 0.45;
		uniforms.focal[1] = camera.projectionMatrix.elements[5] * height * 0.45;
	}

}

export { GaussianSplattingMaterial };