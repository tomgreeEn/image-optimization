import { GetObjectCommand, PutObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { spawn } from 'child_process';
import { createWriteStream, createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import path from 'path';

const s3Client = new S3Client();
const SOURCE_BUCKET = process.env.sourceBucketName;
const THUMBNAIL_BUCKET = process.env.thumbnailBucketName;
const THUMBNAIL_CACHE_TTL = process.env.thumbnailCacheTTL || 'public, max-age=31536000'; // 1 year default
const TMP_DIR = '/tmp';

async function checkThumbnailExists(key) {
    try {
        await s3Client.send(new HeadObjectCommand({
            Bucket: THUMBNAIL_BUCKET,
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

async function getThumbnail(key) {
    const response = await s3Client.send(new GetObjectCommand({
        Bucket: THUMBNAIL_BUCKET,
        Key: `${key}.jpg`
    }));
    return response.Body.transformToByteArray();
}

async function generateThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
        // Use ffmpeg to extract first frame at 1 second
        const ffmpeg = spawn('ffmpeg', [
            '-i', videoPath,
            '-ss', '00:00:01',
            '-vframes', '1',
            '-f', 'image2',
            thumbnailPath
        ]);

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg process exited with code ${code}`));
            }
        });

        ffmpeg.stderr.on('data', (data) => {
            console.log(`ffmpeg stderr: ${data}`);
        });
    });
}

async function downloadVideo(key) {
    const localPath = path.join(TMP_DIR, path.basename(key));
    const writeStream = createWriteStream(localPath);

    const response = await s3Client.send(new GetObjectCommand({
        Bucket: SOURCE_BUCKET,
        Key: key
    }));

    await new Promise((resolve, reject) => {
        response.Body.pipe(writeStream)
            .on('error', reject)
            .on('finish', resolve);
    });

    return localPath;
}

async function uploadThumbnail(thumbnailPath, key) {
    const readStream = createReadStream(thumbnailPath);
    await s3Client.send(new PutObjectCommand({
        Bucket: THUMBNAIL_BUCKET,
        Key: `${key}.jpg`,
        Body: readStream,
        ContentType: 'image/jpeg',
        CacheControl: THUMBNAIL_CACHE_TTL
    }));
}

async function cleanup(...files) {
    await Promise.all(files.map(file => unlink(file).catch(() => {})));
}

export const handler = async (event) => {
    try {
        // Extract video path from the request
        if (!event.requestContext?.http?.path) {
            return { statusCode: 400, body: 'Invalid request: no path provided' };
        }

        // Remove leading slash and decode the path
        const videoPath = decodeURIComponent(event.requestContext.http.path.substring(1));

        // Check if thumbnail already exists
        const thumbnailExists = await checkThumbnailExists(videoPath);
        if (thumbnailExists) {
            console.log(`Thumbnail exists for ${videoPath}, returning from cache`);
            const thumbnail = await getThumbnail(videoPath);
            return {
                statusCode: 200,
                body: Buffer.from(thumbnail).toString('base64'),
                isBase64Encoded: true,
                headers: {
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': THUMBNAIL_CACHE_TTL
                }
            };
        }

        // Download video to temp directory
        console.log(`Downloading video: ${videoPath}`);
        const videoLocalPath = await downloadVideo(videoPath);
        const thumbnailLocalPath = `${videoLocalPath}.jpg`;

        // Generate thumbnail
        console.log('Generating thumbnail');
        await generateThumbnail(videoLocalPath, thumbnailLocalPath);

        // Upload thumbnail to S3
        console.log('Uploading thumbnail');
        await uploadThumbnail(thumbnailLocalPath, videoPath);

        // Read the generated thumbnail
        const thumbnailBuffer = await getThumbnail(videoPath);

        // Cleanup temporary files
        await cleanup(videoLocalPath, thumbnailLocalPath);

        // Return the thumbnail
        return {
            statusCode: 200,
            body: Buffer.from(thumbnailBuffer).toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': THUMBNAIL_CACHE_TTL
            }
        };

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