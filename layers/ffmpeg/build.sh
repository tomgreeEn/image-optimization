#!/bin/bash

# Build the Docker image
docker build -t ffmpeg-lambda-layer .

# Create a container from the image
container_id=$(docker create ffmpeg-lambda-layer)

# Copy the layer zip from the container
docker cp $container_id:/build/ffmpeg-layer.zip .

# Remove the container
docker rm $container_id

echo "FFmpeg layer has been built and copied to ffmpeg-layer.zip" 