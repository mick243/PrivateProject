import type { MetadataRoute } from 'next';
import { publicAppUrl } from '@/lib/app-url';

/**
 * /robots.txt — 크롤러가 API·개인 화면을 긁지 않게.
 * `/api/` 는 JSON 이라 색인해도 쓸모가 없고, 검색 파라미터가 붙은 목록 API 를
 * 크롤러가 훑으면 네이버 지역검색 한도(/api/places)를 같이 태웁니다.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/admin/', '/account', '/welcome', '/login', '/signup'],
      },
    ],
    sitemap: `${publicAppUrl()}/sitemap.xml`,
  };
}
