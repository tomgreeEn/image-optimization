import { GetObjectCommand, PutObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { spawn } from 'child_process';
import { createWriteStream, createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { readdir } from 'fs/promises';
import { join } from 'path';
import fs from 'fs';

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
    const bucketName = PROJECT_BUCKETS[projectName];
    if (!bucketName) {
        throw new Error(`Invalid project: ${projectName}`);
    }
    return bucketName;
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

async function getVideoFromS3(bucket, key) {
    try {
        const response = await s3Client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        return await response.Body.transformToByteArray();
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            return null;
        }
        throw error;
    }
}

async function generateThumbnail(videoBuffer) {
    const tempVideoPath = '/tmp/temp_video.mp4';
    const tempThumbnailPath = '/tmp/temp_thumbnail.jpg';

    try {
        // Write video buffer to temporary file
        await fs.promises.writeFile(tempVideoPath, Buffer.from(videoBuffer));

        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('/opt/bin/ffmpeg', [
                '-i', tempVideoPath,
                '-vf', 'thumbnail,scale=640:360:force_original_aspect_ratio=decrease',
                '-frames:v', '1',
                '-f', 'image2pipe',
                '-vcodec', 'mjpeg',
                tempThumbnailPath
            ]);

            let errorOutput = '';

            ffmpeg.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            ffmpeg.on('close', async (code) => {
                try {
                    if (code === 0) {
                        // Read the generated thumbnail
                        const thumbnailBuffer = await fs.promises.readFile(tempThumbnailPath);
                        resolve(thumbnailBuffer);
                    } else {
                        console.error('FFmpeg error:', errorOutput);
                        reject(new Error(`FFmpeg process exited with code ${code}`));
                    }
                } catch (error) {
                    reject(error);
                } finally {
                    // Clean up temporary files
                    try {
                        await fs.promises.unlink(tempVideoPath);
                        await fs.promises.unlink(tempThumbnailPath);
                    } catch (error) {
                        console.warn('Failed to cleanup temporary files:', error);
                    }
                }
            });

            ffmpeg.on('error', (err) => {
                console.error('FFmpeg spawn error:', err);
                reject(err);
            });
        });
    } catch (error) {
        // Clean up temporary files in case of error
        try {
            await fs.promises.unlink(tempVideoPath);
            await fs.promises.unlink(tempThumbnailPath);
        } catch (cleanupError) {
            console.warn('Failed to cleanup temporary files:', cleanupError);
        }
        throw error;
    }
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

// Extract project and path from the request
function parseRequest(event) {
    if (!event.rawPath) return null;

    const parts = event.rawPath.slice(1).split('/');
    if (parts.length < 2) return null;

    return {
        projectName: parts[0],
        videoPath: parts.slice(1).join('/')
    };
}

export const handler = async (event) => {
    try {
        // Parse the request path
        const path = event.rawPath.slice(1); // Remove leading slash
        const parts = path.split('/');
        
        if (parts.length < 1) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid path format. Expected: {project}/path/to/video' }),
            };
        }

        const projectName = parts[0];
        const videoPath = parts.slice(1).join('/'); // Keep the full path after project name
        const bucketName = PROJECT_BUCKETS[projectName];

        if (!bucketName) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: `Project '${projectName}' not found` }),
            };
        }

        // Check if thumbnail already exists
        const thumbnailKey = `thumbnails/${videoPath}.jpg`;
        const thumbnailExists = await checkThumbnailExists(bucketName, thumbnailKey);

        // Build redirect URL with query parameters
        const queryString = event.rawQueryString ? `?${event.rawQueryString}` : '';
        const redirectUrl = `https://image.boilingkettle.co/${projectName}/${thumbnailKey}${queryString}`;

        if (thumbnailExists) {
            // Thumbnail exists, redirect to image optimization endpoint
            return {
                statusCode: 302,
                headers: {
                    'Location': redirectUrl,
                    'Cache-Control': CONFIG.CACHE_TTL,
                },
            };
        }

        // Get video from S3
        const videoData = await getVideoFromS3(bucketName, videoPath);
        if (!videoData) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: `Video not found: ${videoPath}` }),
            };
        }

        // Generate thumbnail
        const thumbnailBuffer = await generateThumbnail(videoData);
        if (!thumbnailBuffer) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to generate thumbnail' }),
            };
        }

        // Upload thumbnail to S3
        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: thumbnailKey,
            Body: thumbnailBuffer,
            ContentType: 'image/jpeg',
        }));

        // Redirect to image optimization endpoint with query parameters
        return {
            statusCode: 302,
            headers: {
                'Location': redirectUrl,
                'Cache-Control': CONFIG.CACHE_TTL,
            },
        };
    } catch (error) {
        console.error('Error processing video:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Error processing video' }),
        };
    }
}; 