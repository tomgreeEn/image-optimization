import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
//import sharp from 'sharp';
import { PROJECT_BUCKETS, CONFIG } from './config/projects';
const sharp = require('sharp');

const s3Client = new S3Client({});

interface ParsedRequest {
  projectName: string;
  imagePath: string;
  width?: number;
  height?: number;
  quality?: number;
}

function parseRequest(event: any): ParsedRequest | null {
  try {
    const path = event.pathParameters?.proxy || '';
    if (!path) return null;

    const parts = path.split('/');
    if (parts.length < 2) return null;

    const projectName = parts[0];
    const imagePath = parts.slice(1).join('/');

    if (!projectName || !imagePath) return null;

    // Parse query parameters
    const queryParams = event.queryStringParameters || {};
    const width = queryParams.w ? parseInt(queryParams.w) : undefined;
    const height = queryParams.h ? parseInt(queryParams.h) : undefined;
    const quality = queryParams.q ? parseInt(queryParams.q) : undefined;

    return { projectName, imagePath, width, height, quality };
  } catch (error) {
    console.error('Error parsing request:', error);
    return null;
  }
}

async function getImageFromS3(bucket: string, key: string): Promise<Buffer | null> {
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
    
    if (!response.Body) return null;
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error: any) {
    // Handle specific S3 errors
    if (error.name === 'NoSuchKey' || error.name === 'NotFound') {
      return null;
    }
    if (error.name === 'NoSuchBucket') {
      console.error(`Bucket not found: ${bucket}`);
      throw new Error('STORAGE_CONFIG_ERROR');
    }
    if (error.name === 'AccessDenied') {
      console.error(`Access denied to: ${bucket}/${key}`);
      throw new Error('ACCESS_DENIED');
    }
    console.error('S3 error:', error);
    throw error;
  }
}

async function optimizeImage(imageBuffer: Buffer, width?: number, height?: number, quality?: number): Promise<Buffer> {
  try {
    let transform = sharp(imageBuffer);
    
    // Get image metadata
    const metadata = await transform.metadata();
    
    // Validate image type
    if (!metadata.format || !['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) {
      throw new Error('UNSUPPORTED_FORMAT');
    }

    // Resize if dimensions provided
    if (width || height) {
      transform = transform.resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    // Set quality (default to 80 if not specified)
    const outputQuality = quality || 80;
    if (outputQuality < 1 || outputQuality > 100) {
      throw new Error('INVALID_QUALITY');
    }

    // Convert to appropriate format with quality setting
    switch (metadata.format) {
      case 'jpeg':
        return await transform.jpeg({ quality: outputQuality }).toBuffer();
      case 'png':
        return await transform.png({ quality: outputQuality }).toBuffer();
      case 'webp':
        return await transform.webp({ quality: outputQuality }).toBuffer();
      case 'gif':
        return await transform.gif().toBuffer();
      default:
        throw new Error('UNSUPPORTED_FORMAT');
    }
  } catch (error: any) {
    if (error.message === 'UNSUPPORTED_FORMAT' || error.message === 'INVALID_QUALITY') {
      throw error;
    }
    console.error('Image optimization error:', error);
    throw new Error('OPTIMIZATION_FAILED');
  }
}

export const handler = async (event: any) => {
  try {
    // Validate origin
    const headers = event.headers || {};
    if (headers['x-origin-verify'] !== 'cloudfront') {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Access denied' })
      };
    }

    // Parse request
    const requestInfo = parseRequest(event);
    if (!requestInfo) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid request format' })
      };
    }

    const { projectName, imagePath, width, height, quality } = requestInfo;

    // Validate project
    const bucket = PROJECT_BUCKETS[projectName as keyof typeof PROJECT_BUCKETS];
    if (!bucket) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Project not found' })
      };
    }

    // Get image from S3
    const imageBuffer = await getImageFromS3(bucket, imagePath);
    if (!imageBuffer) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Image not found' })
      };
    }

    // Optimize image
    const optimizedImage = await optimizeImage(imageBuffer, width, height, quality);

    // Return optimized image
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': process.env.transformedImageCacheTTL || 'public, max-age=31536000'
      },
      body: optimizedImage.toString('base64'),
      isBase64Encoded: true
    };

  } catch (error: any) {
    console.error('Error processing request:', error);

    // Handle known error types
    switch (error.message) {
      case 'STORAGE_CONFIG_ERROR':
        return {
          statusCode: 503,
          body: JSON.stringify({ error: 'Storage configuration error' })
        };
      case 'ACCESS_DENIED':
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'Access denied to image storage' })
        };
      case 'UNSUPPORTED_FORMAT':
        return {
          statusCode: 415,
          body: JSON.stringify({ error: 'Unsupported image format' })
        };
      case 'INVALID_QUALITY':
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid quality parameter (must be between 1 and 100)' })
        };
      case 'OPTIMIZATION_FAILED':
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Failed to optimize image' })
        };
      default:
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Internal server error' })
        };
    }
  }
}; 