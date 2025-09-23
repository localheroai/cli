import { promises as fs } from 'fs';

export const FILE_SIZE_LIMITS = {
  MAX_SIZE: 100 * 1024 * 1024             // 100MB - hard limit to prevent memory issues
} as const;

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

export async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

export function isFileTooLarge(sizeInBytes: number): boolean {
  return sizeInBytes > FILE_SIZE_LIMITS.MAX_SIZE;
}
