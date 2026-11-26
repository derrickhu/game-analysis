import fs from 'node:fs';
import path from 'node:path';

import { ALL_GAMES, getGameDescriptor, resolveCanonicalGameKey, type GameDescriptor } from '../shared/games';
import { getConfig } from './config';
import { getWechatPublisherConfig, type WechatPublisherGameMapping } from './publisher/wechat/config';
import { getWechatAccountBasicInfo } from './publisher/wechat/client';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'svg';

export interface IconFileInspection {
  valid: boolean;
  exists: boolean;
  filePath: string;
  bytes: number;
  format?: ImageFormat;
  mimeType?: string;
  reason?: string;
}

export interface GameIconCheckResult {
  gameKey: string;
  displayName: string;
  status: 'ok' | 'pulled' | 'missing' | 'invalid';
  source?: string;
  bytes: number;
  format?: ImageFormat;
  publicPath: string;
  distSynced: boolean;
  message?: string;
}

export interface GameIconsReport {
  checkedAt: number;
  total: number;
  ready: number;
  pulled: number;
  missing: string[];
  items: GameIconCheckResult[];
}

const MIN_RASTER_ICON_BYTES = 512;
const SAFE_ICON_FILENAME_RE = /^[a-zA-Z0-9_-]+\.(png|svg|jpg|jpeg|webp)$/;

/** 常见子工程内的小游戏正方形图标相对路径（按清晰度与标准程度从高到低排列） */
const WORKSPACE_ICON_CANDIDATE_RELPATHS = [
  'store/icons/game_icon_512.png',
  'store/icons/game_icon_256.png',
  'store/icons/game_icon_1024.png',
  'store/icons/game_icon_144.png',
  'store/icon_512.png',
  'store/icon.png',
  'platform/huawei/img/icon.png',
  'platform/kuaishou/store/icon_220x220.png',
  'platform/kuaishou/store/icon_148x148.png',
  'platform/wechat/mp_icon_144.png',
  'build/wechat/mp_icon_144.png',
  'assets/icon.png',
  'public/icon.png',
];

const inflightIconPulls = new Map<string, Promise<GameIconCheckResult>>();
const failedPullCooldownUntil = new Map<string, number>();
const FAILED_PULL_COOLDOWN_MS = 5 * 60_000;

export function isSafeIconFilename(filename: string): boolean {
  return SAFE_ICON_FILENAME_RE.test(filename);
}

export function detectImageBufferFormat(buf: Buffer): { format: ImageFormat; mimeType: string } | null {
  if (buf.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return { format: 'png', mimeType: 'image/png' };
    }
  }
  if (buf.length >= 3) {
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return { format: 'jpeg', mimeType: 'image/jpeg' };
    }
  }
  if (buf.length >= 12) {
    // WebP: "RIFF" .... "WEBP"
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
      return { format: 'webp', mimeType: 'image/webp' };
    }
  }
  // SVG（仅用于 default.svg 等内置矢量占位图）
  const headText = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').trimStart();
  if (headText.startsWith('<svg') || (headText.startsWith('<?xml') && headText.includes('<svg'))) {
    return { format: 'svg', mimeType: 'image/svg+xml' };
  }
  return null;
}

export function inspectIconFile(filePath: string, options?: { allowSvg?: boolean }): IconFileInspection {
  if (!fs.existsSync(filePath)) {
    return { valid: false, exists: false, filePath, bytes: 0, reason: 'missing' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return { valid: false, exists: false, filePath, bytes: 0, reason: String(error) };
  }
  if (!stat.isFile() || stat.size === 0) {
    return { valid: false, exists: true, filePath, bytes: stat.size, reason: 'empty_file' };
  }

  let headBuf: Buffer;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      headBuf = Buffer.alloc(Math.min(stat.size, 256));
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { valid: false, exists: true, filePath, bytes: stat.size, reason: String(error) };
  }

  const detected = detectImageBufferFormat(headBuf);
  if (!detected) {
    const preview = headBuf.subarray(0, 48).toString('utf8').replace(/\s+/g, ' ').trim();
    return {
      valid: false,
      exists: true,
      filePath,
      bytes: stat.size,
      reason: `invalid_image_header(${preview.slice(0, 32)})`,
    };
  }
  if (detected.format === 'svg' && !options?.allowSvg) {
    return {
      valid: false,
      exists: true,
      filePath,
      bytes: stat.size,
      format: 'svg',
      mimeType: detected.mimeType,
      reason: 'svg_not_allowed_for_game_icon',
    };
  }
  if (detected.format !== 'svg' && stat.size < MIN_RASTER_ICON_BYTES) {
    return {
      valid: false,
      exists: true,
      filePath,
      bytes: stat.size,
      format: detected.format,
      mimeType: detected.mimeType,
      reason: `file_too_small(${stat.size}B)`,
    };
  }

  return {
    valid: true,
    exists: true,
    filePath,
    bytes: stat.size,
    format: detected.format,
    mimeType: detected.mimeType,
  };
}

