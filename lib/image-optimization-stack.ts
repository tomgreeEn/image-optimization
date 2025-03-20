// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Duration, Token } from 'aws-cdk-lib';
import { FFmpegLayer } from './ffmpeg-layer';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

// Environment variables

const ORIGINAL_IMAGE_BUCKET = process.env.ORIGINAL_IMAGE_BUCKET || 'geerly-cms-content';
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.TRANSFORMED_IMAGE_CACHE_TTL || 'public, max-age=31536000';
const MAX_IMAGE_SIZE = process.env.MAX_IMAGE_SIZE || '10485760';
const THUMBNAIL_CACHE_TTL = process.env.THUMBNAIL_CACHE_TTL || 'public, max-age=31536000';

// Certificate ARNs
const GEERLY_CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:656044625343:certificate/b271caf9-020e-4de3-9ad4-b24e596e8b00';
const BOILINGKETTLE_CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:656044625343:certificate/90d4ad1c-19c1-4c6a-84a7-7b1812831b91';

export class ImgTransformationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket for transformed images
    const s3ThumbnailBucket = new s3.Bucket(this, 'S3ThumbnailBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
        lifecycleRules: [
          {
          enabled: true,
          expiration: Duration.days(30),
        },
      ],
    });

    // Create ffmpeg layer
    const ffmpegLayer = new FFmpegLayer(this, 'FfmpegLayer');

    // Create Lambda for image processing
    var lambdaProps = {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      memorySize: 1024,
      timeout: Duration.seconds(30),
      environment: {
        originalImageBucketName: ORIGINAL_IMAGE_BUCKET,
        transformedImageBucketName: s3ThumbnailBucket.bucketName,
        transformedImageCacheTTL: TRANSFORMED_IMAGE_CACHE_TTL,
        maxImageSize: MAX_IMAGE_SIZE,
      },
      logRetention: logs.RetentionDays.ONE_DAY,
      layers: [ffmpegLayer],
    };

    const imageFunction = new lambda.Function(this, 'ImageFunction', {
      ...lambdaProps,
      functionName: 'geerly-image-optimization',
      code: lambda.Code.fromAsset('functions/image-optimization'),
    });

    // Set removal policy for the function and create its URL
    const cfnImageFunction = imageFunction.node.defaultChild as lambda.CfnFunction;
    cfnImageFunction.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const imageFunctionUrl = imageFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });
    const imageFunctionUrlDomain = cdk.Fn.select(2, cdk.Fn.split('/', imageFunctionUrl.url));

    // Create CloudFront distribution for image processing
    const imageDistribution = new cloudfront.Distribution(this, 'ImageDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(imageFunctionUrlDomain, {
          customHeaders: {
            'x-origin-verify': 'cloudfront',
          },
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: new cloudfront.CachePolicy(this, 'ImageCachePolicy', {
          defaultTtl: Duration.days(365),
          minTtl: Duration.days(365),
          maxTtl: Duration.days(365),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
        }),
      },
      certificate: acm.Certificate.fromCertificateArn(this, 'GeerlyDistributionCertificate', GEERLY_CERTIFICATE_ARN),
      domainNames: ['cdn.geerly.com'],
      comment: 'Geerly Image Optimization Distribution',
      enabled: true,
    });

    // Set removal policy for the distribution
    const cfnImageDistribution = imageDistribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnImageDistribution.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Create Lambda for video thumbnails
    const videoFunction = new lambda.Function(this, 'VideoFunction', {
      ...lambdaProps,
      functionName: 'video-thumbnail',
      code: lambda.Code.fromAsset('functions/video-thumbnail'),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(this, 'FFmpegLayer', 
          'arn:aws:lambda:us-east-1:656044625343:layer:ffmpeg:1'
        )
      ],
      environment: {
        ...lambdaProps.environment,
        sourceBucketName: ORIGINAL_IMAGE_BUCKET,
        thumbnailBucketName: s3ThumbnailBucket.bucketName,
        thumbnailCacheTTL: THUMBNAIL_CACHE_TTL,
      },
    });

    // Set removal policy for the function and create its URL
    const cfnVideoFunction = videoFunction.node.defaultChild as lambda.CfnFunction;
    cfnVideoFunction.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Grant access to source buckets
    const projectBuckets = [
      'geerly-cms-content',
      'files-farmify',
      'files-sopilot'
    ];

    projectBuckets.forEach(bucketName => {
      const bucketArn = `arn:aws:s3:::${bucketName}`;
      const bucketPolicy = new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [bucketArn, `${bucketArn}/*`],
      });
      videoFunction.addToRolePolicy(bucketPolicy);
    });

    // Create video function URL
    const videoFunctionUrl = videoFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });
    const videoFunctionUrlDomain = cdk.Fn.select(2, cdk.Fn.split('/', videoFunctionUrl.url));
    // Create CloudFront distribution for video thumbnails
    const thumbnailDistribution = new cloudfront.Distribution(this, 'ThumbnailDistribution', {
      defaultBehavior: {
    origin: new origins.HttpOrigin(videoFunctionUrlDomain, {          customHeaders: {
            'x-origin-verify': 'cloudfront',
          },
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: new cloudfront.CachePolicy(this, 'ThumbnailCachePolicy', {
          defaultTtl: Duration.days(365),
          minTtl: Duration.days(365),
        maxTtl: Duration.days(365),
        }),
      },
      certificate: acm.Certificate.fromCertificateArn(this, 'BoilingkettleDistributionCertificate', BOILINGKETTLE_CERTIFICATE_ARN),
      domainNames: ['thumbnail.boilingkettle.co'],
      comment: 'Boiling Kettle Video Thumbnail Distribution',
      enabled: true,
    });

    // Set removal policy for the distribution
    const cfnThumbnailDistribution = thumbnailDistribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnThumbnailDistribution.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Grant Lambda functions access to S3 buckets
    s3ThumbnailBucket.grantReadWrite(imageFunction);
    s3ThumbnailBucket.grantReadWrite(videoFunction);

    // Grant access to source bucket
    const sourceBucketArn = `arn:aws:s3:::${ORIGINAL_IMAGE_BUCKET}`;
    const sourceBucketPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [sourceBucketArn, `${sourceBucketArn}/*`],
    });
    imageFunction.addToRolePolicy(sourceBucketPolicy);
    videoFunction.addToRolePolicy(sourceBucketPolicy);

    // Output the CloudFront domains and bucket names
    new cdk.CfnOutput(this, 'ImageDeliveryDomain', {
      value: imageDistribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, 'VideoThumbnailDomain', {
      value: thumbnailDistribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, 'ImageFunctionUrl', {
  value: imageFunctionUrl.url,
});

new cdk.CfnOutput(this, 'VideoFunctionUrl', {
  value: videoFunctionUrl.url,
});

    new cdk.CfnOutput(this, 'ThumbnailBucketName', {
      value: s3ThumbnailBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'OriginalImagesS3Bucket', {
      value: ORIGINAL_IMAGE_BUCKET,
    });
  }
}
