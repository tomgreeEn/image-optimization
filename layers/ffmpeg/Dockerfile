# Use Amazon Linux 2
FROM amazonlinux:2

# Install FFmpeg and dependencies
RUN yum update -y && \
    yum install -y \
    https://dl.fedoraproject.org/pub/epel/epel-release-latest-7.noarch.rpm && \
    yum install -y ffmpeg && \
    yum clean all

# Create layer structure
RUN mkdir -p /opt/layer/bin && \
    cp $(which ffmpeg) /opt/layer/bin/ && \
    chmod 755 /opt/layer/bin/*

# Create layer zip
RUN cd /opt/layer && \
    zip -r9 /build/ffmpeg-layer.zip . 