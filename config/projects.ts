export const PROJECT_BUCKETS = {
  geerly: 'geerly-cms-content',
  farmify: 'files-farmify',
  sopilot: 'files-sopilot',
} as const;

export const CONFIG = {
  CACHE_TTL: 'public, max-age=31536000', // 1 year
  MAX_IMAGE_SIZE: 10000000, // 10MB
  SUPPORTED_FORMATS: ['jpeg', 'png', 'webp', 'avif'],
  DEFAULT_QUALITY: 80,
} as const; 