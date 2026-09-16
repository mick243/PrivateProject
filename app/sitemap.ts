import type { MetadataRoute } from 'next';
import { publicAppUrl } from '@/lib/app-url';

/**
 * /sitemap.xml — 공개 화면 넷 + 법적 고지. 오락실·글 상세는 클라이언트 상태라
 * 고유 URL 이 없어(`/?arcade=3` 은 같은 문서) 넣지 않습니다.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicAppUrl();
  const now = new Date();
  return [
    { url: `${base}/`, lastModified: now, changeFrequency: 'daily', priority: 1 },
    { url: `${base}/finder`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/live`, lastModified: now, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${base}/tier`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/community`, lastModified: now, changeFrequency: 'daily', priority: 0.7 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
  ];
}