function getIconsDirs(): { publicIconsDir: string; distIconsDir: string | null; workspaceRoot: string } {
  const { rootDir } = getConfig();
  const publicIconsDir = path.join(rootDir, 'public', 'game-icons');
  const distDir = path.join(rootDir, 'dist');
  const distIconsDir = fs.existsSync(distDir) ? path.join(distDir, 'game-icons') : null;
  const workspaceRoot = path.resolve(rootDir, '..');
  return { publicIconsDir, distIconsDir, workspaceRoot };
}

async function fetchImageWithRetry(url: string, retries = 3): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'GameAnalysisIconFetcher/1.0' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const buf = Buffer.from(await response.arrayBuffer());
      const detected = detectImageBufferFormat(buf);
      if (!detected || detected.format === 'svg') {
        throw new Error('返回内容不是有效位图文件（PNG/JPEG/WebP）');
      }
      if (buf.length < MIN_RASTER_ICON_BYTES) {
        throw new Error(`下载到的图标体积异常偏小 (${buf.length}B)`);
      }
      return buf;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function findWechatMappingForGame(
  game: GameDescriptor,
  mappings: WechatPublisherGameMapping[],
): WechatPublisherGameMapping | undefined {
  const candidateKeys = new Set([game.gameKey, ...(game.ingestGameKeys ?? [])]);
  return mappings.find(
    (m) =>
      candidateKeys.has(m.gameKey) ||
      candidateKeys.has(resolveCanonicalGameKey(m.gameKey)) ||
      (game.wechatAppId && m.appId === game.wechatAppId),
  );
}

function discoverWorkspaceProjectDir(game: GameDescriptor, workspaceRoot: string): string | null {
  if (game.workspaceDir) {
    const explicitDir = path.join(workspaceRoot, game.workspaceDir);
    if (fs.existsSync(explicitDir) && fs.statSync(explicitDir).isDirectory()) {
      return explicitDir;
    }
  }
  if (!game.wechatAppId || !fs.existsSync(workspaceRoot)) return null;

  // 若未写 workspaceDir，但写了 wechatAppId，则自动扫描同级目录的 project.config.json 匹配 appid
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const configRelCandidates = [
    'project.config.json',
    'platform/wechat/project.config.json',
    'wechat-minigame/minigame/project.config.json',
    'build/wechat/project.config.json',
  ];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const projDir = path.join(workspaceRoot, entry.name);
    for (const rel of configRelCandidates) {
      const cfgPath = path.join(projDir, rel);
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { appid?: string };
        if (parsed.appid === game.wechatAppId) {
          return projDir;
        }
      } catch {
        // ignore invalid json
      }
    }
  }
  return null;
}

function tryPullFromWorkspace(game: GameDescriptor, workspaceRoot: string): { buf: Buffer; source: string } | null {
  const projDir = discoverWorkspaceProjectDir(game, workspaceRoot);
  if (!projDir) return null;

  for (const relPath of WORKSPACE_ICON_CANDIDATE_RELPATHS) {
    const candidate = path.join(projDir, relPath);
    const check = inspectIconFile(candidate);
    if (check.valid) {
      return {
        buf: fs.readFileSync(candidate),
        source: `workspace:${path.basename(projDir)}/${relPath}`,
      };
    }
  }
  return null;
}

