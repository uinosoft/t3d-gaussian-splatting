# T3D Gaussian Splatting

[![NPM Package][npm]][npm-url]

This is a [t3d-based](https://github.com/uinosoft/t3d.js) implementation of 3D Gaussian Splatting for Real-Time Radiance Field Rendering. Supports both `.ply` and `.splat` files.

Only supports WebGL2.

[Online Demo](https://uinosoft.github.io/t3d-gaussian-splatting/examples/)

## Usage

```javascript
import { SplatLoader, PLYLoader } from 't3d-gaussian-splatting';

// ...

// load splat file and add to scene
const splatLoader = new SplatLoader(); // ro new PlyLoader();
splatLoader.loadAsync('./path/to/xx.splat').then(({ buffer, node }) => {
    scene.add(node);
});

function loop() {
    // ...

    // call node.update in loop function
    node.update(camera, renderTargetWidth, renderTargetHeight);

    // ...
}
```

## Reference

- [3D Gaussian Splatting for Real-Time Radiance Field Rendering](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) SIGGRAPH 2023
- [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) - Three.js-based implementation of 3D Gaussian splatting
- [GaussianSplattingMesh](https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/core/src/Meshes/GaussianSplatting/gaussianSplattingMesh.ts) - Babylon-based GaussianSplattingMesh

## TODO

- Optimize sorting algorithm
- Boundings Computations

[npm]: https://img.shields.io/npm/v/t3d-gaussian-splatting
[npm-url]: https://www.npmjs.com/package/t3d-gaussian-splatting