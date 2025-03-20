// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Duration } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { PROJECT_BUCKETS, CONFIG } from '../config/projects';

// Constants
const THUMBNAIL_CACHE_TTL = 'public, max-age=31536000'; // 1 year

// Certificate ARNs (commented out for now)
// const GEERLY_CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:656044625343:certificate/b271caf9-020e-4de3-9ad4-b24e596e8b00';
// const BOILINGKETTLE_CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:656044625343:certificate/90d4ad1c-19c1-4c6a-84a7-7b1812831b91';

export class ImgTransformationStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket for thumbnails
    const thumbnailBucket = new s3.Bucket(this, 'S3ThumbnailBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          enabled: true,
          expiration: Duration.days(30),
        },
      ],
    });

    // Common Lambda props
    const lambdaProps = {
      runtime: lambda.Runtime.NODEJS_18_X,
      memorySize: 1024,
      timeout: Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_DAY,
      environment: {
        thumbnailBucketName: thumbnailBucket.bucketName,
        transformedImageCacheTTL: CONFIG.CACHE_TTL,
        maxImageSize: CONFIG.MAX_IMAGE_SIZE.toString(),
      },
    };

    // Create Lambda function for image optimization
    const imageFunction = new lambda.Function(this, 'ImageFunction', {
      ...lambdaProps,
      functionName: 'boilingkettle-image-optimization',
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-optimization'),
    });

    // Set removal policy for the function
    const cfnImageFunction = imageFunction.node.defaultChild as lambda.CfnFunction;
    cfnImageFunction.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Create Lambda function URL for image optimization
    const imageFunctionUrl = imageFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ['*'],
      },
    });

    // Create Lambda function for video thumbnails
    const videoFunction = new lambda.Function(this, 'VideoFunction', {
      ...lambdaProps,
      functionName: 'video-thumbnail',
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/video-thumbnail'),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(this, 'FFmpegLayer', 
          'arn:aws:lambda:us-east-1:656044625343:layer:ffmpeg:1'
        )
      ],
      environment: {
        ...lambdaProps.environment,
        thumbnailCacheTTL: THUMBNAIL_CACHE_TTL,
      },
    });

    // Set removal policy for the function
    const cfnVideoFunction = videoFunction.node.defaultChild as lambda.CfnFunction;
    cfnVideoFunction.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Create Lambda function URL for video thumbnails
    const videoFunctionUrl = videoFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ['*'],
      },
    });

    // Extract domain from function URLs
    const imageFunctionUrlDomain = cdk.Fn.select(2, cdk.Fn.split('/', imageFunctionUrl.url));
    const videoFunctionUrlDomain = cdk.Fn.select(2, cdk.Fn.split('/', videoFunctionUrl.url));

    // Create CloudFront distribution for image optimization
    const imageDistribution = new cloudfront.Distribution(this, 'ImageDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(imageFunctionUrlDomain, {
          customHeaders: {
            'x-origin-verify': 'cloudfront',
          },
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: new cloudfront.CachePolicy(this, 'ImageCachePolicy', {
          defaultTtl: Duration.days(365),
          minTtl: Duration.days(365),
          maxTtl: Duration.days(365),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
        }),
      },
      comment: 'Boiling Kettle Image Optimization Distribution',
      enabled: true,
      // Domain configuration (commented out for now)
      // certificate: acm.Certificate.fromCertificateArn(this, 'BoilingkettleImageDistributionCertificate', BOILINGKETTLE_CERTIFICATE_ARN),
      // domainNames: ['images.boilingkettle.co'],
    });

    // Set removal policy for the distribution
    const cfnImageDistribution = imageDistribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnImageDistribution.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Create CloudFront distribution for video thumbnails
    const thumbnailDistribution = new cloudfront.Distribution(this, 'ThumbnailDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(videoFunctionUrlDomain, {
          customHeaders: {
            'x-origin-verify': 'cloudfront',
          },
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: new cloudfront.CachePolicy(this, 'ThumbnailCachePolicy', {
          defaultTtl: Duration.days(365),
          minTtl: Duration.days(365),
          maxTtl: Duration.days(365),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
        }),
      },
      comment: 'Boiling Kettle Video Thumbnail Distribution',
      enabled: true,
      // Domain configuration (commented out for now)
      // certificate: acm.Certificate.fromCertificateArn(this, 'BoilingkettleDistributionCertificate', BOILINGKETTLE_CERTIFICATE_ARN),
      // domainNames: ['thumbnail.boilingkettle.co'],
    });

    // Set removal policy for the distribution
    const cfnThumbnailDistribution = thumbnailDistribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnThumbnailDistribution.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Grant Lambda functions access to S3 buckets
    const bucketNames = Object.values(PROJECT_BUCKETS) as string[];
    bucketNames.forEach(bucketName => {
      const bucket = s3.Bucket.fromBucketName(this, `${bucketName}Bucket`, bucketName);
      bucket.grantRead(imageFunction);
      bucket.grantRead(videoFunction);
    });

    thumbnailBucket.grantReadWrite(imageFunction);
    thumbnailBucket.grantReadWrite(videoFunction);

    // Stack outputs
    new cdk.CfnOutput(this, 'ImageDeliveryDomain', {
      value: imageDistribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, 'VideoThumbnailDomain', {
      value: thumbnailDistribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, 'OriginalImagesS3Bucket', {
      value: bucketNames[0],
    });

    new cdk.CfnOutput(this, 'ThumbnailBucketName', {
      value: thumbnailBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'ImageFunctionUrl', {
      value: imageFunctionUrl.url,
    });

    new cdk.CfnOutput(this, 'VideoFunctionUrl', {
      value: videoFunctionUrl.url,
    });
  }
}