async function pullIconBufferForGame(
  game: GameDescriptor,
  mappings: WechatPublisherGameMapping[],
  workspaceRoot: string,
): Promise<{ buf: Buffer; source: string }> {
  const errors: string[] = [];

  // 1) 最高优先级：显式配置的远程 iconUrl
  if (game.iconUrl) {
    try {
      const buf = await fetchImageWithRetry(game.iconUrl);
      return { buf, source: `iconUrl:${game.iconUrl}` };
    } catch (error) {
      errors.push(`iconUrl(${error instanceof Error ? error.message : String(error)})`);
    }
  }

  // 2) 微信公众平台官方头像（getaccountbasicinfo -> head_image_url /0 原图）
  const wxMapping = findWechatMappingForGame(game, mappings);
  if (wxMapping) {
    try {
      const basicInfo = await getWechatAccountBasicInfo(wxMapping);
      const buf = await fetchImageWithRetry(basicInfo.headImageUrl);
      return { buf, source: `wechat_official:${basicInfo.appId}(${basicInfo.nickname})` };
    } catch (error) {
      errors.push(`wechat(${wxMapping.appId}: ${error instanceof Error ? error.message : String(error)})`);
    }
  }

  // 3) 本地同级工作区子工程目录提取标准正方形图标
  const localHit = tryPullFromWorkspace(game, workspaceRoot);
  if (localHit) {
    return localHit;
  }
  errors.push(
    game.workspaceDir
      ? `workspace(${game.workspaceDir}: 未找到标准正方形图标)`
      : '未配置可用 iconUrl / WECHAT_PUBLISHER 映射 / 本地工程图标',
  );

  throw new Error(errors.join('; '));
}

function writeFileAtomically(targetPath: string, buf: Buffer): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, targetPath);
}

function syncGameIconTargets(
  game: GameDescriptor,
  buf: Buffer,
  publicIconsDir: string,
  distIconsDir: string | null,
): boolean {
  const keysToWrite = [game.gameKey, ...(game.ingestGameKeys ?? [])];
  for (const key of keysToWrite) {
    writeFileAtomically(path.join(publicIconsDir, `${key}.png`), buf);
    if (distIconsDir) {
      writeFileAtomically(path.join(distIconsDir, `${key}.png`), buf);
    }
  }
  return Boolean(distIconsDir);
}

function syncExistingPublicToDist(
  game: GameDescriptor,
  publicIconPath: string,
  publicIconsDir: string,
  distIconsDir: string | null,
): boolean {
  let distSynced = false;
  const buf = fs.readFileSync(publicIconPath);

  // 确保 ingestGameKeys 别名（如 xiaochu.png）在 public/game-icons 下也一并存在
  for (const alias of game.ingestGameKeys ?? []) {
    const aliasPublic = path.join(publicIconsDir, `${alias}.png`);
    if (!inspectIconFile(aliasPublic).valid) {
      writeFileAtomically(aliasPublic, buf);
    }
  }

  if (distIconsDir) {
    for (const key of [game.gameKey, ...(game.ingestGameKeys ?? [])]) {
      const distTarget = path.join(distIconsDir, `${key}.png`);
      const distCheck = inspectIconFile(distTarget);
      if (!distCheck.valid || distCheck.bytes !== buf.length) {
        writeFileAtomically(distTarget, buf);
      }
    }
    distSynced = true;
  }
  return distSynced;
}

function safeLoadWechatMappings(): WechatPublisherGameMapping[] {
  try {
    return getWechatPublisherConfig().gameMappings;
  } catch {
    return [];
  }
}

