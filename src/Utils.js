import { nextPowerOfTwo, Texture2D, PIXEL_TYPE, PIXEL_FORMAT, TEXTURE_FILTER, Matrix3, Matrix4, Quaternion } from 't3d';

export const Utils = {

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