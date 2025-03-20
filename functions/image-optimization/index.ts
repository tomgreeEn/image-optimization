import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { PROJECT_BUCKETS, CONFIG } from '../../config/projects';

const s3Client = new S3Client({});

interface ImageParams {
  width?: number;
  height?: number;
  quality?: number;
  format?: string;
}

interface ImageRequest {
  path: string;
  params: ImageParams;
}

export const handler = async (event: any) => {
  try {
    const request = parseRequest(event);
    if (!request) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid request path or parameters' }),
      };
    }

    const { projectName, imagePath } = extractProjectAndPath(request.path);
    if (!projectName || !imagePath) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid path format. Expected: {project}/{path/to/image}' }),
      };
    }

    const bucketName = PROJECT_BUCKETS[projectName as keyof typeof PROJECT_BUCKETS];
    if (!bucketName) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: `Project '${projectName}' not found` }),
      };
    }

    const imageData = await getImageFromS3(bucketName, imagePath);
    if (!imageData) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: `Image not found: ${imagePath}` }),
      };
    }

    const transformedImage = await transformImage(imageData, request.params);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': `image/${request.params.format || 'jpeg'}`,
        'Cache-Control': CONFIG.CACHE_TTL,
      },
      body: transformedImage.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error('Error processing image:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error processing image' }),
    };
  }
};

function parseRequest(event: any): ImageRequest | null {
  if (!event.rawPath) return null;

  const params: ImageParams = {};
  if (event.queryStringParameters) {
    const { width, height, quality, format } = event.queryStringParameters;
    if (width) params.width = parseInt(width, 10);
    if (height) params.height = parseInt(height, 10);
    if (quality) params.quality = parseInt(quality, 10);
    if (format) params.format = format.toLowerCase();
  }

  return {
    path: event.rawPath.slice(1), // Remove leading slash
    params,
  };
}

function extractProjectAndPath(path: string): { projectName: string | null; imagePath: string | null } {
  const parts = path.split('/');
  if (parts.length < 2) {
    return { projectName: null, imagePath: null };
  }

  return {
    projectName: parts[0],
    imagePath: parts.slice(1).join('/'),
  };
}

async function getImageFromS3(bucket: string, key: string): Promise<Buffer | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await s3Client.send(command);
    if (!response.Body) return null;

    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    console.error('Error fetching image from S3:', error);
    return null;
  }
}

async function transformImage(buffer: Buffer, params: ImageParams): Promise<Buffer> {
  let image = sharp(buffer);

  // Resize if width or height is specified
  if (params.width || params.height) {
    image = image.resize(params.width, params.height, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // Convert format if specified and supported
  const format = params.format && CONFIG.SUPPORTED_FORMATS.includes(params.format)
    ? params.format
    : 'jpeg';

  // Set quality for lossy formats
  const quality = params.quality || CONFIG.DEFAULT_QUALITY;

  // Apply format and quality
  switch (format) {
    case 'jpeg':
      image = image.jpeg({ quality });
      break;
    case 'webp':
      image = image.webp({ quality });
      break;
    case 'avif':
      image = image.avif({ quality });
      break;
    case 'png':
      image = image.png();
      break;
  }

  return image.toBuffer();
} 