export async function ensureGameIcon(
  gameKey: string,
  options?: { autoPull?: boolean; forceRefresh?: boolean },
): Promise<GameIconCheckResult> {
  const game = getGameDescriptor(gameKey);
  const canonicalKey = game?.gameKey ?? gameKey;
  const displayName = game?.displayName ?? gameKey;
  const autoPull = options?.autoPull ?? true;
  const forceRefresh = options?.forceRefresh ?? false;

  const { publicIconsDir, distIconsDir, workspaceRoot } = getIconsDirs();
  const publicIconPath = path.join(publicIconsDir, `${canonicalKey}.png`);
  const existing = inspectIconFile(publicIconPath);

  if (existing.valid && !forceRefresh) {
    const distSynced = game
      ? syncExistingPublicToDist(game, publicIconPath, publicIconsDir, distIconsDir)
      : Boolean(distIconsDir && inspectIconFile(path.join(distIconsDir, `${canonicalKey}.png`)).valid);
    return {
      gameKey: canonicalKey,
      displayName,
      status: 'ok',
      source: 'local_public',
      bytes: existing.bytes,
      format: existing.format,
      publicPath: `/game-icons/${canonicalKey}.png`,
      distSynced,
    };
  }

  if (!autoPull || !game) {
    return {
      gameKey: canonicalKey,
      displayName,
      status: existing.exists ? 'invalid' : 'missing',
      bytes: existing.bytes,
      format: existing.format,
      publicPath: `/game-icons/${canonicalKey}.png`,
      distSynced: false,
      message: existing.reason || '未找到游戏图标',
    };
  }

  if (!forceRefresh) {
    const cooldownUntil = failedPullCooldownUntil.get(canonicalKey) ?? 0;
    if (cooldownUntil > Date.now()) {
      return {
        gameKey: canonicalKey,
        displayName,
        status: existing.exists ? 'invalid' : 'missing',
        bytes: existing.bytes,
        publicPath: `/game-icons/${canonicalKey}.png`,
        distSynced: false,
        message: '近期自动拉取失败，处于冷却窗口内',
      };
    }
  }

  const inflight = inflightIconPulls.get(canonicalKey);
  if (inflight) return inflight;

  const task = (async (): Promise<GameIconCheckResult> => {
    try {
      const mappings = safeLoadWechatMappings();
      const { buf, source } = await pullIconBufferForGame(game, mappings, workspaceRoot);
      const detected = detectImageBufferFormat(buf);
      const distSynced = syncGameIconTargets(game, buf, publicIconsDir, distIconsDir);
      failedPullCooldownUntil.delete(canonicalKey);
      return {
        gameKey: canonicalKey,
        displayName,
        status: 'pulled',
        source,
        bytes: buf.length,
        format: detected?.format,
        publicPath: `/game-icons/${canonicalKey}.png`,
        distSynced,
      };
    } catch (error) {
      failedPullCooldownUntil.set(canonicalKey, Date.now() + FAILED_PULL_COOLDOWN_MS);
      // forceRefresh 失败但原本有合法本地图标时，保留原图标不破坏线上展示
      if (existing.valid) {
        return {
          gameKey: canonicalKey,
          displayName,
          status: 'ok',
          source: 'local_public(refresh_failed)',
          bytes: existing.bytes,
          format: existing.format,
          publicPath: `/game-icons/${canonicalKey}.png`,
          distSynced: Boolean(distIconsDir),
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        gameKey: canonicalKey,
        displayName,
        status: existing.exists ? 'invalid' : 'missing',
        bytes: existing.bytes,
        publicPath: `/game-icons/${canonicalKey}.png`,
        distSynced: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      inflightIconPulls.delete(canonicalKey);
    }
  })();

  inflightIconPulls.set(canonicalKey, task);
  return task;
}

export async function ensureAllGameIcons(options?: {
  autoPull?: boolean;
  forceRefresh?: boolean;
}): Promise<GameIconsReport> {
  const items: GameIconCheckResult[] = [];
  for (const game of ALL_GAMES) {
    items.push(await ensureGameIcon(game.gameKey, options));
  }
  const ready = items.filter((i) => i.status === 'ok' || i.status === 'pulled').length;
  const pulled = items.filter((i) => i.status === 'pulled').length;
  const missing = items
    .filter((i) => i.status === 'missing' || i.status === 'invalid')
    .map((i) => i.gameKey);

  return {
    checkedAt: Date.now(),
    total: items.length,
    ready,
    pulled,
    missing,
    items,
  };
}

/**
 * 解析客户端请求的 /game-icons/:filename 对应的真实有效磁盘文件。
 * 若请求的是已登记游戏图标且本地缺失，会自动触发一次按需补拉。
 */
export async function resolveServedGameIconFile(
  filename: string,
): Promise<{ filePath: string; mimeType: string } | null> {
  if (!isSafeIconFilename(filename)) return null;

  const { publicIconsDir, distIconsDir } = getIconsDirs();
  const allowSvg = filename.toLowerCase().endsWith('.svg');

  for (const dir of [publicIconsDir, distIconsDir]) {
    if (!dir) continue;
    const candidate = path.join(dir, filename);
    const check = inspectIconFile(candidate, { allowSvg });
    if (check.valid && check.mimeType) {
      return { filePath: candidate, mimeType: check.mimeType };
    }
  }

  // 若请求形如 {gameKey}.png 且本地不存在，尝试按需自动补拉一次
  if (filename.endsWith('.png')) {
    const requestedKey = filename.slice(0, -4);
    const descriptor = getGameDescriptor(requestedKey);
    if (descriptor) {
      const result = await ensureGameIcon(descriptor.gameKey, { autoPull: true });
      if (result.status === 'ok' || result.status === 'pulled') {
        const refreshed = path.join(publicIconsDir, `${descriptor.gameKey}.png`);
        const check = inspectIconFile(refreshed);
        if (check.valid && check.mimeType) {
          return { filePath: refreshed, mimeType: check.mimeType };
        }
      }
    }
  }

  return null;
}
