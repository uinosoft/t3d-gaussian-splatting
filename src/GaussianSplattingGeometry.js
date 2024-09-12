import { Geometry, Attribute, Buffer, BUFFER_USAGE } from 't3d';

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

export { GaussianSplattingGeometry };