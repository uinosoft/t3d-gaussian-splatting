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

export { GaussianSplattingShader };