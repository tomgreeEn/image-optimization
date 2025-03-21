import { GetObjectCommand, PutObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { spawn } from 'child_process';
import { createWriteStream, createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { join, basename } from 'path';
import { readdir } from 'fs/promises';
import { promises as fsPromises } from 'fs';
import { Readable } from 'stream';
import { PROJECT_BUCKETS, CONFIG } from './config/projects';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// Types
interface ParsedRequest {
    projectName: string;
    videoPath: string;
}

type ProjectName = keyof typeof PROJECT_BUCKETS;

const s3Client = new S3Client({});
const THUMBNAIL_BUCKET = process.env.thumbnailBucketName;
const THUMBNAIL_CACHE_TTL = process.env.thumbnailCacheTTL || CONFIG.CACHE_TTL;

// Validate project name and get bucket
function getProjectBucket(projectName: string): string {
    if (isValidProject(projectName)) {
        return PROJECT_BUCKETS[projectName];
    }
    throw new Error(`Invalid project: ${projectName}`);
}

function isValidProject(projectName: string): projectName is ProjectName {
    return projectName in PROJECT_BUCKETS;
}

async function checkThumbnailExists(bucket: string, key: string): Promise<boolean> {
    try {
        await s3Client.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: `${key}.jpg`
        }));
        return true;
    } catch (error: any) {
        if (error.name === 'NotFound') {
            return false;
        }
        throw error;
    }
}

async function getThumbnail(bucket: string, key: string): Promise<Uint8Array> {
    const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: `${key}.jpg`
    }));
    return response.Body!.transformToByteArray();
}

async function getVideoFromS3(bucket: string, key: string): Promise<Uint8Array | null> {
    try {
        const response = await s3Client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        return await response.Body!.transformToByteArray();
    } catch (error: any) {
        // Handle specific S3 errors
        if (error.name === 'NoSuchKey' || error.name === 'NotFound') {
            return null;
        }
        if (error.name === 'NoSuchBucket') {
            console.error(`Bucket not found: ${bucket}`);
            throw new Error('Storage configuration error');
        }
        if (error.name === 'AccessDenied') {
            console.error(`Access denied to: ${bucket}/${key}`);
            throw new Error('Access denied to video storage');
        }
        console.error('S3 error:', error);
        throw error;
    }
}

async function generateThumbnail(videoBuffer: Uint8Array): Promise<Buffer> {
    const tempVideoPath = '/tmp/temp_video.mp4';
    const tempThumbnailPath = '/tmp/temp_thumbnail.jpg';

    try {
        // Write video buffer to temporary file
        await fsPromises.writeFile(tempVideoPath, Buffer.from(videoBuffer));

        return new Promise<Buffer>((resolve, reject) => {
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
                        const thumbnailBuffer = await fsPromises.readFile(tempThumbnailPath);
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
                        await fsPromises.unlink(tempVideoPath);
                        await fsPromises.unlink(tempThumbnailPath);
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
            await fsPromises.unlink(tempVideoPath);
            await fsPromises.unlink(tempThumbnailPath);
        } catch (cleanupError) {
            console.warn('Failed to cleanup temporary files:', cleanupError);
        }
        throw error;
    }
}

async function downloadVideo(bucket: string, key: string): Promise<string> {
    const localPath = join('/tmp', basename(key));
    const writeStream = createWriteStream(localPath);

    const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key
    }));

    if (!response.Body || !('pipe' in response.Body)) {
        throw new Error('Invalid response body from S3');
    }

    await new Promise<void>((resolve, reject) => {
        (response.Body as Readable).pipe(writeStream)
            .on('error', reject)
            .on('finish', resolve);
    });

    return localPath;
}

async function uploadThumbnail(thumbnailPath: string, bucket: string, key: string): Promise<void> {
    const readStream = createReadStream(thumbnailPath);
    await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${key}.jpg`,
        Body: readStream,
        ContentType: 'image/jpeg',
        CacheControl: process.env.thumbnailCacheTTL || 'public, max-age=31536000'
    }));
}

async function cleanup(...paths: string[]): Promise<void> {
    for (const path of paths) {
        try {
            await unlink(path);
        } catch (error) {
            console.warn(`Failed to cleanup ${path}:`, error);
        }
    }
}

// Extract project and path from the request
function parseRequest(event: APIGatewayProxyEvent): ParsedRequest | null {
    const path = event.pathParameters?.proxy || '';
    if (!path) return null;

    const parts = path.split('/');
    if (parts.length < 2) return null;

    const projectName = parts[0];
    const videoPath = parts.slice(1).join('/');

    if (!projectName || !videoPath) return null;

    return { projectName, videoPath };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        const requestInfo = parseRequest(event);
        if (!requestInfo) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Invalid path format' })
            };
        }

        const { projectName, videoPath } = requestInfo;
        const bucket = PROJECT_BUCKETS[projectName as keyof typeof PROJECT_BUCKETS];
        if (!bucket) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Project not found' })
            };
        }

        const videoData = await getVideoFromS3(bucket, videoPath);
        if (!videoData) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Video not found' })
            };
        }

        const thumbnail = await generateThumbnail(videoData);
        if (!thumbnail) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to generate thumbnail' })
            };
        }

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=31536000'
            },
            body: thumbnail.toString('base64')
        };
    } catch (error: any) {
        console.error('Error processing request:', error);
        
        // Handle known error types
        if (error.message === 'Storage configuration error') {
            return {
                statusCode: 503,
                body: JSON.stringify({ error: 'Service configuration error' })
            };
        }
        if (error.message === 'Access denied to video storage') {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'Access denied' })
            };
        }
        
        // Default error response
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
}; 