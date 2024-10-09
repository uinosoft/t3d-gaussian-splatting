// t3d-gaussian-splatting
import { Quaternion, Matrix3, Matrix4, Texture2D, PIXEL_TYPE, PIXEL_FORMAT, TEXTURE_FILTER, nextPowerOfTwo, ShaderMaterial, Geometry, Attribute, Buffer, BUFFER_USAGE, Mesh, Loader, FileLoader } from 't3d';

const GaussianSplattingShader = {
	name: 'gaussian_splatting',

	defines: {},

	uniforms: {
		'covariancesTexture': null,
		'centersTexture': null,
		'colorsTexture': null,
		'focal': [0, 0],
		'basisViewport': [0, 0]
	},

	// Contains the code to project 3D covariance to 2D and from there calculate the quad (using the eigen vectors of the
	// 2D covariance) that is ultimately rasterized
	vertexShader: `
        #include <common_vert>

        attribute uint splatIndex;

        uniform sampler2D centersTexture;
        uniform sampler2D colorsTexture;
        uniform sampler2D covariancesTexture;
		uniform vec2 covariancesTextureSize;
        uniform vec2 centersColorsTextureSize;

        uniform vec2 focal;
        uniform vec2 basisViewport;

        varying vec4 vColor;
        varying vec2 vPosition;

        vec2 getDataUV(in int stride, in int offset, in vec2 dimensions) {
            vec2 samplerUV = vec2(0.0, 0.0);
            float d = float(splatIndex * uint(stride) + uint(offset)) / dimensions.x;
            samplerUV.y = float(floor(d)) / dimensions.y;
            samplerUV.x = fract(d);
            return samplerUV;
        }

        const float sqrt8 = sqrt(8.0);

        #include <logdepthbuf_pars_vert>

        void main () {
            vec2 centersTextureSize = vec2(textureSize(centersTexture, 0));
            vec4 sampledCenter = texture(centersTexture, getDataUV(1, 0, centersTextureSize));
            vec3 splatCenter = sampledCenter.gba;

			mat4 transformModelViewMatrix = u_View * u_Model;

            vec4 viewCenter = transformModelViewMatrix * vec4(splatCenter, 1.0);
            vec4 clipCenter = u_Projection * viewCenter;

            float clip = 1.2 * clipCenter.w;
            if (clipCenter.z < -clip || clipCenter.x < -clip || clipCenter.x > clip || clipCenter.y < -clip || clipCenter.y > clip) {
                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                return;
            }

            vPosition = a_Position.xy;
            vec2 colorsTextureSize = vec2(textureSize(colorsTexture, 0));
            vColor = texture(colorsTexture, getDataUV(1, 0, colorsTextureSize));

            vec2 covariancesTextureSize = vec2(textureSize(covariancesTexture, 0));
            vec2 sampledCovarianceA = texture(covariancesTexture, getDataUV(3, 0, covariancesTextureSize)).rg;
            vec2 sampledCovarianceB = texture(covariancesTexture, getDataUV(3, 1, covariancesTextureSize)).rg;
            vec2 sampledCovarianceC = texture(covariancesTexture, getDataUV(3, 2, covariancesTextureSize)).rg;

            vec3 cov3D_M11_M12_M13 = vec3(sampledCovarianceA.rg, sampledCovarianceB.r);
            vec3 cov3D_M22_M23_M33 = vec3(sampledCovarianceB.g, sampledCovarianceC.rg);

            // Construct the 3D covariance matrix
            mat3 Vrk = mat3(
                cov3D_M11_M12_M13.x, cov3D_M11_M12_M13.y, cov3D_M11_M12_M13.z,
                cov3D_M11_M12_M13.y, cov3D_M22_M23_M33.x, cov3D_M22_M23_M33.y,
                cov3D_M11_M12_M13.z, cov3D_M22_M23_M33.y, cov3D_M22_M23_M33.z
            );

            // Construct the Jacobian of the affine approximation of the projection matrix. It will be used to transform the
            // 3D covariance matrix instead of using the actual projection matrix because that transformation would
            // require a non-linear component (perspective division) which would yield a non-gaussian result. (This assumes
            // the current projection is a perspective projection).
            float s = 1.0 / (viewCenter.z * viewCenter.z);
            mat3 J = mat3(
                focal.x / viewCenter.z, 0., -(focal.x * viewCenter.x) * s,
                0., focal.y / viewCenter.z, -(focal.y * viewCenter.y) * s,
                0., 0., 0.
            );

			mat3 invy = mat3(-1, 0, 0, 0, -1, 0, 0, 0, 1);

            // Concatenate the projection approximation with the model-view transformation
            mat3 W = transpose(mat3(transformModelViewMatrix));
            mat3 T = invy * W * J;

            // Transform the 3D covariance matrix (Vrk) to compute the 2D covariance matrix
            mat3 cov2Dm = transpose(T) * Vrk * T;
            
            // Apply low-pass filter: every Gaussian should be at least
            // one pixel wide/high. Discard 3rd row and column.
            cov2Dm[0][0] += 0.3;
            cov2Dm[1][1] += 0.3;

            // We are interested in the upper-left 2x2 portion of the projected 3D covariance matrix because
            // we only care about the X and Y values. We want the X-diagonal, cov2Dm[0][0],
            // the Y-diagonal, cov2Dm[1][1], and the correlation between the two cov2Dm[0][1]. We don't
            // need cov2Dm[1][0] because it is a symetric matrix.
            vec3 cov2Dv = vec3(cov2Dm[0][0], cov2Dm[0][1], cov2Dm[1][1]);

            // We now need to solve for the eigen-values and eigen vectors of the 2D covariance matrix
            // so that we can determine the 2D basis for the splat. This is done using the method described
            // here: https://people.math.harvard.edu/~knill/teaching/math21b2004/exhibits/2dmatrices/index.html
            // After calculating the eigen-values and eigen-vectors, we calculate the basis for rendering the splat
            // by normalizing the eigen-vectors and then multiplying them by (sqrt(8) * eigen-value), which is
            // equal to scaling them by sqrt(8) standard deviations.
            //
            // This is a different approach than in the original work at INRIA. In that work they compute the
            // max extents of the projected splat in screen space to form a screen-space aligned bounding rectangle
            // which forms the geometry that is actually rasterized. The dimensions of that bounding box are 3.0
            // times the maximum eigen-value, or 3 standard deviations. They then use the inverse 2D covariance
            // matrix (called 'conic') in the CUDA rendering thread to determine fragment opacity by calculating the
            // full gaussian: exp(-0.5 * (X - mean) * conic * (X - mean)) * splat opacity
            float a = cov2Dv.x;
            float d = cov2Dv.z;
            float b = cov2Dv.y;
            float D = a * d - b * b;
            float trace = a + d;
            float traceOver2 = 0.5 * trace;
            float term2 = sqrt(max(0.1f, traceOver2 * traceOver2 - D));
            float eigenValue1 = traceOver2 + term2;
            float eigenValue2 = traceOver2 - term2;

            float transparentAdjust = step(1.0 / 255.0, vColor.a);
            eigenValue2 = eigenValue2 * transparentAdjust; // hide splat if alpha is zero

            vec2 eigenVector1 = normalize(vec2(b, eigenValue1 - a));
            // since the eigen vectors are orthogonal, we derive the second one from the first
            vec2 eigenVector2 = vec2(eigenVector1.y, -eigenVector1.x);

            // We use sqrt(8) standard deviations instead of 3 to eliminate more of the splat with a very low opacity.
            vec2 basisVector1 = eigenVector1 * sqrt8 * sqrt(eigenValue1);
            vec2 basisVector2 = eigenVector2 * sqrt8 * sqrt(eigenValue2);

            vec2 ndcOffset = vec2(vPosition.x * basisVector1 + vPosition.y * basisVector2) * basisViewport * 2.0;

            // Similarly scale the position data we send to the fragment shader
            vPosition *= sqrt8;

            gl_Position = vec4(clipCenter.xy + ndcOffset * clipCenter.w, clipCenter.zw);

            #include <logdepthbuf_vert>
        }
	`,

	fragmentShader: `
		#include <common_frag>
        #include <logdepthbuf_pars_frag>

        uniform float u_AlphaTest;

		varying vec4 vColor;
		varying vec2 vPosition;

		void main () {
            #include <logdepthbuf_frag>

			// Compute the positional squared distance from the center of the splat to the current fragment.
            float A = dot(vPosition, vPosition);
            // Since the positional data in vPosition has been scaled by sqrt(8), the squared result will be
            // scaled by a factor of 8. If the squared result is larger than 8, it means it is outside the ellipse
            // defined by the rectangle formed by vPosition. It also means it's farther
            // away than sqrt(8) standard deviations from the mean.
            if (A > 8.0) discard;

            if (vColor.a < u_AlphaTest) discard;

            vec3 color = vColor.rgb;

            // Since the rendered splat is scaled by sqrt(8), the inverse covariance matrix that is part of
            // the gaussian formula becomes the identity matrix. We're then left with (X - mean) * (X - mean),
            // and since 'mean' is zero, we have X * X, which is the same as A:
            float opacity = exp(-0.5 * A) * vColor.a;

            gl_FragColor = vec4(color.rgb * u_Color, opacity * u_Opacity);
		}
	`
};

