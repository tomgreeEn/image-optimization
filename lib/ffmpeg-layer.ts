import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export class FFmpegLayer extends lambda.LayerVersion {
  constructor(scope: Construct, id: string) {
    super(scope, id, {
      code: lambda.Code.fromAsset('layers/ffmpeg/dist/ffmpeg-layer.zip'),
      description: 'FFmpeg layer for video processing',
      layerVersionName: `ffmpeglayer${scope.node.addr}`,
      compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
    });
  }
} 