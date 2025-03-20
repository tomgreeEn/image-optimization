// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

export const handler = async (event) => {
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);

    // Log the incoming request details
    console.log('Incoming request headers:', JSON.stringify(event.headers, null, 2));
    console.log('Incoming request context:', JSON.stringify(event.requestContext, null, 2));
    console.log('Incoming request path:', event.requestContext.http.path);

    // Verify request comes from CloudFront
    if (!event.headers || event.headers['x-origin-verify'] !== 'cloudfront') {
        return sendError(403, 'Unauthorized', 'Request not from CloudFront');
    }

    // Validate and extract path
    const path = event.requestContext.http.path;
    if (!path || path === '/') {
        return sendError(400, 'Invalid request: no image path provided', null);
    }

    // Remove leading slash and split path
    const pathParts = path.substring(1).split('/');
    if (pathParts.length < 1) {
        return sendError(400, 'Invalid request: malformed image path', null);
    }

    // The last part might be operations
    let operations = {};
    let imagePath = pathParts.join('/');

    // Check if the last part contains operations
    if (pathParts[pathParts.length - 1].includes('=')) {
        const operationsString = pathParts.pop();
        imagePath = pathParts.join('/');
        try {
            operations = Object.fromEntries(operationsString.split(',').map(operation => operation.split('=')));
        } catch (error) {
            return sendError(400, 'Invalid operations format', error);
        }
    }

    // Validate image path exists
    if (!imagePath) {
        return sendError(400, 'Invalid request: no image path after operations', null);
    }

    var startTime = performance.now();
    // Downloading original image
    let originalImageBody;
    let contentType;
    try {
        const getOriginalImageCommand = new GetObjectCommand({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: imagePath });
        const getOriginalImageCommandOutput = await s3Client.send(getOriginalImageCommand);
        console.log(`Got response from S3 for ${imagePath}`);

        originalImageBody = getOriginalImageCommandOutput.Body.transformToByteArray();
        contentType = getOriginalImageCommandOutput.ContentType;
    } catch (error) {
        return sendError(404, `Image not found: ${imagePath}`, error);
    }
    let transformedImage = Sharp(await originalImageBody, { failOn: 'none', animated: true });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    // execute the requested operations 
    startTime = performance.now();
    try {
        // check if resizing is requested
        var resizingOptions = {};
        if (operations['width']) resizingOptions.width = parseInt(operations['width']);
        if (operations['height']) resizingOptions.height = parseInt(operations['height']);
        if (resizingOptions) transformedImage = transformedImage.resize(resizingOptions);
        // check if rotation is needed
        if (imageMetadata.orientation) transformedImage = transformedImage.rotate();
        // check if formatting is requested
        if (operations['format']) {
            var isLossy = false;
            switch (operations['format']) {
                case 'jpeg': contentType = 'image/jpeg'; isLossy = true; break;
                case 'gif': contentType = 'image/gif'; break;
                case 'webp': contentType = 'image/webp'; isLossy = true; break;
                case 'png': contentType = 'image/png'; break;
                case 'avif': contentType = 'image/avif'; isLossy = true; break;
                default: contentType = 'image/jpeg'; isLossy = true;
            }
            if (operations['quality'] && isLossy) {
                transformedImage = transformedImage.toFormat(operations['format'], {
                    quality: parseInt(operations['quality']),
                });
            } else transformedImage = transformedImage.toFormat(operations['format']);
        } else {
            /// If not format is precised, Sharp converts svg to png by default https://github.com/aws-samples/image-optimization/issues/48
            if (contentType === 'image/svg+xml') contentType = 'image/png';
        }
        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }
    let timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);

    // handle gracefully generated images bigger than a specified limit (e.g. Lambda output object limit)
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    // upload transformed image back to S3 if required in the architecture
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        startTime = performance.now();
        try {
            const putImageCommand = new PutObjectCommand({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: imagePath + '/' + Object.entries(operations).map(([k, v]) => `${k}=${v}`).join(','),
                ContentType: contentType,
                CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
            })
            await s3Client.send(putImageCommand);
            timingLog = timingLog + ',img-upload;dur=' + parseInt(performance.now() - startTime);
            // If the generated image file is too big, send a redirection to the generated image on S3, instead of serving it synchronously from Lambda. 
            if (imageTooBig) {
                return {
                    statusCode: 302,
                    headers: {
                        'Location': '/' + imagePath + '?' + Object.entries(operations).map(([k, v]) => `${k}=${v}`).join(','),
                        'Cache-Control': 'private,no-store',
                        'Server-Timing': timingLog
                    }
                };
            }
        } catch (error) {
            logError('Could not upload transformed image to S3', error);
        }
    }

    // Return error if the image is too big and a redirection to the generated image was not possible, else return transformed image
    if (imageTooBig) {
        return sendError(403, 'Requested transformed image is too big', '');
    } else return {
        statusCode: 200,
        body: transformedImage.toString('base64'),
        isBase64Encoded: true,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
            'Server-Timing': timingLog
        }
    };
};
function sendError(statusCode, body, error) {
    logError(body, error);
    return { 
        statusCode, 
        body: JSON.stringify({
            message: body || 'An error occurred',
            error: error?.message || error || 'Unknown error'
        })
    };
}

function logError(body, error) {
    console.error('APPLICATION ERROR:', body);
    console.error('Error details:', error);
}

