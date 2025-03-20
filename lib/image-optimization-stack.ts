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
import * as iam from 'aws-cdk-lib/aws-iam';

// Constants
const THUMBNAIL_CACHE_TTL = 'public, max-age=31536000'; // 1 year

// Certificate ARNs
const GEERLY_CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:656044625343:certificate/b271caf9-020e-4de3-9ad4-b24e596e8b00';
const BOILINGKETTLE_CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:656044625343:certificate/90d4ad1c-19c1-4c6a-84a7-7b1812831b91';

// Domain names
const IMAGE_DOMAIN = 'image.boilingkettle.co';
const VIDEO_DOMAIN = 'thumbnail.boilingkettle.co';
const GEERLY_IMAGE_DOMAIN = 'cdn.geerly.com';
const FARMIFY_IMAGE_DOMAIN = 'img.farmify.io';
const SOPILOT_IMAGE_DOMAIN = 'img.sopilot.com';

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

    // Import certificates
    const geerlyCertificate = acm.Certificate.fromCertificateArn(this, 'GeerlyCertificate', GEERLY_CERTIFICATE_ARN);
    const boilingkettleCertificate = acm.Certificate.fromCertificateArn(this, 'BoilingkettleCertificate', BOILINGKETTLE_CERTIFICATE_ARN);

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

    // Create Lambda function for image transformation
    const imageFunction = new lambda.Function(this, 'ImageFunction', {
      ...lambdaProps,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-optimization'),
    });

    // Create Lambda function URL for image transformation
    const imageFunctionUrl = imageFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ['*'],
      },
    });

    // Create Lambda function for video thumbnail
    const videoFunction = new lambda.Function(this, 'VideoFunction', {
      ...lambdaProps,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/video-thumbnail'),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(this, 'FFmpegLayer',
          'arn:aws:lambda:us-east-1:656044625343:layer:ffmpeg:1'
        ),
      ],
    });

    // Create Lambda function URL for video thumbnail
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

    // Create CloudFront distribution for image transformation
    const imageDistribution = new cloudfront.Distribution(this, 'ImageDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(imageFunctionUrlDomain, {
          customHeaders: {
            'x-origin-verify': 'cloudfront',
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      certificate: boilingkettleCertificate,
      domainNames: [IMAGE_DOMAIN],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: 'Boiling Kettle Image Optimization Distribution',
    });

    // Create CloudFront distribution for video thumbnails
    const thumbnailDistribution = new cloudfront.Distribution(this, 'ThumbnailDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(videoFunctionUrlDomain, {
          customHeaders: {
            'x-origin-verify': 'cloudfront',
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      certificate: boilingkettleCertificate,
      domainNames: [VIDEO_DOMAIN],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: 'Boiling Kettle Video Thumbnail Distribution',
    });

    // Create CloudFront distribution for Geerly images (with /geerly/ path prefix)
    const geerlyImageDistribution = new cloudfront.Distribution(this, 'GeerlyImageDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(imageFunctionUrlDomain, {
          customHeaders: {
            'x-origin-verify': 'cloudfront',
          },
        }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          {
            function: new cloudfront.Function(this, 'PrependGeerlyPath', {
              code: cloudfront.FunctionCode.fromInline(`
                function handler(event) {
                  var request = event.request;
                  request.uri = '/geerly' + request.uri;
                  return request;
                }
              `),
            }),
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      certificate: geerlyCertificate,
      domainNames: [GEERLY_IMAGE_DOMAIN],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: 'Geerly Image Distribution',
    });

    // Grant Lambda functions access to S3 buckets
    const bucketNames = Object.values(PROJECT_BUCKETS) as string[];
    bucketNames.forEach(bucketName => {
      const bucket = s3.Bucket.fromBucketName(this, `${bucketName}Bucket`, bucketName);
      bucket.grantRead(imageFunction);
      bucket.grantRead(videoFunction);
      // Grant write access for thumbnails directory
      videoFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('thumbnails/*')],
      }));
    });

    thumbnailBucket.grantReadWrite(imageFunction);
    thumbnailBucket.grantReadWrite(videoFunction);

    // Stack outputs
    new cdk.CfnOutput(this, 'ImageDeliveryDomain', {
      value: imageDistribution.distributionDomainName,
      description: 'Boiling Kettle Image Optimization Domain',
    });

    new cdk.CfnOutput(this, 'VideoThumbnailDomain', {
      value: thumbnailDistribution.distributionDomainName,
      description: 'Boiling Kettle Video Thumbnail Domain',
    });

    new cdk.CfnOutput(this, 'GeerlyImageDomain', {
      value: geerlyImageDistribution.distributionDomainName,
      description: 'Geerly Image Domain',
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

    // Domain outputs
    new cdk.CfnOutput(this, 'ImageDomain', {
      value: IMAGE_DOMAIN,
    });

    new cdk.CfnOutput(this, 'VideoDomain', {
      value: VIDEO_DOMAIN,
    });
  }
}
