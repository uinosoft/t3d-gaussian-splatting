import { Quaternion } from 't3d';
import { SplatLoader } from './SplatLoader.js';

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

export { PLYLoader };