const Utils = {

	convertSplatToInternalData: buffer => {
		const f_buffer = new Float32Array(buffer);
		const u_buffer = new Uint8Array(buffer);

		const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
		const vertexCount = u_buffer.length / rowLength;

		const positions = new Float32Array(3 * vertexCount);
		const rotations = new Float32Array(4 * vertexCount);
		const scales = new Float32Array(3 * vertexCount);
		const colors = new Uint8Array(4 * vertexCount);

		for (let i = 0; i < vertexCount; i++) {
			positions[3 * i + 0] = -f_buffer[8 * i + 0];
			positions[3 * i + 1] = -f_buffer[8 * i + 1];
			positions[3 * i + 2] = f_buffer[8 * i + 2];

			rotations[4 * i + 0] = (u_buffer[32 * i + 28 + 0] - 128) / 128;
			rotations[4 * i + 1] = (u_buffer[32 * i + 28 + 1] - 128) / 128;
			rotations[4 * i + 2] = (u_buffer[32 * i + 28 + 2] - 128) / 128;
			rotations[4 * i + 3] = (u_buffer[32 * i + 28 + 3] - 128) / 128;

			scales[3 * i + 0] = f_buffer[8 * i + 3 + 0];
			scales[3 * i + 1] = f_buffer[8 * i + 3 + 1];
			scales[3 * i + 2] = f_buffer[8 * i + 3 + 2];

			colors[4 * i + 0] = u_buffer[32 * i + 24 + 0];
			colors[4 * i + 1] = u_buffer[32 * i + 24 + 1];
			colors[4 * i + 2] = u_buffer[32 * i + 24 + 2];
			colors[4 * i + 3] = u_buffer[32 * i + 24 + 3];
		}

		return {
			vertexCount,
			positions,
			rotations,
			scales,
			colors
		};
	},

	generateCentersTexture: internalData => {
		const { positions, vertexCount } = internalData;

		const size = Utils.getTextureSize(vertexCount);

		const imageData = new Float32Array(4 * size * size);

		for (let i = 0; i < vertexCount; i++) {
			imageData[i * 4 + 0] = 0;
			imageData[i * 4 + 1] = positions[3 * i + 0];
			imageData[i * 4 + 2] = positions[3 * i + 1];
			imageData[i * 4 + 3] = positions[3 * i + 2];
		}

		const texture = new Texture2D();
		texture.image = { data: imageData, width: size, height: size };
		texture.type = PIXEL_TYPE.FLOAT;
		texture.format = PIXEL_FORMAT.RGBA;
		texture.magFilter = TEXTURE_FILTER.NEAREST;
		texture.minFilter = TEXTURE_FILTER.NEAREST;
		texture.generateMipmaps = false;
		texture.flipY = false;
		texture.version++;

		return texture;
	},

	generateCovariancesTexture: internalData => {
		const { rotations, scales, vertexCount } = internalData;

		const size = Utils.getTextureSize(vertexCount * 3);

		const imageData = new Float32Array(2 * size * size);

		for (let i = 0; i < vertexCount; i++) {
			_mat3_1.set(
				scales[i * 3 + 0], 0, 0,
				0, scales[i * 3 + 1], 0,
				0, 0, scales[i * 3 + 2]
			);
			_quat_1.set(
				rotations[i * 4 + 1],
				rotations[i * 4 + 2],
				rotations[i * 4 + 3],
				rotations[i * 4 + 0]
			);
			_mat4_1.makeRotationFromQuaternion(_quat_1);
			_mat3_2.setFromMatrix4(_mat4_1);

			_mat3_2.multiply(_mat3_1);
			_mat3_1.copy(_mat3_2).transpose().premultiply(_mat3_2);

			imageData[i * 6 + 0] = _mat3_1.elements[0];
			imageData[i * 6 + 1] = _mat3_1.elements[3];
			imageData[i * 6 + 2] = _mat3_1.elements[6];
			imageData[i * 6 + 3] = _mat3_1.elements[4];
			imageData[i * 6 + 4] = _mat3_1.elements[7];
			imageData[i * 6 + 5] = _mat3_1.elements[8];
		}

		const texture = new Texture2D();
		texture.image = { data: imageData, width: size, height: size };
		texture.type = PIXEL_TYPE.FLOAT;
		texture.format = PIXEL_FORMAT.RG;
		texture.internalformat = PIXEL_FORMAT.RG32F;
		texture.magFilter = TEXTURE_FILTER.NEAREST;
		texture.minFilter = TEXTURE_FILTER.NEAREST;
		texture.generateMipmaps = false;
		texture.flipY = false;
		texture.version++;

		return texture;
	},

	generateColorsTexture: internalData => {
		const { colors, vertexCount } = internalData;

		const size = Utils.getTextureSize(vertexCount);

		const imageData = new Uint8Array(4 * size * size);
		imageData.set(colors);

		const texture = new Texture2D();
		texture.image = { data: imageData, width: size, height: size };
		texture.type = PIXEL_TYPE.UNSIGNED_BYTE;
		texture.format = PIXEL_FORMAT.RGBA;
		texture.magFilter = TEXTURE_FILTER.NEAREST;
		texture.minFilter = TEXTURE_FILTER.NEAREST;
		texture.generateMipmaps = false;
		texture.flipY = false;
		texture.version++;

		return texture;
	},

	getTextureSize: vertexCount => {
		let size = Math.sqrt(vertexCount);
		size = nextPowerOfTwo(Math.ceil(size));
		return Math.max(4, size);
	}
};

