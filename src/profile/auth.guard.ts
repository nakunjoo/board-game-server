import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { getSupabaseAdmin } from '../database/supabase-admin';

interface CacheEntry {
  userId: string;
  expiresAt: number;
}

const TOKEN_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000; // 60초

// 만료된 캐시 항목 정리 (10분마다)
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of TOKEN_CACHE) {
    if (entry.expiresAt <= now) TOKEN_CACHE.delete(token);
  }
}, 10 * 60 * 1000);

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization;

    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();

    const token = auth.slice(7);

    // 캐시 히트
    const cached = TOKEN_CACHE.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      req['userId'] = cached.userId;
      return true;
    }

    const { data: { user }, error } = await getSupabaseAdmin().auth.getUser(token);

    if (error || !user) throw new UnauthorizedException('Invalid token');

    TOKEN_CACHE.set(token, { userId: user.id, expiresAt: Date.now() + CACHE_TTL_MS });

    req['userId'] = user.id;
    return true;
  }
}
