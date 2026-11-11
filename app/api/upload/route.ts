import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

const BUCKETS = new Set(['product-images', 'chat-media', 'government-ids', 'avatars', 'ad-media']);
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const VIDEO_MAX_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME_TYPES: Record<string, Set<string>> = {
  'product-images': new Set(['image/jpeg','image/png','image/webp','image/avif','image/gif','video/mp4','video/webm','video/quicktime']),
  'chat-media': new Set(['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime']),
  'government-ids': new Set(['image/jpeg','image/png','image/webp','application/pdf']),
  avatars: new Set(['image/jpeg','image/png','image/webp']),
  'ad-media': new Set(['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime']),
};
const MIME_EXTENSIONS: Record<string,string> = {
  'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif','image/gif':'gif',
  'application/pdf':'pdf','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov',
};
function hasValidFileSignature(buffer: Buffer,mimeType: string): boolean {
  switch(mimeType) {
    case 'image/jpeg': return buffer.length>3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
    case 'image/png': return buffer.length>8&&buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    case 'image/webp': return buffer.length>12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';
    case 'image/gif': return buffer.toString('ascii',0,6)==='GIF87a'||buffer.toString('ascii',0,6)==='GIF89a';
    case 'image/avif': return buffer.length>12&&buffer.toString('ascii',4,8)==='ftyp'&&/^(avif|avis)$/.test(buffer.toString('ascii',8,12));
    case 'application/pdf': return buffer.toString('ascii',0,5)==='%PDF-';
    case 'video/mp4': return buffer.length>12&&buffer.toString('ascii',4,8)==='ftyp';
    case 'video/quicktime': return buffer.length>12&&buffer.toString('ascii',4,8)==='ftyp'&&buffer.toString('ascii',8,12)==='qt  ';
    case 'video/webm': return buffer.length>4&&buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
    default: return false;
  }
}

// Checking storage on every upload adds a network round trip to every image.
// Buckets change rarely, so remember successful checks for this server process.
const ensuredBuckets = new Set<string>();
const bucketChecks = new Map<string, Promise<void>>();

async function ensureBucket(admin: ReturnType<typeof createAdminClient>, bucket: string): Promise<void> {
  if (!admin || ensuredBuckets.has(bucket)) return;
  const inFlight = bucketChecks.get(bucket);
  if (inFlight) return inFlight;

  const check = (async () => {
    try {
      const { data: buckets } = await admin.storage.listBuckets();
      if (!buckets?.some((entry) => entry.name === bucket)) {
        await admin.storage.createBucket(bucket, { public: bucket !== 'government-ids' });
      }
      ensuredBuckets.add(bucket);
    } catch (error) {
      // Uploading can still succeed with existing buckets; don't block it.
      logger.warn('Could not ensure storage bucket', { bucket, error: String(error) });
    } finally {
      bucketChecks.delete(bucket);
    }
  })();

  bucketChecks.set(bucket, check);
  return check;
}

/**
 * Cloudinary is enabled when all three keys are present. Uploads are signed
 * server-side with HMAC-SHA1 so the secret never reaches the browser, and no
 * client SDK is required.
 *
 * Note: identity documents intentionally stay on the private Supabase bucket
 * (signed URLs) — they are never sent to a public CDN.
 */
/** Accept either the server name or the public-prefixed name from the dashboard. */
function cloudinaryCloudName(): string {
  return (
    process.env.CLOUDINARY_CLOUD_NAME ||
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ||
    ''
  );
}

function cloudinaryConfigured(): boolean {
  return Boolean(
    cloudinaryCloudName() && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
  );
}

function cloudinarySignature(params: Record<string, string>): string {
  const secret = process.env.CLOUDINARY_API_SECRET!;
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1').update(toSign + secret).digest('hex');
}

type CloudinaryResult = { url: string; publicId: string } | null;

async function uploadToCloudinary(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<CloudinaryResult> {
  const cloudName = cloudinaryCloudName();
  const apiKey = process.env.CLOUDINARY_API_KEY;
  if (!cloudinaryConfigured()) return null;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = { folder: 'goodsale', timestamp };
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(buffer)], { type: mimeType || 'application/octet-stream' }),
    filename
  );
  form.append('api_key', apiKey!);
  form.append('folder', params.folder);
  form.append('timestamp', params.timestamp);
  form.append('signature', cloudinarySignature(params));

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.warn('Cloudinary upload failed', { status: res.status, detail: detail.slice(0, 300) });
    return null;
  }
  const data = (await res.json()) as { secure_url?: string; public_id?: string };
  if (!data?.secure_url) return null;
  // Deliver an auto-format, auto-quality variant instead of the full original.
  const optimized = data.secure_url.replace('/upload/', '/upload/f_auto,q_auto/');
  return { url: optimized, publicId: data.public_id || '' };
}