const _quat_1 = new Quaternion();
const _mat3_1 = new Matrix3();
const _mat3_2 = new Matrix3();
const _mat4_1 = new Matrix4();

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

/**
 * GaussianSplattingGeometry will be used to render the splats. The geometry is instanced and is made up of
 * vertices for a single quad as well as an attribute buffer for the splat indexes
 */
class GaussianSplattingGeometry extends Geometry {

	constructor(maxSplatCount) {
		super();

		this.setIndex(new Attribute(new Buffer(new Uint16Array([0, 1, 2, 0, 2, 3]), 1), 1));

		const positionArray = [-1.0, -1.0, 0.0, -1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, -1.0, 0.0];
		const positionBuffer = new Buffer(new Float32Array(positionArray), 3);
		this.addAttribute('a_Position', new Attribute(positionBuffer));

		const splatIndexArray = new Uint32Array(maxSplatCount);
		const splatIndexBuffer = new Buffer(splatIndexArray, 1);
		splatIndexBuffer.usage = BUFFER_USAGE.DYNAMIC_DRAW;
		const splatIndexAttribute = new Attribute(splatIndexBuffer);
		splatIndexAttribute.divisor = 1;
		this.addAttribute('splatIndex', splatIndexAttribute);
	}

	updateSplatIndices(array, count) {
		const splatIndexBuffer = this.attributes.splatIndex.buffer;
		const splatIndexArray = splatIndexBuffer.array;

		for (let i = 0; i < count; i++) {
			splatIndexArray[i] = array[i];
		}

		splatIndexBuffer.version++;

		this.instanceCount = count;
	}

}

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

