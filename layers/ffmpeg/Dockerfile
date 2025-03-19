FROM amazonlinux:2

# Install build dependencies
RUN yum update -y && \
    yum groupinstall -y "Development Tools" && \
    yum install -y \
    autoconf \
    automake \
    cmake \
    freetype-devel \
    gcc \
    gcc-c++ \
    git \
    libtool \
    make \
    mercurial \
    nasm \
    pkgconfig \
    zlib-devel \
    yasm \
    zip

# Create build directory
WORKDIR /build

# Build and install x264
RUN git clone --depth 1 https://code.videolan.org/videolan/x264.git && \
    cd x264 && \
    ./configure --prefix=/opt --enable-static --enable-pic && \
    make -j$(nproc) && \
    make install && \
    cd ..

# Set PKG_CONFIG_PATH to find x264
ENV PKG_CONFIG_PATH=/opt/lib/pkgconfig

# Download and extract FFmpeg
RUN curl -LO https://ffmpeg.org/releases/ffmpeg-6.1.tar.gz && \
    tar xzf ffmpeg-6.1.tar.gz

# Configure and build FFmpeg with minimal features
RUN cd ffmpeg-6.1 && \
    ./configure \
    --prefix=/opt \
    --enable-static \
    --disable-shared \
    --disable-doc \
    --disable-ffplay \
    --disable-ffprobe \
    --disable-avdevice \
    --disable-swscale \
    --disable-postproc \
    --disable-avfilter \
    --disable-network \
    --disable-encoders \
    --disable-decoders \
    --enable-decoder=h264 \
    --enable-decoder=mjpeg \
    --enable-decoder=mpeg4 \
    --enable-decoder=vp8 \
    --enable-decoder=vp9 \
    --enable-encoder=mjpeg \
    --enable-encoder=png \
    --enable-encoder=libx264 \
    --enable-libx264 \
    --enable-gpl \
    --enable-nonfree \
    --enable-small \
    --extra-cflags="-O2 -fPIC -I/opt/include" \
    --extra-ldflags="-L/opt/lib" && \
    make -j$(nproc) && \
    make install

# Create layer structure
RUN mkdir -p /opt/layer && \
    cp -r /opt/bin /opt/layer/ && \
    cp -r /opt/lib /opt/layer/ && \
    cp -r /opt/share /opt/layer/

# Create layer zip
RUN cd /opt/layer && \
    zip -r9 /build/ffmpeg-layer.zip . 