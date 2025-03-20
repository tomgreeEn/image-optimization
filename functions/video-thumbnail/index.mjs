import { GetObjectCommand, PutObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { spawn } from 'child_process';
import { createWriteStream, createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { readdir } from 'fs/promises';
import { join } from 'path';

// Define configuration directly in the function code since we can't import from outside
const PROJECT_BUCKETS = {
    'geerly': 'geerly-cms-content',
    'farmify': 'files-farmify',
    'sopilot': 'files-sopilot'
};

const CONFIG = {
    CACHE_TTL: 'public, max-age=31536000',
    MAX_IMAGE_SIZE: 10485760,
    SUPPORTED_FORMATS: ['jpeg', 'gif', 'webp', 'png', 'avif'],
    DEFAULT_QUALITY: 80
};

const s3Client = new S3Client({});
const THUMBNAIL_BUCKET = process.env.thumbnailBucketName;
const THUMBNAIL_CACHE_TTL = process.env.thumbnailCacheTTL || CONFIG.CACHE_TTL;

// Validate project name and get bucket
function getProjectBucket(projectName) {
    const bucket = PROJECT_BUCKETS[projectName.toLowerCase()];
    if (!bucket) {
        throw new Error(`Invalid project: ${projectName}`);
    }
    return bucket;
}

async function checkThumbnailExists(bucket, key) {
    try {
        await s3Client.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: `${key}.jpg`
        }));
        return true;
    } catch (error) {
        if (error.name === 'NotFound') {
            return false;
        }
        throw error;
    }
}

async function getThumbnail(bucket, key) {
    const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: `${key}.jpg`
    }));
    return response.Body.transformToByteArray();
}

async function generateThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('/opt/bin/ffmpeg', [
            '-i', videoPath,
            '-ss', '00:00:01',
            '-vframes', '1',
            '-f', 'image2',
            thumbnailPath
        ]);

        ffmpeg.on('error', (err) => {
            console.error('FFmpeg error:', err);
            reject(err);
        });

        ffmpeg.stderr.on('data', (data) => {
            console.debug(`ffmpeg stderr: ${data}`);
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg process exited with code ${code}`));
            }
        });
    });
}

async function downloadVideo(bucket, key) {
    const localPath = path.join('/tmp', path.basename(key));
    const writeStream = createWriteStream(localPath);

    const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key
    }));

    await new Promise((resolve, reject) => {
        response.Body.pipe(writeStream)
            .on('error', reject)
            .on('finish', resolve);
    });

    return localPath;
}

async function uploadThumbnail(thumbnailPath, bucket, key) {
    const readStream = createReadStream(thumbnailPath);
    await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${key}.jpg`,
        Body: readStream,
        ContentType: 'image/jpeg',
        CacheControl: process.env.thumbnailCacheTTL || 'public, max-age=31536000'
    }));
}

async function cleanup(...paths) {
    for (const path of paths) {
        try {
            await unlink(path);
        } catch (error) {
            console.warn(`Failed to cleanup ${path}:`, error);
        }
    }
}

export const handler = async (event) => {
    try {
        // Extract video path from the request
        if (!event.requestContext?.http?.path) {
            return { statusCode: 400, body: JSON.stringify({
                message: 'Invalid request',
                error: 'No path provided'
            })};
        }

        // Remove leading slash and decode the path
        const fullPath = decodeURIComponent(event.requestContext.http.path.substring(1));
        
        // Split path into project and video path
        const [projectName, ...pathParts] = fullPath.split('/');
        if (!projectName || pathParts.length === 0) {
            return { statusCode: 400, body: JSON.stringify({
                message: 'Invalid request',
                error: 'Path must be in format: /{project}/{video_path}'
            })};
        }

        try {
            // Get the bucket for this project
            const sourceBucket = getProjectBucket(projectName);
            const videoPath = pathParts.join('/');
            const thumbnailBucket = process.env.thumbnailBucketName;

            // Check if thumbnail already exists
            const thumbnailExists = await checkThumbnailExists(thumbnailBucket, `${projectName}/${videoPath}`);
            if (thumbnailExists) {
                console.log(`Thumbnail exists for ${projectName}/${videoPath}, returning from cache`);
                const thumbnail = await getThumbnail(thumbnailBucket, `${projectName}/${videoPath}`);
                return {
                    statusCode: 200,
                    body: Buffer.from(thumbnail).toString('base64'),
                    isBase64Encoded: true,
                    headers: {
                        'Content-Type': 'image/jpeg',
                        'Cache-Control': process.env.thumbnailCacheTTL || 'public, max-age=31536000'
                    }
                };
            }

            // Download video to temp directory
            console.log(`Downloading video from ${sourceBucket}/${videoPath}`);
            const videoLocalPath = await downloadVideo(sourceBucket, videoPath);
            const thumbnailLocalPath = `${videoLocalPath}.jpg`;

            // Generate thumbnail
            console.log('Generating thumbnail');
            await generateThumbnail(videoLocalPath, thumbnailLocalPath);

            // Upload thumbnail to S3 with project prefix
            console.log('Uploading thumbnail');
            await uploadThumbnail(thumbnailLocalPath, thumbnailBucket, `${projectName}/${videoPath}`);

            // Read the generated thumbnail
            const thumbnailBuffer = await getThumbnail(thumbnailBucket, `${projectName}/${videoPath}`);

            // Cleanup temporary files
            await cleanup(videoLocalPath, thumbnailLocalPath);

            // Return the thumbnail
            return {
                statusCode: 200,
                body: Buffer.from(thumbnailBuffer).toString('base64'),
                isBase64Encoded: true,
                headers: {
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': process.env.thumbnailCacheTTL || 'public, max-age=31536000'
                }
            };

        } catch (error) {
            if (error.message.startsWith('Invalid project:')) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        message: 'Invalid project',
                        error: error.message
                    })
                };
            }
            throw error;
        }

    } catch (error) {
        console.error('Error processing request:', error);
        return {
            statusCode: error.statusCode || 500,
            body: JSON.stringify({
                message: 'Error generating thumbnail',
                error: error.message
            })
        };
    }
}; 