class PLYLoader extends SplatLoader {

	constructor(manager) {
		super(manager);
	}

	parse(buffer) {
		const splatBuffer = this.convertPLYToSplat(buffer);
		return super.parse(splatBuffer);
	}

	/**
     * Code from https://github.com/dylanebert/gsplat.js/blob/main/src/loaders/PLYLoader.ts Under MIT license
     * Converts a .ply data array buffer to splat
     * @param data the .ply data to load
     * @return the splat buffer
     */
	convertPLYToSplat(data) {
		const ubuf = new Uint8Array(data);
		const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10)); // 10kb

		const headerEnd = 'end_header\n';
		const headerEndIndex = header.indexOf(headerEnd);
		if (headerEndIndex < 0 || !header) {
			return data;
		}
		const matchResult = /element vertex (\d+)\n/.exec(header);
		const vertexCount = matchResult ? parseInt(matchResult[1]) : 0; // Provide a default value if matchResult is falsy

		let rowOffset = 0;
		const offsets = {
			double: 8,
			int: 4,
			uint: 4,
			float: 4,
			short: 2,
			ushort: 2,
			uchar: 1
		};

		const properties = [];
		const filtered = header
			.slice(0, headerEndIndex)
			.split('\n')
			.filter(k => k.startsWith('property '));
		for (const prop of filtered) {
			const [, type, name] = prop.split(' ');
			properties.push({ name, type, offset: rowOffset });
			if (!offsets[type]) throw new Error(`Unsupported property type: ${type}`);
			rowOffset += offsets[type];
		}

		const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
		const SH_C0 = 0.28209479177387814;

		const dataView = new DataView(data, headerEndIndex + headerEnd.length);
		const buffer = new ArrayBuffer(rowLength * vertexCount);
		const q = new Quaternion();

		for (let i = 0; i < vertexCount; i++) {
			const position = new Float32Array(buffer, i * rowLength, 3);
			const scale = new Float32Array(buffer, i * rowLength + 12, 3);
			const rgba = new Uint8ClampedArray(buffer, i * rowLength + 24, 4);
			const rot = new Uint8ClampedArray(buffer, i * rowLength + 28, 4);

			let r0 = 255;
			let r1 = 0;
			let r2 = 0;
			let r3 = 0;

			for (let propertyIndex = 0; propertyIndex < properties.length; propertyIndex++) {
				const property = properties[propertyIndex];
				let value;
				switch (property.type) {
					case 'float':
						value = dataView.getFloat32(property.offset + i * rowOffset, true);
						break;
					case 'int':
						value = dataView.getInt32(property.offset + i * rowOffset, true);
						break;
					default:
						throw new Error(`Unsupported property type: ${property.type}`);
				}

				switch (property.name) {
					case 'x':
						position[0] = value;
						break;
					case 'y':
						position[1] = value;
						break;
					case 'z':
						position[2] = value;
						break;
					case 'scale_0':
						scale[0] = Math.exp(value);
						break;
					case 'scale_1':
						scale[1] = Math.exp(value);
						break;
					case 'scale_2':
						scale[2] = Math.exp(value);
						break;
					case 'red':
						rgba[0] = value;
						break;
					case 'green':
						rgba[1] = value;
						break;
					case 'blue':
						rgba[2] = value;
						break;
					case 'f_dc_0':
						rgba[0] = (0.5 + SH_C0 * value) * 255;
						break;
					case 'f_dc_1':
						rgba[1] = (0.5 + SH_C0 * value) * 255;
						break;
					case 'f_dc_2':
						rgba[2] = (0.5 + SH_C0 * value) * 255;
						break;
					case 'f_dc_3':
						rgba[3] = (0.5 + SH_C0 * value) * 255;
						break;
					case 'opacity':
						rgba[3] = (1 / (1 + Math.exp(-value))) * 255;
						break;
					case 'rot_0':
						r0 = value;
						break;
					case 'rot_1':
						r1 = value;
						break;
					case 'rot_2':
						r2 = value;
						break;
					case 'rot_3':
						r3 = value;
						break;
				}
			}

			q.set(r1, r2, r3, r0);
			q.normalize();
			rot[0] = q.w * 128 + 128;
			rot[1] = q.x * 128 + 128;
			rot[2] = q.y * 128 + 128;
			rot[3] = q.z * 128 + 128;
		}

		return buffer;
	}

}

export { GaussianSplattingMesh, PLYLoader, SplatLoader };
