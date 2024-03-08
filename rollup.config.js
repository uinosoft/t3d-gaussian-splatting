function header() {
	return {
		renderChunk(code) {
			return '// t3d-gaussian-splatting\n' + code;
		}
	};
}

export default [
	{
		input: 'src/index.js',
		plugins: [
			header()
		],
		external: ['t3d'],
		output: [
			{
				format: 'esm',
				file: 'build/t3d.gaussiansplatting.js'
			}
		]
	}
];