/**
 * Authenticated media upload.
 * formData: file, bucket ('product-images' | 'chat-media' | 'government-ids' | 'avatars')
 * Cloudinary handles images + video for public buckets; private IDs stay on Supabase.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`upload:media:${ip}`, 30, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many uploads' }, { status: 429 });
    }

    const supabase = await createServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const bucket = String(formData.get('bucket') || 'product-images');

    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }
    if (!BUCKETS.has(bucket)) {
      return NextResponse.json({ success: false, error: 'Invalid bucket' }, { status: 400 });
    }

    const admin = createAdminClient();

    if (bucket === 'ad-media') {
      if (!admin) return NextResponse.json({success:false,error:'Advertising service is not configured'},{status:503});
      const {data:profile,error:profileError}=await admin.from('profiles').select('role').eq('auth_id',user.id).maybeSingle();
      if (profileError) {
        logger.warn('Could not verify advertising upload permission',{error:profileError.message});
        return NextResponse.json({success:false,error:'Could not verify upload permission'},{status:503});
      }
      if (!profile||!['ADMIN','SUPER_ADMIN'].includes(String(profile.role))) return NextResponse.json({success:false,error:'Admin only'},{status:403});
    }
    if (!ALLOWED_MIME_TYPES[bucket]?.has(file.type)) {
      return NextResponse.json({success:false,error:'This file type is not allowed for the selected upload'},{status:415});
    }
    const isVideo=file.type.startsWith('video/');
    const maxBytes=isVideo?VIDEO_MAX_BYTES:IMAGE_MAX_BYTES;
    if(file.size<=0||file.size>maxBytes) {
      return NextResponse.json({success:false,error:`File must be under ${Math.round(maxBytes/1024/1024)}MB`},{status:413});
    }
    const buffer=Buffer.from(await file.arrayBuffer());
    if(!hasValidFileSignature(buffer,file.type)) {
      return NextResponse.json({success:false,error:'The file content does not match its declared type'},{status:415});
    }
    await ensureBucket(admin,bucket);
    const ext=MIME_EXTENSIONS[file.type];
    const path=`${user.id}/${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
    const safeFilename=`goodsale-upload.${ext}`;

    // Identity documents always stay private on Supabase Storage.
    if (bucket !== 'government-ids' && cloudinaryConfigured()) {
      const cdn = await uploadToCloudinary(buffer, safeFilename, file.type);
      if (cdn) {
        return NextResponse.json({
          success: true,
          url: cdn.url,
          publicId: cdn.publicId,
          provider: 'cloudinary',
          bucket,
        });
      }
      logger.warn('Cloudinary unavailable, falling back to Supabase Storage');
    }

    // --- Supabase Storage (fallback + private buckets) ---
    // The route has already authenticated the user and owns the object path, so
    // the service client writes directly. This avoids a failed RLS attempt and
    // a second upload on every request.
    const uploader = admin || supabase;
    const { error: uploadError } = await uploader.storage.from(bucket).upload(path, buffer, {
      contentType: file.type,
      cacheControl: '31536000',
      upsert: false,
    });

    if (uploadError) {
      return NextResponse.json({ success: false, error: uploadError.message }, { status: 502 });
    }

    if (bucket === 'government-ids') {
      const { data: signed, error: signError } = await (admin || supabase).storage
        .from(bucket)
        .createSignedUrl(path, 60 * 60 * 24);
      if (signError || !signed?.signedUrl) {
        return NextResponse.json({ success: false, error: 'Could not sign URL' }, { status: 502 });
      }
      return NextResponse.json({ success: true, url: signed.signedUrl, path, bucket, private: true });
    }

    const { data: pub } = (admin || supabase).storage.from(bucket).getPublicUrl(path);
    return NextResponse.json({ success: true, url: pub.publicUrl, path, bucket, private: false });
  } catch (error) {
    logger.error('Media upload failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Upload failed') },
      { status: 500 }
    );
  }
}
