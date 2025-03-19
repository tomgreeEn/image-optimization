# AWS Image Optimization Service

This project implements a serverless image optimization service using AWS CDK, Lambda, and CloudFront. It allows for real-time image transformations including resizing, format conversion, and quality adjustments.

## Architecture

The service uses the following AWS components:
- AWS Lambda for image processing
- Amazon S3 for storage
- Amazon CloudFront for content delivery
- AWS CDK for infrastructure as code

## Features

- On-the-fly image transformations
- Supported operations:
  - Resize (width/height)
  - Format conversion (JPEG, PNG, WebP, AVIF, GIF)
  - Quality adjustment for lossy formats
  - Automatic image rotation based on EXIF data
- Caching at CloudFront edge locations
- Fallback to S3 for large images
- CloudFront Origin Access Control (OAC) for security

## Prerequisites

- Node.js 18.x or later
- AWS CLI configured with appropriate credentials
- AWS CDK CLI installed (`npm install -g aws-cdk`)

## Installation

1. Clone the repository:
   ```bash
   git clone [repository-url]
   cd image-optimization
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Deploy the stack:
   ```bash
   cdk deploy
   ```

## Usage

After deployment, you can transform images using URL parameters. Examples:

1. Resize an image:
   ```
   https://[cloudfront-domain]/path/to/image.jpg/width=300
   ```

2. Convert format and resize:
   ```
   https://[cloudfront-domain]/path/to/image.jpg/format=webp,width=300
   ```

3. Adjust quality:
   ```
   https://[cloudfront-domain]/path/to/image.jpg/format=jpeg,quality=80
   ```

## Environment Variables

The following environment variables can be configured:
- `originalImageBucketName`: S3 bucket for original images
- `transformedImageBucketName`: S3 bucket for transformed images
- `transformedImageCacheTTL`: Cache duration for transformed images
- `maxImageSize`: Maximum size limit for transformed images

## Security

- CloudFront Origin Access Control (OAC) is implemented
- S3 buckets are not publicly accessible
- Lambda function validates requests origin

## License

This project is licensed under the MIT License - see the LICENSE file for details. 