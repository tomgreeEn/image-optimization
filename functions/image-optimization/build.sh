#!/bin/bash

# Create config directory and copy config file
mkdir -p config
cp ../../config/projects.ts config/

# Build TypeScript
npm run build

# Clean up
rm -rf config 